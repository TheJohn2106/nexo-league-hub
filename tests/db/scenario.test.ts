// Scénario complet sur PostgreSQL réel : saison → inscription → acceptation → présence → réserviste →
// import → réclamation → correction → classement final. Lancer avec : npm run test:db
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity, decideMembership, requestJoin, setRole } from "../../src/lib/services/community.ts";
import { createChampionship, createRound, linkIracingSession, setChampionshipStatus } from "../../src/lib/services/championships.ts";
import { decideRegistration, registerForChampionship } from "../../src/lib/services/registrations.ts";
import { acceptOffer, checkIn, releaseUncheckedSeats, respond, roundAttendance, withdrawParticipant } from "../../src/lib/services/attendance.ts";
import { addCorrection, applyImport, getImport, importFile, importManual } from "../../src/lib/services/results.ts";
import { decideProtest, fileProtest, startReview } from "../../src/lib/services/stewarding.ts";
import { championshipStandings } from "../../src/lib/services/standings.ts";
import { exportCsv } from "../../src/lib/services/exports.ts";
import { deliverPending, scheduleReminders } from "../../src/lib/services/notifications.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";

let pool: Pool;
const fixture = readFileSync(new URL("../fixtures/iracing-results-get.synthetic.json", import.meta.url), "utf8");
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

const champInput = (over: Record<string, unknown> = {}) => ({
  name: "Coupe GT Démo",
  slug: "",
  description: "Championnat fictif",
  rulesMd: "Article 1 : respect.",
  capacity: 3,
  registrationDeadline: null,
  categories: "Pro, Am",
  cars: "BMW M4 GT3, Porsche 911 GT3 R",
  requireCategory: true,
  requireCar: false,
  requireTeam: false,
  numberPolicy: "unique",
  presenceDeadlineHours: 24,
  checkinOpensMinutes: 60,
  checkinClosesMinutes: 10,
  offerTtlHours: 12,
  protestWindowHours: 48,
  serverInfo: "Serveur : NexoDemo / mdp démo",
  scoring: { ...defaultScoring, pointsByPosition: [25, 18, 15, 12, 10], fastestLap: { points: 1, requiresClassified: true, maxPosition: null }, dropWorst: 0 },
  ...over,
});
const reg = (category = "Pro", number = "") => ({ category, car: "BMW M4 GT3", teamId: "", newTeamName: "", raceNumber: number, acceptedRulesVersion: 1, note: "" });

