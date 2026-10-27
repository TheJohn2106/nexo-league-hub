export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok", application: "nexo-league-hub" }, { headers: { "Cache-Control": "no-store" } });
}
