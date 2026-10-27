import Link from "next/link";
import { notFound } from "next/navigation";
import { requireLeaguePermission } from "@/lib/league";
import { getImport } from "@/lib/services/results";
import { Flash, Hidden, Lap, Pill, Val, When, labels, type SP } from "@/components/ui";
import { applyImportAction, discardImportAction } from "@/app/actions";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Aperçu d’import" };

const how: Record<string, string> = {
  iracing_id: "Identifiant iRacing",
  manual_entry: "Saisie manuelle",
  name: "Nom identique : à confirmer",
  none: "Inconnu : décision requise",
};

export default async function ImportPreview({ params, searchParams }: { params: Promise<{ slug: string; importId: string }>; searchParams: SP }) {
  const { slug, importId } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/imports/${importId}`;
  const { community, db } = await requireLeaguePermission(slug, "results.manage", here);
  let data;
  try {
    data = await getImport(db, community.id, importId);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const { import: imp, parsed, drivers, suggestions } = data;
  const editable = imp.status === "preview";
  const h = { slug, back: here, importId: imp.id, roundId: imp.round_id };
  return (
    <>
      <p>
        <Link href={`/c/${slug}/admin/rounds/${imp.round_id}#resultats`}>← Retour à la manche</Link>
      </p>
      <h1>Aperçu — {imp.label}</h1>
      <Flash searchParams={sp} />
      {sp.dup && <div className="flash ok">Source déjà importée : l’import existant est réutilisé (aucun doublon).</div>}
      <div className="row">
        <Pill value={imp.status} />
        <span>{labels[imp.source]}</span>
        <span className="muted">
          <When date={imp.created_at} tz={community.timezone} />
        </span>
      </div>
      {imp.source === "csv_template" && <p className="breakdown">Format interne Nexo : ce n’est pas un export officiel iRacing.</p>}
      {imp.error && <p className="flash error">{imp.error}</p>}
      {parsed && (
        <>
          <dl className="kv section">
            <dt>Source</dt>
            <dd>{parsed.sourceLabel}</dd>
            {parsed.subsessionId && (
              <>
                <dt>Sous-session</dt>
                <dd className="mono">{parsed.subsessionId}</dd>
                <dt>Simsession</dt>
                <dd>
                  {parsed.simsessionNumber} ({parsed.simsessionName}) — disponibles : {parsed.availableSessions.map((s) => `${s.number} ${s.name}`).join(", ")}
                </dd>
              </>
            )}
            {parsed.track && (
              <>
                <dt>Circuit</dt>
                <dd>{parsed.track}</dd>
              </>
            )}
          </dl>
          {parsed.warnings.map((w) => (
            <p key={w} className="notice warn">
              {w}
            </p>
          ))}
          <form action={applyImportAction} className="form section">
            <Hidden values={h} />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pos.</th>
                    <th>Participant (source)</th>
                    <th>Rapprochement</th>
                    <th>Statut</th>
                    <th className="num">Départ</th>
                    <th className="num">Tours</th>
                    <th className="num">Meilleur tour</th>
                    <th className="num">Écart</th>
                    <th className="num">Inc.</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((r) => {
                    const s = suggestions.find((x) => x.entryKey === r.entryKey)!;
                    return (
                      <tr key={r.entryKey}>
                        <td>
                          {r.finishPosition}
                          {r.classPosition != null && <div className="breakdown">classe {r.classPosition}</div>}
                        </td>
                        <td>
                          <strong>{r.displayName}</strong>
                          <div className="breakdown mono">
                            {r.custId ? `iRacing ${r.custId}` : r.entryKey}
                            {r.carClass && ` · ${r.carClass}`}
                          </div>
                          {r.crew.length > 0 && <div className="breakdown">Équipage : {r.crew.map((c) => c.displayName).join(", ")}</div>}
                        </td>
                        <td>
                          <div className="breakdown">{how[s.how]}</div>
                          {editable ? (
                            <select name={`match:${r.entryKey}`} defaultValue={s.how === "iracing_id" || s.how === "manual_entry" ? "auto" : ""} aria-label={`Rapprochement de ${r.displayName}`} required={s.how === "none" || s.how === "name"}>
                              {(s.how === "iracing_id" || s.how === "manual_entry") && (
                                <option value="auto">{drivers.find((d) => d.userId === s.userId)?.displayName ?? "Pilote"} (automatique)</option>
                              )}
                              {(s.how === "none" || s.how === "name") && <option value="">— Choisir —</option>}
                              <option value="none">Hors classement (non inscrit)</option>
                              {drivers.map((d) => (
                                <option key={d.userId} value={d.userId}>
                                  {d.displayName} ({labels[d.status]}){d.userId === s.userId && s.how === "name" ? " — suggéré" : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span>{s.userId ? drivers.find((d) => d.userId === s.userId)?.displayName : "—"}</span>
                          )}
                        </td>
                        <td>
                          <Pill value={r.status} />
                          {r.reasonOut && r.reasonOut !== "Running" && <div className="breakdown">{r.reasonOut}</div>}
                        </td>
                        <td className="num">
                          <Val v={r.startPosition} />
                        </td>
                        <td className="num">
                          <Val v={r.laps} />
                        </td>
                        <td className="num">
                          <Lap ms={r.bestLapMs} />
                        </td>
                        <td className="num">{r.gapLaps ? `+${r.gapLaps} t.` : r.gapMs != null ? `+${(r.gapMs / 1000).toFixed(3)} s` : <span className="muted">non fourni</span>}</td>
                        <td className="num">
                          <Val v={r.incidents} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {editable && (
              <div className="card stack">
                <label className="check">
                  <input type="checkbox" name="final" />
                  <span>Résultats définitifs (sinon : provisoires, par exemple en attente des réclamations)</span>
                </label>
                <label className="check">
                  <input type="checkbox" name="saveIds" defaultChecked />
                  <span>Enregistrer l’identifiant iRacing sur le profil des pilotes rapprochés manuellement (s’il est vide et libre)</span>
                </label>
                <div className="row">
                  <button className="btn primary">Valider l’import</button>
                </div>
                <small className="muted">La validation remplace l’import précédent de cette session sans créer de doublon ; la source brute reste conservée.</small>
              </div>
            )}
          </form>
          {editable && (
            <form action={discardImportAction} className="section">
              <Hidden values={h} />
              <button className="btn danger small">Abandonner cet aperçu</button>
            </form>
          )}
        </>
      )}
      <details className="section">
        <summary>Source brute conservée</summary>
        <pre className="body mono" style={{ whiteSpace: "pre-wrap", maxHeight: 400, overflow: "auto" }}>
          {JSON.stringify(imp.raw, null, 1).slice(0, 20000)}
        </pre>
      </details>
    </>
  );
}
