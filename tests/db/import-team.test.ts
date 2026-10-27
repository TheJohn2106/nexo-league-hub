// Import d'une course en équipage multi-classe : rapprochement par l'équipage, décision exigée si ambiguïté.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity, decideMembership, requestJoin } from "../../src/lib/services/community.ts";
import { createChampionship, createRound, linkIracingSession, setChampionshipStatus } from "../../src/lib/services/championships.ts";
import { decideRegistration, registerForChampionship } from "../../src/lib/services/registrations.ts";
import { applyImport, getImport, importFile } from "../../src/lib/services/results.ts";
import { championshipStandings } from "../../src/lib/services/standings.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});
const fixture = readFileSync(new URL("../fixtures/iracing-results-get.team-multiclass.synthetic.json", import.meta.url), "utf8");
const champInput = (capacity: number) => ({
  name: "Sprint Cup",
  slug: "",
  description: "",
  rulesMd: "R",
  capacity,
  registrationDeadline: null,
  categories: "",
  cars: "",
  requireCategory: false,
  requireCar: false,
  requireTeam: false,
  numberPolicy: "free",
  presenceDeadlineHours: 1,
  checkinOpensMinutes: 30,
  checkinClosesMinutes: 5,
  offerTtlHours: 2,
  protestWindowHours: 24,
  serverInfo: "secret",
  scoring: defaultScoring,
});
const reg = { category: "", car: "", teamId: "", newTeamName: "", raceNumber: "", acceptedRulesVersion: 1, note: "" };

test("course en équipage : rapprochement par l'équipage et choix explicite si plusieurs inscrits", async () => {
  const owner = await makeUser(pool, "Orga");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "endurance", name: "Endurance" }, owner)))!;
  const champ = (await run(pool, (db) => createChampionship(db, cid, owner, { ...champInput(10), scoring: { ...defaultScoring, positionBasis: "class" } })))!;
  await run(pool, (db) => setChampionshipStatus(db, cid, owner, champ, "open"));
  const ids: Record<string, string> = {};
  for (const [name, cust] of [["Noah", 900006], ["Alex", 900001], ["Sam", 900002], ["Lea", 900003], ["Jade", 900007]] as const) {
    const u = await makeUser(pool, name, cust);
    await run(pool, (db) => requestJoin(db, cid, u, ""));
    await run(pool, (db) => decideMembership(db, cid, owner, u, "accepted"));
    await run(pool, (db) => registerForChampionship(db, cid, u, champ, reg));
    const r = (await pool.query("SELECT id FROM registrations WHERE user_id=$1", [u])).rows[0].id;
    await run(pool, (db) => decideRegistration(db, cid, owner, r, "accepted"));
    ids[name] = u;
  }
  const round = (await run(pool, (db) =>
    createRound(db, cid, owner, champ, { name: "6 h", track: "Circuit fictif", trackConfig: "", startsAt: new Date(Date.now() + 86400000), capacity: "", serverInfo: "", notes: "", jokerEligible: true }),
  ))!;
  await pool.query("UPDATE round_sessions SET starts_at=now()-interval '8 hours' WHERE round_id=$1", [round]);
  const race = (await pool.query("SELECT id FROM round_sessions WHERE round_id=$1 AND kind='race'", [round])).rows[0].id;
  await run(pool, (db) => linkIracingSession(db, cid, owner, race, "81234999", ""));
  const imp = (await run(pool, (db) => importFile(db, cid, owner, race, "6h.json", fixture)))!;
  const pre = await getImport(pool, cid, imp.importId);
  const how = Object.fromEntries(pre.suggestions.map((s) => [s.entryKey, [s.how, s.userId]]));
  assert.deepEqual(how["team:-501"], ["none", null]);
  assert.deepEqual(how["team:-502"], ["crew", ids.Noah]);
  assert.equal(how["team:-503"][0], "crew_choice");
  assert.deepEqual(how["team:-504"], ["crew", ids.Lea]);
  assert.deepEqual(how["team:-505"], ["crew", ids.Jade]);
  // Voiture partagée par deux inscrits : la décision est obligatoire.
  await assert.rejects(run(pool, (db) => applyImport(db, cid, owner, imp.importId, { final: true, matches: { "team:-501": "none" }, saveIracingIds: false })), /Rapprochement/);
  await run(pool, (db) => applyImport(db, cid, owner, imp.importId, { final: true, matches: { "team:-501": "none", "team:-503": ids.Alex }, saveIracingIds: false }));
  const { output } = await run(pool, (db) => championshipStandings(db, cid, champ));
  const p = (u: string) => output.drivers.find((d) => d.userId === u)!.points;
  // Base « classe » : Noah 2e GTP derrière une voiture non inscrite, Alex 1er GT3, Léa 2e GT3, Jade abandon.
  // Pole et meilleur tour GT3 : Léa (la pole se lit dans la qualification, ici non importée : seul le meilleur tour compte).
  assert.equal(p(ids.Alex), defaultScoring.pointsByPosition[0]);
  assert.equal(p(ids.Lea), defaultScoring.pointsByPosition[1] + 1);
  assert.equal(p(ids.Noah), defaultScoring.pointsByPosition[1]);
  assert.equal(p(ids.Sam), 0);
});
