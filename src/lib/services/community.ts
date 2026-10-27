import { z } from "zod";
import type { Db } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { roles, type Role } from "../permissions.ts";
import { audit, membershipOf, requirePermission, uniqueViolation, type Branding } from "./context.ts";

export async function createCommunity(db: Db, input: { slug: string; name: string; tagline?: string; timezone?: string }, ownerId: string) {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new AppError("Identifiant d’URL : lettres minuscules, chiffres et tirets.");
  const tz = input.timezone ?? "Europe/Brussels";
  try {
    new Intl.DateTimeFormat("fr", { timeZone: tz });
  } catch {
    throw new AppError("Fuseau horaire inconnu.");
  }
  try {
    const c = (
      await db.query("INSERT INTO communities(slug, name, tagline, timezone) VALUES($1,$2,$3,$4) RETURNING id", [
        slug,
        input.name.trim(),
        input.tagline ?? "",
        tz,
      ])
    ).rows[0];
    await db.query(
      "INSERT INTO memberships(community_id, user_id, role, status, decided_at) VALUES($1,$2,'owner','accepted',now())",
      [c.id, ownerId],
    );
    await audit(db, c.id, ownerId, "community.create", "community", c.id, { slug });
    return c.id as string;
  } catch (e) {
    uniqueViolation(e, "Cet identifiant de ligue existe déjà.");
  }
}

export async function requestJoin(db: Db, communityId: string, userId: string, message: unknown) {
  const msg = String(message ?? "").trim().slice(0, 500);
  const policy = (await db.query("SELECT join_policy FROM communities WHERE id=$1", [communityId])).rows[0]?.join_policy;
  if (policy === "closed") throw new AppError("Les adhésions sont fermées pour le moment.", 403);
  const existing = await membershipOf(db, communityId, userId);
  if (existing?.status === "accepted") throw new AppError("Vous êtes déjà membre de cette ligue.", 409);
  if (existing?.status === "pending") throw new AppError("Votre demande est déjà en attente de validation.", 409);
  if (existing?.status === "refused") throw new AppError("Votre demande a été refusée. Contactez un organisateur.", 403);
  await db.query(
    `INSERT INTO memberships(community_id, user_id, role, status, message) VALUES($1,$2,'driver','pending',$3)
     ON CONFLICT(community_id, user_id) DO UPDATE SET status='pending', role='driver', message=EXCLUDED.message, decided_by=NULL, decided_at=NULL, created_at=now()`,
    [communityId, userId, msg],
  );
  await audit(db, communityId, userId, "membership.request", "user", userId);
}

export async function decideMembership(db: Db, communityId: string, actorId: string, userId: string, decision: "accepted" | "refused") {
  await requirePermission(db, communityId, actorId, "members.review");
  const r = await db.query(
    "UPDATE memberships SET status=$3, decided_by=$4, decided_at=now() WHERE community_id=$1 AND user_id=$2 AND status='pending' RETURNING user_id",
    [communityId, userId, decision, actorId],
  );
  if (!r.rowCount) throw notFound("Demande d’adhésion en attente");
  await audit(db, communityId, actorId, `membership.${decision}`, "user", userId);
}

export async function setRole(db: Db, communityId: string, actorId: string, userId: string, role: unknown) {
  await requirePermission(db, communityId, actorId, "community.manage");
  if (!roles.includes(role as Role)) throw new AppError("Rôle inconnu.");
  const current = await membershipOf(db, communityId, userId);
  if (current?.status !== "accepted") throw new AppError("Seul un membre accepté peut recevoir un rôle.");
  if (current.role === "owner" && role !== "owner") {
    const owners = (await db.query("SELECT count(*)::int n FROM memberships WHERE community_id=$1 AND role='owner' AND status='accepted'", [communityId])).rows[0].n;
    if (owners <= 1) throw new AppError("Il doit rester au moins un propriétaire.");
  }
  await db.query("UPDATE memberships SET role=$3 WHERE community_id=$1 AND user_id=$2", [communityId, userId, role]);
  await audit(db, communityId, actorId, "membership.role", "user", userId, { from: current.role, to: role });
}

