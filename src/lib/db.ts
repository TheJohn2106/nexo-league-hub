import { Pool, type PoolClient } from "pg";

const globalDb = globalThis as unknown as { nexoPool?: Pool };
export type Db = Pick<PoolClient, "query">;

export function getPool() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL manquante. Configurez PostgreSQL (voir .env.example).");
  return (globalDb.nexoPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  }));
}

/** Exécute fn dans une transaction ; ROLLBACK sur toute erreur. */
export async function tx<T>(fn: (db: PoolClient) => Promise<T>, pool: Pool = getPool()): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
