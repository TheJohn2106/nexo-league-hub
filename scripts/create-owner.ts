// Crée (ou réutilise) un compte et une ligue dont il est propriétaire. Aucun mot de passe par défaut :
//   npm run owner:create -- --email orga@exemple.org --name "Orga" --slug ma-ligue --league "Ma Ligue"
// Le mot de passe est lu depuis NEXO_OWNER_PASSWORD ou demandé de façon interactive (non affiché).
import "dotenv/config";
import { parseArgs } from "node:util";
import { askPassword } from "./ask-password.ts";
import { getPool, tx } from "../src/lib/db.ts";
import { registerUser } from "../src/lib/services/accounts.ts";
import { createCommunity } from "../src/lib/services/community.ts";

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, league: { type: "string" }, timezone: { type: "string" } },
});
if (!values.email || !values.slug || !values.league) {
  console.error('Usage : npm run owner:create -- --email <email> --name <pseudo> --slug <url> --league "<nom>" [--timezone Europe/Brussels]');
  process.exit(2);
}

const pool = getPool();
try {
  const email = values.email.trim().toLowerCase();
  let userId = (await pool.query("SELECT id FROM users WHERE email=$1", [email])).rows[0]?.id as string | undefined;
  if (!userId) {
    const password = await askPassword();
    userId = await tx((db) => registerUser(db, { email, password, displayName: values.name ?? email.split("@")[0] }));
    console.log(`Compte créé : ${email}`);
  } else console.log(`Compte existant réutilisé : ${email}`);
  const communityId = await tx((db) => createCommunity(db, { slug: values.slug!, name: values.league!, timezone: values.timezone }, userId!));
  console.log(`Ligue créée : /c/${values.slug} (id ${communityId}). ${email} en est propriétaire.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
