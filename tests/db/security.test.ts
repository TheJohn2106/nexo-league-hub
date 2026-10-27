// Isolation entre communautés, permissions serveur, concurrence sur la dernière place, limitation des tentatives.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { createCommunity, decideMembership, requestJoin, setRole, updateBranding } from "../../src/lib/services/community.ts";
import { createChampionship, createRound, setChampionshipStatus } from "../../src/lib/services/championships.ts";
import { decideRegistration, registerForChampionship } from "../../src/lib/services/registrations.ts";
import { acceptOffer, respond, roundAttendance } from "../../src/lib/services/attendance.ts";
import { championshipStandings } from "../../src/lib/services/standings.ts";
import { verifyLogin } from "../../src/lib/services/accounts.ts";
import { tx } from "../../src/lib/db.ts";
import { defaultScoring } from "../../src/lib/scoring/types.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

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

async function league(slug: string, drivers: number, capacity: number) {
  const owner = await makeUser(pool, `Owner${slug}`);
  const cid = (await run(pool, (db) => createCommunity(db, { slug, name: `Ligue ${slug}` }, owner)))!;
  const champ = (await run(pool, (db) => createChampionship(db, cid, owner, champInput(capacity))))!;
  await run(pool, (db) => setChampionshipStatus(db, cid, owner, champ, "open"));
  const ids: string[] = [];
  for (let i = 0; i < drivers; i++) {
    const u = await makeUser(pool, `P${slug}`, Math.floor(Math.random() * 1e9) + 1);
    await run(pool, (db) => requestJoin(db, cid, u, ""));
    await run(pool, (db) => decideMembership(db, cid, owner, u, "accepted"));
    await run(pool, (db) => registerForChampionship(db, cid, u, champ, reg));
    ids.push(u);
  }
  const round = (await run(pool, (db) =>
    createRound(db, cid, owner, champ, { name: "M1", track: "T", trackConfig: "", startsAt: new Date(Date.now() + 86400000), capacity: "", serverInfo: "", notes: "", jokerEligible: true }),
  ))!;
  return { owner, cid, champ, round, ids };
}

test("isolation : une communauté ne lit ni ne modifie les objets d'une autre", async () => {
  const a = await league("ligue-a", 1, 5);
  const b = await league("ligue-b", 1, 5);
  // Propriétaire de B sur un championnat de A via l'identifiant de B → introuvable.
  await assert.rejects(run(pool, (db) => championshipStandings(db, b.cid, a.champ)), /introuvable/);
  await assert.rejects(run(pool, (db) => setChampionshipStatus(db, b.cid, b.owner, a.champ, "closed")), /introuvable/);
  // Propriétaire de B agissant dans A : aucun rôle.
  await assert.rejects(run(pool, (db) => setChampionshipStatus(db, a.cid, b.owner, a.champ, "closed")), /non autorisée/);
  await assert.rejects(run(pool, (db) => roundAttendance(db, b.cid, a.round)), /introuvable/);
  // Pilote de A ne peut pas répondre pour une manche de B.
  await assert.rejects(run(pool, (db) => respond(db, b.cid, a.ids[0], a.round, "yes")), /introuvable/);
  await assert.rejects(run(pool, (db) => respond(db, b.cid, a.ids[0], b.round, "yes")), /acceptés ou réservistes/);
});

test("permissions : pilote, capitaine, commissaire ne gèrent pas la ligue ; rôle retiré = droits retirés", async () => {
  const l = await league("ligue-c", 2, 5);
  const [p1, p2] = l.ids;
  await assert.rejects(run(pool, (db) => decideMembership(db, l.cid, p1, p2, "refused")), /non autorisée/);
  await run(pool, (db) => setRole(db, l.cid, l.owner, p1, "organizer"));
  await assert.rejects(run(pool, (db) => setRole(db, l.cid, p1, p2, "owner")), /non autorisée/);
  await assert.rejects(run(pool, (db) => updateBranding(db, l.cid, p1, {})), /non autorisée/);
  const regId = (await pool.query("SELECT id FROM registrations WHERE user_id=$1", [p2])).rows[0].id;
  await run(pool, (db) => decideRegistration(db, l.cid, p1, regId, "accepted"));
  await run(pool, (db) => setRole(db, l.cid, l.owner, p1, "captain"));
  await assert.rejects(run(pool, (db) => decideRegistration(db, l.cid, p1, regId, "refused")), /non autorisée/);
  await assert.rejects(run(pool, (db) => setRole(db, l.cid, l.owner, l.owner, "driver")), /au moins un propriétaire/);
  // Adhésion en attente : aucun droit même avec un rôle élevé en base.
  const pending = await makeUser(pool, "Attente");
  await run(pool, (db) => requestJoin(db, l.cid, pending, ""));
  await pool.query("UPDATE memberships SET role='owner' WHERE user_id=$1", [pending]);
  await assert.rejects(run(pool, (db) => setChampionshipStatus(db, l.cid, pending, l.champ, "closed")), /non autorisée/);
});

