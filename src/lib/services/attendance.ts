// Présences par manche : intention (réponse), place attribuée, liste d'attente, pointage, constat au départ.
// Toutes les mutations verrouillent la ligne de la manche (SELECT … FOR UPDATE) : deux pilotes qui
// visent la dernière place sont traités l'un après l'autre, jamais en double.
import type { Db } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { audit, requirePermission, roundIn } from "./context.ts";
import { enqueue } from "./notifications.ts";

export type Response = "none" | "yes" | "no" | "maybe";
const responses: Response[] = ["none", "yes", "no", "maybe"];

async function logEvent(db: Db, roundId: string, userId: string, actorId: string | null, kind: string, detail: Record<string, unknown> = {}) {
  await db.query("INSERT INTO attendance_events(round_id, user_id, actor_id, kind, detail) VALUES($1,$2,$3,$4,$5)", [
    roundId,
    userId,
    actorId,
    kind,
    JSON.stringify(detail),
  ]);
}

export function roundWindows(round: { starts_at: Date | string; presence_deadline_hours: number; checkin_opens_minutes: number; checkin_closes_minutes: number }) {
  const start = new Date(round.starts_at).getTime();
  return {
    presenceDeadline: new Date(start - round.presence_deadline_hours * 3600000),
    checkinOpens: new Date(start - round.checkin_opens_minutes * 60000),
    checkinCloses: new Date(start - round.checkin_closes_minutes * 60000),
    start: new Date(start),
  };
}

async function registrationStatus(db: Db, championshipId: string, userId: string) {
  return (await db.query("SELECT status, reserve_rank FROM registrations WHERE championship_id=$1 AND user_id=$2", [championshipId, userId])).rows[0] as
    | { status: string; reserve_rank: number | null }
    | undefined;
}

/**
 * Recalcule les places d'une manche verrouillée. Idempotent.
 * 1. offres expirées → libérées ; 2. réponses ≠ présent → place libérée ;
 * 3. titulaires présents d'abord (ordre de réponse), puis réservistes (rang, ordre de réponse) ;
 * 4. titulaire → place confirmée ; réserviste → place proposée avec délai d'acceptation.
 */
