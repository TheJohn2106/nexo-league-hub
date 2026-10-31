import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.ts";
import { AppError } from "../errors.ts";
import { hashPassword, tokenHash, verifyPassword } from "../password.ts";
import { audit, requirePermission, uniqueViolation } from "./context.ts";

export const SESSION_DAYS = 30;
const email = z.string().trim().toLowerCase().email("Adresse email invalide.").max(200);
const password = z
  .string()
  .min(10, "Mot de passe : 10 caractères minimum.")
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), "Mot de passe : au moins une lettre et un chiffre.");
export const displayNameSchema = z
  .string()
  .trim()
  .min(2, "Pseudo : 2 caractères minimum.")
  .max(40, "Pseudo : 40 caractères maximum.")
  .regex(/^[\p{L}\p{N} ._'-]+$/u, "Pseudo : lettres, chiffres, espaces et . _ ' - uniquement.");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError(r.error.issues[0]?.message ?? "Données invalides.");
  return r.data;
}

/** Limitation des tentatives sensibles (fenêtre glissante simple, clés hachées). */
export async function rateLimit(db: Db, key: string, limit: number, windowMinutes = 15) {
  const row = (
    await db.query(
      `INSERT INTO rate_limits(key_hash, attempts) VALUES($1, 1)
       ON CONFLICT(key_hash) DO UPDATE SET
         attempts = CASE WHEN rate_limits.window_start < now() - make_interval(mins => $2) THEN 1 ELSE rate_limits.attempts + 1 END,
         window_start = CASE WHEN rate_limits.window_start < now() - make_interval(mins => $2) THEN now() ELSE rate_limits.window_start END
       RETURNING attempts`,
      [tokenHash(key), windowMinutes],
    )
  ).rows[0];
  if (row.attempts > limit) throw new AppError(`Trop de tentatives. Réessayez dans ${windowMinutes} minutes.`, 429);
}
export async function clearRateLimit(db: Db, key: string) {
  await db.query("DELETE FROM rate_limits WHERE key_hash=$1", [tokenHash(key)]);
}

export async function registerUser(db: Db, input: { email: unknown; password: unknown; displayName: unknown }) {
  const data = {
    email: parse(email, input.email),
    password: parse(password, input.password),
    displayName: parse(displayNameSchema, input.displayName),
  };
  try {
    const user = (
      await db.query("INSERT INTO users(email, password_hash, display_name) VALUES($1,$2,$3) RETURNING id", [
        data.email,
        hashPassword(data.password),
        data.displayName,
      ])
    ).rows[0];
    await db.query("INSERT INTO driver_profiles(user_id) VALUES($1)", [user.id]);
    return user.id as string;
  } catch (e) {
    uniqueViolation(e, "Cette adresse email ou ce pseudo est déjà utilisé.");
  }
}

/** À appeler HORS transaction (pool) : les tentatives échouées doivent être enregistrées même si l'appel lève une erreur. */
export async function verifyLogin(db: Db, rawEmail: unknown, rawPassword: unknown, clientKey: string) {
  const e = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const p = typeof rawPassword === "string" ? rawPassword : "";
  await rateLimit(db, `login:email:${e}`, 8);
  await rateLimit(db, `login:client:${clientKey}`, 30);
  const user = (await db.query("SELECT id, password_hash FROM users WHERE email=$1 AND NOT disabled", [e])).rows[0];
  // Comparaison effectuée même sans compte pour limiter les écarts de temps de réponse.
  const ok = verifyPassword(p, user?.password_hash ?? "00:00");
  if (!user || !ok) throw new AppError("Email ou mot de passe incorrect.", 401);
  await clearRateLimit(db, `login:email:${e}`);
  return user.id as string;
}

export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query("DELETE FROM auth_sessions WHERE expires_at < now()");
  await db.query(`INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES($1,$2, now() + interval '${SESSION_DAYS} days')`, [
    tokenHash(token),
    userId,
  ]);
  return token;
}
export async function destroySession(db: Db, token: string) {
  await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash(token)]);
}

export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}
export async function userFromToken(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  return (
    (
      await db.query(
        `SELECT u.id, u.display_name AS "displayName", u.email, u.avatar_url AS "avatarUrl"
         FROM auth_sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=$1 AND s.expires_at > now() AND NOT u.disabled`,
        [tokenHash(token)],
      )
    ).rows[0] ?? null
  );
}

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s"'<>]+$/.test(v), "Lien : adresse https:// attendue.");

