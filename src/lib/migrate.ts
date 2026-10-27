import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const dir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** Applique les migrations SQL non encore appliquées, dans l'ordre, chacune dans sa transaction. */
export async function migrate(pool: Pool, log: (m: string) => void = console.log) {
  const db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(91827301)");
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      if ((await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [file])).rowCount) continue;
      await db.query("BEGIN");
      try {
        await db.query(await readFile(dir + file, "utf8"));
        await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
        await db.query("COMMIT");
        log(`Migration appliquée : ${file}`);
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock(91827301)");
    db.release();
  }
}
