// Accès aux données avec isolation stricte par communauté : chaque lecture d'un objet
// vérifie qu'il appartient à la communauté de la requête, et chaque mutation vérifie le rôle.
import type { Db } from "../db.ts";
import { AppError, forbidden, notFound } from "../errors.ts";
import { can, type Permission, type Role } from "../permissions.ts";

export interface Community {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  timezone: string;
  branding: Branding;
  joinPolicy: "approval" | "closed";
  discordConfigured: boolean;
  discordReminderHours: number;
}
export interface Branding {
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  twitchUrl?: string;
  discordUrl?: string;
  websiteUrl?: string;
  partners?: { name: string; url?: string; logoUrl?: string }[];
}

const communityCols = `id, slug, name, tagline, timezone, branding, join_policy AS "joinPolicy",
  (discord_webhook_url IS NOT NULL AND discord_webhook_url <> '') AS "discordConfigured",
  discord_reminder_hours AS "discordReminderHours"`;

export async function getCommunityBySlug(db: Db, slug: string): Promise<Community> {
  const row = (await db.query(`SELECT ${communityCols} FROM communities WHERE slug=$1`, [slug])).rows[0];
  if (!row) throw notFound("Ligue");
  return row;
}
export async function getCommunityById(db: Db, id: string): Promise<Community> {
  const row = (await db.query(`SELECT ${communityCols} FROM communities WHERE id=$1`, [id])).rows[0];
  if (!row) throw notFound("Ligue");
  return row;
}
export async function listCommunities(db: Db): Promise<Community[]> {
  return (await db.query(`SELECT ${communityCols} FROM communities ORDER BY name`)).rows;
}

export interface MembershipInfo {
  role: Role;
  status: "pending" | "accepted" | "refused" | "removed";
}
export async function membershipOf(db: Db, communityId: string, userId: string | null | undefined): Promise<MembershipInfo | null> {
  if (!userId) return null;
  return (
    (
      await db.query(
        `SELECT m.role, m.status FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.community_id=$1 AND m.user_id=$2 AND NOT u.disabled`,
        [communityId, userId],
      )
    ).rows[0] ?? null
  );
}
/** Rôle effectif : uniquement pour une adhésion acceptée. */
export async function roleOf(db: Db, communityId: string, userId: string | null | undefined): Promise<Role | null> {
  const m = await membershipOf(db, communityId, userId);
  return m?.status === "accepted" ? m.role : null;
}
export async function requirePermission(db: Db, communityId: string, userId: string | null | undefined, permission: Permission): Promise<Role> {
  if (!userId) throw new AppError("Connexion requise.", 401);
  const role = await roleOf(db, communityId, userId);
  if (!can(role, permission)) throw forbidden();
  return role!;
}

export async function audit(
  db: Db,
  communityId: string | null,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  detail: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO audit_log(community_id, actor_id, action, target_type, target_id, detail) VALUES($1,$2,$3,$4,$5,$6)",
    [communityId, actorId, action, targetType, targetId, JSON.stringify(detail)],
  );
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(id: string, what = "Élément") {
  if (!uuidRe.test(id)) throw notFound(what);
}

export async function championshipIn(db: Db, communityId: string, championshipId: string, lock = false) {
  assertUuid(championshipId, "Championnat");
  const row = (
    await db.query(`SELECT * FROM championships WHERE id=$1 AND community_id=$2 ${lock ? "FOR UPDATE" : ""}`, [championshipId, communityId])
  ).rows[0];
  if (!row) throw notFound("Championnat");
  return row;
}
export async function championshipBySlug(db: Db, communityId: string, slug: string) {
  const row = (await db.query("SELECT * FROM championships WHERE slug=$1 AND community_id=$2", [slug, communityId])).rows[0];
  if (!row) throw notFound("Championnat");
  return row;
}
export async function roundIn(db: Db, communityId: string, roundId: string, lock = false) {
  assertUuid(roundId, "Manche");
  const row = (
    await db.query(
      `SELECT r.*, c.community_id, c.capacity AS champ_capacity, c.offer_ttl_hours, c.presence_deadline_hours,
              c.checkin_opens_minutes, c.checkin_closes_minutes, c.name AS championship_name, c.slug AS championship_slug,
              c.status AS championship_status
       FROM rounds r JOIN championships c ON c.id=r.championship_id
       WHERE r.id=$1 AND c.community_id=$2 ${lock ? "FOR UPDATE OF r" : ""}`,
      [roundId, communityId],
    )
  ).rows[0];
  if (!row) throw notFound("Manche");
  return row;
}
export async function sessionIn(db: Db, communityId: string, sessionId: string, lock = false) {
  assertUuid(sessionId, "Session");
  const row = (
    await db.query(
      `SELECT s.*, r.championship_id, r.number AS round_number, r.name AS round_name, r.starts_at AS round_starts_at,
              c.community_id, c.protest_window_hours
       FROM round_sessions s JOIN rounds r ON r.id=s.round_id JOIN championships c ON c.id=r.championship_id
       WHERE s.id=$1 AND c.community_id=$2 ${lock ? "FOR UPDATE OF s" : ""}`,
      [sessionId, communityId],
    )
  ).rows[0];
  if (!row) throw notFound("Session");
  return row;
}

/** Erreurs PostgreSQL de contrainte unique → message lisible. */
export function uniqueViolation(error: unknown, message: string): never {
  if ((error as { code?: string })?.code === "23505") throw new AppError(message, 409);
  throw error;
}
