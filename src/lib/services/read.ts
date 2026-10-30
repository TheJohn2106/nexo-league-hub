// Lectures pour les pages. Les vues publiques ne renvoient que des pseudos et données sportives.
import type { Db } from "../db.ts";
import { notFound } from "../errors.ts";
import { assertUuid, roleOf } from "./context.ts";
import { can } from "../permissions.ts";

export async function championshipsOf(db: Db, communityId: string, includeDrafts = false) {
  return (
    await db.query(
      `SELECT c.id, c.slug, c.name, c.description, c.status, c.capacity, c.registration_deadline AS "registrationDeadline",
              (SELECT count(*)::int FROM registrations r WHERE r.championship_id=c.id AND r.status='accepted') AS accepted,
              (SELECT count(*)::int FROM registrations r WHERE r.championship_id=c.id AND r.status='reserve') AS reserves,
              (SELECT count(*)::int FROM rounds r WHERE r.championship_id=c.id AND r.status <> 'draft') AS rounds
       FROM championships c WHERE c.community_id=$1 AND ($2 OR c.status <> 'draft')
       ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 WHEN 'draft' THEN 2 WHEN 'finished' THEN 3 ELSE 4 END, c.created_at DESC`,
      [communityId, includeDrafts],
    )
  ).rows;
}

export async function roundsOf(db: Db, championshipId: string, includeDrafts = false) {
  return (
    await db.query(
      `SELECT r.id, r.number, r.name, r.track, r.track_config AS "trackConfig", r.starts_at AS "startsAt", r.original_starts_at AS "originalStartsAt",
              r.status, r.capacity, r.is_joker_eligible AS "jokerEligible", r.cars,
              (SELECT count(*)::int FROM attendances a WHERE a.round_id=r.id AND a.seat='confirmed') AS confirmed,
              (SELECT json_agg(json_build_object('id', s.id, 'kind', s.kind, 'label', s.label, 'startsAt', s.starts_at, 'durationMinutes', s.duration_minutes,
                  'resultsStatus', s.results_status, 'awardsPoints', s.awards_points, 'coefficient', s.coefficient) ORDER BY s.starts_at, s.ordinal)
                 FROM round_sessions s WHERE s.round_id=r.id) AS sessions
       FROM rounds r WHERE r.championship_id=$1 AND ($2 OR r.status <> 'draft') ORDER BY r.number`,
      [championshipId, includeDrafts],
    )
  ).rows;
}

export async function nextRound(db: Db, communityId: string, championshipId?: string) {
  return (
    (
      await db.query(
        `SELECT r.id, r.number, r.name, r.track, r.track_config AS "trackConfig", r.starts_at AS "startsAt", r.status, r.cars,
                c.name AS "championshipName", c.slug AS "championshipSlug", c.id AS "championshipId", COALESCE(r.capacity, c.capacity) AS capacity,
                (SELECT count(*)::int FROM attendances a WHERE a.round_id=r.id AND a.seat='confirmed') AS confirmed
         FROM rounds r JOIN championships c ON c.id=r.championship_id
         WHERE c.community_id=$1 AND ($2::uuid IS NULL OR c.id=$2) AND c.status IN ('open','closed')
           AND r.status IN ('scheduled','postponed') AND r.starts_at > now() - interval '3 hours'
         ORDER BY r.starts_at LIMIT 1`,
        [communityId, championshipId ?? null],
      )
    ).rows[0] ?? null
  );
}

/** Participants publics : pseudo, numéro, équipe, catégorie, statut. */
export async function participants(db: Db, championshipId: string) {
  return (
    await db.query(
      `SELECT r.user_id AS "userId", u.display_name AS "displayName", u.avatar_url AS "avatarUrl", r.status, r.category, r.car,
              r.race_number AS "raceNumber", t.name AS "teamName", t.id AS "teamId", p.country
       FROM registrations r JOIN users u ON u.id=r.user_id JOIN driver_profiles p ON p.user_id=r.user_id LEFT JOIN teams t ON t.id=r.team_id
       WHERE r.championship_id=$1 AND r.status IN ('accepted','reserve') ORDER BY r.status, t.name NULLS LAST, u.display_name`,
      [championshipId],
    )
  ).rows;
}

