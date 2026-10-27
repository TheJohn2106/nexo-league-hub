import { z } from "zod";
import type { Db } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { defaultScoring, type ScoringConfig } from "../scoring/types.ts";
import { audit, championshipIn, requirePermission, roundIn, sessionIn, uniqueViolation } from "./context.ts";

const tiebreaks = ["wins", "countback", "lastRound", "fewestIncidents"] as const;
export const scoringSchema = z.object({
  pointsByPosition: z.array(z.number().min(0).max(1000)).min(1).max(100),
  positionBasis: z.enum(["overall", "class"]),
  participationPoints: z.number().min(0).max(100),
  pole: z.object({ points: z.number().min(0).max(100), requiresStart: z.boolean() }),
  fastestLap: z.object({ points: z.number().min(0).max(100), requiresClassified: z.boolean(), maxPosition: z.number().int().min(1).max(200).nullable() }),
  dnf: z.object({ mode: z.enum(["position", "zero"]), minLapsPercent: z.number().min(0).max(100) }),
  dropWorst: z.number().int().min(0).max(20),
  absencePenaltyPoints: z.number().min(0).max(100).nullable(),
  tiebreak: z.array(z.enum(tiebreaks)).max(4),
  teams: z.object({ countBest: z.number().int().min(1).max(10) }),
});

const list = (v: unknown) =>
  String(v ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);

export interface ChampionshipInput {
  name: unknown;
  slug: unknown;
  description: unknown;
  rulesMd: unknown;
  capacity: unknown;
  registrationDeadline: Date | null;
  categories: unknown;
  cars: unknown;
  requireCategory: unknown;
  requireCar: unknown;
  requireTeam: unknown;
  numberPolicy: unknown;
  presenceDeadlineHours: unknown;
  checkinOpensMinutes: unknown;
  checkinClosesMinutes: unknown;
  offerTtlHours: unknown;
  protestWindowHours: unknown;
  serverInfo: unknown;
  scoring: ScoringConfig;
}

function normalize(input: ChampionshipInput) {
  const name = String(input.name ?? "").trim();
  if (name.length < 3 || name.length > 100) throw new AppError("Nom du championnat : 3 à 100 caractères.");
  const slug = String(input.slug ?? "").trim().toLowerCase() || name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new AppError("Identifiant d’URL invalide.");
  const int = (v: unknown, min: number, max: number, label: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${label} : valeur entre ${min} et ${max}.`);
    return n;
  };
  const scoring = scoringSchema.safeParse(input.scoring);
  if (!scoring.success) throw new AppError(`Barème invalide : ${scoring.error.issues[0]?.path.join(".")} ${scoring.error.issues[0]?.message}`);
  const opens = int(input.checkinOpensMinutes, 0, 1440, "Ouverture du pointage");
  const closes = int(input.checkinClosesMinutes, 0, 1440, "Fermeture du pointage");
  if (closes >= opens) throw new AppError("Le pointage doit ouvrir avant de fermer (minutes avant le départ).");
  const policy = String(input.numberPolicy ?? "unique");
  if (!["unique", "free", "none"].includes(policy)) throw new AppError("Règle des numéros inconnue.");
  return {
    name,
    slug,
    description: String(input.description ?? "").slice(0, 4000),
    rulesMd: String(input.rulesMd ?? "").slice(0, 50000),
    capacity: int(input.capacity, 1, 200, "Capacité"),
    registrationDeadline: input.registrationDeadline,
    categories: list(input.categories),
    cars: list(input.cars),
    requireCategory: input.requireCategory === true || input.requireCategory === "on",
    requireCar: input.requireCar === true || input.requireCar === "on",
    requireTeam: input.requireTeam === true || input.requireTeam === "on",
    numberPolicy: policy,
    presenceDeadlineHours: int(input.presenceDeadlineHours, 0, 720, "Date limite de présence"),
    checkinOpens: opens,
    checkinCloses: closes,
    offerTtlHours: int(input.offerTtlHours, 1, 168, "Délai d’acceptation d’une place"),
    protestWindowHours: int(input.protestWindowHours, 1, 336, "Délai de réclamation"),
    serverInfo: String(input.serverInfo ?? "").slice(0, 2000),
    scoring: scoring.data,
  };
}

export async function createChampionship(db: Db, communityId: string, actorId: string, input: ChampionshipInput) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const d = normalize(input);
  try {
    const row = (
      await db.query(
        `INSERT INTO championships(community_id, slug, name, description, rules_md, capacity, registration_deadline, categories, cars,
           require_category, require_car, require_team, number_policy, presence_deadline_hours, checkin_opens_minutes, checkin_closes_minutes,
           offer_ttl_hours, protest_window_hours, server_info, scoring)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [
          communityId, d.slug, d.name, d.description, d.rulesMd, d.capacity, d.registrationDeadline, JSON.stringify(d.categories),
          JSON.stringify(d.cars), d.requireCategory, d.requireCar, d.requireTeam, d.numberPolicy, d.presenceDeadlineHours, d.checkinOpens,
          d.checkinCloses, d.offerTtlHours, d.protestWindowHours, d.serverInfo, JSON.stringify(d.scoring),
        ],
      )
    ).rows[0];
    await audit(db, communityId, actorId, "championship.create", "championship", row.id, { name: d.name });
    return row.id as string;
  } catch (e) {
    uniqueViolation(e, "Un championnat utilise déjà cet identifiant d’URL.");
  }
}

