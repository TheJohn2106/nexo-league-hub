// Réinitialisation de mot de passe par lien d'organisation : droits, usage unique, expiration, sessions fermées.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { freshPool, makeUser, run } from "./helpers.ts";
import { consumePasswordReset, createPasswordReset, createSession, passwordResetValid, userFromToken, verifyLogin } from "../../src/lib/services/accounts.ts";
import { createCommunity } from "../../src/lib/services/community.ts";

let pool: Pool;
before(async () => {
  pool = await freshPool();
});
after(async () => {
  await pool?.end();
});

const member = (cid: string, userId: string, role: string, status = "accepted") =>
  pool.query("INSERT INTO memberships(community_id, user_id, role, status) VALUES($1,$2,$3,$4)", [cid, userId, role, status]);

test("droits de création du lien", async () => {
  const owner = await makeUser(pool, "Proprio");
  const orga = await makeUser(pool, "Orga");
  const steward = await makeUser(pool, "Commissaire");
  const driver = await makeUser(pool, "Pilote");
  const pending = await makeUser(pool, "Candidat");
  const outsider = await makeUser(pool, "Exterieur");
  const otherOwner = await makeUser(pool, "AutreProprio");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "ligue-reset", name: "Ligue Reset" }, owner)))!;
  const other = (await run(pool, (db) => createCommunity(db, { slug: "autre-ligue", name: "Autre" }, otherOwner)))!;
  await member(cid, orga, "organizer");
  await member(cid, steward, "steward");
  await member(cid, driver, "driver");
  await member(cid, pending, "driver", "pending");
  await member(cid, otherOwner, "driver");

  const create = (actor: string, target: string) => run(pool, (db) => createPasswordReset(db, cid, actor, target));
  // Organisateur : pilotes et candidats seulement.
  assert.ok(await create(orga, driver));
  assert.ok(await create(orga, pending));
  await assert.rejects(create(orga, steward), /pilote ou d’un capitaine/);
  await assert.rejects(create(orga, owner), /pilote ou d’un capitaine/);
  // Propriétaire : tout sauf un propriétaire, y compris propriétaire d'une autre ligue.
  assert.ok(await create(owner, steward));
  assert.ok(await create(owner, orga));
  await assert.rejects(create(owner, otherOwner), /propriétaire/);
  await assert.rejects(create(owner, owner), /profil/);
  // Pas de lien pour un non-membre, ni pour un pilote ou un commissaire, ni depuis une autre ligue.
  await assert.rejects(create(owner, outsider), /introuvable/);
  await assert.rejects(create(driver, pending), /droit|autoris/i);
  await assert.rejects(create(steward, driver), /droit|autoris/i);
  await assert.rejects(run(pool, (db) => createPasswordReset(db, other, otherOwner, driver)), /introuvable/);
  // Compte Discord seul : pas de mot de passe à réinitialiser.
  await pool.query("UPDATE users SET email=NULL, password_hash=NULL WHERE id=$1", [pending]);
  await assert.rejects(create(owner, pending), /Discord/);
  // Le jeton n'est stocké que haché, et chaque création est tracée.
  const n = (await pool.query("SELECT count(*)::int n FROM password_resets WHERE token_hash LIKE '%-%' OR length(token_hash) < 40")).rows[0].n;
  assert.equal(n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='password.reset_link'")).rows[0].n, 4);
});

test("usage unique, expiration, ancien lien invalidé, sessions fermées", async () => {
  const owner = await makeUser(pool, "Proprio");
  const driver = await makeUser(pool, "Pilote");
  const cid = (await run(pool, (db) => createCommunity(db, { slug: "ligue-reset-2", name: "Ligue Reset 2" }, owner)))!;
  await member(cid, driver, "driver");
  const email = (await pool.query("SELECT email FROM users WHERE id=$1", [driver])).rows[0].email;
  const session = await createSession(pool, driver);

  const first = (await run(pool, (db) => createPasswordReset(db, cid, owner, driver)))!;
  const token = (await run(pool, (db) => createPasswordReset(db, cid, owner, driver)))!;
  assert.equal(await passwordResetValid(pool, first), false, "un nouveau lien invalide le précédent");
  assert.equal(await passwordResetValid(pool, token), true);

  // Un mot de passe refusé ne consomme pas le lien.
  await assert.rejects(run(pool, (db) => consumePasswordReset(db, token, "court")), /10 caractères/);
  assert.equal(await passwordResetValid(pool, token), true);

  assert.equal(await run(pool, (db) => consumePasswordReset(db, token, "nouveauMotDePasse9")), driver);
  assert.equal(await userFromToken(pool, session), null, "les sessions existantes sont fermées");
  assert.equal(await verifyLogin(pool, email, "nouveauMotDePasse9", "test-reset"), driver);
  await assert.rejects(verifyLogin(pool, email, "motdepasse123", "test-reset-2"));
  await assert.rejects(run(pool, (db) => consumePasswordReset(db, token, "encoreUnAutre9")), /déjà utilisé/);
  await assert.rejects(run(pool, (db) => consumePasswordReset(db, "inventé", "encoreUnAutre9")), /invalide/);

  const late = (await run(pool, (db) => createPasswordReset(db, cid, owner, driver)))!;
  await pool.query("UPDATE password_resets SET expires_at=now() - interval '1 minute' WHERE used_at IS NULL");
  assert.equal(await passwordResetValid(pool, late), false);
  await assert.rejects(run(pool, (db) => consumePasswordReset(db, late, "encoreUnAutre9")), /expiré/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='password.reset_done'")).rows[0].n, 1);
});