test("scénario complet d'une manche", async () => {
  const owner = await makeUser(pool, "Orga");
  const steward = await makeUser(pool, "Commissaire", 900100);
  const alex = await makeUser(pool, "Alex", 900001);
  const sam = await makeUser(pool, "Sam", 900002);
  const lea = await makeUser(pool, "Lea", 900003);
  const ines = await makeUser(pool, "Ines", 900005);
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "demo-ligue", name: "Ligue Démo" }, owner)))!;

  // Adhésion : un compte créé n'est pas membre ni participant.
  for (const u of [steward, alex, sam, lea, ines]) await run(pool, (db) => requestJoin(db, cid, u, "Bonjour"));
  await assert.rejects(
    run(pool, (db) => registerForChampionship(db, cid, alex, "00000000-0000-0000-0000-000000000000", reg())),
    /adhésion/,
  );
  for (const u of [steward, alex, sam, lea, ines]) await run(pool, (db) => decideMembership(db, cid, owner, u, "accepted"));
  await run(pool, (db) => setRole(db, cid, owner, steward, "steward"));

  // Saison
  const champ = (await run(pool, (db) => createChampionship(db, cid, owner, champInput())))!;
  await assert.rejects(run(pool, (db) => registerForChampionship(db, cid, alex, champ, reg())), /pas ouvertes/);
  await run(pool, (db) => setChampionshipStatus(db, cid, owner, champ, "open"));
  const start = new Date(Date.now() + 3 * 24 * 3600000);
  const round = await run(pool, (db) =>
    createRound(db, cid, owner, champ, { name: "Manche 1", track: "Circuit fictif", trackConfig: "GP", startsAt: start, capacity: "", serverInfo: "", notes: "", jokerEligible: true }),
  );

  // Inscriptions
  await assert.rejects(run(pool, (db) => registerForChampionship(db, cid, alex, champ, { ...reg(), acceptedRulesVersion: 0 })), /version actuelle/);
  await assert.rejects(run(pool, (db) => registerForChampionship(db, cid, alex, champ, { ...reg(""), category: "" })), /catégorie/);
  for (const [u, num, cat] of [[alex, "7", "Pro"], [sam, "8", "Pro"], [lea, "9", "Am"], [ines, "10", "Am"], [steward, "", "Am"]] as const)
    await run(pool, (db) => registerForChampionship(db, cid, u, champ, reg(cat, num)));
  const late = await makeUser(pool, "Doublon", 900099);
  await run(pool, (db) => requestJoin(db, cid, late, ""));
  await run(pool, (db) => decideMembership(db, cid, owner, late, "accepted"));
  await assert.rejects(run(pool, (db) => registerForChampionship(db, cid, late, champ, reg("Pro", "7"))), /déjà pris/);
  const regs = (await pool.query("SELECT id, user_id, status FROM registrations WHERE championship_id=$1", [champ])).rows;
  assert.ok(regs.every((r) => r.status === "pending"));
  const regOf = (u: string) => regs.find((r) => r.user_id === u)!.id;
  for (const u of [alex, sam, lea]) await run(pool, (db) => decideRegistration(db, cid, owner, regOf(u), "accepted"));
  await assert.rejects(run(pool, (db) => decideRegistration(db, cid, owner, regOf(ines), "accepted")), /Capacité atteinte/);
  await run(pool, (db) => decideRegistration(db, cid, owner, regOf(ines), "reserve"));
  await run(pool, (db) => decideRegistration(db, cid, owner, regOf(steward), "reserve"));
  await assert.rejects(run(pool, (db) => decideRegistration(db, cid, alex, regOf(steward), "accepted")), /non autorisée/);

  // Présences : 3 places, 3 titulaires présents ; réserviste en attente.
  for (const u of [alex, sam, lea, ines]) await run(pool, (db) => respond(db, cid, u, round!, "yes"));
  let att = await run(pool, (db) => roundAttendance(db, cid, round!));
  assert.equal(att.totals.confirmed, 3);
  assert.equal(att.rows.find((r) => r.userId === ines)!.seat, "waitlist");
  assert.equal(att.totals.none, 1); // le commissaire réserviste n'a pas répondu

  // Léa se désiste → place proposée à Inès, qui l'accepte.
  await run(pool, (db) => respond(db, cid, lea, round!, "no"));
  att = await run(pool, (db) => roundAttendance(db, cid, round!));
  assert.equal(att.rows.find((r) => r.userId === ines)!.seat, "offered");
  await run(pool, (db) => acceptOffer(db, cid, ines, round!));
  att = await run(pool, (db) => roundAttendance(db, cid, round!));
  assert.equal(att.rows.find((r) => r.userId === ines)!.seat, "confirmed");
  assert.equal(att.rows.find((r) => r.userId === lea)!.seat, "released");

  // Rappels : planifiés une seule fois, jamais « envoyés » sans Discord.
  await pool.query("UPDATE communities SET discord_reminder_hours=200 WHERE id=$1", [cid]);
  const first = await run(pool, (db) => scheduleReminders(db));
  const second = await run(pool, (db) => scheduleReminders(db));
  assert.equal(first, 1);
  assert.equal(second, 0);
  let calls = 0;
  const stats = await run(pool, (db) => deliverPending(db, (async () => { calls++; return new Response("{}"); }) as typeof fetch));
  assert.equal(calls, 0);
  assert.equal(stats.sent, 0);
  assert.ok(stats.skipped >= 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM notification_outbox WHERE status='sent'")).rows[0].n, 0);

  // Pointage : fenêtre simulée en avançant l'heure de la manche.
  await pool.query("UPDATE rounds SET starts_at=now()+interval '30 minutes' WHERE id=$1", [round]);
  await run(pool, (db) => checkIn(db, cid, alex, round!));
  await run(pool, (db) => checkIn(db, cid, sam, round!));
  await assert.rejects(run(pool, (db) => checkIn(db, cid, lea, round!)), /place confirmée/);
  await pool.query("UPDATE rounds SET starts_at=now()+interval '5 minutes' WHERE id=$1", [round]);
  const released = await run(pool, (db) => releaseUncheckedSeats(db, cid, owner, round!));
  assert.deepEqual(released.released, [ines]);
  att = await run(pool, (db) => roundAttendance(db, cid, round!));
  assert.equal(att.rows.find((r) => r.userId === ines)!.startStatus, "no_show");
  assert.equal(att.rows.find((r) => r.userId === lea)!.startStatus, null); // absent annoncé ≠ absent au départ

  // Course passée ; association iRacing explicite puis import du fichier Data API.
  await pool.query("UPDATE rounds SET starts_at=now()-interval '2 hours' WHERE id=$1", [round]);
  await pool.query("UPDATE round_sessions SET starts_at=now()-interval '2 hours' WHERE round_id=$1", [round]);
  const sessions = (await pool.query("SELECT id, kind FROM round_sessions WHERE round_id=$1", [round])).rows;
  const race = sessions.find((s) => s.kind === "race")!.id;
  const qual = sessions.find((s) => s.kind === "qualifying")!.id;
  await run(pool, (db) => linkIracingSession(db, cid, owner, race, "81234567", ""));
  await assert.rejects(run(pool, (db) => linkIracingSession(db, cid, owner, qual, "81234567", "-1")), /déjà associée/);
  const imp = await run(pool, (db) => importFile(db, cid, owner, race, "r.json", fixture));
  assert.equal(imp.status, "preview");
  const again = await run(pool, (db) => importFile(db, cid, owner, race, "r.json", fixture));
  assert.equal(again.duplicate, true);
  assert.equal(again.importId, imp.importId);
  const preview = await run(pool, (db) => getImport(db, cid, imp.importId));
  const unknown = preview.suggestions.find((s) => s.how === "none")!;
  assert.equal(preview.parsed!.rows.find((r) => r.entryKey === unknown.entryKey)!.displayName, "Invité Mystère");
  await assert.rejects(run(pool, (db) => applyImport(db, cid, owner, imp.importId, { final: false, matches: {}, saveIracingIds: false })), /Rapprochement/);
  await run(pool, (db) => applyImport(db, cid, owner, imp.importId, { final: false, matches: { [unknown.entryKey]: "none" }, saveIracingIds: false }));
  await assert.rejects(run(pool, (db) => applyImport(db, cid, owner, imp.importId, { final: true, matches: { [unknown.entryKey]: "none" }, saveIracingIds: false })), /déjà validé/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM results WHERE session_id=$1", [race])).rows[0].n, 5);

  let { output } = await run(pool, (db) => championshipStandings(db, cid, champ));
  assert.equal(output.provisional, true);
  // Arrivée : Sam P1, Alex P2 (meilleur tour), invité P3 (hors classement), Léa P4, Inès DNF (8/20 tours).
  const p = (u: string) => output.drivers.find((d) => d.userId === u)!.points;
  assert.equal(p(sam), 25);
  assert.equal(p(alex), 18 + 1);
  assert.equal(p(lea), 12);
  assert.equal(p(ines), 0);

  // Réclamation de Sam contre Alex → pénalité de 2 places décidée par le commissaire.
  const protest = await run(pool, (db) => fileProtest(db, cid, sam, race, { againstUserId: alex, lap: "3", description: "Contact au virage 1, sortie de piste.", videoUrl: "https://video.exemple.test/clip" }));
  await assert.rejects(run(pool, (db) => decideProtest(db, cid, alex, protest!, { outcome: "dismissed", decision: "Je me juge moi-même", penalty: null })), /non autorisée/);
  await run(pool, (db) => startReview(db, cid, steward, protest!));
  await run(pool, (db) =>
    decideProtest(db, cid, steward, protest!, {
      outcome: "decided",
      decision: "Contact évitable au virage 1 : recul de 2 places.",
      penalty: { userId: alex, kind: "positions", value: 2, scope: "session", reason: "Contact évitable" },
    }),
  );
  // Correction : Léa a en réalité terminé le dernier tour (classée avec 20 tours).
  const leaResult = (await pool.query("SELECT id FROM results WHERE session_id=$1 AND iracing_cust_id=900003", [race])).rows[0].id;
  await run(pool, (db) => addCorrection(db, cid, owner, leaResult, "laps", "20", "Tour final validé par la direction de course"));
  // Rapprochement tardif de l'invité : non inscrit → refus.
  const guest = (await pool.query("SELECT id FROM results WHERE session_id=$1 AND iracing_cust_id=999999", [race])).rows[0].id;
  await assert.rejects(run(pool, (db) => addCorrection(db, cid, owner, guest, "user_id", late, "Rattachement")), /non inscrit/);

  // Résultats définitifs (sans réimport) → classement final.
  const { setResultsStatus } = await import("../../src/lib/services/results.ts");
  await run(pool, (db) => setResultsStatus(db, cid, owner, race, true));
  ({ output } = await run(pool, (db) => championshipStandings(db, cid, champ)));
  assert.equal(output.provisional, false);
  const order = output.effective[race].map((r) => r.displayName);
  assert.deepEqual(order, ["Sam Dupont", "Invité Mystère", "Léa Moreau", "Alex Martin", "Inès Petit"]);
  assert.equal(p(sam), 25);
  assert.equal(p(lea), 15); // P3 après la pénalité d'Alex
  assert.equal(p(alex), 12 + 1);
  assert.equal(output.drivers[0].userId, sam);
  // Résultat original intact
  const original = (await pool.query("SELECT finish_position, laps FROM results WHERE id=$1", [leaResult])).rows[0];
  assert.deepEqual(original, { finish_position: 4, laps: 19 });
  // Participation réelle constatée
  att = await run(pool, (db) => roundAttendance(db, cid, round!));
  assert.equal(att.rows.find((r) => r.userId === sam)!.startStatus, "started");
  assert.equal((await pool.query("SELECT status FROM rounds WHERE id=$1", [round])).rows[0].status, "completed");

  // Exports
  const csv = await run(pool, (db) => exportCsv(db, cid, owner, champ, "standings"));
  assert.match(csv, /rang;pilote/);
  await assert.rejects(run(pool, (db) => exportCsv(db, cid, alex, champ, "registrations")), /non autorisée/);

  // Réimport (API → même source) : aucun doublon de résultats
  await run(pool, (db) => importManual(db, cid, owner, qual, [
    { userId: alex, position: 1, status: "classified", laps: 3, bestLap: "2:18.100", totalTime: "", incidents: 0 },
    { userId: sam, position: 2, status: "classified", laps: 3, bestLap: "2:18.250", totalTime: "", incidents: 0 },
  ]));
  const before = (await pool.query("SELECT count(*)::int n FROM results")).rows[0].n;
  const manual = (await pool.query("SELECT id FROM result_imports WHERE session_id=$1 AND status='preview'", [qual])).rows[0].id;
  await run(pool, (db) => applyImport(db, cid, owner, manual, { final: true, matches: {}, saveIracingIds: false }));
  await run(pool, (db) => importManual(db, cid, owner, qual, [
    { userId: alex, position: 1, status: "classified", laps: 3, bestLap: "2:18.100", totalTime: "", incidents: 0 },
    { userId: sam, position: 2, status: "classified", laps: 3, bestLap: "2:18.200", totalTime: "", incidents: 0 },
  ]));
  const manual2 = (await pool.query("SELECT id FROM result_imports WHERE session_id=$1 AND status='preview'", [qual])).rows[0].id;
  await run(pool, (db) => applyImport(db, cid, owner, manual2, { final: true, matches: {}, saveIracingIds: false }));
  assert.equal((await pool.query("SELECT count(*)::int n FROM results")).rows[0].n, before + 2);
  ({ output } = await run(pool, (db) => championshipStandings(db, cid, champ)));
  assert.equal(p(alex), 12 + 1 + 1); // pole (qualification) + meilleur tour
  // Journal d'administration alimenté
  assert.ok((await pool.query("SELECT count(*)::int n FROM audit_log WHERE community_id=$1", [cid])).rows[0].n > 20);

  // Retrait d'un participant par l'organisateur sur une manche future : place au réserviste suivant.
  const r2 = await run(pool, (db) =>
    createRound(db, cid, owner, champ, { name: "Manche 2", track: "Autre circuit", trackConfig: "", startsAt: new Date(Date.now() + 5 * 86400000), capacity: "2", serverInfo: "", notes: "", jokerEligible: true }),
  );
  for (const u of [alex, sam, ines]) await run(pool, (db) => respond(db, cid, u, r2!, "yes"));
  await run(pool, (db) => withdrawParticipant(db, cid, owner, r2!, sam, "Suspendu une manche"));
  att = await run(pool, (db) => roundAttendance(db, cid, r2!));
  assert.equal(att.rows.find((r) => r.userId === ines)!.seat, "offered");
});