export async function updateChampionship(db: Db, communityId: string, actorId: string, id: string, input: ChampionshipInput, newRulesVersion: boolean) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const before = await championshipIn(db, communityId, id, true);
  const d = normalize(input);
  const rulesChanged = before.rules_md !== d.rulesMd;
  const version = before.rules_version + (rulesChanged && newRulesVersion ? 1 : 0);
  try {
    await db.query(
      `UPDATE championships SET slug=$2, name=$3, description=$4, rules_md=$5, rules_version=$6, capacity=$7, registration_deadline=$8,
         categories=$9, cars=$10, require_category=$11, require_car=$12, require_team=$13, number_policy=$14, presence_deadline_hours=$15,
         checkin_opens_minutes=$16, checkin_closes_minutes=$17, offer_ttl_hours=$18, protest_window_hours=$19, server_info=$20, scoring=$21
       WHERE id=$1`,
      [
        id, d.slug, d.name, d.description, d.rulesMd, version, d.capacity, d.registrationDeadline, JSON.stringify(d.categories),
        JSON.stringify(d.cars), d.requireCategory, d.requireCar, d.requireTeam, d.numberPolicy, d.presenceDeadlineHours, d.checkinOpens,
        d.checkinCloses, d.offerTtlHours, d.protestWindowHours, d.serverInfo, JSON.stringify(d.scoring),
      ],
    );
  } catch (e) {
    uniqueViolation(e, "Un championnat utilise déjà cet identifiant d’URL.");
  }
  await audit(db, communityId, actorId, "championship.update", "championship", id, {
    rulesVersion: version,
    scoringChanged: JSON.stringify(before.scoring) !== JSON.stringify(d.scoring),
  });
}

const championshipTransitions: Record<string, string[]> = {
  draft: ["open", "cancelled"],
  open: ["closed", "cancelled", "draft"],
  closed: ["open", "finished", "cancelled"],
  finished: ["closed"],
  cancelled: ["draft"],
};
export async function setChampionshipStatus(db: Db, communityId: string, actorId: string, id: string, status: string) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const c = await championshipIn(db, communityId, id, true);
  if (!championshipTransitions[c.status]?.includes(status)) throw new AppError(`Passage de « ${c.status} » à « ${status} » non autorisé.`);
  await db.query("UPDATE championships SET status=$2 WHERE id=$1", [id, status]);
  await audit(db, communityId, actorId, "championship.status", "championship", id, { from: c.status, to: status });
}

export interface SessionPlan {
  kind: "practice" | "qualifying" | "race";
  label: string;
  offsetMinutes: number; // décalage par rapport au départ de la manche
  durationMinutes: number;
  coefficient?: number;
}
export const defaultSessionPlan: SessionPlan[] = [
  { kind: "practice", label: "Essais libres", offsetMinutes: -45, durationMinutes: 20 },
  { kind: "qualifying", label: "Qualifications", offsetMinutes: -20, durationMinutes: 15 },
  { kind: "race", label: "Course", offsetMinutes: 0, durationMinutes: 45 },
];

