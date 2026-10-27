import Link from "next/link";
import { requireLeaguePermission } from "@/lib/league";
import { listProtests } from "@/lib/services/stewarding";
import { Flash, Hidden, Pill, When, type SP } from "@/components/ui";
import { decideProtestAction, reviewProtestAction } from "@/app/actions";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Réclamations" };

export default async function Protests({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/protests`;
  const { community, db, user, role } = await requireLeaguePermission(slug, "protests.view", here);
  const protests = await listProtests(db, community.id, user.id);
  const decide = can(role, "protests.decide");
  const tz = community.timezone;
  const h = { slug, back: here };
  return (
    <>
      <h1>Réclamations</h1>
      <Flash searchParams={sp} />
      {!decide && <p className="notice">Votre rôle permet de consulter les réclamations ; seuls les commissaires et le propriétaire décident.</p>}
      {protests.length === 0 && <p className="empty">Aucune réclamation.</p>}
      <div className="stack">
        {protests.map((p) => {
          const open = p.status === "submitted" || p.status === "under_review";
          const conflict = p.filedById === user.id || p.againstId === user.id;
          return (
            <article key={p.id} className="card stack" id={`p-${p.id}`}>
              <div className="row between">
                <strong>
                  {p.championshipName} · M{p.roundNumber} {p.roundName} · {p.sessionLabel}
                </strong>
                <Pill value={p.status} />
              </div>
              <div>
                <strong>{p.filedBy}</strong> contre <strong>{p.against ?? "incident général"}</strong>
                {p.lap != null && <> · tour {p.lap}</>}
                <div className="breakdown">
                  Déposée <When date={p.createdAt} tz={tz} /> · délai de dépôt <When date={p.deadline} tz={tz} />
                </div>
              </div>
              <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{p.description}</p>
              {p.videoUrl && (
                <p style={{ margin: 0 }}>
                  <a href={p.videoUrl} target="_blank" rel="noopener noreferrer nofollow">
                    Vidéo / replay ↗
                  </a>
                </p>
              )}
              {p.decision && (
                <div className="notice">
                  <strong>Décision</strong> ({p.decidedBy}, <When date={p.decidedAt} tz={tz} />) : {p.decision}
                </div>
              )}
              <p style={{ margin: 0 }}>
                <Link href={`/c/${slug}/admin/sessions/${p.sessionId}`}>Résultats et pénalités de la session →</Link>
              </p>
              {open && decide && conflict && <p className="notice warn">Conflit d’intérêts : vous êtes concerné, un autre commissaire doit décider.</p>}
              {open && decide && !conflict && (
                <>
                  {p.status === "submitted" && (
                    <form action={reviewProtestAction}>
                      <Hidden values={{ ...h, protestId: p.id }} />
                      <button className="btn small">Passer en examen</button>
                    </form>
                  )}
                  <details>
                    <summary>Rendre une décision</summary>
                    <form action={decideProtestAction} className="body form">
                      <Hidden values={{ ...h, protestId: p.id }} />
                      <label>
                        Issue
                        <select name="outcome">
                          <option value="decided">Fondée (décision rendue)</option>
                          <option value="dismissed">Rejetée</option>
                        </select>
                      </label>
                      <label>
                        Motivation (publique pour les parties) *
                        <textarea name="decision" required minLength={10} rows={3} />
                      </label>
                      <div className="cols">
                        <label>
                          Pénalité
                          <select name="penaltyKind" defaultValue="none">
                            <option value="none">Aucune</option>
                            <option value="warning">Avertissement</option>
                            <option value="time">Temps (secondes)</option>
                            <option value="positions">Places</option>
                            <option value="points">Points</option>
                            <option value="dsq">Disqualification</option>
                          </select>
                        </label>
                        <label>
                          Pilote pénalisé
                          <select name="penaltyUserId" defaultValue={p.againstId ?? p.filedById}>
                            {p.againstId && <option value={p.againstId}>{p.against}</option>}
                            <option value={p.filedById}>{p.filedBy}</option>
                          </select>
                        </label>
                        <label>
                          Valeur
                          <input name="penaltyValue" type="number" min={0} defaultValue={5} />
                        </label>
                        <label>
                          Portée
                          <select name="penaltyScope">
                            <option value="session">Cette course</option>
                            <option value="championship">Total du championnat (points)</option>
                          </select>
                        </label>
                      </div>
                      <small className="muted">Une pénalité n’est appliquée que si l’issue est « fondée ». Elle reste annulable et tracée.</small>
                      <button className="btn primary">Enregistrer la décision</button>
                    </form>
                  </details>
                </>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}
