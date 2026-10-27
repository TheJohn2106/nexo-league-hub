import Link from "next/link";
import { redirect } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { myOverview, sessionRoster } from "@/lib/services/read";
import { listProtests } from "@/lib/services/stewarding";
import { getProfile } from "@/lib/services/accounts";
import { Flash, Hidden, Pill, When, type SP } from "@/components/ui";
import { PresenceControls } from "@/components/presence";
import { acceptRulesAction, fileProtestAction, joinAction, withdrawProtestAction, withdrawRegistrationAction } from "@/app/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mon espace" };

export default async function Me({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { community, db, user, membership, role } = await loadLeague(slug);
  const here = `/c/${slug}/me`;
  if (!user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const profile = await getProfile(db, user.id);
  const tz = community.timezone;
  if (!role)
    return (
      <div style={{ maxWidth: 640 }}>
        <h1>Mon espace</h1>
        <Flash searchParams={sp} />
        {membership?.status === "pending" ? (
          <p className="notice warn">Votre demande d’adhésion est en attente. Un organisateur va l’examiner.</p>
        ) : membership?.status === "refused" ? (
          <p className="notice warn">Votre demande d’adhésion a été refusée.</p>
        ) : (
          <form action={joinAction} className="card form">
            <Hidden values={{ slug, back: here }} />
            <p>Vous n’êtes pas encore membre de {community.name}.</p>
            <label>
              Message (facultatif)
              <input name="message" maxLength={500} />
            </label>
            <button className="btn primary">Demander à rejoindre la ligue</button>
          </form>
        )}
      </div>
    );
  const { registrations, rounds, recentSessions } = await myOverview(db, community.id, user.id);
  const protests = await listProtests(db, community.id, user.id, { userId: user.id });
  const rosters = await Promise.all(recentSessions.map((s) => sessionRoster(db, s.id)));
  return (
    <>
      <h1>Mon espace</h1>
      <Flash searchParams={sp} />
      {!profile.iracingCustId && (
        <p className="notice warn">
          Ajoutez votre identifiant client iRacing pour vous inscrire et être associé aux résultats.{" "}
          <Link href={`/profile?back=${encodeURIComponent(here)}`}>Compléter mon profil</Link>
        </p>
      )}
      <section className="section">
        <h2>Prochaines confirmations</h2>
        {rounds.length === 0 && <p className="empty">Aucune manche à venir pour vos championnats.</p>}
        <div className="grid two">
          {rounds.map((r) => (
            <article key={r.id} className="card accent stack">
              <div>
                <div className="muted">
                  {r.championshipName} · Manche {r.number}
                </div>
                <h3 style={{ margin: "4px 0" }}>
                  <Link href={`/c/${slug}/rounds/${r.id}`}>{r.name}</Link>
                </h3>
                <div>
                  {r.track} · <When date={r.startsAt} tz={tz} />
                </div>
                {r.registration === "reserve" && <small className="muted">Vous êtes réserviste : une place vous sera proposée si elle se libère.</small>}
              </div>
              <PresenceControls slug={slug} back={here} r={r} tz={tz} />
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Mes inscriptions</h2>
        {registrations.length === 0 && <p className="empty">Aucune inscription. Choisissez un championnat ouvert depuis l’accueil.</p>}
        <div className="stack">
          {registrations.map((r) => (
            <div key={r.id} className="card row between">
              <div>
                <Link href={`/c/${slug}/championships/${r.slug}`}>
                  <strong>{r.name}</strong>
                </Link>
                <div className="muted">
                  {[r.category, r.car, r.teamName, r.raceNumber != null ? `#${r.raceNumber}` : null].filter(Boolean).join(" · ")}
                  {r.status === "reserve" && r.reserveRank && ` · réserviste n°${r.reserveRank}`}
                </div>
              </div>
              <div className="row">
                <Pill value={r.status} />
                {["accepted", "reserve", "pending"].includes(r.status) && r.rulesVersion < r.currentRulesVersion && (
                  <form action={acceptRulesAction}>
                    <Hidden values={{ slug, back: here, championshipId: r.championshipId, rulesVersion: r.currentRulesVersion }} />
                    <button className="btn small primary">Accepter le règlement v{r.currentRulesVersion}</button>
                  </form>
                )}
                {["accepted", "reserve", "pending"].includes(r.status) && (
                  <details>
                    <summary>Me retirer</summary>
                    <form action={withdrawRegistrationAction} className="body">
                      <Hidden values={{ slug, back: here, championshipId: r.championshipId }} />
                      <p className="muted">Vos places aux manches futures seront libérées.</p>
                      <button className="btn danger small">Confirmer le retrait</button>
                    </form>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Réclamations</h2>
        {recentSessions.map((s, i) => (
          <details key={s.id} className="section">
            <summary>
              Déposer une réclamation — {s.championshipName}, M{s.number} ({s.label})
            </summary>
            <form action={fileProtestAction} className="body form">
              <Hidden values={{ slug, back: here, sessionId: s.id }} />
              <div className="cols">
                <label>
                  Pilote concerné
                  <select name="againstUserId" defaultValue="">
                    <option value="">Non précisé</option>
                    {rosters[i]
                      .filter((p) => p.userId !== user.id)
                      .map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Tour
                  <input name="lap" inputMode="numeric" pattern="\d{0,4}" />
                </label>
              </div>
              <label>
                Description
                <textarea name="description" required minLength={10} maxLength={4000} />
              </label>
              <label>
                Lien vidéo (https)
                <input name="videoUrl" type="url" placeholder="https://…" />
              </label>
              <button className="btn primary">Envoyer aux commissaires</button>
            </form>
          </details>
        ))}
        {recentSessions.length === 0 && <p className="muted">Aucune course récente ouverte aux réclamations.</p>}
        {protests.length > 0 && (
          <div className="table-wrap section">
            <table>
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Contre</th>
                  <th>Statut</th>
                  <th>Décision</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {protests.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.championshipName} · M{p.roundNumber} ({p.sessionLabel})
                    </td>
                    <td>{p.against ?? "—"}</td>
                    <td>
                      <Pill value={p.status} />
                    </td>
                    <td>{p.decision ?? <span className="muted">Limite : <When date={p.deadline} tz={tz} /></span>}</td>
                    <td>
                      {p.status === "submitted" && (
                        <form action={withdrawProtestAction}>
                          <Hidden values={{ slug, back: here, protestId: p.id }} />
                          <button className="btn small">Retirer</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
