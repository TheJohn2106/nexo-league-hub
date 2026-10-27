import { getPool } from "@/lib/db";
import { exchangeToken, fetchData, callbackUrl, iracingConfigured, IRacingError } from "@/lib/integrations/iracing-client";
import { consumeOAuthState, seeOther } from "@/lib/oauth";
import { saveTokens } from "@/lib/services/iracing";
import { currentUser } from "@/lib/session";

export async function GET(request: Request) {
  const back = (code: string) => seeOther(`/profile?iracing=${code}`);
  if (!iracingConfigured()) return back("configuration");
  const q = new URL(request.url).searchParams;
  const flow = await consumeOAuthState("iracing", q.get("state"));
  const user = await currentUser();
  if (!flow || !user || flow.userId !== user.id || !flow.verifier) return back("failed");
  if (q.has("error") || !q.get("code")) return back("cancelled");
  try {
    const tokens = await exchangeToken({ grant_type: "authorization_code", code: q.get("code")!, code_verifier: flow.verifier, redirect_uri: callbackUrl() });
    const info = (await fetchData("/member/info", tokens.access_token)) as { cust_id?: unknown };
    const custId = Number(info?.cust_id);
    if (!Number.isSafeInteger(custId) || custId <= 0) throw new IRacingError("provider");
    const pool = getPool();
    const taken = (await pool.query("SELECT 1 FROM iracing_connections WHERE cust_id=$1 AND user_id<>$2", [custId, user.id])).rowCount;
    if (taken) throw new IRacingError("identity");
    await saveTokens(pool, user.id, custId, tokens);
    // Renseigne l'identifiant iRacing du profil s'il est vide et libre (vérifié, puisque issu d'OAuth).
    await pool.query(
      "UPDATE driver_profiles SET iracing_cust_id=$2 WHERE user_id=$1 AND iracing_cust_id IS NULL AND NOT EXISTS (SELECT 1 FROM driver_profiles WHERE iracing_cust_id=$2)",
      [user.id, custId],
    );
    return back("linked");
  } catch (e) {
    return back(e instanceof IRacingError ? e.code : "failed");
  }
}
