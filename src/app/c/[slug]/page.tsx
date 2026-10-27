import Link from "next/link";
import { loadLeague } from "@/lib/league";
import { championshipsOf, nextRound } from "@/lib/services/read";
import { championshipStandings } from "@/lib/services/standings";
import { Flash, Pill, When, type SP } from "@/components/ui";
import { DriverTable } from "@/components/standings";
import { joinAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function LeagueHome({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { community, user, membership, db } = await loadLeague(slug);
  const champs = await championshipsOf(db, community.id);
  const next = await nextRound(db, community.id);
  const featured = champs.find((c) => c.status === "open" || c.status === "closed") ?? champs[0];
  const standings = featured ? await championshipStandings(db, community.id, featured.id) : null;
  const base = `/c/${slug}`;
  return (
    <>
      <Flash searchParams={sp} />
      <section className="hero">
        <div className="kicker">Ligue simracing</div>
        <h1>{community.name}</h1>
        {community.tagline && <p className="muted">{community.tagline}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          {!user && (
            <>
              <Link className="btn primary" href={`/register?next=${encodeURIComponent(base)}`}>
                Rejoindre la ligue
              </Link>
              <Link className="btn" href={`/login?next=${encodeURIComponent(base)}`}>
                Connexion
              </Link>
            </>
          )}
          {user && membership?.status === "accepted" && (
            <Link className="btn primary" href={`${base}/me`}>
              Mon espace pilote
            </Link>
          )}
          {user && membership?.status === "pending" && <span className="pill warn">Adhésion en attente de validation</span>}
          {user && membership?.status === "refused" && <span className="pill danger">Adhésion refusée</span>}
          {community.branding.twitchUrl && (
            <a className="btn" href={community.branding.twitchUrl} target="_blank" rel="noopener noreferrer">
              Voir le stream
            </a>
          )}
        </div>
        {user && (!membership || membership.status === "removed") && community.joinPolicy === "approval" && (
          <form action={joinAction} className="form" style={{ marginTop: 16, maxWidth: 520 }}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="back" value={base} />
            <label>
              Message pour les organisateurs (facultatif)
              <input name="message" maxLength={500} placeholder="Pseudo Twitch/Discord, expérience…" />
            </label>
            <button className="btn primary" type="submit">
              Demander à rejoindre la ligue
            </button>
          </form>
        )}
      </section>

      <div className="grid two">
        <section className="card accent" aria-labelledby="next-title">
          <h2 id="next-title">Prochaine manche</h2>
          {next ? (
            <div className="stack">
              <div>
                <strong>{next.championshipName}</strong> — Manche {next.number} : {next.name}
              </div>
              <div className="muted">
                {next.track}
                {next.trackConfig ? ` · ${next.trackConfig}` : ""}
              </div>
              <div>
                <When date={next.startsAt} tz={community.timezone} /> {next.status === "postponed" && <Pill value="postponed" />}
              </div>
              <div>
                Places confirmées : <strong>{next.confirmed}</strong> / {next.capacity}
              </div>
              <Link className="btn" href={`${base}/rounds/${next.id}`}>
                Voir la manche
              </Link>
            </div>
          ) : (
            <p className="muted">Aucune manche programmée.</p>
          )}
        </section>
        <section className="card" aria-labelledby="champs-title">
          <h2 id="champs-title">Championnats</h2>
          {champs.length === 0 && <p className="muted">Aucun championnat publié.</p>}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
            {champs.map((c) => (
              <li key={c.id} className="row between">
                <Link href={`${base}/championships/${c.slug}`}>
                  <strong>{c.name}</strong>
                </Link>
                <span className="row">
                  <Pill value={c.status} />
                  <span className="muted">
                    {c.accepted}/{c.capacity} pilotes
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {featured && standings && (
        <section className="section">
          <div className="section-title">
            <h2>Classement — {featured.name}</h2>
            <Link href={`${base}/championships/${featured.slug}`}>Classement complet →</Link>
          </div>
          {standings.output.provisional && <p className="notice warn">Classement provisoire : des résultats sont en attente de validation définitive.</p>}
          <DriverTable rows={standings.output.drivers.filter((d) => d.starts > 0 || d.points !== 0).slice(0, 10)} rounds={standings.input.rounds} base={base} compact />
        </section>
      )}
    </>
  );
}
