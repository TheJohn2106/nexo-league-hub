import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getPool } from "./db.ts";
import { tokenHash } from "./password.ts";

// État OAuth à usage unique (10 minutes) : haché en base, valeur brute en cookie httpOnly.
const cookieName = (provider: string) => `nexo_${provider}_state`;

export async function createOAuthState(provider: "discord" | "iracing", userId: string | null, returnTo: string, verifier: string | null = null) {
  const db = getPool();
  await db.query("DELETE FROM oauth_states WHERE expires_at < now()");
  if (userId) await db.query("DELETE FROM oauth_states WHERE provider=$1 AND user_id=$2", [provider, userId]);
  const state = randomBytes(32).toString("hex");
  await db.query("INSERT INTO oauth_states(state_hash, provider, user_id, verifier, return_to, expires_at) VALUES($1,$2,$3,$4,$5, now() + interval '10 minutes')", [
    tokenHash(state),
    provider,
    userId,
    verifier,
    returnTo,
  ]);
  (await cookies()).set(cookieName(provider), state, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return state;
}

/** Consomme l'état : null si absent, expiré ou différent du cookie. */
export async function consumeOAuthState(provider: "discord" | "iracing", state: string | null) {
  const jar = await cookies();
  const expected = jar.get(cookieName(provider))?.value;
  jar.delete(cookieName(provider));
  if (!state || state !== expected || !/^[a-f0-9]{64}$/.test(state)) return null;
  const row = (
    await getPool().query("DELETE FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at > now() RETURNING user_id, verifier, return_to", [
      tokenHash(state),
      provider,
    ])
  ).rows[0];
  return row ? { userId: row.user_id as string | null, verifier: row.verifier as string | null, returnTo: row.return_to as string } : null;
}

export function seeOther(location: string) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

export function discordConfigured() {
  return !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.APP_ORIGIN);
}
export function discordCallback() {
  return new URL("/api/auth/discord/callback", process.env.APP_ORIGIN!).href;
}