export async function getProfile(db: Db, userId: string) {
  return (
    await db.query(
      `SELECT u.id, u.display_name AS "displayName", u.email, u.avatar_url AS "avatarUrl",
              p.iracing_cust_id AS "iracingCustId", p.preferred_number AS "preferredNumber", p.country, p.private_contact AS "privateContact",
              EXISTS(SELECT 1 FROM discord_identities d WHERE d.user_id=u.id) AS "discordLinked"
       FROM users u JOIN driver_profiles p ON p.user_id=u.id WHERE u.id=$1`,
      [userId],
    )
  ).rows[0];
}

export async function updateProfile(
  db: Db,
  userId: string,
  input: { displayName: unknown; avatarUrl: unknown; iracingCustId: unknown; preferredNumber: unknown; country: unknown; privateContact: unknown },
) {
  const displayName = parse(displayNameSchema, input.displayName);
  const avatarUrl = parse(httpsUrl, input.avatarUrl ?? "") || null;
  const custRaw = String(input.iracingCustId ?? "").trim();
  if (custRaw && !/^\d{1,10}$/.test(custRaw)) throw new AppError("Identifiant client iRacing : nombre attendu (visible dans votre profil iRacing).");
  const numRaw = String(input.preferredNumber ?? "").trim();
  if (numRaw && !/^\d{1,3}$/.test(numRaw)) throw new AppError("Numéro : entre 0 et 999.");
  const country = String(input.country ?? "").trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new AppError("Pays : code à 2 lettres (BE, FR…).");
  const privateContact = String(input.privateContact ?? "").trim().slice(0, 200);
  const previous = (await db.query("SELECT iracing_cust_id FROM driver_profiles WHERE user_id=$1", [userId])).rows[0];
  try {
    await db.query("UPDATE users SET display_name=$2, avatar_url=$3 WHERE id=$1", [userId, displayName, avatarUrl]);
    await db.query(
      "UPDATE driver_profiles SET iracing_cust_id=$2, preferred_number=$3, country=$4, private_contact=$5, updated_at=now() WHERE user_id=$1",
      [userId, custRaw ? Number(custRaw) : null, numRaw ? Number(numRaw) : null, country, privateContact],
    );
  } catch (e) {
    uniqueViolation(e, "Pseudo déjà utilisé, ou identifiant iRacing déjà associé à un autre compte (contactez un organisateur).");
  }
  if (String(previous?.iracing_cust_id ?? "") !== custRaw)
    await db.query(
      "INSERT INTO audit_log(actor_id, action, target_type, target_id, detail) VALUES($1,'profile.iracing_id','user',$3,$2)",
      [userId, JSON.stringify({ from: previous?.iracing_cust_id ?? null, to: custRaw || null }), userId],
    );
}

/** À appeler hors transaction (voir verifyLogin). */
export async function changePassword(db: Db, userId: string, current: unknown, next: unknown) {
  const row = (await db.query("SELECT password_hash FROM users WHERE id=$1", [userId])).rows[0];
  await rateLimit(db, `password:${userId}`, 5);
  if (row?.password_hash && !verifyPassword(String(current ?? ""), row.password_hash)) throw new AppError("Mot de passe actuel incorrect.", 401);
  await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [userId, hashPassword(parse(password, next))]);
  await db.query("DELETE FROM auth_sessions WHERE user_id=$1", [userId]);
}

// ---------- Réinitialisation par l'organisation (sans serveur d'email) ----------

export const RESET_HOURS = 24;
const rank: Record<string, number> = { owner: 4, organizer: 3, steward: 2, captain: 1, driver: 1 };

/**
 * Crée un lien de réinitialisation à usage unique, à transmettre au pilote par l'organisation.
 * Un propriétaire peut réinitialiser tout compte sans rôle de propriétaire ; un organisateur, seulement
 * un pilote ou capitaine. Le rôle le plus élevé du compte dans *toutes* les ligues est pris en compte,
 * car le compte est commun : une ligue ne doit pas pouvoir prendre la main sur l'organisateur d'une autre.
 * Renvoie le jeton brut (seul son hachage est stocké).
 */
