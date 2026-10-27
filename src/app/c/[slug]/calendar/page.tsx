import Link from "next/link";
import { loadLeague } from "@/lib/league";
import { championshipsOf, roundsOf } from "@/lib/services/read";
import { Pill, When } from "@/components/ui";
import { formatDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendrier" };

export default async function Calendar({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { community, db } = await loadLeague(slug);
  const champs = (await championshipsOf(db, community.id)).filter((c) => c.status !== "cancelled");
  const all = (
    await Promise.all(champs.map(async (c) => (await roundsOf(db, c.id)).map((r) => ({ ...r, champ: c }))))
  ).flat().sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return (
    <>
      <h1>Calendrier</h1>
      <p className="muted">Horaires affichés en {community.timezone.replace("_", " ")}.</p>
      {all.length === 0 && <p className="empty">Aucune manche programmée.</p>}
      <div className="stack">
        {all.map((r) => (
          <article key={r.id} className="card row between">
            <div>
              <div className="muted">
                {r.champ.name} · Manche {r.number}
              </div>
              <h3 style={{ margin: "4px 0" }}>
                <Link href={`/c/${slug}/rounds/${r.id}`}>{r.name}</Link>
              </h3>
              <div>
                {r.track}
                {r.trackConfig ? ` · ${r.trackConfig}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div>
                <When date={r.startsAt} tz={community.timezone} />
              </div>
              {r.status !== "scheduled" && <Pill value={r.status} />}
              {r.status === "postponed" && <div className="breakdown">initialement {formatDateTime(r.originalStartsAt, community.timezone)}</div>}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
