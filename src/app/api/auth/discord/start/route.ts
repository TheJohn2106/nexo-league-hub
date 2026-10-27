import { isSameOrigin } from "@/lib/http";
import { createOAuthState, discordCallback, discordConfigured, seeOther } from "@/lib/oauth";
import { currentUser } from "@/lib/session";
import { safePath } from "@/lib/web";

// Connexion ou liaison Discord (scope identify uniquement : aucun email demandé).
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response(null, { status: 403 });
  if (!discordConfigured()) return seeOther("/login?discord=unavailable");
  const user = await currentUser();
  const form = await request.formData();
  const next = safePath(String(form.get("next") ?? ""), user ? "/profile" : "/");
  const state = await createOAuthState("discord", user?.id ?? null, next);
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID!,
    redirect_uri: discordCallback(),
    response_type: "code",
    scope: "identify",
    state,
  }).toString();
  return seeOther(url.href);
}