export async function roundPublic(db: Db, communityId: string, roundId: string, viewerId: string | null) {
  assertUuid(roundId, "Manche");
  const round = (
    await db.query(
      `SELECT r.*, c.name AS championship_name, c.slug AS championship_slug, c.id AS championship_id, c.capacity AS champ_capacity,
              c.server_info AS champ_server_info, c.presence_deadline_hours, c.checkin_opens_minutes, c.checkin_closes_minutes, c.status AS championship_status
       FROM rounds r JOIN championships c ON c.id=r.championship_id WHERE r.id=$1 AND c.community_id=$2 AND r.status <> 'draft'`,
      [roundId, communityId],
    )
  ).rows[0];
  if (!round) throw notFound("Manche");
  const sessions = (await db.query("SELECT * FROM round_sessions WHERE round_id=$1 ORDER BY starts_at, ordinal", [round.id])).rows;
  const confirmed = (
    await db.query(
      `SELECT u.id AS "userId", u.display_name AS "displayName", reg.race_number AS "raceNumber", a.checked_in_at IS NOT NULL AS "checkedIn"
       FROM attendances a JOIN users u ON u.id=a.user_id LEFT JOIN registrations reg ON reg.user_id=a.user_id AND reg.championship_id=$2
       WHERE a.round_id=$1 AND a.seat='confirmed' ORDER BY u.display_name`,
      [round.id, round.championship_id],
    )
  ).rows;
  const role = await roleOf(db, communityId, viewerId);
  const mine = viewerId ? (await db.query("SELECT * FROM attendances WHERE round_id=$1 AND user_id=$2", [round.id, viewerId])).rows[0] ?? null : null;
  // Informations serveur : participants confirmés et organisateurs uniquement.
  const canSeeServer = can(role, "attendance.manage") || mine?.seat === "confirmed";
  return {
    round: { ...round, server_info: undefined, champ_server_info: undefined },
    serverInfo: canSeeServer ? [round.champ_server_info, round.server_info].filter(Boolean).join("\n") : null,
    sessions,
    confirmed,
    mine,
    role,
  };
}

export async function myOverview(db: Db, communityId: string, userId: string) {
  const registrations = (
    await db.query(
      `SELECT r.id, r.status, r.category, r.car, r.race_number AS "raceNumber", r.rules_version AS "rulesVersion", r.reserve_rank AS "reserveRank",
              c.id AS "championshipId", c.slug, c.name, c.rules_version AS "currentRulesVersion", c.status AS "championshipStatus", t.name AS "teamName"
       FROM registrations r JOIN championships c ON c.id=r.championship_id LEFT JOIN teams t ON t.id=r.team_id
       WHERE r.user_id=$1 AND c.community_id=$2 ORDER BY c.created_at DESC`,
      [userId, communityId],
    )
  ).rows;
  const rounds = (
    await db.query(
      `SELECT r.id, r.number, r.name, r.track, r.starts_at AS "startsAt", r.status, c.name AS "championshipName", c.slug AS "championshipSlug",
              c.presence_deadline_hours AS "presenceDeadlineHours", c.checkin_opens_minutes AS "checkinOpensMinutes", c.checkin_closes_minutes AS "checkinClosesMinutes",
              COALESCE(a.response,'none') AS response, COALESCE(a.seat,'none') AS seat, a.waitlist_position AS "waitlistPosition",
              a.offer_expires_at AS "offerExpiresAt", a.checked_in_at AS "checkedInAt", reg.status AS "registration"
       FROM registrations reg JOIN championships c ON c.id=reg.championship_id JOIN rounds r ON r.championship_id=c.id
       LEFT JOIN attendances a ON a.round_id=r.id AND a.user_id=reg.user_id
       WHERE reg.user_id=$1 AND c.community_id=$2 AND reg.status IN ('accepted','reserve') AND r.status IN ('scheduled','postponed')
         AND r.starts_at > now() - interval '3 hours'
       ORDER BY r.starts_at LIMIT 12`,
      [userId, communityId],
    )
  ).rows;
  const recentSessions = (
    await db.query(
      `SELECT s.id, s.label, s.kind, s.starts_at AS "startsAt", r.number, r.name AS "roundName", c.name AS "championshipName", c.protest_window_hours AS "protestWindowHours", s.duration_minutes AS "durationMinutes"
       FROM registrations reg JOIN championships c ON c.id=reg.championship_id JOIN rounds r ON r.championship_id=c.id JOIN round_sessions s ON s.round_id=r.id
       WHERE reg.user_id=$1 AND c.community_id=$2 AND reg.status IN ('accepted','reserve') AND s.kind='race'
         AND s.starts_at < now() AND s.starts_at + make_interval(mins => s.duration_minutes) + make_interval(hours => c.protest_window_hours) > now()
       ORDER BY s.starts_at DESC`,
      [userId, communityId],
    )
  ).rows;
  return { registrations, rounds, recentSessions };
}

export async function sessionRoster(db: Db, sessionId: string) {
  return (
    await db.query(
      `SELECT u.id AS "userId", u.display_name AS "displayName" FROM round_sessions s JOIN rounds r ON r.id=s.round_id
       JOIN registrations reg ON reg.championship_id=r.championship_id JOIN users u ON u.id=reg.user_id
       WHERE s.id=$1 ORDER BY u.display_name`,
      [sessionId],
    )
  ).rows;
}