export async function createPasswordReset(db: Db, communityId: string, actorId: string, userId: string) {
  const actorRole = await requirePermission(db, communityId, actorId, "members.review");
  if (userId === actorId) throw new AppError("Utilisez « Changer mon mot de passe » dans votre profil.");
  const target = (
    await db.query(
      `SELECT u.email, u.disabled, m.status FROM users u
       JOIN memberships m ON m.user_id=u.id AND m.community_id=$1
       WHERE u.id=$2`,
      [communityId, userId],
    )
  ).rows[0];
  if (!target || !["pending", "accepted"].includes(target.status)) throw new AppError("Membre introuvable.", 404);
  if (target.disabled) throw new AppError("Ce compte est désactivé.");
  if (!target.email) throw new AppError("Ce compte se connecte uniquement avec Discord : pas de mot de passe à réinitialiser.");
  const highest = Math.max(
    0,
    ...(
      await db.query("SELECT role FROM memberships WHERE user_id=$1 AND status='accepted'", [userId])
    ).rows.map((r) => rank[r.role] ?? 0),
  );
  const limit = actorRole === "owner" ? rank.organizer : rank.driver;
  if (highest > limit)
    throw new AppError(
      actorRole === "owner"
        ? "Impossible pour un compte propriétaire : utilisez la commande user:password sur le serveur."
        : "Un organisateur ne peut réinitialiser que le compte d’un pilote ou d’un capitaine.",
      403,
    );
  await rateLimit(db, `reset-create:${actorId}`, 20, 60);
  await db.query("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [userId]);
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO password_resets(token_hash, user_id, community_id, created_by, expires_at)
     VALUES($1,$2,$3,$4, now() + interval '${RESET_HOURS} hours')`,
    [tokenHash(token), userId, communityId, actorId],
  );
  await audit(db, communityId, actorId, "password.reset_link", "user", userId, { hours: RESET_HOURS });
  return token;
}

/** Le lien est-il encore valable ? (affichage de la page, sans le consommer) */
export async function passwordResetValid(db: Db, token: string | undefined) {
  if (!token) return false;
  return (
    (await db.query("SELECT 1 FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()", [tokenHash(token)])).rowCount === 1
  );
}

/**
 * Consomme le lien : nouveau mot de passe, lien marqué utilisé, toutes les sessions du compte fermées.
 * Le mot de passe est validé avant de consommer le lien, pour qu'une saisie refusée ne le grille pas.
 */
export async function consumePasswordReset(db: Db, token: unknown, next: unknown) {
  const newPassword = parse(password, next);
  const row = (
    await db.query(
      `UPDATE password_resets SET used_at=now()
       WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, community_id`,
      [tokenHash(String(token ?? ""))],
    )
  ).rows[0];
  if (!row) throw new AppError("Lien invalide, expiré ou déjà utilisé. Demandez-en un nouveau à l’organisation.", 400);
  await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [row.user_id, hashPassword(newPassword)]);
  await db.query("DELETE FROM auth_sessions WHERE user_id=$1", [row.user_id]);
  await audit(db, row.community_id, row.user_id, "password.reset_done", "user", row.user_id);
  return row.user_id as string;
}

/** Réinitialisation sur le serveur (commande user:password), seule voie pour un compte propriétaire. */
export async function setPasswordByEmail(db: Db, rawEmail: string, next: unknown) {
  const newPassword = parse(password, next);
  const user = (await db.query("SELECT id FROM users WHERE email=$1", [parse(email, rawEmail)])).rows[0];
  if (!user) throw new AppError("Aucun compte avec cette adresse.", 404);
  await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [user.id, hashPassword(newPassword)]);
  await db.query("DELETE FROM auth_sessions WHERE user_id=$1", [user.id]);
  await db.query("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [user.id]);
  await audit(db, null, null, "password.reset_server", "user", user.id);
  return user.id as string;
}

// ---------- Première installation (serveur vierge) ----------

/** Vrai tant qu'aucun compte n'existe : la page /setup n'est utilisable qu'à ce moment-là. */
export async function needsSetup(db: Db) {
  return (await db.query("SELECT 1 FROM users LIMIT 1")).rowCount === 0;
}
