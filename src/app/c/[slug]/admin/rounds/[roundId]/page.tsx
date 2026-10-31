import Link from "next/link";
import { notFound } from "next/navigation";
import { requireLeaguePermission } from "@/lib/league";
import { attendanceHistory, roundAttendance } from "@/lib/services/attendance";
import { sessionImports } from "@/lib/services/results";
import { iracingApiStatus } from "@/lib/services/iracing";
import { Flash, Hidden, Pill, When, labels, type SP } from "@/components/ui";
import {
  announceRoundAction,
  deleteSessionAction,
  importApiAction,
  importFileAction,
  importManualAction,
  linkIracingAction,
  overrideResponseAction,
  postponeRoundAction,
  releaseUncheckedAction,
  resultsStatusAction,
  roundStatusAction,
  sessionAction,
  updateRoundAction,
} from "@/app/actions";
import { AppError } from "@/lib/errors";
import { formatDateTime, utcToZonedLocal } from "@/lib/time";
import { csvTemplateHeader } from "@/lib/results/parse";

export const dynamic = "force-dynamic";
export const metadata = { title: "Gestion de la manche" };

const eventLabels: Record<string, string> = {
  response: "Réponse",
  response_override: "Correction organisateur",
  seat_confirmed: "Place confirmée",
  seat_offered: "Place proposée",
  seat_released: "Place libérée",
  offer_accepted: "Offre acceptée",
  offer_declined: "Offre déclinée",
  offer_expired: "Offre expirée",
  checked_in: "Pointage",
  no_show_checkin: "Absent au pointage",
  registration_withdrawn: "Retrait du championnat",
  registration_refused: "Inscription refusée",
};

