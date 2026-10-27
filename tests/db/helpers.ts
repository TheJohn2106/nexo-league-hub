import { Pool } from "pg";
import { migrate } from "../../src/lib/migrate.ts";
import { tx } from "../../src/lib/db.ts";
import { registerUser } from "../../src/lib/services/accounts.ts";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://nexo:nexo_local_only@127.0.0.1:5432/nexo_test";

export async function freshPool() {
  if (!/test/.test(TEST_DATABASE_URL)) throw new Error("TEST_DATABASE_URL doit désigner une base de test (nom contenant « test »).");
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool, () => {});
  return pool;
}

let n = 0;
export async function makeUser(pool: Pool, name: string, custId?: number) {
  const id = await tx((db) => registerUser(db, { email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@exemple.test`, password: "motdepasse123", displayName: `${name}${n}` }), pool);
  if (custId) await pool.query("UPDATE driver_profiles SET iracing_cust_id=$2 WHERE user_id=$1", [id, custId]);
  return id!;
}
export const run = <T>(pool: Pool, fn: Parameters<typeof tx<T>>[0]) => tx(fn, pool);
