import Link from "next/link";
import { notFound } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { roundPublic } from "@/lib/services/read";
import { championshipStandings } from "@/lib/services/standings";
import { SessionResults } from "@/components/standings";
import { Flash, Pill, When, labels, type SP } from "@/components/ui";
import { PresenceControls } from "@/components/presence";
import { AppError } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function RoundPage({ params, searchParams }: { params: Promise<{ slug: string; roundId: string }>; searchParams: SP }) {
  const { slug, roundId } = await params;
  const sp = await searchParams;
  const { community, db, user } = await loadLeague(slug);
  let data;
  try {
    data = await roundPublic(db, community.id, roundId, user?.id ?? null);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { round, sessions, confirmed, mine, serverInfo, role } = data;
  const { input, output } = await championshipStandings(db, community.id, round.championship_id);
  const names = new Map(input.drivers.map((d) => [d.userId, d.displayName]));
  const reg = user ? (await db.query("SELECT status FROM registrations WHERE championship_id=$1 AND user_id=$2", [round.championship_id, user.id])).rows[0] : null;
  const base = `/c/${slug}`;
  const here = `${base}/rounds/${round.id}`;
  const tz = community.timezone;
  return (
    <>
      <p>
        <Link href={`${base}/championships/${round.championship_slug}?tab=calendrier`}>← {round.championship_name}</Link>
      </p>
      <Flash searchParams={sp} />
      <section className="hero">
        <div className="kicker">Manche {round.number}</div>
        <h1>{round.name}</h1>
        <div className="row">
          <span>
            {round.track}
            {round.track_config && ` · ${round.track_config}`}
          </span>
          <Pill value={round.status} />
        </div>
        <p style={{ marginTop: 8 }}>
          <When date={round.starts_at} tz={tz} />
          {round.status === "postponed" && <span className="muted"> (initialement {formatDateTime(round.original_starts_at, tz)})</span>}
        </p>
        {round.cars?.length > 0 && <p className="muted">Voitures : {round.cars.join(", ")}</p>}
        {round.notes && <p className="muted">{round.notes}</p>}
        {can(role, "attendance.manage") && (
          <Link className="btn small" href={`${base}/admin/rounds/${round.id}`}>
            Gérer la manche
          </Link>
        )}
      </section>

      <div className="grid two">
        <section className="card">
          <h2>Programme</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
            {sessions.map((s) => (
              <li key={s.id} className="row between">
                <span>
                  <strong>{s.label}</strong> <span className="muted">({labels[s.kind]}, {s.duration_minutes} min{Number(s.coefficient) !== 1 ? `, coef. ${Number(s.coefficient)}` : ""})</span>
                </span>
                <When date={s.starts_at} tz={tz} />
              </li>
            ))}
          </ul>
        </section>
        <section className="card accent">
          <h2>Ma présence</h2>
          {!user && (
            <p>
              <Link href={`/login?next=${encodeURIComponent(here)}`}>Connectez-vous</Link> pour indiquer votre présence.
            </p>
          )}
          {user && (!reg || !["accepted", "reserve"].includes(reg.status)) && <p className="muted">Réservé aux pilotes acceptés ou réservistes de ce championnat.</p>}
          {user && reg && ["accepted", "reserve"].includes(reg.status) && ["scheduled", "postponed"].includes(round.status) && (
            <PresenceControls
              slug={slug}
              back={here}
              tz={tz}
              r={{
                id: round.id,
                startsAt: round.starts_at,
                status: round.status,
                response: mine?.response ?? "none",
                seat: mine?.seat ?? "none",
                waitlistPosition: mine?.waitlist_position ?? null,
                offerExpiresAt: mine?.offer_expires_at ?? null,
                checkedInAt: mine?.checked_in_at ?? null,
                presenceDeadlineHours: round.presence_deadline_hours,
                checkinOpensMinutes: round.checkin_opens_minutes,
                checkinClosesMinutes: round.checkin_closes_minutes,
              }}
            />
          )}
          {serverInfo && (
            <div className="section">
              <h3>Informations serveur</h3>
              <p className="rules mono">{serverInfo}</p>
              <small className="muted">Visible uniquement des pilotes confirmés et des organisateurs.</small>
            </div>
          )}
        </section>
      </div>

      <section className="section">
        <div className="section-title">
          <h2>Grille confirmée</h2>
          <span className="muted">
            {confirmed.length} / {round.capacity ?? round.champ_capacity} places
          </span>
        </div>
        {confirmed.length === 0 ? (
          <p className="empty">Aucune place confirmée pour le moment.</p>
        ) : (
          <div className="card row">
            {confirmed.map((c) => (
              <span key={c.userId} className="pill">
                {c.raceNumber != null && `#${c.raceNumber} `}
                {c.displayName}
                {c.checkedIn && " ✓"}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="section" id="resultats">
        <h2>Résultats</h2>
        {sessions.filter((s) => s.results_status !== "none").length === 0 && <p className="empty">Résultats non publiés.</p>}
        {sessions
          .filter((s) => s.results_status !== "none")
          .map((s) => (
            <div key={s.id} className="section">
              <div className="section-title">
                <h3>{s.label}</h3>
                <Pill value={s.results_status} />
              </div>
              <SessionResults
                rows={output.effective[s.id] ?? []}
                lines={output.lines.filter((l) => l.sessionId === s.id)}
                names={names}
                base={base}
                showPoints={s.awards_points}
                isPublic={!can(role, "results.manage")}
              />
            </div>
          ))}
      </section>
    </>
  );
}
