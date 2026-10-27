// Connexion OAuth iRacing d'un organisateur et récupération d'un résultat de sous-session.
// Reprend le client OAuth/Data API du Rabbit Hub (PKCE, jetons chiffrés AES-256-GCM, URL de données vérifiées).
import type { Pool } from "pg";
import { AppError } from "../errors.ts";
import {
  decryptTokens,
  encryptTokens,
  exchangeToken,
  fetchData,
  iracingConfigured,
  IRacingError,
  type Tokens,
  type Transport as ClientTransport,
} from "../integrations/iracing-client.ts";

export type Transport = ClientTransport;

export function iracingApiStatus() {
  if (iracingConfigured()) return { configured: true, message: "API iRacing configurée." };
  return {
    configured: false,
    message:
      "API iRacing non configurée : renseignez IRACING_CLIENT_ID (client OAuth enregistré chez iRacing, audience data-server), " +
      "IRACING_TOKEN_KEY (64 caractères hexadécimaux) et APP_ORIGIN, puis connectez votre compte iRacing dans votre profil. " +
      "En attendant, utilisez l’import de fichier ou la saisie manuelle.",
  };
}

const messages: Record<string, string> = {
  configuration: "API iRacing non configurée sur ce serveur.",
  reconnect: "Autorisation iRacing expirée ou révoquée : reconnectez votre compte iRacing dans votre profil.",
  "rate-limit": "Limite de requêtes iRacing atteinte : nouvelle tentative possible dans quelques minutes.",
  provider: "Le service iRacing n’a pas répondu correctement. Réessayez plus tard.",
  "data-link": "Lien de téléchargement iRacing inattendu : opération refusée par sécurité.",
  "data-path": "Requête iRacing non autorisée.",
  scope: "Autorisation iRacing incomplète (scope iracing.auth requis).",
  "not-linked": "Aucun compte iRacing connecté pour votre profil. Connectez-le depuis « Mon profil ».",
  busy: "Une synchronisation iRacing est déjà en cours pour votre compte.",
};
export function iracingMessage(code: string) {
  return messages[code] ?? "Erreur iRacing inattendue.";
}

class ApiError extends AppError {
  code: string;
  constructor(code: string, status = 502) {
    super(iracingMessage(code), status);
    this.code = code;
  }
}

export async function saveTokens(pool: Pool, userId: string, custId: number, tokens: Tokens) {
  await pool.query(
    `INSERT INTO iracing_connections(user_id, cust_id, tokens, expires_at) VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id) DO UPDATE SET cust_id=EXCLUDED.cust_id, tokens=EXCLUDED.tokens, expires_at=EXCLUDED.expires_at, last_error=NULL, updated_at=now()`,
    [userId, custId, encryptTokens(tokens), new Date(Date.now() + tokens.expires_in * 1000)],
  );
}

/** Jeton valide de l'utilisateur (renouvelé si besoin, sous verrou pour ne jamais réutiliser un refresh token). */
async function accessToken(pool: Pool, userId: string, transport: Transport) {
  const db = await pool.connect();
  try {
    const locked = (await db.query("SELECT pg_try_advisory_lock(hashtextextended($1, 4242)) AS ok", [userId])).rows[0].ok;
    if (!locked) throw new ApiError("busy", 409);
    try {
      const c = (await db.query("SELECT * FROM iracing_connections WHERE user_id=$1", [userId])).rows[0];
      if (!c) throw new ApiError("not-linked", 400);
      let tokens = decryptTokens(c.tokens);
      if (new Date(c.expires_at).getTime() < Date.now() + 60000) {
        if (!tokens.refresh_token) throw new ApiError("reconnect", 401);
        tokens = await exchangeToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, transport);
        await saveTokens(pool, userId, Number(c.cust_id), tokens);
      }
      return tokens.access_token;
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 4242))", [userId]);
    }
  } catch (e) {
    if (e instanceof IRacingError) {
      await pool.query("UPDATE iracing_connections SET last_error=$2 WHERE user_id=$1", [userId, e.code]);
      throw new ApiError(e.code);
    }
    throw e;
  } finally {
    db.release();
  }
}

export async function fetchSubsessionResult(pool: Pool, userId: string, subsessionId: number, transport: Transport = fetch) {
  if (!iracingConfigured()) throw new ApiError("configuration", 400);
  const token = await accessToken(pool, userId, transport);
  try {
    return await fetchData(`/results/get?subsession_id=${subsessionId}`, token, transport);
  } catch (e) {
    if (e instanceof IRacingError) {
      if (e.code === "reconnect") await pool.query("UPDATE iracing_connections SET last_error='reconnect' WHERE user_id=$1", [userId]);
      throw new ApiError(e.code, e.code === "rate-limit" ? 429 : 502);
    }
    throw new ApiError("provider");
  }
}

export async function connectionStatus(pool: Pool, userId: string) {
  return (
    (await pool.query(`SELECT cust_id AS "custId", expires_at AS "expiresAt", last_error AS "lastError", updated_at AS "updatedAt" FROM iracing_connections WHERE user_id=$1`, [userId])).rows[0] ??
    null
  );
}
