import "server-only";
import type { PoolClient } from "pg";
import { redirect } from "next/navigation";
import { getPool, tx } from "./db.ts";
import { AppError } from "./errors.ts";
import { getCommunityBySlug, type Community } from "./services/context.ts";
import { currentUser } from "./session.ts";
import type { SessionUser } from "./services/accounts.ts";

export const str = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Chemin de retour sûr (interne uniquement). */
export function safePath(path: string | null | undefined, fallback = "/") {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return fallback;
  return path;
}
export function withFlash(path: string, kind: "ok" | "error", message: string) {
  const [base, hash] = path.split("#");
  const url = new URL(base, "http://x");
  url.searchParams.delete("ok");
  url.searchParams.delete("error");
  url.searchParams.set(kind, message.slice(0, 300));
  return url.pathname + url.search + (hash ? `#${hash}` : "");
}

/**
 * Exécute une action serveur : utilisateur connecté requis, communauté résolue par slug,
 * transaction, puis redirection avec message. Les erreurs métier deviennent un message ; les autres sont journalisées.
 */
export async function perform(
  form: FormData,
  fn: (db: PoolClient, user: SessionUser, community: Community) => Promise<string | void>,
  success = "Enregistré.",
  options: { noTx?: boolean } = {},
) {
  const back = safePath(str(form, "back"), "/");
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(back)}`);
  let target: string;
  try {
    const community = await getCommunityBySlug(getPool(), str(form, "slug"));
    const out = options.noTx
      ? await fn(getPool() as unknown as PoolClient, user, community)
      : await tx((db) => fn(db, user, community));
    target = typeof out === "string" && out.startsWith("/") ? withFlash(out, "ok", success) : withFlash(back, "ok", typeof out === "string" && out ? out : success);
  } catch (e) {
    if (e instanceof AppError) target = withFlash(back, "error", e.message);
    else {
      console.error("Action échouée", e);
      target = withFlash(back, "error", "Erreur inattendue. Réessayez ; si le problème persiste, contactez l’organisateur.");
    }
  }
  redirect(target);
}
