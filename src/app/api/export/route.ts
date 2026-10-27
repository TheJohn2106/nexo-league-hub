import { getPool } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getCommunityBySlug } from "@/lib/services/context";
import { exportCsv, type ExportKind } from "@/lib/services/exports";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
const kinds: ExportKind[] = ["registrations", "attendance", "results", "standings"];

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const user = await currentUser();
  if (!user) return new Response("Connexion requise.", { status: 401 });
  const kind = q.get("kind") as ExportKind;
  if (!kinds.includes(kind)) return new Response("Export inconnu.", { status: 400 });
  try {
    const db = getPool();
    const community = await getCommunityBySlug(db, q.get("slug") ?? "");
    const csv = await exportCsv(db, community.id, user.id, q.get("championship") ?? "", kind);
    const filename = `${community.slug}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
