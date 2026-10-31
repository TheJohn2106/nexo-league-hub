// Imports de résultats : source brute conservée → aperçu → rapprochement des identités → validation.
// Idempotent : même source = même import ; une ré-application remplace les lignes par clé d'entrée sans doublon.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Db } from "../db.ts";
import { tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { parseCsvTemplate, parseIracingResult, parseManualRows, type ManualRowInput, type ParsedSession } from "../results/parse.ts";
import { assertUuid, audit, requirePermission, sessionIn } from "./context.ts";
import { markStartsFromResults } from "./attendance.ts";
import { enqueue } from "./notifications.ts";
import { fetchSubsessionResult, iracingApiStatus, type Transport } from "./iracing.ts";

/** Résultats définitifs d'une course : constat de participation et clôture de la manche si toutes ses courses sont définitives. */
async function onFinalRace(db: Db, session: { id: string; round_id: string }) {
  await markStartsFromResults(db, session.round_id, session.id);
  const pending = (
    await db.query("SELECT count(*)::int n FROM round_sessions WHERE round_id=$1 AND awards_points AND results_status <> 'final'", [session.round_id])
  ).rows[0].n;
  if (pending === 0) await db.query("UPDATE rounds SET status='completed' WHERE id=$1 AND status IN ('scheduled','postponed')", [session.round_id]);
}

export type ImportSource = "iracing_api" | "iracing_json" | "manual" | "csv_template";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

async function storeImport(db: Db, communityId: string, actorId: string, session: { id: string }, source: ImportSource, raw: unknown, hashInput: string, parse: () => ParsedSession) {
  const hash = sha256(`${source}:${hashInput}`);
  const existing = (
    await db.query("SELECT id, status FROM result_imports WHERE session_id=$1 AND payload_sha256=$2 AND status IN ('preview','applied')", [session.id, hash])
  ).rows[0];
  if (existing) return { importId: existing.id as string, duplicate: true, status: existing.status as string, error: null as string | null };
  let parsed: ParsedSession | null = null,
    error: string | null = null;
  try {
    parsed = parse();
  } catch (e) {
    error = (e as Error).message;
  }
  const row = (
    await db.query(
      `INSERT INTO result_imports(session_id, source, status, payload_sha256, raw, parsed, error, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [session.id, source, error ? "failed" : "preview", error ? null : hash, JSON.stringify(raw), parsed ? JSON.stringify(parsed) : null, error, actorId],
    )
  ).rows[0];
  await audit(db, communityId, actorId, error ? "import.failed" : "import.preview", "session", session.id, { importId: row.id, source, error });
  // Un échec d'analyse reste enregistré (source brute + message) : l'appelant affiche l'erreur.
  return { importId: row.id as string, duplicate: false, status: error ? "failed" : "preview", error };
}

/** Fichier JSON de la Data API (réponse results/get) ou modèle CSV Nexo. */
export async function importFile(db: Db, communityId: string, actorId: string, sessionId: string, fileName: string, text: string) {
  await requirePermission(db, communityId, actorId, "results.manage");
  const session = await sessionIn(db, communityId, sessionId, true);
  if (text.length > 5_000_000) throw new AppError("Fichier trop volumineux (5 Mo maximum).");
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new AppError("JSON invalide.");
    }
    return storeImport(db, communityId, actorId, session, "iracing_json", json, stableStringify(json), () =>
      parseIracingResult(json, {
        kind: session.kind,
        simsessionNumber: session.iracing_simsession_number,
        expectedSubsessionId: session.iracing_subsession_id ? Number(session.iracing_subsession_id) : null,
      }),
    );
  }
  return storeImport(db, communityId, actorId, session, "csv_template", { fileName, text: trimmed }, trimmed, () => parseCsvTemplate(trimmed));
}

export async function importManual(db: Db, communityId: string, actorId: string, sessionId: string, rows: Omit<ManualRowInput, "custId" | "displayName">[]) {
  await requirePermission(db, communityId, actorId, "results.manage");
  const session = await sessionIn(db, communityId, sessionId, true);
  const users = (
    await db.query(
      `SELECT r.user_id, u.display_name, p.iracing_cust_id, r.category FROM registrations r JOIN users u ON u.id=r.user_id
       JOIN driver_profiles p ON p.user_id=r.user_id WHERE r.championship_id=$1`,
      [session.championship_id],
    )
  ).rows;
  const full = rows.map((r) => {
    const u = users.find((x) => x.user_id === r.userId);
    if (!u) throw new AppError("Pilote non inscrit à ce championnat.");
    // Classe : celle saisie, sinon la catégorie d'inscription (championnat multiclasse).
    return { ...r, carClass: String(r.carClass ?? "").trim() || u.category || null, custId: u.iracing_cust_id ? Number(u.iracing_cust_id) : null, displayName: u.display_name };
  });
  const raw = { manual: full, enteredAt: new Date().toISOString() };
  return storeImport(db, communityId, actorId, session, "manual", raw, stableStringify(full), () => parseManualRows(full));
}

// Échecs repris automatiquement par le worker (avec le compte iRacing de l'organisateur qui a lancé la récupération).
// Les autres (configuration, autorisation à renouveler, format) attendent une action humaine.
const RETRYABLE = new Set(["rate-limit", "provider", "busy"]);
export const MAX_SYNC_ATTEMPTS = 5;

export async function recordSyncFailure(db: Db, communityId: string, sessionId: string, actorId: string, code: string, message: string) {
  const retryable = RETRYABLE.has(code);
  // Délai : 15 min pour une limite de requêtes, sinon 5, 10, 20, 40 min.
  const updated = await db.query(
    `UPDATE sync_failures SET attempts=attempts+1, code=$3, message=$4, actor_id=$5,
       retry_after=CASE WHEN $6 AND attempts+1 < $7 THEN now() + make_interval(mins => CASE WHEN $3='rate-limit' THEN 15 ELSE 5 * power(2, attempts)::int END) END
     WHERE session_id=$1 AND community_id=$2 AND kind='iracing_results' AND resolved_at IS NULL RETURNING id`,
    [sessionId, communityId, code, message, actorId, retryable, MAX_SYNC_ATTEMPTS],
  );
  if (updated.rowCount) return;
  await db.query(
    `INSERT INTO sync_failures(community_id, session_id, kind, code, message, actor_id, retry_after)
     VALUES($1,$2,'iracing_results',$3,$4,$5, CASE WHEN $6 THEN now() + make_interval(mins => CASE WHEN $3='rate-limit' THEN 15 ELSE 5 END) END)`,
    [communityId, sessionId, code, message, actorId, retryable],
  );
}

/** Reprise des échecs arrivés à échéance (worker). Un nouvel échec reprogramme ou abandonne via recordSyncFailure. */
export async function retryDueSyncFailures(pool: Pool, transport?: Transport, now = new Date()) {
  const due = (
    await pool.query(
      `SELECT id, community_id, session_id, actor_id FROM sync_failures
       WHERE resolved_at IS NULL AND kind='iracing_results' AND retry_after <= $1 AND session_id IS NOT NULL ORDER BY retry_after LIMIT 10`,
      [now],
    )
  ).rows;
  const stats = { retried: 0, recovered: 0, failed: 0 };
  for (const f of due) {
    stats.retried++;
    // Réserve l'essai : un autre worker ne reprend pas la même ligne.
    const claimed = await pool.query("UPDATE sync_failures SET retry_after=NULL WHERE id=$1 AND retry_after IS NOT NULL RETURNING id", [f.id]);
    if (!claimed.rowCount) continue;
    if (!f.actor_id) {
      await pool.query("UPDATE sync_failures SET message='Auteur de la récupération introuvable : relancez-la manuellement.' WHERE id=$1", [f.id]);
      stats.failed++;
      continue;
    }
    try {
      const out = await importFromIracingApi(pool, f.community_id, f.actor_id, f.session_id, transport);
      if (out.status === "failed") stats.failed++;
      else stats.recovered++;
    } catch (e) {
      stats.failed++;
      // Droits retirés, session supprimée… : pas de nouvel essai automatique.
      if (!(e as { code?: string }).code)
        await pool.query("UPDATE sync_failures SET message=$2 WHERE id=$1 AND resolved_at IS NULL", [
          f.id,
          `Reprise automatique impossible : ${(e as Error).message}`,
        ]);
    }
  }
  return stats;
}

/** Récupération via la Data API : réseau hors transaction, puis enregistrement de l'aperçu. */
export async function importFromIracingApi(pool: Pool, communityId: string, actorId: string, sessionId: string, transport?: Transport) {
  const session = await tx(async (db) => {
    await requirePermission(db, communityId, actorId, "results.manage");
    return sessionIn(db, communityId, sessionId);
  }, pool);
  if (!session.iracing_subsession_id) throw new AppError("Associez d’abord l’identifiant de sous-session iRacing à cette session.");
  const status = iracingApiStatus();
  if (!status.configured) throw new AppError(status.message);
  let raw: unknown;
  try {
    raw = await fetchSubsessionResult(pool, actorId, Number(session.iracing_subsession_id), transport);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "provider";
    const message = (e as Error).message;
    await recordSyncFailure(pool, communityId, session.id, actorId, code, message);
    throw e instanceof AppError ? e : new AppError(message, 502);
  }
  return tx(async (db) => {
    const locked = await sessionIn(db, communityId, sessionId, true);
    const out = await storeImport(db, communityId, actorId, locked, "iracing_api", raw, stableStringify(raw), () =>
      parseIracingResult(raw, { kind: locked.kind, simsessionNumber: locked.iracing_simsession_number, expectedSubsessionId: Number(locked.iracing_subsession_id) }),
    );
    if (out.status === "failed") await recordSyncFailure(db, communityId, locked.id, actorId, "results-format", out.error ?? "Format inattendu.");
    else await db.query("UPDATE sync_failures SET resolved_at=now() WHERE session_id=$1 AND resolved_at IS NULL", [locked.id]);
    return out;
  }, pool);
}

export interface MatchSuggestion {
  entryKey: string;
  userId: string | null;
  how: "iracing_id" | "crew" | "crew_choice" | "manual_entry" | "name" | "none";
  registered: boolean;
}

async function championshipDrivers(db: Db, championshipId: string) {
  return (
    await db.query(
      `SELECT r.user_id AS "userId", u.display_name AS "displayName", p.iracing_cust_id AS "custId", r.status
       FROM registrations r JOIN users u ON u.id=r.user_id JOIN driver_profiles p ON p.user_id=r.user_id
       WHERE r.championship_id=$1 ORDER BY u.display_name`,
      [championshipId],
    )
  ).rows as { userId: string; displayName: string; custId: string | null; status: string }[];
}

export async function getImport(db: Db, communityId: string, importId: string) {
  assertUuid(importId, "Import");
  const imp = (
    await db.query(
      `SELECT i.*, s.round_id, s.kind, s.label, r.championship_id FROM result_imports i JOIN round_sessions s ON s.id=i.session_id
       JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id WHERE i.id=$1 AND c.community_id=$2`,
      [importId, communityId],
    )
  ).rows[0];
  if (!imp) throw notFound("Import");
  const drivers = await championshipDrivers(db, imp.championship_id);
  const parsed: ParsedSession | null = imp.parsed;
  const suggestions: MatchSuggestion[] = (parsed?.rows ?? []).map((row) => {
    if (row.entryKey.startsWith("user:")) {
      const id = row.entryKey.slice(5);
      return { entryKey: row.entryKey, userId: id, how: "manual_entry", registered: drivers.some((d) => d.userId === id) };
    }
    const byId = row.custId != null ? drivers.find((d) => d.custId != null && Number(d.custId) === row.custId) : undefined;
    if (byId) return { entryKey: row.entryKey, userId: byId.userId, how: "iracing_id", registered: true };
    // Voiture d'équipage : rapprochée par les identifiants iRacing de ses pilotes.
    const crew = drivers.filter((d) => d.custId != null && (row.crew ?? []).some((c) => c.custId === Number(d.custId)));
    if (crew.length === 1) return { entryKey: row.entryKey, userId: crew[0].userId, how: "crew", registered: true };
    if (crew.length > 1) return { entryKey: row.entryKey, userId: crew[0].userId, how: "crew_choice", registered: true };
    const byName = drivers.find((d) => d.displayName.toLowerCase() === row.displayName.toLowerCase());
    if (byName) return { entryKey: row.entryKey, userId: byName.userId, how: "name", registered: true };
    return { entryKey: row.entryKey, userId: null, how: "none", registered: false };
  });
  return { import: imp, parsed, drivers, suggestions };
}

/**
 * Validation d'un aperçu. matches : décision explicite pour chaque ligne non rapprochée par identifiant iRacing
 * (userId, ou "none" pour laisser le participant hors classement).
 */
export async function applyImport(
  db: Db,
  communityId: string,
  actorId: string,
  importId: string,
  options: { final: boolean; matches: Record<string, string>; saveIracingIds: boolean },
) {
  await requirePermission(db, communityId, actorId, "results.manage");
  const { import: imp, parsed, drivers, suggestions } = await getImport(db, communityId, importId);
  const session = await sessionIn(db, communityId, imp.session_id, true);
  const current = (await db.query("SELECT status FROM result_imports WHERE id=$1 FOR UPDATE", [imp.id])).rows[0];
  if (current.status === "applied") throw new AppError("Cet import est déjà validé.", 409);
  if (current.status !== "preview" || !parsed) throw new AppError("Seul un aperçu valide peut être validé.");
  const assigned = new Map<string, string | null>();
  const undecided: string[] = [];
  for (const s of suggestions) {
    const choice = options.matches[s.entryKey];
    if (s.how === "iracing_id" || s.how === "crew" || s.how === "manual_entry") assigned.set(s.entryKey, choice && choice !== "auto" ? (choice === "none" ? null : choice) : s.userId);
    else if (choice === "none") assigned.set(s.entryKey, null);
    else if (choice && choice !== "auto") assigned.set(s.entryKey, choice);
    else undecided.push(parsed.rows.find((r) => r.entryKey === s.entryKey)!.displayName);
  }
  if (undecided.length) throw new AppError(`Rapprochement à valider pour : ${undecided.join(", ")}. Choisissez un pilote ou « hors classement ».`);
  const used = new Set<string>();
  for (const [, userId] of assigned) {
    if (!userId) continue;
    if (!drivers.some((d) => d.userId === userId)) throw new AppError("Un pilote choisi n’est pas inscrit à ce championnat.");
    if (used.has(userId)) throw new AppError("Un même pilote est associé à deux lignes de résultat.");
    used.add(userId);
  }

  const previous = (await db.query("SELECT id FROM result_imports WHERE session_id=$1 AND status='applied'", [session.id])).rows.map((r) => r.id);
  if (previous.length) await db.query("UPDATE result_imports SET status='superseded' WHERE id = ANY($1)", [previous]);
  const keys = parsed.rows.map((r) => r.entryKey);
  const removed = await db.query("DELETE FROM results WHERE session_id=$1 AND NOT (entry_key = ANY($2)) RETURNING entry_key", [session.id, keys]);
  for (const r of parsed.rows) {
    await db.query(
      `INSERT INTO results(session_id, import_id, entry_key, user_id, iracing_cust_id, display_name, team_name, car, car_class, finish_position,
         class_position, start_position, laps, laps_led, best_lap_ms, best_lap_number, total_time_ms, gap_ms, gap_laps, incidents, status, reason_out)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT(session_id, entry_key) DO UPDATE SET import_id=EXCLUDED.import_id, user_id=EXCLUDED.user_id, iracing_cust_id=EXCLUDED.iracing_cust_id,
         display_name=EXCLUDED.display_name, team_name=EXCLUDED.team_name, car=EXCLUDED.car, car_class=EXCLUDED.car_class,
         finish_position=EXCLUDED.finish_position, class_position=EXCLUDED.class_position, start_position=EXCLUDED.start_position,
         laps=EXCLUDED.laps, laps_led=EXCLUDED.laps_led, best_lap_ms=EXCLUDED.best_lap_ms, best_lap_number=EXCLUDED.best_lap_number,
         total_time_ms=EXCLUDED.total_time_ms, gap_ms=EXCLUDED.gap_ms, gap_laps=EXCLUDED.gap_laps, incidents=EXCLUDED.incidents,
         status=EXCLUDED.status, reason_out=EXCLUDED.reason_out`,
      [
        session.id, imp.id, r.entryKey, assigned.get(r.entryKey) ?? null, r.custId, r.displayName, r.teamName, r.car, r.carClass, r.finishPosition,
        r.classPosition, r.startPosition, r.laps, r.lapsLed, r.bestLapMs, r.bestLapNumber, r.totalTimeMs, r.gapMs, r.gapLaps, r.incidents, r.status, r.reasonOut,
      ],
    );
    const userId = assigned.get(r.entryKey);
    if (options.saveIracingIds && userId && r.custId) {
      // N'écrase jamais un identifiant existant ; ignore si l'identifiant appartient déjà à un autre compte.
      await db.query(
        `UPDATE driver_profiles SET iracing_cust_id=$2, updated_at=now() WHERE user_id=$1 AND iracing_cust_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM driver_profiles WHERE iracing_cust_id=$2)`,
        [userId, r.custId],
      );
    }
  }
  await db.query("UPDATE result_imports SET status='applied', is_final=$2, applied_by=$3, applied_at=now() WHERE id=$1", [imp.id, options.final, actorId]);
  await db.query("UPDATE round_sessions SET results_status=$2 WHERE id=$1", [session.id, options.final ? "final" : "provisional"]);
  if (session.kind === "race" && options.final) await onFinalRace(db, session);
  if (session.awards_points)
    await enqueue(db, communityId, "results_published", `results:${session.id}:${imp.id}:${options.final ? "final" : "provisional"}`, {
      sessionId: session.id,
      final: options.final,
    });
  await audit(db, communityId, actorId, "import.apply", "session", session.id, {
    importId: imp.id,
    final: options.final,
    superseded: previous,
    removedEntries: removed.rows.map((r) => r.entry_key),
    unmatched: [...assigned].filter(([, u]) => !u).map(([k]) => k),
  });
}

/** Passage de provisoire à définitif (ou inverse) sans réimport. */
export async function setResultsStatus(db: Db, communityId: string, actorId: string, sessionId: string, final: boolean) {
  await requirePermission(db, communityId, actorId, "results.manage");
  const s = await sessionIn(db, communityId, sessionId, true);
  if (s.results_status === "none") throw new AppError("Aucun résultat validé pour cette session.");
  await db.query("UPDATE round_sessions SET results_status=$2 WHERE id=$1", [s.id, final ? "final" : "provisional"]);
  await db.query("UPDATE result_imports SET is_final=$2 WHERE session_id=$1 AND status='applied'", [s.id, final]);
  if (final && s.kind === "race") await onFinalRace(db, s);
  if (final && s.awards_points) await enqueue(db, communityId, "results_published", `results:${s.id}:final:${Date.now()}`, { sessionId: s.id, final: true });
  await audit(db, communityId, actorId, final ? "results.final" : "results.provisional", "session", s.id);
}

export async function discardImport(db: Db, communityId: string, actorId: string, importId: string) {
  await requirePermission(db, communityId, actorId, "results.manage");
  const { import: imp } = await getImport(db, communityId, importId);
  if (imp.status !== "preview") throw new AppError("Seul un aperçu peut être abandonné.");
  await db.query("UPDATE result_imports SET status='discarded' WHERE id=$1", [imp.id]);
  await audit(db, communityId, actorId, "import.discard", "session", imp.session_id, { importId: imp.id });
}

const correctable = ["finish_position", "status", "laps", "best_lap_ms", "incidents", "user_id", "total_time_ms", "start_position"] as const;
export async function addCorrection(db: Db, communityId: string, actorId: string, resultId: string, field: unknown, value: unknown, reason: unknown) {
  await requirePermission(db, communityId, actorId, "results.manage");
  assertUuid(resultId, "Résultat");
  if (!correctable.includes(field as (typeof correctable)[number])) throw new AppError("Champ non corrigeable.");
  const why = String(reason ?? "").trim();
  if (why.length < 3) throw new AppError("Motif obligatoire.");
  const r = (
    await db.query(
      `SELECT res.*, s.round_id, r.championship_id FROM results res JOIN round_sessions s ON s.id=res.session_id JOIN rounds r ON r.id=s.round_id
       JOIN championships c ON c.id=r.championship_id WHERE res.id=$1 AND c.community_id=$2`,
      [resultId, communityId],
    )
  ).rows[0];
  if (!r) throw notFound("Résultat");
  let v = String(value ?? "").trim();
  if (field === "status" && !["classified", "dnf", "dns", "dsq"].includes(v)) throw new AppError("Statut invalide.");
  if (["finish_position", "laps", "incidents", "start_position"].includes(String(field)) && v && !/^\d+$/.test(v)) throw new AppError("Nombre entier attendu.");
  if (["best_lap_ms", "total_time_ms"].includes(String(field)) && v) {
    const { parseLapTime } = await import("../time.ts");
    v = String(parseLapTime(v));
  }
  if (field === "user_id" && v) {
    assertUuid(v, "Pilote");
    const ok = (await db.query("SELECT 1 FROM registrations WHERE championship_id=$1 AND user_id=$2", [r.championship_id, v])).rowCount;
    if (!ok) throw new AppError("Pilote non inscrit à ce championnat.");
  }
  const column = field as string;
  const old = r[column] == null ? null : String(r[column]);
  await db.query("INSERT INTO result_corrections(result_id, field, old_value, new_value, reason, created_by) VALUES($1,$2,$3,$4,$5,$6)", [
    r.id,
    field,
    old,
    v || null,
    why,
    actorId,
  ]);
  await audit(db, communityId, actorId, "result.correct", "result", r.id, { field, old, new: v || null, reason: why });
}

export async function revokeCorrection(db: Db, communityId: string, actorId: string, correctionId: string) {
  await requirePermission(db, communityId, actorId, "results.manage");
  assertUuid(correctionId, "Correction");
  const r = await db.query(
    `UPDATE result_corrections rc SET revoked_at=now(), revoked_by=$3 FROM results res, round_sessions s, rounds r, championships c
     WHERE rc.id=$1 AND res.id=rc.result_id AND s.id=res.session_id AND r.id=s.round_id AND c.id=r.championship_id AND c.community_id=$2 AND rc.revoked_at IS NULL
     RETURNING rc.id`,
    [correctionId, communityId, actorId],
  );
  if (!r.rowCount) throw notFound("Correction");
  await audit(db, communityId, actorId, "result.correction_revoke", "correction", correctionId);
}

export async function sessionImports(db: Db, communityId: string, sessionId: string) {
  const s = await sessionIn(db, communityId, sessionId);
  return (
    await db.query(
      `SELECT i.id, i.source, i.status, i.error, i.is_final AS "isFinal", i.created_at AS "createdAt", i.applied_at AS "appliedAt",
              u.display_name AS "createdBy", jsonb_array_length(COALESCE(i.parsed->'rows','[]'::jsonb)) AS "rowCount"
       FROM result_imports i LEFT JOIN users u ON u.id=i.created_by WHERE i.session_id=$1 ORDER BY i.created_at DESC`,
      [s.id],
    )
  ).rows;
}

export async function sessionResultRows(db: Db, communityId: string, sessionId: string) {
  const s = await sessionIn(db, communityId, sessionId);
  const results = (await db.query("SELECT * FROM results WHERE session_id=$1 ORDER BY finish_position", [s.id])).rows;
  const corrections = (
    await db.query(
      `SELECT rc.*, u.display_name AS author FROM result_corrections rc JOIN results r ON r.id=rc.result_id JOIN users u ON u.id=rc.created_by
       WHERE r.session_id=$1 ORDER BY rc.created_at`,
      [s.id],
    )
  ).rows;
  return { session: s, results, corrections };
}
