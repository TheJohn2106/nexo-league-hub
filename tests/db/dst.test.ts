// Rappels de présence autour du passage à l'heure d'hiver (Europe/Brussels) : déclenchement à l'instant exact, une seule fois.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity, decideMembership, requestJoin } from "../../src/lib/services/community.ts";
import { createChampionship, createRound, setChampionshipStatus } from "../../src/lib/services/championships.ts";
import { decideRegistration, registerForChampionship } from "../../src/lib/services/registrations.ts";
import { scheduleReminders } from "../../src/lib/services/notifications.ts";
import { roundWindows } from "../../src/lib/services/attendance.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";
import { zonedLocalToUtc } from "../../src/lib/time.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

test("rappel 24 h avant la limite de réponse, la limite étant de l'autre côté du changement d'heure", async () => {
  const owner = await makeUser(pool, "Orga");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "ligue-hiver", name: "Ligue Hiver" }, owner)))!;
  await pool.query("UPDATE communities SET discord_reminder_hours=24 WHERE id=$1", [cid]);
  const champ = (await run(pool, (db) =>
    createChampionship(db, cid, owner, {
      name: "Hiver",
      slug: "",
      description: "",
      rulesMd: "R",
      capacity: 10,
      registrationDeadline: null,
      categories: "",
      cars: "",
      requireCategory: false,
      requireCar: false,
      requireTeam: false,
      numberPolicy: "free",
      presenceDeadlineHours: 48,
      checkinOpensMinutes: 60,
      checkinClosesMinutes: 10,
      offerTtlHours: 12,
      protestWindowHours: 24,
      serverInfo: "",
      scoring: defaultScoring,
    }),
  ))!;
  await run(pool, (db) => setChampionshipStatus(db, cid, owner, champ, "open"));
  const driver = await makeUser(pool, "Pilote", 900111);
  await run(pool, (db) => requestJoin(db, cid, driver, ""));
  await run(pool, (db) => decideMembership(db, cid, owner, driver, "accepted"));
  await run(pool, (db) => registerForChampionship(db, cid, driver, champ, { category: "", car: "", teamId: "", newTeamName: "", raceNumber: "", acceptedRulesVersion: 1, note: "" }));
  const reg = (await pool.query("SELECT id FROM registrations WHERE user_id=$1", [driver])).rows[0].id;
  await run(pool, (db) => decideRegistration(db, cid, owner, reg, "accepted"));
  // Lundi 26 octobre 2026, 20:30 heure d'hiver (19:30 UTC). Limite : samedi 24, 21:30 heure d'été (19:30 UTC). Rappel : vendredi 23, 21:30.
  const startsAt = zonedLocalToUtc("2026-10-26T20:30", "Europe/Brussels");
  await run(pool, (db) => createRound(db, cid, owner, champ, { name: "Nuit", track: "Circuit fictif", trackConfig: "", startsAt, capacity: "", serverInfo: "", notes: "", jokerEligible: true }));

  const deadline = roundWindows({ starts_at: startsAt, presence_deadline_hours: 48, checkin_opens_minutes: 60, checkin_closes_minutes: 10 }).presenceDeadline;
  assert.equal(deadline.toISOString(), "2026-10-24T19:30:00.000Z");
  const at = (iso: string) => run(pool, async (db) => {
    // Le fuseau de la session SQL ne doit rien changer : tout est calculé en durées absolues.
    await db.query("SET LOCAL TIME ZONE 'Europe/Brussels'");
    return scheduleReminders(db, new Date(iso));
  });
  assert.equal(await at("2026-10-23T19:29:59Z"), 0, "pas avant l'heure");
  assert.equal(await at("2026-10-23T19:30:00Z"), 1, "à l'heure exacte");
  assert.equal(await at("2026-10-24T08:00:00Z"), 0, "jamais deux fois");
  assert.equal((await pool.query("SELECT count(*)::int n FROM notification_outbox WHERE kind='presence_reminder'")).rows[0].n, 1);
  await pool.query("DELETE FROM notification_outbox");
  assert.equal(await at("2026-10-24T19:30:00Z"), 0, "plus de rappel une fois la limite atteinte");
});
