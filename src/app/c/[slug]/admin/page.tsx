import Link from "next/link";
import { redirect } from "next/navigation";
import { requireLeaguePermission } from "@/lib/league";
import { adminDashboard, championshipsOf, nextRound } from "@/lib/services/read";
import { roundAttendance } from "@/lib/services/attendance";
import { Flash, Pill, When, labels, type SP } from "@/components/ui";
import { can } from "@/lib/permissions";
import { loadLeague } from "@/lib/league";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration" };

export default async function Dashboard({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const pre = await loadLeague(slug);
  if (!can(pre.role, "championship.manage")) redirect(`/c/${slug}/admin/protests`);
  const { community, db } = await requireLeaguePermission(slug, "championship.manage", `/c/${slug}/admin`);
  const d = await adminDashboard(db, community.id);
  const champs = await championshipsOf(db, community.id, true);
  const next = await nextRound(db, community.id);
  const att = next ? await roundAttendance(db, community.id, next.id) : null;
  const base = `/c/${slug}`;
  const tz = community.timezone;
  return (
    <>
      <h1>Tableau de bord</h1>
      <Flash searchParams={sp} />
      <div className="grid three">
        <Link href={`${base}/admin/members`} className="card" style={{ textDecoration: "none" }}>
          <div className="muted">Adhésions à traiter</div>
          <div className="stat">{d.pendingMembers}</div>
        </Link>
        <div className="card">
          <div className="muted">Inscriptions à traiter</div>
          <div className="stat">{d.pendingRegistrations.reduce((s, r) => s + r.n, 0)}</div>
          {d.pendingRegistrations.map((r) => (
            <div key={r.id}>
              <Link href={`${base}/admin/championships/${r.id}#inscriptions`}>
                {r.name} : {r.n}
              </Link>
            </div>
          ))}
        </div>
        <Link href={`${base}/admin/protests`} className="card" style={{ textDecoration: "none" }}>
          <div className="muted">Réclamations ouvertes</div>
          <div className="stat">{d.openProtests}</div>
        </Link>
      </div>

      <section className="section card accent">
        <h2>Prochaine manche</h2>
        {next && att ? (
          <div className="stack">
            <div className="row between">
              <Link href={`${base}/admin/rounds/${next.id}`}>
                <strong>
                  {next.championshipName} · M{next.number} {next.name}
                </strong>
              </Link>
              <When date={next.startsAt} tz={tz} />
            </div>
            <div className="row">
              <span className="pill ok">Confirmés {att.totals.confirmed}/{att.capacity}</span>
              <span className="pill warn">Offres en cours {att.totals.offered}</span>
              <span className="pill info">Liste d’attente {att.totals.waitlist}</span>
              <span className="pill">Présents {att.totals.yes}</span>
              <span className="pill">Incertains {att.totals.maybe}</span>
              <span className="pill danger">Absents {att.totals.no}</span>
              <span className="pill warn">Sans réponse {att.totals.none}</span>
              <span className="pill">Pointés {att.totals.checkedIn}</span>
            </div>
            {att.totals.none > 0 && (
              <div className="muted">
                Sans réponse :{" "}
                {att.rows
                  .filter((r) => r.response === "none" && ["accepted", "reserve"].includes(r.registration))
                  .map((r) => r.displayName)
                  .join(", ")}
              </div>
            )}
          </div>
        ) : (
          <p className="muted">Aucune manche programmée.</p>
        )}
      </section>

      <div className="grid two section">
        <section className="card">
          <h2>Résultats à traiter</h2>
          {d.previews.length + d.awaitingResults.length + d.provisional.length === 0 && <p className="muted">Rien en attente.</p>}
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {d.previews.map((p) => (
              <li key={p.id}>
                <Link href={`${base}/admin/imports/${p.id}`}>
                  Aperçu à valider : {p.championshipName} M{p.number} ({p.label})
                </Link>{" "}
                <span className="muted">{labels[p.source]}</span>
              </li>
            ))}
            {d.provisional.map((p) => (
              <li key={p.id}>
                <Link href={`${base}/admin/rounds/${p.roundId}#resultats`}>
                  Résultats provisoires : {p.championshipName} M{p.number} ({p.label})
                </Link>
              </li>
            ))}
            {d.awaitingResults.map((p) => (
              <li key={p.id}>
                <Link href={`${base}/admin/rounds/${p.roundId}#resultats`}>
                  Résultats manquants : {p.championshipName} M{p.number} ({p.label})
                </Link>
                {!p.subsessionId && <span className="muted"> · sous-session iRacing non associée</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Échecs de synchronisation</h2>
          {d.syncFailures.length === 0 && d.failedNotifications === 0 && <p className="muted">Aucun échec.</p>}
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {d.syncFailures.map((f) => (
              <li key={f.id}>
                <Pill value="failed" /> {f.message}{" "}
                {f.roundId && <Link href={`${base}/admin/rounds/${f.roundId}#resultats`}>M{f.number} ({f.label})</Link>} · <When date={f.createdAt} tz={tz} />
                <div className="breakdown">
                  {f.attempts} essai(s) ·{" "}
                  {f.retryAfter ? (
                    <>
                      nouvel essai automatique <When date={f.retryAfter} tz={tz} />
                    </>
                  ) : (
                    "pas de nouvel essai automatique : action requise"
                  )}
                </div>
              </li>
            ))}
            {d.failedNotifications > 0 && (
              <li>
                <Link href={`${base}/admin/settings`}>{d.failedNotifications} notification(s) Discord en échec</Link>
              </li>
            )}
          </ul>
        </section>
      </div>

      <section className="section">
        <div className="section-title">
          <h2>Championnats</h2>
          <Link className="btn primary" href={`${base}/admin/championships/new`}>
            Nouveau championnat
          </Link>
        </div>
        <div className="stack">
          {champs.map((c) => (
            <Link key={c.id} href={`${base}/admin/championships/${c.id}`} className="card row between" style={{ textDecoration: "none" }}>
              <strong>{c.name}</strong>
              <span className="row">
                <Pill value={c.status} />
                <span className="muted">
                  {c.accepted}/{c.capacity} titulaires · {c.reserves} réservistes · {c.rounds} manches
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
