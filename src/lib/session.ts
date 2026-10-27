import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getPool } from "./db.ts";
import { SESSION_DAYS, userFromToken, type SessionUser } from "./services/accounts.ts";

export const SESSION_COOKIE = "nexo_session";
/** Lien de réinitialisation venant d’être créé, affiché une fois sur la page Membres (2 minutes). */
export const RESET_LINK_COOKIE = "nexo_reset_link";

export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return userFromToken(getPool(), token);
});

export async function requireUser(next = "/") {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

/** Clé client pour la limitation des tentatives (adresse transmise par le proxy, sinon inconnue). */
export async function clientKey() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "unknown";
}