test("concurrence : 6 pilotes visent 2 places en même temps → exactement 2 places", async () => {
  const l = await league("ligue-d", 6, 6);
  await pool.query("UPDATE rounds SET capacity=2 WHERE id=$1", [l.round]);
  for (const u of l.ids) {
    const id = (await pool.query("SELECT id FROM registrations WHERE user_id=$1", [u])).rows[0].id;
    await run(pool, (db) => decideRegistration(db, l.cid, l.owner, id, "accepted"));
  }
  await Promise.all(l.ids.map((u) => tx((db) => respond(db, l.cid, u, l.round, "yes"), pool)));
  const att = await run(pool, (db) => roundAttendance(db, l.cid, l.round));
  assert.equal(att.totals.confirmed, 2);
  assert.equal(att.totals.waitlist, 4);
  assert.deepEqual(
    att.rows.filter((r) => r.seat === "waitlist").map((r) => r.waitlistPosition),
    [1, 2, 3, 4],
  );
});

test("concurrence : deux réservistes et une seule place proposée", async () => {
  const l = await league("ligue-e", 4, 2);
  const regs = (await pool.query("SELECT r.id, r.user_id FROM registrations r JOIN championships c ON c.id=r.championship_id WHERE c.community_id=$1 ORDER BY r.created_at", [l.cid])).rows;
  await run(pool, (db) => decideRegistration(db, l.cid, l.owner, regs[0].id, "accepted"));
  await run(pool, (db) => decideRegistration(db, l.cid, l.owner, regs[1].id, "accepted"));
  await run(pool, (db) => decideRegistration(db, l.cid, l.owner, regs[2].id, "reserve"));
  await run(pool, (db) => decideRegistration(db, l.cid, l.owner, regs[3].id, "reserve"));
  for (const r of regs) await run(pool, (db) => respond(db, l.cid, r.user_id, l.round, "yes"));
  await run(pool, (db) => respond(db, l.cid, regs[0].user_id, l.round, "no"));
  // Seul le réserviste n°1 reçoit l'offre ; le n°2 ne peut pas la prendre, même simultanément.
  const results = await Promise.allSettled([regs[2].user_id, regs[3].user_id].map((u) => tx((db) => acceptOffer(db, l.cid, u, l.round), pool)));
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
  const att = await run(pool, (db) => roundAttendance(db, l.cid, l.round));
  assert.equal(att.totals.confirmed, 2);
  // Offre expirée → passe au suivant.
  await run(pool, (db) => respond(db, l.cid, regs[1].user_id, l.round, "no"));
  await pool.query("UPDATE attendances SET offer_expires_at=now()-interval '1 minute' WHERE seat='offered' AND round_id=$1", [l.round]);
  await run(pool, (db) => respond(db, l.cid, regs[0].user_id, l.round, "yes"));
  const after = await run(pool, (db) => roundAttendance(db, l.cid, l.round));
  assert.equal(after.rows.find((r) => r.userId === regs[3].user_id)!.response, "no");
  assert.equal(after.rows.find((r) => r.userId === regs[0].user_id)!.seat, "confirmed");
});

test("connexion : limitation des tentatives", async () => {
  await makeUser(pool, "Cible");
  const email = (await pool.query("SELECT email FROM users WHERE display_name LIKE 'Cible%'")).rows[0].email;
  for (let i = 0; i < 8; i++) await assert.rejects(verifyLogin(pool, email, "mauvais", "ip1"), /incorrect/);
  await assert.rejects(verifyLogin(pool, email, "motdepasse123", "ip1"), /Trop de tentatives/);
});
