import Link from "next/link";
import { notFound } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { championshipBySlug } from "@/lib/services/context";
import { participants, roundsOf } from "@/lib/services/read";
import { championshipStandings } from "@/lib/services/standings";
import { DriverTable, TeamTable } from "@/components/standings";
import { Flash, Pill, When, type SP } from "@/components/ui";
import { formatDateTime } from "@/lib/time";
import { AppError } from "@/lib/errors";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

const tabs = [
  ["classement", "Classement"],
  ["calendrier", "Calendrier"],
  ["participants", "Participants"],
  ["reglement", "Règlement"],
] as const;

export default async function Championship({ params, searchParams }: { params: Promise<{ slug: string; champ: string }>; searchParams: SP }) {
  const { slug, champ } = await params;
  const sp = await searchParams;
  const { community, db, user, role } = await loadLeague(slug);
  let c;
  try {
    c = await championshipBySlug(db, community.id, champ);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  if (c.status === "draft" && !role) notFound();
  const tab = tabs.some(([k]) => k === sp.tab) ? (sp.tab as string) : "classement";
  const base = `/c/${slug}`;
  const here = `${base}/championships/${c.slug}`;
  const myReg = user ? (await db.query("SELECT status FROM registrations WHERE championship_id=$1 AND user_id=$2", [c.id, user.id])).rows[0] : null;
  const scoring = c.scoring;
  return (
    <>
      <Flash searchParams={sp} />
      <section className="hero">
        <div className="kicker">Championnat</div>
        <h1>{c.name}</h1>
        <div className="row">
          <Pill value={c.status} />
          {c.registration_deadline && c.status === "open" && (
            <span className="muted">Inscriptions jusqu’au {formatDateTime(c.registration_deadline, community.timezone)}</span>
          )}
        </div>
        {c.description && <p style={{ marginTop: 12 }}>{c.description}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          {c.status === "open" && !myReg && (
            <Link className="btn primary" href={user ? `${here}/register` : `/login?next=${encodeURIComponent(here + "/register")}`}>
              S’inscrire au championnat
            </Link>
          )}
          {myReg && <span className="pill info">Votre inscription : {myReg.status === "pending" ? "en attente" : myReg.status === "accepted" ? "acceptée" : myReg.status === "reserve" ? "réserviste" : myReg.status === "refused" ? "refusée" : "retirée"}</span>}
          {c.status !== "draft" && (
            <Link className="btn" href={`/obs/${slug}/standings?championship=${c.slug}`} target="_blank">
              Vue OBS
            </Link>
          )}
        </div>
      </section>
      <nav className="tabs" aria-label="Sections du championnat">
        {tabs.map(([k, label]) => (
          <Link key={k} href={`${here}?tab=${k}`} aria-current={tab === k ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "classement" && <StandingsTab communityId={community.id} championshipId={c.id} base={base} />}
      {tab === "calendrier" && <CalendarTab championshipId={c.id} base={base} tz={community.timezone} />}
      {tab === "participants" && <ParticipantsTab championshipId={c.id} base={base} />}
      {tab === "reglement" && (
        <section className="grid two">
          <article className="card">
            <h2>Règlement — version {c.rules_version}</h2>
            <div className="rules">{c.rules_md || "Règlement non publié."}</div>
          </article>
          <article className="card">
            <h2>Barème</h2>
            <dl className="kv">
              <dt>Points</dt>
              <dd>{scoring.pointsByPosition.join(" · ")}</dd>
              <dt>Base</dt>
              <dd>{scoring.positionBasis === "class" ? "Position dans la classe" : "Classement général"}</dd>
              <dt>Pole</dt>
              <dd>{scoring.pole.points ? `+${scoring.pole.points}${scoring.pole.requiresStart ? " (si au départ)" : ""}` : "aucun bonus"}</dd>
              <dt>Meilleur tour</dt>
              <dd>
                {scoring.fastestLap.points
                  ? `+${scoring.fastestLap.points}${scoring.fastestLap.requiresClassified ? ", pilote classé" : ""}${scoring.fastestLap.maxPosition ? `, dans le top ${scoring.fastestLap.maxPosition}` : ""}`
                  : "aucun bonus"}
              </dd>
              <dt>Abandon</dt>
              <dd>{scoring.dnf.mode === "position" ? `points de la place si ≥ ${scoring.dnf.minLapsPercent} % des tours du vainqueur` : "0 point"}</dd>
              <dt>Non partant / disqualifié</dt>
              <dd>0 point</dd>
              <dt>Jokers</dt>
              <dd>{scoring.dropWorst ? `${scoring.dropWorst} plus mauvais résultat(s) retiré(s)` : "aucun"}</dd>
              <dt>Absence non annoncée</dt>
              <dd>{scoring.absencePenaltyPoints != null ? `−${scoring.absencePenaltyPoints} pt` : "aucune sanction automatique"}</dd>
              <dt>Départage</dt>
              <dd>{scoring.tiebreak.map((t: string) => ({ wins: "victoires", countback: "meilleurs résultats", lastRound: "dernière manche", fewestIncidents: "moins d’incidents" })[t]).join(", ")}</dd>
              <dt>Équipes</dt>
              <dd>{scoring.teams.countBest} meilleur(s) résultat(s) par course</dd>
            </dl>
          </article>
        </section>
      )}
    </>
  );
}

async function StandingsTab({ communityId, championshipId, base }: { communityId: string; championshipId: string; base: string }) {
  const db = getPool();
  const { input, output } = await championshipStandings(db, communityId, championshipId);
  const rows = output.drivers.filter((d) => d.starts > 0 || d.points !== 0);
  return (
    <div className="stack">
      {output.provisional && <p className="notice warn">Classement provisoire : certains résultats ne sont pas encore définitifs.</p>}
      <h2>Pilotes</h2>
      <DriverTable rows={rows} rounds={input.rounds} base={base} />
      {output.teams.length > 0 && (
        <>
          <h2 className="section">Équipes</h2>
          <TeamTable rows={output.teams} />
        </>
      )}
      {Object.entries(output.categories).map(([cat, list]) => (
        <section key={cat} className="section">
          <h2>Catégorie {cat}</h2>
          <DriverTable rows={list.filter((d) => d.starts > 0 || d.points !== 0)} rounds={input.rounds} base={base} compact />
        </section>
      ))}
    </div>
  );
}

async function CalendarTab({ championshipId, base, tz }: { championshipId: string; base: string; tz: string }) {
  const db = getPool();
  const rounds = await roundsOf(db, championshipId);
  if (!rounds.length) return <p className="empty">Calendrier à venir.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Manche</th>
            <th>Circuit</th>
            <th>Date</th>
            <th>Statut</th>
            <th>Résultats</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`${base}/rounds/${r.id}`}>
                  M{r.number} · {r.name}
                </Link>
              </td>
              <td>
                {r.track}
                {r.trackConfig && <span className="muted"> · {r.trackConfig}</span>}
              </td>
              <td>
                <When date={r.startsAt} tz={tz} />
              </td>
              <td>
                <Pill value={r.status} />
              </td>
              <td>
                {(r.sessions ?? [])
                  .filter((s: { kind: string }) => s.kind === "race")
                  .map((s: { id: string; label: string; resultsStatus: string }) => (
                    <div key={s.id}>
                      {s.label} : {s.resultsStatus === "none" ? <span className="muted">à venir</span> : <Pill value={s.resultsStatus} />}
                    </div>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function ParticipantsTab({ championshipId, base }: { championshipId: string; base: string }) {
  const db = getPool();
  const list = await participants(db, championshipId);
  if (!list.length) return <p className="empty">Aucun participant accepté pour le moment.</p>;
  const teams = new Map<string, typeof list>();
  for (const p of list) {
    const k = p.teamName ?? "";
    if (!teams.has(k)) teams.set(k, []);
    teams.get(k)!.push(p);
  }
  return (
    <div className="grid three">
      {[...teams].map(([team, members]) => (
        <section key={team} className="card">
          <h3>{team || "Sans équipe"}</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
            {members.map((m) => (
              <li key={m.userId} className="row between">
                <span>
                  {m.raceNumber != null && <span className="pos">{m.raceNumber}</span>} <Link href={`${base}/drivers/${m.userId}`}>{m.displayName}</Link>
                </span>
                <span className="row">
                  {m.category && <span className="pill">{m.category}</span>}
                  {m.status === "reserve" && <Pill value="reserve" />}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