export async function removeMember(db: Db, communityId: string, actorId: string, userId: string, reason: unknown) {
  await requirePermission(db, communityId, actorId, "members.review");
  const current = await membershipOf(db, communityId, userId);
  if (!current) throw notFound("Membre");
  if (current.role === "owner") throw new AppError("Un propriétaire ne peut pas être retiré ici.");
  await db.query("UPDATE memberships SET status='removed', decided_by=$3, decided_at=now() WHERE community_id=$1 AND user_id=$2", [
    communityId,
    userId,
    actorId,
  ]);
  await audit(db, communityId, actorId, "membership.remove", "user", userId, { reason: String(reason ?? "").slice(0, 300) });
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Couleur : format #RRGGBB.");
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s"'<>]+$/.test(v), "Lien : adresse https:// attendue.");
const brandingSchema = z.object({
  name: z.string().trim().min(2).max(80),
  tagline: z.string().trim().max(160),
  logoUrl: url,
  primaryColor: hex,
  accentColor: hex,
  twitchUrl: url,
  discordUrl: url,
  websiteUrl: url,
  partners: z.array(z.object({ name: z.string().trim().min(1).max(60), url: url.optional(), logoUrl: url.optional() })).max(12),
  timezone: z.string(),
  joinPolicy: z.enum(["approval", "closed"]),
});

export async function updateBranding(db: Db, communityId: string, actorId: string, input: unknown) {
  await requirePermission(db, communityId, actorId, "community.manage");
  const r = brandingSchema.safeParse(input);
  if (!r.success) throw new AppError(r.error.issues[0]?.message ?? "Paramètres invalides.");
  try {
    new Intl.DateTimeFormat("fr", { timeZone: r.data.timezone });
  } catch {
    throw new AppError("Fuseau horaire inconnu.");
  }
  const { name, tagline, timezone, joinPolicy, ...rest } = r.data;
  const branding: Branding = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== "")) as Branding;
  await db.query("UPDATE communities SET name=$2, tagline=$3, timezone=$4, join_policy=$5, branding=$6 WHERE id=$1", [
    communityId,
    name,
    tagline,
    timezone,
    joinPolicy,
    JSON.stringify(branding),
  ]);
  await audit(db, communityId, actorId, "community.branding", "community", communityId);
}

export async function updateDiscordSettings(db: Db, communityId: string, actorId: string, webhookUrl: unknown, reminderHours: unknown) {
  await requirePermission(db, communityId, actorId, "community.manage");
  const w = String(webhookUrl ?? "").trim();
  if (w && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(w))
    throw new AppError("URL de webhook Discord invalide (https://discord.com/api/webhooks/…).");
  const h = Number(reminderHours);
  if (!Number.isInteger(h) || h < 1 || h > 336) throw new AppError("Délai de rappel : entre 1 et 336 heures.");
  // Valeur vide = conserver le webhook existant ; "-" = supprimer.
  if (w || webhookUrl === "-")
    await db.query("UPDATE communities SET discord_webhook_url=$2 WHERE id=$1", [communityId, webhookUrl === "-" ? null : w]);
  await db.query("UPDATE communities SET discord_reminder_hours=$2 WHERE id=$1", [communityId, h]);
  await audit(db, communityId, actorId, "community.discord", "community", communityId, { webhookChanged: !!w || webhookUrl === "-" });
}

export async function listMembers(db: Db, communityId: string, actorId: string) {
  await requirePermission(db, communityId, actorId, "members.review");
  return (
    await db.query(
      `SELECT m.user_id AS "userId", u.display_name AS "displayName", u.email, m.role, m.status, m.message, m.created_at AS "createdAt",
              p.iracing_cust_id AS "iracingCustId", p.private_contact AS "privateContact",
              EXISTS(SELECT 1 FROM discord_identities d WHERE d.user_id=u.id) AS "discordLinked"
       FROM memberships m JOIN users u ON u.id=m.user_id JOIN driver_profiles p ON p.user_id=u.id
       WHERE m.community_id=$1 ORDER BY (m.status='pending') DESC, u.display_name`,
      [communityId],
    )
  ).rows;
}
