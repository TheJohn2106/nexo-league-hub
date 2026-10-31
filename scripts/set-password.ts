// Définit le mot de passe d'un compte depuis le serveur (accès à la base requis), par exemple pour un propriétaire :
//   npm run user:password -- --email orga@exemple.org
// Le mot de passe est lu depuis NEXO_OWNER_PASSWORD ou demandé de façon interactive (non affiché). Toutes les sessions du compte sont fermées.
import "dotenv/config";
import { parseArgs } from "node:util";
import { askPassword } from "./ask-password.ts";
import { getPool, tx } from "../src/lib/db.ts";
import { setPasswordByEmail } from "../src/lib/services/accounts.ts";

const { values } = parseArgs({ options: { email: { type: "string" } } });
if (!values.email) {
  console.error("Usage : npm run user:password -- --email <email>");
  process.exit(2);
}
const pool = getPool();
try {
  const password = await askPassword();
  await tx((db) => setPasswordByEmail(db, values.email!, password));
  console.log(`Mot de passe modifié pour ${values.email.trim().toLowerCase()} ; ses sessions ont été fermées.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
