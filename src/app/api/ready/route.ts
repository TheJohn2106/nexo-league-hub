import { readdir } from "node:fs/promises";
import path from "node:path";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

// Prêt seulement si la base répond et que toutes les migrations du dépôt sont appliquées.
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const files = (await readdir(path.join(process.cwd(), "db", "migrations"))).filter((f) => f.endsWith(".sql"));
    const r = await getPool().query("SELECT count(*)::int n FROM schema_migrations WHERE name = ANY($1::text[])", [files]);
    if (r.rows[0].n !== files.length) throw new Error("migrations");
    return Response.json({ status: "ready" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
