// Réclamations et décisions des commissaires. Une décision peut créer une pénalité motivée ;
// les pénalités ne modifient jamais le résultat importé : le moteur les applique au calcul.
import type { Db } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { assertUuid, audit, requirePermission, roleOf, sessionIn } from "./context.ts";

export function protestDeadline(session: { starts_at: Date | string; duration_minutes: number; protest_window_hours: number }) {
  return new Date(new Date(session.starts_at).getTime() + session.duration_minutes * 60000 + session.protest_window_hours * 3600000);
}

export async function fileProtest(
  db: Db,
  communityId: string,
  userId: string,
  sessionId: string,
  input: { againstUserId: unknown; lap: unknown; description: unknown; videoUrl: unknown },
) {
  if (!(await roleOf(db, communityId, userId))) throw new AppError("Réservé aux membres de la ligue.", 403);
  const s = await sessionIn(db, communityId, sessionId);
  const reg = (await db.query("SELECT status FROM registrations WHERE championship_id=$1 AND user_id=$2", [s.championship_id, userId])).rows[0];
  if (!reg || !["accepted", "reserve"].includes(reg.status)) throw new AppError("Seuls les pilotes inscrits peuvent déposer une réclamation.", 403);
  const deadline = protestDeadline(s);
  const now = Date.now();
  if (now < new Date(s.starts_at).getTime()) throw new AppError("La session n’a pas encore eu lieu.");
  if (now > deadline.getTime()) throw new AppError("Le délai de réclamation est dépassé.");
  const description = String(input.description ?? "").trim();
  if (description.length < 10) throw new AppError("Décrivez l’incident (10 caractères minimum).");
  if (description.length > 4000) throw new AppError("Description trop longue (4000 caractères maximum).");
  const video = String(input.videoUrl ?? "").trim();
  if (video && !/^https:\/\/[^\s"'<>]+$/.test(video)) throw new AppError("Lien vidéo : adresse https:// attendue.");
  const lapRaw = String(input.lap ?? "").trim();
  if (lapRaw && !/^\d{1,4}$/.test(lapRaw)) throw new AppError("Tour : nombre entier.");
  let against: string | null = null;
  if (input.againstUserId) {
    assertUuid(String(input.againstUserId), "Pilote");
    if (input.againstUserId === userId) throw new AppError("Vous ne pouvez pas déposer une réclamation contre vous-même.");
    const ok = (await db.query("SELECT 1 FROM registrations WHERE championship_id=$1 AND user_id=$2", [s.championship_id, input.againstUserId])).rowCount;
    if (!ok) throw notFound("Pilote visé");
    against = String(input.againstUserId);
  }
  const open = (await db.query("SELECT count(*)::int n FROM protests WHERE session_id=$1 AND filed_by=$2 AND status IN ('submitted','under_review')", [s.id, userId])).rows[0].n;
  if (open >= 5) throw new AppError("Trop de réclamations ouvertes pour cette session.", 429);
  const row = (
    await db.query(
      "INSERT INTO protests(session_id, filed_by, against_user_id, lap, description, video_url, deadline) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [s.id, userId, against, lapRaw ? Number(lapRaw) : null, description, video || null, deadline],
    )
  ).rows[0];
  await audit(db, communityId, userId, "protest.file", "protest", row.id, { sessionId: s.id });
  return row.id as string;
}

export async function withdrawProtest(db: Db, communityId: string, userId: string, protestId: string) {
  assertUuid(protestId, "Réclamation");
  const r = await db.query(
    `UPDATE protests p SET status='withdrawn' FROM round_sessions s, rounds r, championships c
     WHERE p.id=$1 AND p.filed_by=$3 AND p.status='submitted' AND s.id=p.session_id AND r.id=s.round_id AND c.id=r.championship_id AND c.community_id=$2 RETURNING p.id`,
    [protestId, communityId, userId],
  );
  if (!r.rowCount) throw notFound("Réclamation modifiable");
  await audit(db, communityId, userId, "protest.withdraw", "protest", protestId);
}

async function protestIn(db: Db, communityId: string, protestId: string, lock = false) {
  assertUuid(protestId, "Réclamation");
  const p = (
    await db.query(
      `SELECT p.*, s.round_id, r.championship_id FROM protests p JOIN round_sessions s ON s.id=p.session_id JOIN rounds r ON r.id=s.round_id
       JOIN championships c ON c.id=r.championship_id WHERE p.id=$1 AND c.community_id=$2 ${lock ? "FOR UPDATE OF p" : ""}`,
      [protestId, communityId],
    )
  ).rows[0];
  if (!p) throw notFound("Réclamation");
  return p;
}

export async function startReview(db: Db, communityId: string, actorId: string, protestId: string) {
  await requirePermission(db, communityId, actorId, "protests.decide");
  const p = await protestIn(db, communityId, protestId, true);
  if (p.status !== "submitted") throw new AppError("Réclamation déjà prise en charge.");
  await db.query("UPDATE protests SET status='under_review' WHERE id=$1", [p.id]);
  await audit(db, communityId, actorId, "protest.review", "protest", p.id);
}

export interface PenaltyInput {
  userId: unknown;
  kind: unknown;
  value: unknown;
  scope: unknown;
  reason: unknown;
}
function validatePenalty(input: PenaltyInput) {
  const kind = String(input.kind);
  if (!["time", "positions", "points", "dsq", "warning"].includes(kind)) throw new AppError("Type de pénalité inconnu.");
  const value = kind === "dsq" || kind === "warning" ? 0 : Number(input.value);
  if (!Number.isInteger(value) || value < 0 || value > 3600) throw new AppError("Valeur de pénalité : entier positif (secondes, places ou points).");
  if (["time", "positions", "points"].includes(kind) && value === 0) throw new AppError("Valeur de pénalité obligatoire.");
  const scope = String(input.scope ?? "session");
  if (!["session", "championship"].includes(scope)) throw new AppError("Portée inconnue.");
  if (scope === "championship" && kind !== "points") throw new AppError("Seules les pénalités en points peuvent porter sur le championnat.");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) throw new AppError("Motif obligatoire.");
  return { kind, value, scope, reason };
}

export async function applyPenalty(db: Db, communityId: string, actorId: string, sessionId: string, input: PenaltyInput, protestId: string | null = null) {
  await requirePermission(db, communityId, actorId, "protests.decide");
  const s = await sessionIn(db, communityId, sessionId);
  assertUuid(String(input.userId ?? ""), "Pilote");
  const ok = (await db.query("SELECT 1 FROM registrations WHERE championship_id=$1 AND user_id=$2", [s.championship_id, input.userId])).rowCount;
  if (!ok) throw notFound("Pilote");
  const p = validatePenalty(input);
  const row = (
    await db.query(
      "INSERT INTO penalties(session_id, user_id, kind, value, scope, reason, protest_id, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [s.id, input.userId, p.kind, p.value, p.scope, p.reason, protestId, actorId],
    )
  ).rows[0];
  await audit(db, communityId, actorId, "penalty.apply", "penalty", row.id, { sessionId: s.id, userId: input.userId, ...p, protestId });
  return row.id as string;
}

export async function revokePenalty(db: Db, communityId: string, actorId: string, penaltyId: string, reason: unknown) {
  await requirePermission(db, communityId, actorId, "protests.decide");
  assertUuid(penaltyId, "Pénalité");
  const why = String(reason ?? "").trim();
  if (why.length < 3) throw new AppError("Motif obligatoire.");
  const r = await db.query(
    `UPDATE penalties p SET revoked_at=now(), revoked_by=$3 FROM round_sessions s, rounds r, championships c
     WHERE p.id=$1 AND p.revoked_at IS NULL AND s.id=p.session_id AND r.id=s.round_id AND c.id=r.championship_id AND c.community_id=$2 RETURNING p.id`,
    [penaltyId, communityId, actorId],
  );
  if (!r.rowCount) throw notFound("Pénalité active");
  await audit(db, communityId, actorId, "penalty.revoke", "penalty", penaltyId, { reason: why });
}

/** Décision motivée ; avec une pénalité éventuelle (pilote visé par défaut). */
export async function decideProtest(
  db: Db,
  communityId: string,
  actorId: string,
  protestId: string,
  input: { outcome: unknown; decision: unknown; penalty?: PenaltyInput | null },
) {
  await requirePermission(db, communityId, actorId, "protests.decide");
  const p = await protestIn(db, communityId, protestId, true);
  if (!["submitted", "under_review"].includes(p.status)) throw new AppError("Réclamation déjà clôturée.");
  if (p.filed_by === actorId || p.against_user_id === actorId) throw new AppError("Conflit d’intérêts : un autre commissaire doit décider.", 403);
  const outcome = String(input.outcome);
  if (!["decided", "dismissed"].includes(outcome)) throw new AppError("Issue inconnue.");
  const decision = String(input.decision ?? "").trim();
  if (decision.length < 10) throw new AppError("Motivez la décision (10 caractères minimum).");
  let penaltyId: string | null = null;
  if (outcome === "decided" && input.penalty) penaltyId = await applyPenalty(db, communityId, actorId, p.session_id, input.penalty, p.id);
  await db.query("UPDATE protests SET status=$2, decision=$3, decided_by=$4, decided_at=now() WHERE id=$1", [p.id, outcome, decision, actorId]);
  await audit(db, communityId, actorId, `protest.${outcome}`, "protest", p.id, { penaltyId });
  return penaltyId;
}

export async function listProtests(db: Db, communityId: string, actorId: string, filter: { userId?: string } = {}) {
  const role = await roleOf(db, communityId, actorId);
  const all = filter.userId == null;
  if (all) await requirePermission(db, communityId, actorId, "protests.view");
  else if (filter.userId !== actorId || !role) throw new AppError("Action non autorisée.", 403);
  return (
    await db.query(
      `SELECT p.id, p.status, p.description, p.video_url AS "videoUrl", p.lap, p.deadline, p.decision, p.created_at AS "createdAt", p.decided_at AS "decidedAt",
              p.session_id AS "sessionId", s.label AS "sessionLabel", r.number AS "roundNumber", r.name AS "roundName", c.name AS "championshipName",
              f.display_name AS "filedBy", p.filed_by AS "filedById", a.display_name AS "against", p.against_user_id AS "againstId", d.display_name AS "decidedBy"
       FROM protests p JOIN round_sessions s ON s.id=p.session_id JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id
       JOIN users f ON f.id=p.filed_by LEFT JOIN users a ON a.id=p.against_user_id LEFT JOIN users d ON d.id=p.decided_by
       WHERE c.community_id=$1 AND ($2::uuid IS NULL OR p.filed_by=$2)
       ORDER BY CASE p.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END, p.created_at DESC`,
      [communityId, filter.userId ?? null],
    )
  ).rows;
}

export async function sessionPenalties(db: Db, communityId: string, sessionId: string) {
  const s = await sessionIn(db, communityId, sessionId);
  return (
    await db.query(
      `SELECT p.*, u.display_name AS "displayName", a.display_name AS author FROM penalties p JOIN users u ON u.id=p.user_id JOIN users a ON a.id=p.created_by
       WHERE p.session_id=$1 ORDER BY p.created_at`,
      [s.id],
    )
  ).rows;
}