export async function createRound(
  db: Db,
  communityId: string,
  actorId: string,
  championshipId: string,
  input: { name: unknown; track: unknown; trackConfig: unknown; startsAt: Date; capacity: unknown; serverInfo: unknown; notes: unknown; jokerEligible: unknown; plan?: SessionPlan[] },
) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const c = await championshipIn(db, communityId, championshipId, true);
  const name = String(input.name ?? "").trim();
  const track = String(input.track ?? "").trim();
  if (!name || !track) throw new AppError("Nom et circuit obligatoires.");
  const cap = String(input.capacity ?? "").trim();
  if (cap && !/^\d+$/.test(cap)) throw new AppError("Capacité : nombre entier.");
  if (Number.isNaN(input.startsAt.getTime())) throw new AppError("Date de départ invalide.");
  const number = (await db.query("SELECT COALESCE(max(number),0)+1 AS n FROM rounds WHERE championship_id=$1", [c.id])).rows[0].n;
  const round = (
    await db.query(
      `INSERT INTO rounds(championship_id, number, name, track, track_config, starts_at, original_starts_at, capacity, server_info, notes, is_joker_eligible)
       VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10) RETURNING id`,
      [c.id, number, name, track, String(input.trackConfig ?? "").trim(), input.startsAt, cap ? Number(cap) : null, String(input.serverInfo ?? ""), String(input.notes ?? ""), input.jokerEligible !== false && input.jokerEligible !== "off"],
    )
  ).rows[0];
  const plan = input.plan ?? defaultSessionPlan;
  const ordinals: Record<string, number> = {};
  for (const s of plan) {
    ordinals[s.kind] = (ordinals[s.kind] ?? 0) + 1;
    await db.query(
      `INSERT INTO round_sessions(round_id, kind, label, ordinal, starts_at, duration_minutes, coefficient, awards_points, awards_pole)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        round.id, s.kind, s.label, ordinals[s.kind], new Date(input.startsAt.getTime() + s.offsetMinutes * 60000), s.durationMinutes,
        s.coefficient ?? 1, s.kind === "race", s.kind === "qualifying" && ordinals[s.kind] === 1,
      ],
    );
  }
  await audit(db, communityId, actorId, "round.create", "round", round.id, { number, name });
  return round.id as string;
}

export async function updateRound(
  db: Db,
  communityId: string,
  actorId: string,
  roundId: string,
  input: { name: unknown; track: unknown; trackConfig: unknown; capacity: unknown; serverInfo: unknown; notes: unknown; jokerEligible: unknown },
) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const r = await roundIn(db, communityId, roundId, true);
  const cap = String(input.capacity ?? "").trim();
  if (cap && !/^\d+$/.test(cap)) throw new AppError("Capacité : nombre entier.");
  await db.query(
    "UPDATE rounds SET name=$2, track=$3, track_config=$4, capacity=$5, server_info=$6, notes=$7, is_joker_eligible=$8 WHERE id=$1",
    [r.id, String(input.name ?? r.name).trim() || r.name, String(input.track ?? r.track).trim() || r.track, String(input.trackConfig ?? ""), cap ? Number(cap) : null, String(input.serverInfo ?? ""), String(input.notes ?? ""), input.jokerEligible === "on" || input.jokerEligible === true],
  );
  await audit(db, communityId, actorId, "round.update", "round", r.id);
}

/** Report : l'heure d'origine est conservée, les sessions sont décalées d'autant, les réponses restent valables. */
export async function postponeRound(db: Db, communityId: string, actorId: string, roundId: string, newStart: Date, reason: unknown) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const r = await roundIn(db, communityId, roundId, true);
  if (r.status === "cancelled" || r.status === "completed") throw new AppError("Manche annulée ou terminée : report impossible.");
  if (Number.isNaN(newStart.getTime())) throw new AppError("Nouvelle date invalide.");
  const why = String(reason ?? "").trim();
  if (why.length < 3) throw new AppError("Motif du report obligatoire.");
  const delta = newStart.getTime() - new Date(r.starts_at).getTime();
  await db.query("UPDATE rounds SET starts_at=$2, status='postponed' WHERE id=$1", [r.id, newStart]);
  await db.query("UPDATE round_sessions SET starts_at = starts_at + make_interval(secs => $2) WHERE round_id=$1", [r.id, delta / 1000]);
  await audit(db, communityId, actorId, "round.postpone", "round", r.id, { from: r.starts_at, to: newStart.toISOString(), reason: why });
}

export async function setRoundStatus(db: Db, communityId: string, actorId: string, roundId: string, status: "scheduled" | "cancelled" | "completed" | "draft", reason: unknown) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const r = await roundIn(db, communityId, roundId, true);
  const why = String(reason ?? "").trim();
  if (status === "cancelled" && why.length < 3) throw new AppError("Motif d’annulation obligatoire.");
  await db.query("UPDATE rounds SET status=$2 WHERE id=$1", [r.id, status]);
  await audit(db, communityId, actorId, `round.${status}`, "round", r.id, { from: r.status, reason: why });
}

export async function upsertSession(
  db: Db,
  communityId: string,
  actorId: string,
  roundId: string,
  sessionId: string | null,
  input: { kind: unknown; label: unknown; startsAt: Date; durationMinutes: unknown; coefficient: unknown; awardsPoints: unknown; awardsPole: unknown },
) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const r = await roundIn(db, communityId, roundId, true);
  const kind = String(input.kind);
  if (!["practice", "qualifying", "race"].includes(kind)) throw new AppError("Type de session inconnu.");
  const duration = Number(input.durationMinutes);
  const coef = Number(String(input.coefficient ?? "1").replace(",", "."));
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) throw new AppError("Durée : 1 à 1440 minutes.");
  if (!(coef >= 0 && coef <= 10)) throw new AppError("Coefficient : entre 0 et 10.");
  const label = String(input.label ?? "").trim() || kind;
  const awardsPoints = kind === "race" && (input.awardsPoints === "on" || input.awardsPoints === true);
  const awardsPole = kind === "qualifying" && (input.awardsPole === "on" || input.awardsPole === true);
  if (sessionId) {
    const s = await sessionIn(db, communityId, sessionId);
    if (s.round_id !== r.id) throw notFound("Session");
    await db.query(
      "UPDATE round_sessions SET label=$2, starts_at=$3, duration_minutes=$4, coefficient=$5, awards_points=$6, awards_pole=$7 WHERE id=$1",
      [s.id, label, input.startsAt, duration, coef, awardsPoints, awardsPole],
    );
    await audit(db, communityId, actorId, "session.update", "session", s.id);
    return s.id as string;
  }
  const ordinal = (await db.query("SELECT COALESCE(max(ordinal),0)+1 AS n FROM round_sessions WHERE round_id=$1 AND kind=$2", [r.id, kind])).rows[0].n;
  const row = (
    await db.query(
      `INSERT INTO round_sessions(round_id, kind, label, ordinal, starts_at, duration_minutes, coefficient, awards_points, awards_pole)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [r.id, kind, label, ordinal, input.startsAt, duration, coef, awardsPoints, awardsPole],
    )
  ).rows[0];
  await audit(db, communityId, actorId, "session.create", "session", row.id);
  return row.id as string;
}