export default async function RoundAdmin({ params, searchParams }: { params: Promise<{ slug: string; roundId: string }>; searchParams: SP }) {
  const { slug, roundId } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/rounds/${roundId}`;
  const { community, db } = await requireLeaguePermission(slug, "attendance.manage", here);
  let att;
  try {
    att = await roundAttendance(db, community.id, roundId);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { round, windows, totals, rows, capacity } = att;
  const sessions = (await db.query("SELECT * FROM round_sessions WHERE round_id=$1 ORDER BY starts_at, ordinal", [round.id])).rows;
  const imports: Record<string, Awaited<ReturnType<typeof sessionImports>>> = Object.fromEntries(await Promise.all(sessions.map(async (s) => [s.id, await sessionImports(db, community.id, s.id)] as const)));
  const history = await attendanceHistory(db, community.id, round.id);
  const roster = rows.filter((r) => ["accepted", "reserve"].includes(r.registration));
  const api = iracingApiStatus();
  const tz = community.timezone;
  const h = { slug, back: here, roundId: round.id };
  const now = Date.now();
  return (
    <>
      <p>
        <Link href={`/c/${slug}/admin/championships/${round.championship_id}`}>← {round.championship_name}</Link> ·{" "}
        <Link href={`/c/${slug}/rounds/${round.id}`}>Page publique</Link>
      </p>
      <h1>
        M{round.number} · {round.name}
      </h1>
      <Flash searchParams={sp} />
      <div className="row">
        <Pill value={round.status} />
        <When date={round.starts_at} tz={tz} />
        {round.status === "postponed" && <span className="muted">initialement {formatDateTime(round.original_starts_at, tz)}</span>}
        <form action={announceRoundAction}>
          <Hidden values={h} />
          <button className="btn small">Annoncer sur Discord</button>
        </form>
      </div>
      {!community.discordConfigured && <p className="breakdown">Discord non configuré : les annonces et rappels ne sont pas envoyés.</p>}

      <section className="section card" id="presences">
        <div className="section-title">
          <h2>Présences et places</h2>
          <span className="muted">
            Capacité {capacity} · réponse avant <When date={windows.presenceDeadline} tz={tz} /> · pointage <When date={windows.checkinOpens} tz={tz} /> →{" "}
            <When date={windows.checkinCloses} tz={tz} />
          </span>
        </div>
        <div className="row">
          <span className="pill ok">Confirmés {totals.confirmed}</span>
          <span className="pill warn">Offres {totals.offered}</span>
          <span className="pill info">Attente {totals.waitlist}</span>
          <span className="pill">Présents {totals.yes}</span>
          <span className="pill">Incertains {totals.maybe}</span>
          <span className="pill danger">Absents {totals.no}</span>
          <span className="pill warn">Sans réponse {totals.none}</span>
          <span className="pill">Pointés {totals.checkedIn}</span>
        </div>
        <div className="table-wrap section">
          <table>
            <thead>
              <tr>
                <th>Pilote</th>
                <th>Inscription</th>
                <th>Réponse</th>
                <th>Place</th>
                <th>Pointage / départ</th>
                <th>Corriger (motif obligatoire)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td>
                    {r.displayName}
                    {r.teamName && <div className="breakdown">{r.teamName}</div>}
                  </td>
                  <td>
                    <Pill value={r.registration} />
                    {r.registration === "reserve" && r.reserveRank && <div className="breakdown">rang {r.reserveRank}</div>}
                  </td>
                  <td>
                    <Pill value={r.response} />
                    {r.respondedAt && (
                      <div className="breakdown">
                        <When date={r.respondedAt} tz={tz} />
                      </div>
                    )}
                  </td>
                  <td>
                    <Pill value={r.seat}>{r.seat === "waitlist" ? `Attente n°${r.waitlistPosition}` : undefined}</Pill>
                    {r.seat === "offered" && (
                      <div className="breakdown">
                        jusqu’au <When date={r.offerExpiresAt} tz={tz} />
                      </div>
                    )}
                  </td>
                  <td>
                    {r.checkedInAt ? <span className="pill ok">Pointé</span> : <span className="muted">—</span>}
                    {r.startStatus && <Pill value={r.startStatus} />}
                  </td>
                  <td>
                    <form action={overrideResponseAction} className="row">
                      <Hidden values={{ ...h, userId: r.userId }} />
                      <select name="response" defaultValue={r.response} aria-label={`Réponse de ${r.displayName}`} style={{ width: 130, minHeight: 34 }}>
                        {["none", "yes", "maybe", "no"].map((v) => (
                          <option key={v} value={v}>
                            {labels[v]}
                          </option>
                        ))}
                      </select>
                      <input name="reason" placeholder="Motif" required minLength={3} style={{ width: 140, minHeight: 34 }} aria-label="Motif" />
                      <button className="btn small">OK</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row section">
          <form action={releaseUncheckedAction}>
            <Hidden values={h} />
            <button className="btn" disabled={now < windows.checkinCloses.getTime()}>
              Libérer les places non pointées
            </button>
          </form>
          <small className="muted">
            Disponible après la fermeture du pointage. Les pilotes concernés sont notés « absent au départ » ; aucune sanction n’est appliquée sans règle activée.
          </small>
        </div>
      </section>

      <section className="section" id="resultats">
        <h2>Sessions et résultats</h2>
        {!api.configured && <p className="notice">{api.message}</p>}
        <div className="stack">
          {sessions.map((s) => (
            <details key={s.id} className="card" open={s.kind === "race"}>
              <summary>
                {s.label} · <When date={s.starts_at} tz={tz} /> · {labels[s.kind]} {s.results_status !== "none" && <Pill value={s.results_status} />}
              </summary>
              <div className="body stack">
                <form action={sessionAction} className="form">
                  <Hidden values={{ ...h, sessionId: s.id, kind: s.kind }} />
                  <div className="cols">
                    <label>
                      Libellé
                      <input name="label" defaultValue={s.label} />
                    </label>
                    <label>
                      Début ({tz})
                      <input name="startsAt" type="datetime-local" defaultValue={utcToZonedLocal(s.starts_at, tz)} required />
                    </label>
                    <label>
                      Durée (min)
                      <input name="durationMinutes" type="number" min={1} defaultValue={s.duration_minutes} />
                    </label>
                    <label>
                      Coefficient
                      <input name="coefficient" defaultValue={Number(s.coefficient)} inputMode="decimal" />
                    </label>
                  </div>
                  <div className="row">
                    {s.kind === "race" && (
                      <label className="check">
                        <input type="checkbox" name="awardsPoints" defaultChecked={s.awards_points} /> Attribue des points
                      </label>
                    )}
                    {s.kind === "qualifying" && (
                      <label className="check">
                        <input type="checkbox" name="awardsPole" defaultChecked={s.awards_pole} /> Attribue la pole
                      </label>
                    )}
                    <button className="btn small">Enregistrer la session</button>
                  </div>
                </form>

                <form action={linkIracingAction} className="form">
                  <Hidden values={{ ...h, sessionId: s.id }} />
                  <div className="cols">
                    <label>
                      Sous-session iRacing (subsession_id)
                      <span className="hint">Association explicite : visible dans l’URL du résultat iRacing.</span>
                      <input name="subsessionId" inputMode="numeric" defaultValue={s.iracing_subsession_id ?? ""} />
                    </label>
                    <label>
                      N° de simsession (facultatif)
                      <span className="hint">0 = course principale, -1/-2 = sessions précédentes. Vide = détection par type.</span>
                      <input name="simsessionNumber" defaultValue={s.iracing_simsession_number ?? ""} />
                    </label>
                  </div>
                  <button className="btn small">Associer</button>
                </form>

                <div className="grid two">
                  <form action={importApiAction} className="card form">
                    <Hidden values={{ ...h, sessionId: s.id }} />
                    <h3>1. API iRacing</h3>
                    <p className="breakdown">Récupère /data/results/get pour la sous-session associée, avec votre compte iRacing connecté.</p>
                    <button className="btn" disabled={!api.configured || !s.iracing_subsession_id}>
                      Récupérer les résultats
                    </button>
                  </form>
                  <form action={importFileAction} className="card form">
                    <Hidden values={{ ...h, sessionId: s.id }} />
                    <h3>2. Fichier</h3>
                    <p className="breakdown">
                      JSON de la Data API iRacing (réponse results/get) ou modèle CSV Nexo (format interne, non officiel) : <span className="mono">{csvTemplateHeader}</span>
                    </p>
                    <input type="file" name="file" accept=".json,.csv,application/json,text/csv" required />
                    <button className="btn">Prévisualiser</button>
                  </form>
                </div>
                <details>
                  <summary>3. Saisie manuelle de secours</summary>
                  <form action={importManualAction} className="body form">
                    <Hidden values={{ ...h, sessionId: s.id }} />
                    <p className="breakdown">Laissez la position vide pour les pilotes absents. Temps au format 1:32.456. Position au général ; en multiclasse, indiquez la classe (pré-remplie depuis l’inscription), la place en classe est calculée.</p>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Pilote</th>
                            <th>Pos.</th>
                            <th>Statut</th>
                            <th>Tours</th>
                            <th>Meilleur tour</th>
                            <th>Temps total</th>
                            <th>Inc.</th>
                            <th>Classe</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roster.map((p) => (
                            <tr key={p.userId}>
                              <td>
                                {p.displayName}
                                <input type="hidden" name="userId" value={p.userId} />
                              </td>
                              <td>
                                <input name="position" inputMode="numeric" style={{ width: 64 }} aria-label={`Position ${p.displayName}`} />
                              </td>
                              <td>
                                <select name="status" defaultValue="classified" aria-label={`Statut ${p.displayName}`}>
                                  {["classified", "dnf", "dns", "dsq"].map((v) => (
                                    <option key={v} value={v}>
                                      {labels[v]}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input name="laps" inputMode="numeric" style={{ width: 70 }} aria-label={`Tours ${p.displayName}`} />
                              </td>
                              <td>
                                <input name="bestLap" style={{ width: 110 }} aria-label={`Meilleur tour ${p.displayName}`} />
                              </td>
                              <td>
                                <input name="totalTime" style={{ width: 120 }} aria-label={`Temps total ${p.displayName}`} />
                              </td>
                              <td>
                                <input name="incidents" inputMode="numeric" style={{ width: 60 }} aria-label={`Incidents ${p.displayName}`} />
                              </td>
                              <td>
                                <input name="carClass" defaultValue={p.category ?? ""} style={{ width: 90 }} aria-label={`Classe ${p.displayName}`} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button className="btn">Prévisualiser la saisie</button>
                  </form>
                </details>

                {imports[s.id].length > 0 && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Import</th>
                          <th>Statut</th>
                          <th>Lignes</th>
                          <th>Par</th>
                        </tr>
                      </thead>
                      <tbody>
                        {imports[s.id].map((i) => (
                          <tr key={i.id}>
                            <td>
                              <Link href={`/c/${slug}/admin/imports/${i.id}`}>{labels[i.source]}</Link>
                              <div className="breakdown">
                                <When date={i.createdAt} tz={tz} />
                              </div>
                              {i.error && <div className="breakdown">{i.error}</div>}
                            </td>
                            <td>
                              <Pill value={i.status} /> {i.status === "applied" && <Pill value={i.isFinal ? "final" : "provisional"} />}
                            </td>
                            <td>{i.rowCount}</td>
                            <td>{i.createdBy}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {s.results_status !== "none" && (
                  <div className="row">
                    <Link className="btn small" href={`/c/${slug}/admin/sessions/${s.id}`}>
                      Corrections et pénalités
                    </Link>
                    <form action={resultsStatusAction}>
                      <Hidden values={{ ...h, sessionId: s.id, final: s.results_status === "final" ? "0" : "1" }} />
                      <button className="btn small">{s.results_status === "final" ? "Repasser en provisoire" : "Rendre définitif"}</button>
                    </form>
                  </div>
                )}
                {imports[s.id].length === 0 && (
                  <form action={deleteSessionAction}>
                    <Hidden values={{ ...h, sessionId: s.id }} />
                    <button className="btn small danger">Supprimer cette session</button>
                  </form>
                )}
              </div>
            </details>
          ))}
        </div>
        <details className="section">
          <summary>Ajouter une session</summary>
          <form action={sessionAction} className="body form">
            <Hidden values={h} />
            <div className="cols">
              <label>
                Type
                <select name="kind" defaultValue="race">
                  <option value="practice">Essais</option>
                  <option value="qualifying">Qualifications</option>
                  <option value="race">Course</option>
                </select>
              </label>
              <label>
                Libellé
                <input name="label" placeholder="Course 2" />
              </label>
              <label>
                Début ({tz})
                <input name="startsAt" type="datetime-local" required />
              </label>
              <label>
                Durée (min)
                <input name="durationMinutes" type="number" min={1} defaultValue={30} />
              </label>
              <label>
                Coefficient
                <input name="coefficient" defaultValue="1" inputMode="decimal" />
              </label>
            </div>
            <div className="row">
              <label className="check">
                <input type="checkbox" name="awardsPoints" defaultChecked /> Course à points
              </label>
              <label className="check">
                <input type="checkbox" name="awardsPole" /> Qualification attribuant la pole
              </label>
            </div>
            <button className="btn">Ajouter</button>
          </form>
        </details>
      </section>

      <div className="grid two section">
        <details className="card">
          <summary>Modifier la manche</summary>
          <form action={updateRoundAction} className="body form">
            <Hidden values={h} />
            <label>
              Nom
              <input name="name" defaultValue={round.name} />
            </label>
            <div className="cols">
              <label>
                Circuit
                <input name="track" defaultValue={round.track} />
              </label>
              <label>
                Configuration
                <input name="trackConfig" defaultValue={round.track_config} />
              </label>
              <label>
                Voitures de la manche <span className="hint">Séparées par des virgules. Vide = voitures du championnat.</span>
                <input name="cars" defaultValue={(round.cars ?? []).join(", ")} />
              </label>
              <label>
                Capacité
                <input name="capacity" type="number" defaultValue={round.capacity ?? ""} />
              </label>
            </div>
            <label>
              Informations serveur (protégées)
              <textarea name="serverInfo" defaultValue={round.server_info} rows={2} />
            </label>
            <label>
              Notes publiques
              <textarea name="notes" defaultValue={round.notes} rows={2} />
            </label>
            <label className="check">
              <input type="checkbox" name="jokerEligible" defaultChecked={round.is_joker_eligible} /> Peut être retirée comme joker
            </label>
            <button className="btn">Enregistrer</button>
          </form>
        </details>
        <details className="card">
          <summary>Reporter ou annuler</summary>
          <div className="body stack">
            <form action={postponeRoundAction} className="form">
              <Hidden values={h} />
              <label>
                Nouvelle date de départ ({tz})
                <input name="startsAt" type="datetime-local" required />
              </label>
              <label>
                Motif
                <input name="reason" required minLength={3} />
              </label>
              <button className="btn">Reporter (réponses conservées)</button>
            </form>
            {round.status !== "cancelled" ? (
              <form action={roundStatusAction} className="form">
                <Hidden values={{ ...h, status: "cancelled" }} />
                <label>
                  Motif d’annulation
                  <input name="reason" required minLength={3} />
                </label>
                <button className="btn danger">Annuler la manche (historique conservé)</button>
              </form>
            ) : (
              <form action={roundStatusAction}>
                <Hidden values={{ ...h, status: "scheduled", reason: "Rétablie" }} />
                <button className="btn">Rétablir la manche</button>
              </form>
            )}
          </div>
        </details>
      </div>

      <details className="section">
        <summary>Historique des présences ({history.length})</summary>
        <div className="body">
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {history.map((e, i) => (
              <li key={i}>
                <When date={e.createdAt} tz={tz} /> · <strong>{e.displayName}</strong> · {eventLabels[e.kind] ?? e.kind}
                {e.detail?.to && ` → ${labels[e.detail.to] ?? e.detail.to}`}
                {e.detail?.reason && ` (« ${e.detail.reason} »)`}
                {e.actorName && e.actorName !== e.displayName && <span className="muted"> par {e.actorName}</span>}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </>
  );
}