export async function driverPublic(db: Db, communityId: string, userId: string) {
  assertUuid(userId, "Pilote");
  const driver = (
    await db.query(
      `SELECT u.id, u.display_name AS "displayName", u.avatar_url AS "avatarUrl", p.country, p.preferred_number AS "preferredNumber"
       FROM users u JOIN driver_profiles p ON p.user_id=u.id JOIN memberships m ON m.user_id=u.id AND m.community_id=$2 AND m.status='accepted'
       WHERE u.id=$1 AND NOT u.disabled`,
      [userId, communityId],
    )
  ).rows[0];
  if (!driver) throw notFound("Pilote");
  const history = (
    await db.query(
      `SELECT res.finish_position AS position, res.status, res.laps, res.best_lap_ms AS "bestLapMs", res.incidents, s.label, s.kind, s.results_status AS "resultsStatus",
              r.id AS "roundId", r.number, r.name AS "roundName", r.track, s.starts_at AS "startsAt", c.name AS "championshipName", c.slug AS "championshipSlug", res.session_id AS "sessionId"
       FROM results res JOIN round_sessions s ON s.id=res.session_id JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id
       WHERE res.user_id=$1 AND c.community_id=$2 AND s.results_status <> 'none' ORDER BY s.starts_at DESC LIMIT 100`,
      [userId, communityId],
    )
  ).rows;
  const championships = (
    await db.query(
      `SELECT c.id, c.slug, c.name, r.status, r.race_number AS "raceNumber", t.name AS "teamName", r.category
       FROM registrations r JOIN championships c ON c.id=r.championship_id LEFT JOIN teams t ON t.id=r.team_id
       WHERE r.user_id=$1 AND c.community_id=$2 AND r.status IN ('accepted','reserve') ORDER BY c.created_at DESC`,
      [userId, communityId],
    )
  ).rows;
  return { driver, history, championships };
}

export async function adminDashboard(db: Db, communityId: string) {
  const one = async (sql: string) => (await db.query(sql, [communityId])).rows[0].n as number;
  return {
    pendingMembers: await one("SELECT count(*)::int n FROM memberships WHERE community_id=$1 AND status='pending'"),
    pendingRegistrations: (
      await db.query(
        `SELECT c.id, c.name, count(*)::int n FROM registrations r JOIN championships c ON c.id=r.championship_id
         WHERE c.community_id=$1 AND r.status='pending' GROUP BY c.id, c.name`,
        [communityId],
      )
    ).rows,
    previews: (
      await db.query(
        `SELECT i.id, i.source, i.created_at AS "createdAt", s.label, r.number, r.id AS "roundId", c.name AS "championshipName"
         FROM result_imports i JOIN round_sessions s ON s.id=i.session_id JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id
         WHERE c.community_id=$1 AND i.status='preview' ORDER BY i.created_at`,
        [communityId],
      )
    ).rows,
    provisional: (
      await db.query(
        `SELECT s.id, s.label, r.number, r.id AS "roundId", c.name AS "championshipName" FROM round_sessions s JOIN rounds r ON r.id=s.round_id
         JOIN championships c ON c.id=r.championship_id WHERE c.community_id=$1 AND s.results_status='provisional'`,
        [communityId],
      )
    ).rows,
    awaitingResults: (
      await db.query(
        `SELECT s.id, s.label, r.number, r.id AS "roundId", c.name AS "championshipName", s.starts_at AS "startsAt", s.iracing_subsession_id AS "subsessionId"
         FROM round_sessions s JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id
         WHERE c.community_id=$1 AND s.awards_points AND s.results_status='none' AND r.status NOT IN ('cancelled','draft')
           AND s.starts_at + make_interval(mins => s.duration_minutes) < now() ORDER BY s.starts_at`,
        [communityId],
      )
    ).rows,
    openProtests: await one(
      `SELECT count(*)::int n FROM protests p JOIN round_sessions s ON s.id=p.session_id JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id
       WHERE c.community_id=$1 AND p.status IN ('submitted','under_review')`,
    ),
    syncFailures: (
      await db.query(
        `SELECT f.id, f.code, f.message, f.created_at AS "createdAt", f.attempts, f.retry_after AS "retryAfter", s.label, r.number, r.id AS "roundId"
         FROM sync_failures f LEFT JOIN round_sessions s ON s.id=f.session_id LEFT JOIN rounds r ON r.id=s.round_id
         WHERE f.community_id=$1 AND f.resolved_at IS NULL ORDER BY f.created_at DESC LIMIT 10`,
        [communityId],
      )
    ).rows,
    failedNotifications: await one("SELECT count(*)::int n FROM notification_outbox WHERE community_id=$1 AND status='failed'"),
  };
}

export async function auditEntries(db: Db, communityId: string, limit = 200) {
  return (
    await db.query(
      `SELECT a.id, a.action, a.target_type AS "targetType", a.target_id AS "targetId", a.detail, a.created_at AS "createdAt", u.display_name AS actor
       FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id WHERE a.community_id=$1 ORDER BY a.id DESC LIMIT $2`,
      [communityId, limit],
    )
  ).rows;
}
