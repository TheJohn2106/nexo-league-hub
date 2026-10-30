import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { championshipBySlug, getCommunityBySlug } from "@/lib/services/context";
import { nextRound } from "@/lib/services/read";
import { formatDateTime } from "@/lib/time";
import { AutoRefresh } from "../refresh";

export const dynamic = "force-dynamic";
export const metadata = { title: "OBS · Prochaine manche", robots: { index: false } };

export default async function ObsNext({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const db = getPool();
  let c, champId: string | undefined;
  try {
    c = await getCommunityBySlug(db, slug);
    if (sp.championship) champId = (await championshipBySlug(db, c.id, sp.championship)).id;
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const r = await nextRound(db, c.id, champId);
  return (
    <div className="obs-panel">
      <AutoRefresh seconds={60} />
      <div className="obs-head">
        {c.branding.logoUrl && <img src={c.branding.logoUrl} alt="" />}
        <span>Prochaine manche</span>
      </div>
      <div className="obs-next">
        {r ? (
          <>
            <div>{r.championshipName}</div>
            <div className="big">
              M{r.number} · {r.track}
            </div>
            {r.trackConfig && <div>{r.trackConfig}</div>}
            {r.cars?.length > 0 && <div>{r.cars.join(" · ")}</div>}
            <div>
              {formatDateTime(r.startsAt, c.timezone)}
              {r.status === "postponed" ? " · reportée" : ""}
            </div>
            <div>
              {r.confirmed}/{r.capacity} pilotes confirmés
            </div>
          </>
        ) : (
          <div>Aucune manche programmée</div>
        )}
      </div>
    </div>
  );
}