export async function deleteSession(db: Db, communityId: string, actorId: string, sessionId: string) {
  await requirePermission(db, communityId, actorId, "championship.manage");
  const s = await sessionIn(db, communityId, sessionId, true);
  const used = (await db.query("SELECT 1 FROM result_imports WHERE session_id=$1 LIMIT 1", [s.id])).rowCount;
  if (used) throw new AppError("Session avec des imports de résultats : suppression refusée pour conserver l’historique.");
  await db.query("DELETE FROM round_sessions WHERE id=$1", [s.id]);
  await audit(db, communityId, actorId, "session.delete", "session", s.id, { label: s.label });
}

/** Association explicite manche/session ↔ sous-session iRacing. */
export async function linkIracingSession(db: Db, communityId: string, actorId: string, sessionId: string, subsessionRaw: unknown, simsessionRaw: unknown) {
  await requirePermission(db, communityId, actorId, "results.manage");
  const s = await sessionIn(db, communityId, sessionId, true);
  const sub = String(subsessionRaw ?? "").trim();
  const sim = String(simsessionRaw ?? "").trim();
  if (sub && !/^\d{1,12}$/.test(sub)) throw new AppError("Identifiant de sous-session iRacing : nombre (visible dans l’URL du résultat iRacing).");
  if (sim && !/^-?\d{1,2}$/.test(sim)) throw new AppError("Numéro de simsession : entier (0 = course principale, -1, -2… sessions précédentes).");
  try {
    await db.query("UPDATE round_sessions SET iracing_subsession_id=$2, iracing_simsession_number=$3 WHERE id=$1", [s.id, sub ? Number(sub) : null, sim ? Number(sim) : null]);
  } catch (e) {
    uniqueViolation(e, "Cette sous-session iRacing est déjà associée à une autre session.");
  }
  await audit(db, communityId, actorId, "session.link_iracing", "session", s.id, { subsession: sub || null, simsession: sim || null });
}

export function parseScoringForm(form: FormData): ScoringConfig {
  const n = (k: string, d: number) => {
    const v = String(form.get(k) ?? "").trim().replace(",", ".");
    return v === "" ? d : Number(v);
  };
  const points = String(form.get("pointsByPosition") ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  const tb = String(form.get("tiebreak") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxPos = String(form.get("fastestLapMaxPosition") ?? "").trim();
  const absence = String(form.get("absencePenaltyPoints") ?? "").trim();
  return {
    pointsByPosition: points.length ? points : defaultScoring.pointsByPosition,
    positionBasis: form.get("positionBasis") === "class" ? "class" : "overall",
    participationPoints: n("participationPoints", 0),
    pole: { points: n("polePoints", 0), requiresStart: form.get("poleRequiresStart") === "on" },
    fastestLap: { points: n("fastestLapPoints", 0), requiresClassified: form.get("fastestLapRequiresClassified") === "on", maxPosition: maxPos ? Number(maxPos) : null },
    dnf: { mode: form.get("dnfMode") === "zero" ? "zero" : "position", minLapsPercent: n("dnfMinLapsPercent", 75) },
    dropWorst: n("dropWorst", 0),
    absencePenaltyPoints: form.get("absenceRule") === "on" && absence ? Number(absence) : null,
    tiebreak: (tb.length ? tb : defaultScoring.tiebreak) as ScoringConfig["tiebreak"],
    teams: { countBest: n("teamCountBest", 2) },
  };
}
