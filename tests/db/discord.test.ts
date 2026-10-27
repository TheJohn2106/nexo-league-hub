// Envoi Discord avec un transport simulé : aucun appel réseau réel.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity, updateDiscordSettings } from "../../src/lib/services/community.ts";
import { deliverPending, enqueue } from "../../src/lib/services/notifications.ts";
import { createChampionship, createRound } from "../../src/lib/services/championships.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

const WEBHOOK = "https://discord.com/api/webhooks/123456789/jeton-fictif_de-test";

test("file Discord : envoi, déduplication, limite 429, échecs et mentions restreintes", async () => {
  const owner = await makeUser(pool, "Orga");
  const driver = await makeUser(pool, "Pilote");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "ligue-discord", name: "Ligue Discord" }, owner)))!;
  await assert.rejects(run(pool, (db) => updateDiscordSettings(db, cid, owner, "https://exemple.test/hook", 24)), /webhook/);
  await assert.rejects(run(pool, (db) => updateDiscordSettings(db, cid, driver, WEBHOOK, 24)), /non autorisée/);
  await run(pool, (db) => updateDiscordSettings(db, cid, owner, WEBHOOK, 24));
  const champ = (await run(pool, (db) =>
    createChampionship(db, cid, owner, {
      name: "Coupe", slug: "", description: "", rulesMd: "", capacity: 10, registrationDeadline: null, categories: "", cars: "",
      requireCategory: false, requireCar: false, requireTeam: false, numberPolicy: "none", presenceDeadlineHours: 24,
      checkinOpensMinutes: 60, checkinClosesMinutes: 10, offerTtlHours: 12, protestWindowHours: 48, serverInfo: "", scoring: defaultScoring,
    }),
  ))!;
  const round = (await run(pool, (db) =>
    createRound(db, cid, owner, champ, { name: "M1", track: "Circuit fictif", trackConfig: "", startsAt: new Date(Date.now() + 5 * 86400000), capacity: "", serverInfo: "", notes: "", jokerEligible: true }),
  ))!;

  assert.equal(await run(pool, (db) => enqueue(db, cid, "round_announcement", `announce:${round}`, { roundId: round })), true);
  assert.equal(await run(pool, (db) => enqueue(db, cid, "round_announcement", `announce:${round}`, { roundId: round })), false);

  const calls: { url: string; body: { content: string; allowed_mentions: unknown } }[] = [];
  let mode: "ok" | "429" | "500" = "429";
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (mode === "429") return new Response("{}", { status: 429, headers: { "retry-after": "2" } });
    if (mode === "500") return new Response("err", { status: 500 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  let s = await run(pool, (db) => deliverPending(db, fake));
  assert.deepEqual(s, { sent: 0, skipped: 0, failed: 1 });
  assert.equal(calls[0].url, `${WEBHOOK}?wait=true`);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: ["users"] });
  assert.match(calls[0].body.content, /Manche 1 : M1/);
  // Pas de nouvel essai avant le délai demandé par Discord.
  mode = "ok";
  s = await run(pool, (db) => deliverPending(db, fake));
  assert.equal(s.sent, 0);
  await pool.query("UPDATE notification_outbox SET next_attempt_at=now()");
  s = await run(pool, (db) => deliverPending(db, fake));
  assert.equal(s.sent, 1);
  const row = (await pool.query("SELECT status, sent_at FROM notification_outbox")).rows[0];
  assert.equal(row.status, "sent");
  assert.ok(row.sent_at);
  // Un message envoyé ne repart jamais.
  s = await run(pool, (db) => deliverPending(db, fake));
  assert.equal(s.sent, 0);

  // Échecs répétés : abandon après 5 tentatives, statut « failed » (jamais « sent »).
  mode = "500";
  await run(pool, (db) => enqueue(db, cid, "presence_reminder", `reminder:${round}:${driver}`, { roundId: round, userId: driver }));
  for (let i = 0; i < 5; i++) {
    await pool.query("UPDATE notification_outbox SET next_attempt_at=now() WHERE status='pending'");
    await run(pool, (db) => deliverPending(db, fake));
  }
  const failed = (await pool.query("SELECT status, attempts, last_error FROM notification_outbox WHERE kind='presence_reminder'")).rows[0];
  assert.deepEqual([failed.status, failed.attempts, failed.last_error], ["failed", 5, "HTTP 500"]);

  // Suppression du webhook : les nouveaux messages sont « non envoyés », sans appel.
  await run(pool, (db) => updateDiscordSettings(db, cid, owner, "-", 24));
  const before = calls.length;
  await run(pool, (db) => enqueue(db, cid, "round_announcement", `announce:${round}:2`, { roundId: round }));
  s = await run(pool, (db) => deliverPending(db, fake));
  assert.deepEqual(s, { sent: 0, skipped: 1, failed: 0 });
  assert.equal(calls.length, before);
});
