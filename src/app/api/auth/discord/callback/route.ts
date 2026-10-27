import { z } from "zod";
import { getPool, tx } from "@/lib/db";
import { createSession } from "@/lib/services/accounts";
import { consumeOAuthState, discordCallback, discordConfigured, seeOther } from "@/lib/oauth";
import { currentUser, setSessionCookie } from "@/lib/session";

const profileSchema = z.object({ id: z.string().regex(/^\d+$/), username: z.string(), global_name: z.string().nullable().optional() });

export async function GET(request: Request) {
  if (!discordConfigured()) return seeOther("/login?discord=unavailable");
  const params = new URL(request.url).searchParams;
  const flow = await consumeOAuthState("discord", params.get("state"));
  if (!flow || params.has("error") || !params.get("code")) return seeOther("/login?discord=failed");
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code: params.get("code")!,
        redirect_uri: discordCallback(),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) throw new Error("token");
    const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json());
    const me = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!me.ok) throw new Error("profile");
    const profile = profileSchema.parse(await me.json());
    const viewer = await currentUser();
    let linkedTo: string;
    if (flow.userId) {
      // Liaison : la session qui a lancé le flux doit être toujours la même.
      if (viewer?.id !== flow.userId) throw new Error("session");
      linkedTo = await tx(async (db) => {
        const existing = (await db.query("SELECT user_id FROM discord_identities WHERE discord_id=$1", [profile.id])).rows[0];
        if (existing && existing.user_id !== flow.userId) throw new Error("already-linked");
        await db.query(
          "INSERT INTO discord_identities(discord_id, user_id, username) VALUES($1,$2,$3) ON CONFLICT(discord_id) DO UPDATE SET username=EXCLUDED.username",
          [profile.id, flow.userId, profile.username],
        );
        return flow.userId!;
      });
      return seeOther(`${flow.returnTo}${flow.returnTo.includes("?") ? "&" : "?"}ok=${encodeURIComponent("Compte Discord lié.")}`);
    }
    linkedTo = await tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(72722403)");
      const existing = (await db.query("SELECT d.user_id FROM discord_identities d JOIN users u ON u.id=d.user_id WHERE d.discord_id=$1 AND NOT u.disabled", [profile.id])).rows[0];
      if (existing) return existing.user_id as string;
      // Nouveau compte sans email ni mot de passe : pseudo Discord, rendu unique si besoin.
      const base = (profile.global_name || profile.username).replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 32).padEnd(2, "_");
      let name = base;
      for (let i = 2; (await db.query("SELECT 1 FROM users WHERE lower(display_name)=lower($1)", [name])).rowCount; i++) name = `${base} ${i}`;
      const u = (await db.query("INSERT INTO users(display_name) VALUES($1) RETURNING id", [name])).rows[0];
      await db.query("INSERT INTO driver_profiles(user_id) VALUES($1)", [u.id]);
      await db.query("INSERT INTO discord_identities(discord_id, user_id, username) VALUES($1,$2,$3)", [profile.id, u.id, profile.username]);
      return u.id as string;
    });
    await setSessionCookie(await createSession(getPool(), linkedTo));
    return seeOther(flow.returnTo);
  } catch (e) {
    console.warn("Discord OAuth échoué :", e instanceof Error ? e.message : "inconnu");
    return seeOther(flow.userId ? `/profile?error=${encodeURIComponent("Liaison Discord impossible (compte déjà lié à un autre profil ?).")}` : "/login?discord=failed");
  }
}
