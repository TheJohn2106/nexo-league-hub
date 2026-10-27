import type { Db } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { assertUuid, audit, championshipIn, requirePermission, roleOf } from "./context.ts";
import { releaseFutureSeats } from "./attendance.ts";

export interface RegistrationInput {
  category: unknown;
  car: unknown;
  teamId: unknown;
  newTeamName: unknown;
  raceNumber: unknown;
  acceptedRulesVersion: unknown;
  note: unknown;
}

const active = ["pending", "accepted", "reserve"];

/** Inscription d'un membre accepté. N'accorde jamais de place : statut « en attente » jusqu'à décision. */
export async function registerForChampionship(db: Db, communityId: string, userId: string, championshipId: string, input: RegistrationInput) {
  if (!(await roleOf(db, communityId, userId))) throw new AppError("Votre adhésion à la ligue doit être acceptée avant l’inscription.", 403);
  const c = await championshipIn(db, communityId, championshipId, true);
  if (c.status !== "open") throw new AppError("Les inscriptions à ce championnat ne sont pas ouvertes.");
  if (c.registration_deadline && new Date(c.registration_deadline).getTime() < Date.now()) throw new AppError("La date limite d’inscription est dépassée.");
  if (Number(input.acceptedRulesVersion) !== c.rules_version)
    throw new AppError("Vous devez accepter la version actuelle du règlement (il a peut-être été mis à jour : rechargez la page).");
  const profile = (await db.query("SELECT iracing_cust_id FROM driver_profiles WHERE user_id=$1", [userId])).rows[0];
  if (!profile?.iracing_cust_id) throw new AppError("Renseignez votre identifiant client iRacing dans votre profil avant de vous inscrire.");

  const categories: string[] = c.categories ?? [];
  const cars: string[] = c.cars ?? [];
  const category = String(input.category ?? "").trim() || null;
  const car = String(input.car ?? "").trim() || null;
  if (category && !categories.includes(category)) throw new AppError("Catégorie inconnue.");
  if (c.require_category && !category) throw new AppError("Choisissez une catégorie.");
  if (car && !cars.includes(car)) throw new AppError("Voiture non autorisée.");
  if (c.require_car && !car) throw new AppError("Choisissez une voiture.");

  let raceNumber: number | null = null;
  if (c.number_policy !== "none") {
    const raw = String(input.raceNumber ?? "").trim();
    if (raw) {
      if (!/^\d{1,3}$/.test(raw)) throw new AppError("Numéro de course : entre 0 et 999.");
      raceNumber = Number(raw);
    }
    if (c.number_policy === "unique" && raceNumber != null) {
      const taken = (
        await db.query(
          "SELECT 1 FROM registrations WHERE championship_id=$1 AND race_number=$2 AND user_id<>$3 AND status = ANY($4)",
          [c.id, raceNumber, userId, active],
        )
      ).rowCount;
      if (taken) throw new AppError(`Le numéro ${raceNumber} est déjà pris dans ce championnat.`, 409);
    }
  }

  // Identité iRacing : refuser un second compte inscrit avec le même identifiant (protection supplémentaire à la contrainte unique du profil).
  const dup = (
    await db.query(
      `SELECT 1 FROM registrations r JOIN driver_profiles p ON p.user_id=r.user_id
       WHERE r.championship_id=$1 AND p.iracing_cust_id=$2 AND r.user_id<>$3 AND r.status = ANY($4)`,
      [c.id, profile.iracing_cust_id, userId, active],
    )
  ).rowCount;
  if (dup) throw new AppError("Cet identifiant iRacing est déjà inscrit via un autre compte.", 409);

  let teamId: string | null = null;
  const newTeam = String(input.newTeamName ?? "").trim();
  if (newTeam) {
    if (newTeam.length < 2 || newTeam.length > 60) throw new AppError("Nom d’équipe : 2 à 60 caractères.");
    const existing = (await db.query("SELECT id FROM teams WHERE championship_id=$1 AND lower(name)=lower($2)", [c.id, newTeam])).rows[0];
    teamId = existing?.id ?? (await db.query("INSERT INTO teams(championship_id, name, captain_id) VALUES($1,$2,$3) RETURNING id", [c.id, newTeam, userId])).rows[0].id;
  } else if (input.teamId) {
    assertUuid(String(input.teamId), "Équipe");
    const t = (await db.query("SELECT id FROM teams WHERE id=$1 AND championship_id=$2", [input.teamId, c.id])).rows[0];
    if (!t) throw notFound("Équipe");
    teamId = t.id;
  }
  if (c.require_team && !teamId) throw new AppError("Choisissez ou créez une équipe.");

  const existing = (await db.query("SELECT id, status FROM registrations WHERE championship_id=$1 AND user_id=$2", [c.id, userId])).rows[0];
  if (existing && ["accepted", "reserve"].includes(existing.status)) throw new AppError("Vous êtes déjà inscrit à ce championnat.", 409);
  if (existing?.status === "refused") throw new AppError("Votre inscription a été refusée. Contactez un organisateur.", 403);
  if (existing?.status === "pending") {
    await db.query(
      "UPDATE registrations SET category=$2, car=$3, team_id=$4, race_number=$5, rules_version=$6, rules_accepted_at=now(), note=$7 WHERE id=$1",
      [existing.id, category, car, teamId, raceNumber, c.rules_version, String(input.note ?? "").slice(0, 500)],
    );
    await audit(db, communityId, userId, "registration.update", "registration", existing.id);
    return existing.id as string;
  }
  const row = (
    await db.query(
      `INSERT INTO registrations(championship_id, user_id, status, category, car, team_id, race_number, rules_version, rules_accepted_at, note)
       VALUES($1,$2,'pending',$3,$4,$5,$6,$7,now(),$8)
       ON CONFLICT(championship_id, user_id) DO UPDATE SET status='pending', category=EXCLUDED.category, car=EXCLUDED.car, team_id=EXCLUDED.team_id,
         race_number=EXCLUDED.race_number, rules_version=EXCLUDED.rules_version, rules_accepted_at=now(), note=EXCLUDED.note,
         decided_by=NULL, decided_at=NULL, reserve_rank=NULL
       RETURNING id`,
      [c.id, userId, category, car, teamId, raceNumber, c.rules_version, String(input.note ?? "").slice(0, 500)],
    )
  ).rows[0];
  await audit(db, communityId, userId, "registration.submit", "registration", row.id, { rulesVersion: c.rules_version });
  return row.id as string;
}

