// Récupération Data API de bout en bout avec un iRacing simulé (aucun appel réseau) : erreurs, reprise automatique, succès.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity } from "../../src/lib/services/community.ts";
import { createChampionship, createRound, linkIracingSession } from "../../src/lib/services/championships.ts";
import { importFromIracingApi, retryDueSyncFailures } from "../../src/lib/services/results.ts";
import { saveTokens } from "../../src/lib/services/iracing.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";

let pool: Pool;
before(async () => {
  process.env.IRACING_CLIENT_ID = "client-de-test";
  process.env.APP_ORIGIN = "http://localhost:3000";
  process.env.IRACING_TOKEN_KEY = "a".repeat(64);
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});
const fixture = readFileSync(new URL("../fixtures/iracing-results-get.synthetic.json", import.meta.url), "utf8");

test("API iRacing simulée : limite 429, erreur serveur, reprise automatique puis aperçu", async () => {
  const owner = await makeUser(pool, "Orga");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "api-ligue", name: "API" }, owner)))!;
  const champ = (await run(pool, (db) =>
    createChampionship(db, cid, owner, {
      name: "Coupe", slug: "", description: "", rulesMd: "", capacity: 10, registrationDeadline: null, categories: "", cars: "",
      requireCategory: false, requireCar: false, requireTeam: false, numberPolicy: "none", presenceDeadlineHours: 24,
      checkinOpensMinutes: 60, checkinClosesMinutes: 10, offerTtlHours: 12, protestWindowHours: 48, serverInfo: "", scoring: defaultScoring,
    }),
  ))!;
  const round = (await run(pool, (db) =>
    createRound(db, cid, owner, champ, { name: "M1", track: "Circuit fictif", trackConfig: "", startsAt: new Date(Date.now() + 86400000), capacity: "", serverInfo: "", notes: "", jokerEligible: true }),
  ))!;
  const race = (await pool.query("SELECT id FROM round_sessions WHERE round_id=$1 AND kind='race'", [round])).rows[0].id;
  await run(pool, (db) => linkIracingSession(db, cid, owner, race, "81234567", ""));

  // Sans compte iRacing connecté : échec non repris automatiquement.
  await assert.rejects(importFromIracingApi(pool, cid, owner, race, (async () => new Response("{}")) as unknown as typeof fetch), /Aucun compte iRacing/);
  let f = (await pool.query("SELECT code, attempts, retry_after FROM sync_failures")).rows[0];
  assert.deepEqual([f.code, f.attempts, f.retry_after], ["not-linked", 1, null]);
  await pool.query("DELETE FROM sync_failures");

  await saveTokens(pool, owner, 900100, { access_token: "jeton-fictif", token_type: "Bearer", expires_in: 3600, refresh_token: "r", scope: "iracing.auth" });
  const calls: { url: string; auth: string | null }[] = [];
  let mode: number = 429;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
    calls.push({ url: u, auth: headers.get("authorization") });
    if (u.startsWith("https://members-assets.iracing.com/")) return new Response(fixture, { status: 200 });
    if (mode !== 200) return new Response("{}", { status: mode });
    return Response.json({ link: "https://members-assets.iracing.com/resultats-fictifs.json", expires: "2026-11-01T00:00:00Z" });
  }) as unknown as typeof fetch;

  await assert.rejects(importFromIracingApi(pool, cid, owner, race, fake), /Limite de requêtes/);
  assert.match(calls[0].url, /\/data\/results\/get\?subsession_id=81234567$/);
  assert.equal(calls[0].auth, "Bearer jeton-fictif");
  f = (await pool.query("SELECT code, attempts, actor_id, retry_after FROM sync_failures WHERE resolved_at IS NULL")).rows[0];
  assert.equal(f.code, "rate-limit");
  assert.equal(f.actor_id, owner);
  const wait = (new Date(f.retry_after).getTime() - Date.now()) / 60000;
  assert.ok(wait > 14 && wait <= 15, `délai ${wait}`);

  // Pas encore dû : rien n'est repris.
  assert.deepEqual(await retryDueSyncFailures(pool, fake), { retried: 0, recovered: 0, failed: 0 });
  // Dû, iRacing en erreur serveur : nouvel essai programmé plus tard, une seule ligne d'échec.
  mode = 503;
  const later = new Date(Date.now() + 16 * 60000);
  assert.equal((await retryDueSyncFailures(pool, fake, later)).failed, 1);
  f = (await pool.query("SELECT code, attempts, retry_after FROM sync_failures WHERE resolved_at IS NULL")).rows[0];
  assert.deepEqual([f.code, f.attempts], ["provider", 2]);
  assert.ok(f.retry_after);
  assert.equal((await pool.query("SELECT count(*)::int n FROM sync_failures")).rows[0].n, 1);

  // Dû, iRacing répond : aperçu créé, échec résolu, le lien signé ne reçoit pas le jeton.
  mode = 200;
  const r = await retryDueSyncFailures(pool, fake, new Date(Date.now() + 3 * 3600000));
  assert.deepEqual(r, { retried: 1, recovered: 1, failed: 0 });
  const dl = calls.find((c) => c.url.startsWith("https://members-assets.iracing.com/"))!;
  assert.equal(dl.auth, null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM sync_failures WHERE resolved_at IS NULL")).rows[0].n, 0);
  const imp = (await pool.query("SELECT source, status, parsed->'rows' AS rows FROM result_imports WHERE session_id=$1", [race])).rows[0];
  assert.deepEqual([imp.source, imp.status, imp.rows.length], ["iracing_api", "preview", 5]);

  // Même résultat récupéré à nouveau : réutilisation de l'aperçu, pas de doublon.
  const again = await importFromIracingApi(pool, cid, owner, race, fake);
  assert.equal(again.duplicate, true);

  // Autorisation révoquée (401) : pas de reprise automatique, action humaine requise.
  mode = 401;
  await assert.rejects(importFromIracingApi(pool, cid, owner, race, fake), /reconnectez/);
  f = (await pool.query("SELECT code, retry_after FROM sync_failures WHERE resolved_at IS NULL")).rows[0];
  assert.deepEqual([f.code, f.retry_after], ["reconnect", null]);
});

test("abandon de la reprise après 5 essais", async () => {
  const s = (await pool.query("SELECT session_id, community_id, actor_id FROM sync_failures LIMIT 1")).rows[0];
  await pool.query("DELETE FROM sync_failures");
  const { recordSyncFailure, MAX_SYNC_ATTEMPTS } = await import("../../src/lib/services/results.ts");
  for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) await recordSyncFailure(pool, s.community_id, s.session_id, s.actor_id, "provider", "HTTP 503");
  const f = (await pool.query("SELECT attempts, retry_after FROM sync_failures")).rows[0];
  assert.deepEqual([f.attempts, f.retry_after], [MAX_SYNC_ATTEMPTS, null]);
});
