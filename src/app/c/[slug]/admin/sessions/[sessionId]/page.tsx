import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { sessionResultRows } from "@/lib/services/results";
import { sessionPenalties } from "@/lib/services/stewarding";
import { championshipStandings } from "@/lib/services/standings";
import { SessionResults } from "@/components/standings";
import { Flash, Hidden, Pill, When, labels, type SP } from "@/components/ui";
import { correctionAction, penaltyAction, revokeCorrectionAction, revokePenaltyAction } from "@/app/actions";
import { AppError } from "@/lib/errors";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Corrections et pénalités" };

const fields: [string, string][] = [
  ["finish_position", "Position"],
  ["status", "Statut (classified, dnf, dns, dsq)"],
  ["laps", "Tours"],
  ["best_lap_ms", "Meilleur tour (1:32.456)"],
  ["total_time_ms", "Temps total (45:12.300)"],
  ["incidents", "Incidents"],
  ["start_position", "Position de départ"],
  ["user_id", "Pilote rattaché"],
];

export default async function SessionAdmin({ params, searchParams }: { params: Promise<{ slug: string; sessionId: string }>; searchParams: SP }) {
  const { slug, sessionId } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/sessions/${sessionId}`;
  const { community, db, user, role } = await loadLeague(slug);
  if (!user) redirect(`/login?next=${encodeURIComponent(here)}`);
  const manage = can(role, "results.manage");
  const decide = can(role, "protests.decide");
  if (!manage && !decide) redirect(`/c/${slug}?error=${encodeURIComponent("Accès réservé.")}`);
  let data;
  try {
    data = await sessionResultRows(db, community.id, sessionId);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { session, results, corrections } = data;
  const penalties = await sessionPenalties(db, community.id, session.id);
  const { input, output } = await championshipStandings(db, community.id, session.championship_id);
  const names = new Map(input.drivers.map((d) => [d.userId, d.displayName]));
  const unapplied = output.unappliedPenalties;
  const h = { slug, back: here, sessionId: session.id };
  const tz = community.timezone;
  return (
    <>
      <p>
        <Link href={`/c/${slug}/admin/rounds/${session.round_id}#resultats`}>← M{session.round_number} · {session.round_name}</Link>
      </p>
      <h1>{session.label}</h1>
      <Flash searchParams={sp} />
      <Pill value={session.results_status} />
      <section className="section">
        <h2>Résultat recalculé</h2>
        <p className="breakdown">Le résultat importé n’est jamais modifié : corrections et pénalités sont appliquées au calcul.</p>
        <SessionResults rows={output.effective[session.id] ?? []} lines={output.lines.filter((l) => l.sessionId === session.id)} names={names} base={`/c/${slug}`} showPoints={session.awards_points} isPublic={false} />
      </section>

      <div className="grid two section">
        <section className="card">
          <h2>Pénalités</h2>
          {penalties.length === 0 && <p className="muted">Aucune pénalité.</p>}
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {penalties.map((p) => {
              const u = unapplied.find((x) => x.penaltyId === p.id);
              return (
                <li key={p.id}>
                  <strong>{p.displayName}</strong> · {labels[p.kind]} {p.value ? p.value : ""} {p.kind === "time" ? "s" : p.kind === "positions" ? "place(s)" : p.kind === "points" ? "pt" : ""} · portée {labels[p.scope]}
                  <div className="breakdown">
                    « {p.reason} » — {p.author}, <When date={p.created_at} tz={tz} />
                  </div>
                  {p.revoked_at ? (
                    <span className="pill">Annulée</span>
                  ) : u ? (
                    <div className="notice warn">{u.reason}</div>
                  ) : null}
                  {!p.revoked_at && decide && (
                    <form action={revokePenaltyAction} className="row" style={{ marginTop: 6 }}>
                      <Hidden values={{ ...h, penaltyId: p.id }} />
                      <input name="reason" placeholder="Motif d’annulation" required minLength={3} style={{ minHeight: 34, maxWidth: 220 }} aria-label="Motif d’annulation" />
                      <button className="btn small danger">Annuler</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          {decide && (
            <details className="section">
              <summary>Appliquer une pénalité</summary>
              <form action={penaltyAction} className="body form">
                <Hidden values={h} />
                <div className="cols">
                  <label>
                    Pilote
                    <select name="userId" required>
                      {input.drivers.map((d) => (
                        <option key={d.userId} value={d.userId}>
                          {d.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Type
                    <select name="kind">
                      <option value="time">Temps (secondes)</option>
                      <option value="positions">Places</option>
                      <option value="points">Points</option>
                      <option value="dsq">Disqualification</option>
                      <option value="warning">Avertissement</option>
                    </select>
                  </label>
                  <label>
                    Valeur
                    <input name="value" type="number" min={0} defaultValue={5} />
                  </label>
                  <label>
                    Portée
                    <select name="scope">
                      <option value="session">Cette course</option>
                      <option value="championship">Total du championnat (points)</option>
                    </select>
                  </label>
                </div>
                <label>
                  Motif
                  <input name="reason" required minLength={3} />
                </label>
                <button className="btn primary">Appliquer</button>
                <small className="muted">Une pénalité en temps n’est appliquée que si les temps nécessaires sont connus ; sinon, décidez d’une pénalité en places.</small>
              </form>
            </details>
          )}
        </section>

        <section className="card">
          <h2>Corrections</h2>
          {corrections.length === 0 && <p className="muted">Aucune correction.</p>}
          <ul className="stack" style={{ paddingLeft: 18 }}>
            {corrections.map((c) => {
              const r = results.find((x) => x.id === c.result_id);
              return (
                <li key={c.id}>
                  <strong>{r ? (r.user_id ? names.get(r.user_id) ?? r.display_name : r.display_name) : "?"}</strong> · {c.field} : {c.old_value ?? "—"} → {c.new_value ?? "—"}
                  <div className="breakdown">
                    « {c.reason} » — {c.author}, <When date={c.created_at} tz={tz} />
                  </div>
                  {c.revoked_at ? (
                    <span className="pill">Annulée</span>
                  ) : (
                    manage && (
                      <form action={revokeCorrectionAction}>
                        <Hidden values={{ ...h, correctionId: c.id }} />
                        <button className="btn small danger">Annuler</button>
                      </form>
                    )
                  )}
                </li>
              );
            })}
          </ul>
          {manage && (
            <details className="section">
              <summary>Corriger un résultat</summary>
              <form action={correctionAction} className="body form">
                <Hidden values={h} />
                <label>
                  Ligne de résultat
                  <select name="resultId" required>
                    {results.map((r) => (
                      <option key={r.id} value={r.id}>
                        P{r.finish_position} · {r.user_id ? names.get(r.user_id) ?? r.display_name : `${r.display_name} (non rattaché)`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="cols">
                  <label>
                    Champ
                    <select name="field">
                      {fields.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Nouvelle valeur
                    <span className="hint">Pour « Pilote rattaché » : choisir ci-dessous.</span>
                    <input name="value" list="drivers-list" />
                  </label>
                </div>
                <datalist id="drivers-list">
                  {input.drivers.map((d) => (
                    <option key={d.userId} value={d.userId}>
                      {d.displayName}
                    </option>
                  ))}
                </datalist>
                <label>
                  Motif
                  <input name="reason" required minLength={3} />
                </label>
                <button className="btn primary">Enregistrer la correction</button>
              </form>
            </details>
          )}
        </section>
      </div>
    </>
  );
}