/** Ré-acceptation d'une nouvelle version du règlement par un pilote déjà inscrit. */
export async function acceptRules(db: Db, communityId: string, userId: string, championshipId: string, version: unknown) {
  const c = await championshipIn(db, communityId, championshipId);
  if (Number(version) !== c.rules_version) throw new AppError("Version du règlement périmée : rechargez la page.");
  const r = await db.query("UPDATE registrations SET rules_version=$3, rules_accepted_at=now() WHERE championship_id=$1 AND user_id=$2 RETURNING id", [c.id, userId, c.rules_version]);
  if (!r.rowCount) throw notFound("Inscription");
  await audit(db, communityId, userId, "registration.rules_accept", "registration", r.rows[0].id, { version: c.rules_version });
}

export async function decideRegistration(
  db: Db,
  communityId: string,
  actorId: string,
  registrationId: string,
  decision: "accepted" | "reserve" | "refused",
  note?: unknown,
) {
  await requirePermission(db, communityId, actorId, "registrations.review");
  assertUuid(registrationId, "Inscription");
  const reg = (
    await db.query(
      "SELECT r.* FROM registrations r JOIN championships c ON c.id=r.championship_id WHERE r.id=$1 AND c.community_id=$2",
      [registrationId, communityId],
    )
  ).rows[0];
  if (!reg) throw notFound("Inscription");
  // Verrou championnat : deux décisions simultanées ne peuvent pas dépasser la capacité.
  const c = await championshipIn(db, communityId, reg.championship_id, true);
  const current = (await db.query("SELECT status FROM registrations WHERE id=$1 FOR UPDATE", [reg.id])).rows[0];
  if (current.status === decision) return;
  if (current.status === "withdrawn") throw new AppError("Inscription retirée par le pilote.");
  if (decision === "accepted") {
    const accepted = (await db.query("SELECT count(*)::int n FROM registrations WHERE championship_id=$1 AND status='accepted'", [c.id])).rows[0].n;
    if (accepted >= c.capacity) throw new AppError(`Capacité atteinte (${c.capacity} titulaires). Placez ce pilote en réserviste ou augmentez la capacité.`, 409);
  }
  let rank: number | null = null;
  if (decision === "reserve")
    rank = (await db.query("SELECT COALESCE(max(reserve_rank),0)+1 AS n FROM registrations WHERE championship_id=$1 AND status='reserve'", [c.id])).rows[0].n;
  await db.query("UPDATE registrations SET status=$2, reserve_rank=$3, decided_by=$4, decided_at=now() WHERE id=$1", [reg.id, decision, rank, actorId]);
  await audit(db, communityId, actorId, `registration.${decision}`, "registration", reg.id, { from: current.status, note: String(note ?? "").slice(0, 300) });
  if (decision === "refused") await releaseFutureSeats(db, communityId, actorId, c.id, reg.user_id, "registration_refused");
}

