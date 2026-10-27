import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getPool } from "./db.ts";
import { AppError } from "./errors.ts";
import { can, type Permission } from "./permissions.ts";
import { getCommunityBySlug, membershipOf } from "./services/context.ts";
import { currentUser } from "./session.ts";

/** Contexte d'une page de ligue : communauté, utilisateur, adhésion et rôle effectif. */
export const loadLeague = cache(async (slug: string) => {
  let community;
  try {
    community = await getCommunityBySlug(getPool(), slug);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  const user = await currentUser();
  const membership = await membershipOf(getPool(), community.id, user?.id);
  const role = membership?.status === "accepted" ? membership.role : null;
  return { community, user, membership, role, db: getPool() };
});

/** Page d'administration : refuse l'accès sans la permission (contrôle serveur). */
export async function requireLeaguePermission(slug: string, permission: Permission, path: string) {
  const ctx = await loadLeague(slug);
  if (!ctx.user) redirect(`/login?next=${encodeURIComponent(path)}`);
  if (!can(ctx.role, permission)) redirect(`/c/${slug}?error=${encodeURIComponent("Accès réservé à l’équipe d’organisation.")}`);
  return { ...ctx, user: ctx.user };
}
