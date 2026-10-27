import { createHash, randomBytes } from "node:crypto";
import { isSameOrigin } from "@/lib/http";
import { callbackUrl, iracingConfigured, oauthBase } from "@/lib/integrations/iracing-client";
import { createOAuthState, seeOther } from "@/lib/oauth";
import { currentUser } from "@/lib/session";

// OAuth iRacing (authorization code + PKCE), repris du Rabbit Hub.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response(null, { status: 403 });
  const user = await currentUser();
  if (!user) return seeOther("/login?next=/profile");
  if (!iracingConfigured()) return seeOther("/profile?iracing=configuration");
  const verifier = randomBytes(32).toString("base64url");
  const state = await createOAuthState("iracing", user.id, "/profile", verifier);
  const url = new URL(oauthBase + "/authorize");
  url.search = new URLSearchParams({
    client_id: process.env.IRACING_CLIENT_ID!,
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: "iracing.auth",
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  return seeOther(url.href);
}