export async function reorderReserve(db: Db, communityId: string, actorId: string, registrationId: string, rank: unknown) {
  await requirePermission(db, communityId, actorId, "registrations.review");
  assertUuid(registrationId, "Inscription");
  const n = Number(rank);
  if (!Number.isInteger(n) || n < 1) throw new AppError("Rang de réserve invalide.");
  const r = await db.query(
    `UPDATE registrations r SET reserve_rank=$3 FROM championships c
     WHERE r.id=$1 AND c.id=r.championship_id AND c.community_id=$2 AND r.status='reserve' RETURNING r.id`,
    [registrationId, communityId, n],
  );
  if (!r.rowCount) throw notFound("Réserviste");
  await audit(db, communityId, actorId, "registration.reserve_rank", "registration", registrationId, { rank: n });
}

/** Retrait par le pilote : les places futures sont libérées et réattribuées. */
export async function withdrawRegistration(db: Db, communityId: string, userId: string, championshipId: string) {
  const c = await championshipIn(db, communityId, championshipId, true);
  const r = await db.query(
    "UPDATE registrations SET status='withdrawn' WHERE championship_id=$1 AND user_id=$2 AND status = ANY($3) RETURNING id",
    [c.id, userId, active],
  );
  if (!r.rowCount) throw notFound("Inscription active");
  await audit(db, communityId, userId, "registration.withdraw", "registration", r.rows[0].id);
  await releaseFutureSeats(db, communityId, userId, c.id, userId, "registration_withdrawn");
}

export async function listRegistrations(db: Db, communityId: string, championshipId: string) {
  return (
    await db.query(
      `SELECT r.id, r.user_id AS "userId", u.display_name AS "displayName", r.status, r.category, r.car, r.race_number AS "raceNumber",
              r.rules_version AS "rulesVersion", r.rules_accepted_at AS "rulesAcceptedAt", r.reserve_rank AS "reserveRank", r.note,
              r.created_at AS "createdAt", t.name AS "teamName", t.id AS "teamId", p.iracing_cust_id AS "iracingCustId"
       FROM registrations r JOIN championships c ON c.id=r.championship_id JOIN users u ON u.id=r.user_id
       JOIN driver_profiles p ON p.user_id=r.user_id LEFT JOIN teams t ON t.id=r.team_id
       WHERE r.championship_id=$1 AND c.community_id=$2
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 WHEN 'reserve' THEN 2 ELSE 3 END, r.reserve_rank NULLS LAST, u.display_name`,
      [championshipId, communityId],
    )
  ).rows;
}
