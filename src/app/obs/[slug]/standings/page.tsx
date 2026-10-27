import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { championshipBySlug, getCommunityBySlug } from "@/lib/services/context";
import { championshipsOf } from "@/lib/services/read";
import { championshipStandings } from "@/lib/services/standings";
import { AutoRefresh } from "../refresh";

export const dynamic = "force-dynamic";
export const metadata = { title: "OBS · Classement", robots: { index: false } };

export default async function ObsStandings({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const db = getPool();
  const limit = Math.min(Math.max(Number(sp.limit) || 10, 1), 40);
  let c, champ;
  try {
    c = await getCommunityBySlug(db, slug);
    champ = sp.championship ? await championshipBySlug(db, c.id, sp.championship) : (await championshipsOf(db, c.id))[0];
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  if (!champ || champ.status === "draft") notFound();
  const { output } = await championshipStandings(db, c.id, champ.id);
  const rows = output.drivers.filter((d) => !sp.category || d.category === sp.category).slice(0, limit);
  return (
    <div className="obs-panel">
      <AutoRefresh seconds={60} />
      <div className="obs-head">
        {c.branding.logoUrl && <img src={c.branding.logoUrl} alt="" />}
        <span>
          {champ.name}
          {sp.category ? ` · ${sp.category}` : ""}
        </span>
      </div>
      {rows.length === 0 && <div className="obs-next">Classement à venir</div>}
      {rows.map((d, i) => (
        <div key={d.userId} className="obs-row">
          <span className="p">{sp.category ? i + 1 : d.rank}</span>
          <span>{d.displayName}</span>
          <span className="pts">{d.points}</span>
        </div>
      ))}
    </div>
  );
}