export async function rebalance(db: Db, round: { id: string; championship_id: string; capacity: number | null; champ_capacity: number; offer_ttl_hours: number; starts_at: Date | string; community_id: string; name: string }, actorId: string | null) {
  const capacity = round.capacity ?? round.champ_capacity;
  const now = Date.now();
  const rows = (
    await db.query(
      `SELECT a.*, r.status AS reg_status, r.reserve_rank FROM attendances a
       JOIN registrations r ON r.user_id=a.user_id AND r.championship_id=$2
       WHERE a.round_id=$1`,
      [round.id, round.championship_id],
    )
  ).rows;
  for (const a of rows) {
    const eligible = a.reg_status === "accepted" || a.reg_status === "reserve";
    if (a.seat === "offered" && new Date(a.offer_expires_at).getTime() <= now) {
      // Offre non acceptée dans le délai : considérée comme déclinée, la place passe au suivant.
      a.seat = "released";
      a.response = "no";
      await db.query("UPDATE attendances SET seat='released', response='no', offer_expires_at=NULL, waitlist_position=NULL, updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, a.user_id]);
      await logEvent(db, round.id, a.user_id, null, "offer_expired");
    } else if ((a.response !== "yes" || !eligible) && ["confirmed", "offered", "waitlist"].includes(a.seat)) {
      const prev = a.seat;
      a.seat = prev === "waitlist" ? "none" : "released";
      await db.query("UPDATE attendances SET seat=$3, offer_expires_at=NULL, waitlist_position=NULL, updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, a.user_id, a.seat]);
      if (prev !== "waitlist") await logEvent(db, round.id, a.user_id, actorId, "seat_released", { previous: prev });
    }
  }
  let holders = rows.filter((a) => a.seat === "confirmed" || a.seat === "offered").length;
  const candidates = rows
    .filter(
      (a) =>
        a.response === "yes" &&
        a.start_status !== "no_show" &&
        (a.reg_status === "accepted" || a.reg_status === "reserve") &&
        !["confirmed", "offered"].includes(a.seat),
    )
    .sort((a, b) => {
      const pa = a.reg_status === "accepted" ? 0 : 1,
        pb = b.reg_status === "accepted" ? 0 : 1;
      return pa - pb || (a.reserve_rank ?? 0) - (b.reserve_rank ?? 0) || new Date(a.responded_at).getTime() - new Date(b.responded_at).getTime() || String(a.user_id).localeCompare(String(b.user_id));
    });
  const offers: string[] = [];
  let waitPos = 0;
  const startMs = new Date(round.starts_at).getTime();
  for (const c of candidates) {
    if (holders < capacity && startMs > now) {
      holders++;
      if (c.reg_status === "accepted") {
        await db.query("UPDATE attendances SET seat='confirmed', waitlist_position=NULL, offer_expires_at=NULL, updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, c.user_id]);
        await logEvent(db, round.id, c.user_id, actorId, "seat_confirmed");
      } else {
        const expires = new Date(Math.min(now + round.offer_ttl_hours * 3600000, startMs));
        await db.query("UPDATE attendances SET seat='offered', waitlist_position=NULL, offer_expires_at=$3, updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, c.user_id, expires]);
        await logEvent(db, round.id, c.user_id, actorId, "seat_offered", { expiresAt: expires.toISOString() });
        offers.push(c.user_id);
        await enqueue(db, round.community_id, "seat_offer", `offer:${round.id}:${c.user_id}:${expires.getTime()}`, {
          roundId: round.id,
          userId: c.user_id,
          expiresAt: expires.toISOString(),
        });
      }
    } else {
      waitPos++;
      if (c.seat !== "waitlist" || c.waitlist_position !== waitPos)
        await db.query("UPDATE attendances SET seat='waitlist', waitlist_position=$3, updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, c.user_id, waitPos]);
    }
  }
  return { offers, capacity, holders };
}

function assertOpenRound(round: { status: string }) {
  if (round.status === "cancelled") throw new AppError("Manche annulée.");
  if (round.status === "completed") throw new AppError("Manche terminée.");
}

/** Réponse du pilote pour une manche. */
export async function respond(db: Db, communityId: string, userId: string, roundId: string, response: unknown) {
  if (!responses.includes(response as Response) || response === "none") throw new AppError("Réponse invalide.");
  const round = await roundIn(db, communityId, roundId, true);
  assertOpenRound(round);
  const reg = await registrationStatus(db, round.championship_id, userId);
  if (!reg || !["accepted", "reserve"].includes(reg.status)) throw new AppError("Seuls les pilotes acceptés ou réservistes répondent aux présences.", 403);
  const w = roundWindows(round);
  const now = Date.now();
  if (now >= w.start.getTime()) throw new AppError("La manche a commencé : contactez un organisateur.");
  if (response !== "no" && now > w.presenceDeadline.getTime())
    throw new AppError("La date limite de réponse est dépassée. Vous pouvez encore vous déclarer absent pour libérer votre place.");
  const prev = (await db.query("SELECT response FROM attendances WHERE round_id=$1 AND user_id=$2", [round.id, userId])).rows[0];
  if (prev?.response === response) return rebalance(db, round, userId);
  await db.query(
    `INSERT INTO attendances(round_id, user_id, response, responded_at) VALUES($1,$2,$3,now())
     ON CONFLICT(round_id, user_id) DO UPDATE SET response=EXCLUDED.response, responded_at=now(), updated_at=now()`,
    [round.id, userId, response],
  );
  await logEvent(db, round.id, userId, userId, "response", { from: prev?.response ?? "none", to: response });
  return rebalance(db, round, userId);
}

/** Correction d'une réponse par un organisateur, avec motif tracé. */
export async function setResponseAsOrganizer(db: Db, communityId: string, actorId: string, roundId: string, userId: string, response: unknown, reason: unknown) {
  await requirePermission(db, communityId, actorId, "attendance.manage");
  if (!responses.includes(response as Response)) throw new AppError("Réponse invalide.");
  const why = String(reason ?? "").trim();
  if (why.length < 3) throw new AppError("Motif obligatoire pour corriger une présence.");
  const round = await roundIn(db, communityId, roundId, true);
  const reg = await registrationStatus(db, round.championship_id, userId);
  if (!reg) throw notFound("Inscription du pilote");
  const prev = (await db.query("SELECT response FROM attendances WHERE round_id=$1 AND user_id=$2", [round.id, userId])).rows[0];
  await db.query(
    `INSERT INTO attendances(round_id, user_id, response, responded_at) VALUES($1,$2,$3,now())
     ON CONFLICT(round_id, user_id) DO UPDATE SET response=EXCLUDED.response, responded_at=COALESCE(attendances.responded_at, now()), updated_at=now()`,
    [round.id, userId, response],
  );
  await logEvent(db, round.id, userId, actorId, "response_override", { from: prev?.response ?? "none", to: response, reason: why });
  await audit(db, communityId, actorId, "attendance.override", "round", round.id, { userId, to: response, reason: why });
  return rebalance(db, round, actorId);
}

export async function acceptOffer(db: Db, communityId: string, userId: string, roundId: string) {
  const round = await roundIn(db, communityId, roundId, true);
  assertOpenRound(round);
  await rebalance(db, round, userId); // fait expirer les offres échues avant de vérifier
  const a = (await db.query("SELECT seat, offer_expires_at FROM attendances WHERE round_id=$1 AND user_id=$2", [round.id, userId])).rows[0];
  if (a?.seat !== "offered") throw new AppError("Aucune place ne vous est proposée (offre expirée ou déjà attribuée).", 409);
  await db.query("UPDATE attendances SET seat='confirmed', offer_expires_at=NULL, updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, userId]);
  await logEvent(db, round.id, userId, userId, "offer_accepted");
}

export async function declineOffer(db: Db, communityId: string, userId: string, roundId: string) {
  const round = await roundIn(db, communityId, roundId, true);
  const a = (await db.query("SELECT seat FROM attendances WHERE round_id=$1 AND user_id=$2", [round.id, userId])).rows[0];
  if (a?.seat !== "offered") throw new AppError("Aucune place proposée.", 409);
  await db.query("UPDATE attendances SET response='no', responded_at=now(), updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, userId]);
  await logEvent(db, round.id, userId, userId, "offer_declined");
  return rebalance(db, round, userId);
}

export async function checkIn(db: Db, communityId: string, userId: string, roundId: string) {
  const round = await roundIn(db, communityId, roundId, true);
  assertOpenRound(round);
  const w = roundWindows(round);
  const now = Date.now();
  if (now < w.checkinOpens.getTime()) throw new AppError("Le pointage n’est pas encore ouvert.");
  if (now > w.checkinCloses.getTime()) throw new AppError("Le pointage est fermé.");
  const r = await db.query(
    "UPDATE attendances SET checked_in_at=now(), updated_at=now() WHERE round_id=$1 AND user_id=$2 AND seat='confirmed' AND checked_in_at IS NULL RETURNING user_id",
    [round.id, userId],
  );
  if (!r.rowCount) {
    const a = (await db.query("SELECT seat, checked_in_at FROM attendances WHERE round_id=$1 AND user_id=$2", [round.id, userId])).rows[0];
    if (a?.checked_in_at) return;
    throw new AppError("Seuls les pilotes avec une place confirmée peuvent pointer.", 403);
  }
  await logEvent(db, round.id, userId, userId, "checked_in");
}

/** Retrait d'un participant par l'organisateur : sa place passe au réserviste suivant. */
export async function withdrawParticipant(db: Db, communityId: string, actorId: string, roundId: string, userId: string, reason: unknown) {
  return setResponseAsOrganizer(db, communityId, actorId, roundId, userId, "no", reason);
}

/**
 * Après la fermeture du pointage : les places confirmées non pointées sont libérées
 * (absent au départ) et proposées à la liste d'attente. Aucune sanction n'est appliquée ici.
 */
export async function releaseUncheckedSeats(db: Db, communityId: string, actorId: string, roundId: string) {
  await requirePermission(db, communityId, actorId, "attendance.manage");
  const round = await roundIn(db, communityId, roundId, true);
  const w = roundWindows(round);
  if (Date.now() < w.checkinCloses.getTime()) throw new AppError("Le pointage n’est pas encore fermé.");
  const unchecked = (
    await db.query("SELECT user_id FROM attendances WHERE round_id=$1 AND seat='confirmed' AND checked_in_at IS NULL", [round.id])
  ).rows.map((r) => r.user_id as string);
  for (const u of unchecked) {
    await db.query("UPDATE attendances SET seat='released', start_status='no_show', updated_at=now() WHERE round_id=$1 AND user_id=$2", [round.id, u]);
    await logEvent(db, round.id, u, actorId, "no_show_checkin");
  }
  await audit(db, communityId, actorId, "attendance.release_unchecked", "round", round.id, { count: unchecked.length });
  // Les places libérées vont aux pilotes en liste d'attente (offre jusqu'au départ).
  const out = await rebalance(db, round, actorId);
  return { released: unchecked, ...out };
}

/** Libère les places futures d'un pilote (retrait ou refus d'inscription). */
export async function releaseFutureSeats(db: Db, communityId: string, actorId: string, championshipId: string, userId: string, kind: string) {
  const rounds = (
    await db.query(
      `SELECT r.id FROM rounds r JOIN attendances a ON a.round_id=r.id AND a.user_id=$2
       WHERE r.championship_id=$1 AND r.starts_at > now() AND r.status IN ('scheduled','postponed','draft')`,
      [championshipId, userId],
    )
  ).rows;
  for (const { id } of rounds) {
    const round = await roundIn(db, communityId, id, true);
    await db.query("UPDATE attendances SET response='no', updated_at=now() WHERE round_id=$1 AND user_id=$2", [id, userId]);
    await logEvent(db, id, userId, actorId, kind);
    await rebalance(db, round, actorId);
  }
}

/** Constat de participation réelle à partir des résultats définitifs. */
export async function markStartsFromResults(db: Db, roundId: string, sessionId: string) {
  await db.query(
    `UPDATE attendances a SET start_status = CASE WHEN EXISTS (
        SELECT 1 FROM results r WHERE r.session_id=$2 AND r.user_id=a.user_id AND r.status <> 'dns') THEN 'started' ELSE 'no_show' END,
       updated_at=now()
     WHERE a.round_id=$1 AND (a.seat='confirmed' OR a.start_status='no_show')`,
    [roundId, sessionId],
  );
}

export async function roundAttendance(db: Db, communityId: string, roundId: string) {
  const round = await roundIn(db, communityId, roundId);
  const rows = (
    await db.query(
      `SELECT r.user_id AS "userId", u.display_name AS "displayName", r.status AS "registration", r.reserve_rank AS "reserveRank",
              t.name AS "teamName", t.id AS "teamId", r.race_number AS "raceNumber",
              COALESCE(a.response,'none') AS response, a.responded_at AS "respondedAt", COALESCE(a.seat,'none') AS seat,
              a.waitlist_position AS "waitlistPosition", a.offer_expires_at AS "offerExpiresAt", a.checked_in_at AS "checkedInAt",
              a.start_status AS "startStatus"
       FROM registrations r JOIN users u ON u.id=r.user_id LEFT JOIN teams t ON t.id=r.team_id
       LEFT JOIN attendances a ON a.round_id=$1 AND a.user_id=r.user_id
       WHERE r.championship_id=$2 AND (r.status IN ('accepted','reserve') OR a.user_id IS NOT NULL)
       ORDER BY CASE COALESCE(a.seat,'none') WHEN 'confirmed' THEN 0 WHEN 'offered' THEN 1 WHEN 'waitlist' THEN 2 ELSE 3 END,
                a.waitlist_position NULLS LAST, r.status, u.display_name`,
      [round.id, round.championship_id],
    )
  ).rows;
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return {
    round,
    windows: roundWindows(round),
    capacity: round.capacity ?? round.champ_capacity,
    rows,
    totals: {
      yes: count((r) => r.response === "yes"),
      no: count((r) => r.response === "no"),
      maybe: count((r) => r.response === "maybe"),
      none: count((r) => r.response === "none" && ["accepted", "reserve"].includes(r.registration)),
      confirmed: count((r) => r.seat === "confirmed"),
      offered: count((r) => r.seat === "offered"),
      waitlist: count((r) => r.seat === "waitlist"),
      checkedIn: count((r) => !!r.checkedInAt),
    },
  };
}

export async function attendanceHistory(db: Db, communityId: string, roundId: string) {
  const round = await roundIn(db, communityId, roundId);
  return (
    await db.query(
      `SELECT e.kind, e.detail, e.created_at AS "createdAt", u.display_name AS "displayName", a.display_name AS "actorName"
       FROM attendance_events e JOIN users u ON u.id=e.user_id LEFT JOIN users a ON a.id=e.actor_id
       WHERE e.round_id=$1 ORDER BY e.created_at DESC, e.id DESC LIMIT 200`,
      [round.id],
    )
  ).rows;
}
