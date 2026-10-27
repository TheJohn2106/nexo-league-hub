import Link from "next/link";
import { notFound } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { driverPublic } from "@/lib/services/read";
import { Lap, Pill, Pos, When, labels } from "@/components/ui";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export default async function DriverPage({ params }: { params: Promise<{ slug: string; userId: string }> }) {
  const { slug, userId } = await params;
  const { community, db } = await loadLeague(slug);
  let data;
  try {
    data = await driverPublic(db, community.id, userId);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { driver, history, championships } = data;
  const races = history.filter((h) => h.kind === "race");
  const base = `/c/${slug}`;
  return (
    <>
      <section className="hero row">
        {driver.avatarUrl && <img className="avatar" src={driver.avatarUrl} alt="" style={{ width: 72, height: 72 }} />}
        <div>
          <div className="kicker">Pilote</div>
          <h1>{driver.displayName}</h1>
          <div className="row">
            {driver.preferredNumber != null && <span className="pos">{driver.preferredNumber}</span>}
            {driver.country && <span className="pill">{driver.country}</span>}
          </div>
        </div>
      </section>
      <div className="grid three">
        <div className="card">
          <div className="muted">Courses</div>
          <div className="stat">{races.length}</div>
        </div>
        <div className="card">
          <div className="muted">Victoires</div>
          <div className="stat">{races.filter((r) => r.position === 1 && r.status === "classified").length}</div>
        </div>
        <div className="card">
          <div className="muted">Podiums</div>
          <div className="stat">{races.filter((r) => r.position <= 3 && r.status === "classified").length}</div>
        </div>
      </div>
      {championships.length > 0 && (
        <section className="section">
          <h2>Championnats</h2>
          <div className="row">
            {championships.map((c) => (
              <Link key={c.id} className="pill" href={`${base}/championships/${c.slug}`}>
                {c.name}
                {c.teamName && ` · ${c.teamName}`}
              </Link>
            ))}
          </div>
        </section>
      )}
      <section className="section">
        <h2>Historique</h2>
        {history.length === 0 ? (
          <p className="empty">Aucun résultat publié.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Manche</th>
                  <th>Session</th>
                  <th>Pos.</th>
                  <th>Statut</th>
                  <th className="num">Meilleur tour</th>
                  <th className="num">Inc.</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.sessionId}>
                    <td>
                      <When date={h.startsAt} tz={community.timezone} />
                    </td>
                    <td>
                      <Link href={`${base}/rounds/${h.roundId}`}>
                        {h.championshipName} · M{h.number}
                      </Link>
                      <div className="breakdown">{h.track}</div>
                    </td>
                    <td>
                      {h.label} {h.resultsStatus === "provisional" && <Pill value="provisional" />}
                    </td>
                    <td>
                      <Pos n={h.position} />
                    </td>
                    <td>{labels[h.status]}</td>
                    <td className="num">
                      <Lap ms={h.bestLapMs} />
                    </td>
                    <td className="num">{h.incidents ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="breakdown">Positions telles qu’importées ; les pénalités éventuelles sont détaillées sur la page de chaque manche.</p>
      </section>
    </>
  );
}
