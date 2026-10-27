import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import { Configuration, MemberApi, ResultsApi } from "@iracing-data/api-client-fetch";

export const oauthBase = "https://oauth.iracing.com/oauth2";
export const dataBase = "https://members-ng.iracing.com/data";
export class IRacingError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function iracingConfigured() {
  return !!(
    process.env.IRACING_CLIENT_ID &&
    process.env.APP_ORIGIN &&
    /^[a-f\d]{64}$/i.test(process.env.IRACING_TOKEN_KEY ?? "")
  );
}
export function callbackUrl() {
  return new URL("/api/auth/iracing/callback", process.env.APP_ORIGIN!).href;
}
export function maskSecret(secret: string, id: string) {
  return createHash("sha256")
    .update(secret + id.trim().toLowerCase())
    .digest("base64");
}
function encryptionKey() {
  if (!/^[a-f\d]{64}$/i.test(process.env.IRACING_TOKEN_KEY ?? ""))
    throw new IRacingError("configuration");
  return Buffer.from(process.env.IRACING_TOKEN_KEY!, "hex");
}
export function encryptTokens(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function decryptTokens(value: string) {
  const [iv, tag, body] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return tokenSchema.parse(
    JSON.parse(
      Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8"),
    ),
  );
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().positive(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
export type Tokens = z.infer<typeof tokenSchema>;
export type Transport = typeof fetch;
export async function exchangeToken(
  params: Record<string, string>,
  transport: Transport = fetch,
): Promise<Tokens> {
  const form = new URLSearchParams({
    ...params,
    client_id: process.env.IRACING_CLIENT_ID!,
  });
  if (process.env.IRACING_CLIENT_SECRET)
    form.set(
      "client_secret",
      maskSecret(
        process.env.IRACING_CLIENT_SECRET,
        process.env.IRACING_CLIENT_ID!,
      ),
    );
  const response = await transport(oauthBase + "/token", {
    method: "POST",
    body: form,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new IRacingError(
      response.status === 400 || response.status === 401
        ? "reconnect"
        : "provider",
    );
  const token = tokenSchema.parse(await response.json());
  if (!token.scope?.split(/\s+/).includes("iracing.auth"))
    throw new IRacingError("scope");
  return token;
}
export function trustedDataLink(value: string) {
  const u = new URL(value);
  const host = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !(
      host === "members-ng.iracing.com" ||
      host === "members-assets.iracing.com" ||
      host.endsWith(".s3.amazonaws.com") ||
      /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)
    )
  )
    throw new IRacingError("data-link");
  return u.href;
}
export async function fetchData(
  path: string,
  token: string,
  transport: Transport = fetch,
): Promise<unknown> {
  if (!/^\/[a-z_]+\/[a-z_]+(?:\?.*)?$/.test(path))
    throw new IRacingError("data-path");
  const config = new Configuration({
    basePath: new URL(dataBase).origin,
    accessToken: token,
    fetchApi: (url, init) => transport(url, {
      ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    }),
  });
  const endpoint = new URL(dataBase + path);
  let response: Response;
  try {
    // Client généré (repris de Rabbit) ; seuls member/info et results/get sont autorisés dans Nexo.
    if (endpoint.pathname === "/data/member/info" && !endpoint.search) {
      response = (await new MemberApi(config).getMemberInfoRaw()).raw;
    } else if (endpoint.pathname === "/data/results/get") {
      const id = Number(endpoint.searchParams.get("subsession_id"));
      if (!Number.isSafeInteger(id) || id <= 0) throw new IRacingError("data-path");
      response = (await new ResultsApi(config).getResultsRaw({ subsession_id: id })).raw;
    } else {
      throw new IRacingError("data-path");
    }
  } catch (error) {
    // This published ES5 client does not preserve instanceof for Error subclasses.
    if (error instanceof Error && error.name === "ResponseError" && "response" in error && error.response instanceof Response) response = error.response;
    else throw error;
  }
  if (!response.ok)
    throw new IRacingError(
      response.status === 401
        ? "reconnect"
        : response.status === 429
          ? "rate-limit"
          : "provider",
    );
  const body = await response.json();
  if (body && typeof body.link === "string") {
    // Signed download URLs receive no bearer token or cookies.
    const download = await transport(trustedDataLink(body.link), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!download.ok) throw new IRacingError("provider");
    return download.json();
  }
  return body;
}
