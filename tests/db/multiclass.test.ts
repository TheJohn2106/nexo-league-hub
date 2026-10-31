// Championnat multiclasse dont les voitures changent d'une manche à l'autre : voitures par manche, points par classe,
// classe déduite des résultats pour un pilote inscrit sans catégorie, saisie manuelle avec classe.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity, decideMembership, requestJoin } from "../../src/lib/services/community.ts";
import { createChampionship, createRound, setChampionshipStatus, updateRound } from "../../src/lib/services/championships.ts";
import { decideRegistration, registerForChampionship } from "../../src/lib/services/registrations.ts";
import { applyImport, importManual } from "../../src/lib/services/results.ts";
import { championshipStandings } from "../../src/lib/services/standings.ts";
import { roundsOf } from "../../src/lib/services/read.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

test("multiclasse, voitures différentes par manche", async () => {
  const owner = await makeUser(pool, "Orga");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "multi", name: "Multi" }, owner)))!;
  const champ = (await run(pool, (db) =>
    createChampionship(db, cid, owner, {
      name: "Coupe tournante",
      slug: "",
      description: "",
      rulesMd: "R",
      capacity: 10,
      registrationDeadline: null,
      categories: "GT3, GT4",
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
      serverInfo: "",
      scoring: { ...defaultScoring, positionBasis: "class", pole: { points: 0, requiresStart: true }, fastestLap: { points: 0, requiresClassified: true, maxPosition: null } },
    }),
  ))!;
  await run(pool, (db) => setChampionshipStatus(db, cid, owner, champ, "open"));
  const ids: Record<string, string> = {};
  // Ana et Ben inscrits en GT3 / GT4 ; Chloé et Dan sans catégorie (classe déduite des résultats).
  for (const [name, category] of [["Ana", "GT3"], ["Ben", "GT4"], ["Chloe", ""], ["Dan", ""]] as const) {
    const u = await makeUser(pool, name, 900500 + Object.keys(ids).length);
    await run(pool, (db) => requestJoin(db, cid, u, ""));
    await run(pool, (db) => decideMembership(db, cid, owner, u, "accepted"));
    await run(pool, (db) => registerForChampionship(db, cid, u, champ, { category, car: "", teamId: "", newTeamName: "", raceNumber: "", acceptedRulesVersion: 1, note: "" }));
    const r = (await pool.query("SELECT id FROM registrations WHERE user_id=$1", [u])).rows[0].id;
    await run(pool, (db) => decideRegistration(db, cid, owner, r, "accepted"));
    ids[name] = u;
  }
  const mk = (name: string, cars: string) =>
    run(pool, (db) =>
      createRound(db, cid, owner, champ, { name, track: "Circuit fictif", trackConfig: "", startsAt: new Date(Date.now() + 86400000), capacity: "", serverInfo: "", notes: "", jokerEligible: true, cars }),
    );
  const r1 = (await mk("Manche 1", "Porsche 911 GT3 R, Aston Martin Vantage GT4"))!;
  const r2 = (await mk("Manche 2", "BMW M4 GT3\nMcLaren 570S GT4"))!;
  let rounds = await roundsOf(pool, champ);
  assert.deepEqual(rounds.map((r) => r.cars), [["Porsche 911 GT3 R", "Aston Martin Vantage GT4"], ["BMW M4 GT3", "McLaren 570S GT4"]]);
  // Modifier la manche sans le champ « voitures » ne les efface pas ; un champ vide les retire.
  await run(pool, (db) => updateRound(db, cid, owner, r2, { name: "Manche 2", track: "Autre circuit", trackConfig: "", capacity: "", serverInfo: "", notes: "", jokerEligible: "on" }));
  assert.deepEqual((await roundsOf(pool, champ))[1].cars, ["BMW M4 GT3", "McLaren 570S GT4"]);
  await run(pool, (db) => updateRound(db, cid, owner, r2, { name: "Manche 2", track: "Autre circuit", trackConfig: "", capacity: "", serverInfo: "", notes: "", jokerEligible: "on", cars: "Ferrari 296 GT3" }));
  rounds = await roundsOf(pool, champ);
  assert.deepEqual(rounds[1].cars, ["Ferrari 296 GT3"]);

  const race = async (roundId: string) => {
    await pool.query("UPDATE round_sessions SET starts_at=now()-interval '3 hours' WHERE round_id=$1", [roundId]);
    return (await pool.query("SELECT id FROM round_sessions WHERE round_id=$1 AND kind='race'", [roundId])).rows[0].id as string;
  };
  const row = (who: string, position: number, carClass?: string) => ({ userId: ids[who], position, status: "classified" as const, laps: 10, bestLap: "", totalTime: "", incidents: 0, carClass });
  const apply = async (sessionId: string, rows: ReturnType<typeof row>[]) => {
    const imp = (await run(pool, (db) => importManual(db, cid, owner, sessionId, rows)))!;
    await run(pool, (db) => applyImport(db, cid, owner, imp.importId, { final: true, matches: {}, saveIracingIds: false }));
  };
  // Manche 1 : au général Ana, Chloé (GT3), Ben, Dan (GT4). Classe d'Ana et Ben reprise de l'inscription.
  const s1 = await race(r1);
  await apply(s1, [row("Ana", 1), row("Chloe", 2, "GT3"), row("Ben", 3), row("Dan", 4, "GT4")]);
  // Manche 2 : Dan devant Ben en GT4, Chloé devant Ana en GT3, et une GT4 devant au général ne change rien en classe.
  const s2 = await race(r2);
  await apply(s2, [row("Dan", 1, "GT4"), row("Chloe", 2, "GT3"), row("Ana", 3), row("Ben", 4)]);
  const classes = (await pool.query("SELECT display_name, car_class, class_position FROM results WHERE session_id=$1 ORDER BY finish_position", [s2])).rows;
  assert.deepEqual(classes.map((c) => [c.car_class, c.class_position]), [["GT4", 1], ["GT3", 1], ["GT3", 2], ["GT4", 2]]);

  const { output } = await run(pool, (db) => championshipStandings(db, cid, champ));
  const p1 = defaultScoring.pointsByPosition[0], p2 = defaultScoring.pointsByPosition[1];
  const pts = (who: string) => output.drivers.find((d) => d.userId === ids[who])!.points;
  // Points par classe : chacun gagne une fois et finit 2e une fois.
  for (const who of ["Ana", "Ben", "Chloe", "Dan"]) assert.equal(pts(who), p1 + p2, who);
  // Classements par classe : Chloé et Dan y figurent grâce à leurs résultats.
  assert.deepEqual(Object.keys(output.categories), ["GT3", "GT4"]);
  assert.deepEqual(output.categories.GT3.map((d) => d.userId).sort(), [ids.Ana, ids.Chloe].sort());
  assert.deepEqual(output.categories.GT4.map((d) => d.userId).sort(), [ids.Ben, ids.Dan].sort());
});
