// Profil pilote : identifiant iRacing unique, changement tracé, validations.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { getProfile, updateProfile } from "../../src/lib/services/accounts.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

const input = (over: Record<string, unknown> = {}) => ({ displayName: "Pilote Test", avatarUrl: "", iracingCustId: "", preferredNumber: "", country: "", privateContact: "", ...over });

test("mise à jour du profil et de l'identifiant iRacing", async () => {
  const a = await makeUser(pool, "Alpha");
  const b = await makeUser(pool, "Bravo");
  await run(pool, (db) => updateProfile(db, a, input({ iracingCustId: "959999", preferredNumber: "42", country: "be" })));
  const p = await getProfile(pool, a);
  assert.equal(Number(p.iracingCustId), 959999);
  assert.equal(p.country, "BE");
  const log = (await pool.query("SELECT target_id, detail FROM audit_log WHERE action='profile.iracing_id'")).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].target_id, a);
  await assert.rejects(run(pool, (db) => updateProfile(db, b, input({ displayName: "Bravo B", iracingCustId: "959999" }))), /déjà associé/);
  await assert.rejects(run(pool, (db) => updateProfile(db, b, input({ displayName: "Bravo B", iracingCustId: "12ab" }))), /nombre attendu/);
  await assert.rejects(run(pool, (db) => updateProfile(db, b, input({ displayName: "Bravo B", preferredNumber: "1000" }))), /Numéro/);
  // Sans changement d'identifiant : pas de nouvelle trace.
  await run(pool, (db) => updateProfile(db, a, input({ iracingCustId: "959999", privateContact: "discord: alpha" })));
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='profile.iracing_id'")).rows[0].n, 1);
});
