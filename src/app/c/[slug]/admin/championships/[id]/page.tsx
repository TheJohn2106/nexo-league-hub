import Link from "next/link";
import { notFound } from "next/navigation";
import { requireLeaguePermission } from "@/lib/league";
import { championshipIn } from "@/lib/services/context";
import { listRegistrations } from "@/lib/services/registrations";
import { roundsOf } from "@/lib/services/read";
import { ChampionshipFields } from "@/components/championship-form";
import { Flash, Hidden, Pill, When, type SP } from "@/components/ui";
import {
  championshipStatusAction,
  createRoundAction,
  decideRegistrationAction,
  reserveRankAction,
  updateChampionshipAction,
} from "@/app/actions";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Gestion du championnat" };

const transitions: Record<string, [string, string][]> = {
  draft: [["open", "Ouvrir les inscriptions"], ["cancelled", "Annuler"]],
  open: [["closed", "Fermer les inscriptions"], ["draft", "Repasser en brouillon"], ["cancelled", "Annuler"]],
  closed: [["open", "Rouvrir les inscriptions"], ["finished", "Clôturer la saison"], ["cancelled", "Annuler"]],
  finished: [["closed", "Rouvrir la saison"]],
  cancelled: [["draft", "Restaurer en brouillon"]],
};

export default async function ChampionshipAdmin({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: SP }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/championships/${id}`;
  const { community, db } = await requireLeaguePermission(slug, "championship.manage", here);
  let c;
  try {
    c = await championshipIn(db, community.id, id);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const regs = await listRegistrations(db, community.id, c.id);
  const rounds = await roundsOf(db, c.id, true);
  const h = { slug, back: here };
  const tz = community.timezone;
  const accepted = regs.filter((r) => r.status === "accepted").length;
  return (
    <>
      <p>
        <Link href={`/c/${slug}/championships/${c.slug}`}>Voir la page publique →</Link>
      </p>
      <h1>{c.name}</h1>
      <Flash searchParams={sp} />
      <div className="row">
        <Pill value={c.status} />
        <span className="muted">Règlement v{c.rules_version}</span>
        {(transitions[c.status] ?? []).map(([to, label]) => (
          <form key={to} action={championshipStatusAction}>
            <Hidden values={{ ...h, championshipId: c.id, status: to }} />
            <button className={`btn small ${to === "cancelled" ? "danger" : ""}`}>{label}</button>
          </form>
        ))}
      </div>

      <section className="section" id="inscriptions">
        <div className="section-title">
          <h2>Inscriptions</h2>
          <span className="muted">
            {accepted}/{c.capacity} titulaires
          </span>
        </div>
        {regs.length === 0 ? (
          <p className="empty">Aucune inscription.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pilote</th>
                  <th>Choix</th>
                  <th>Règlement</th>
                  <th>Statut</th>
                  <th>Décision</th>
                </tr>
              </thead>
              <tbody>
                {regs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.displayName}</strong>
                      <div className="breakdown mono">iRacing {r.iracingCustId ?? "—"}</div>
                      {r.note && <div className="breakdown">« {r.note} »</div>}
                    </td>
                    <td>
                      {[r.category, r.car, r.teamName, r.raceNumber != null ? `#${r.raceNumber}` : null].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td>
                      v{r.rulesVersion} {r.rulesVersion < c.rules_version && <span className="pill warn">à ré-accepter</span>}
                      <div className="breakdown">
                        <When date={r.rulesAcceptedAt} tz={tz} />
                      </div>
                    </td>
                    <td>
                      <Pill value={r.status} />
                      {r.status === "reserve" && (
                        <form action={reserveRankAction} className="row" style={{ marginTop: 6 }}>
                          <Hidden values={{ ...h, registrationId: r.id }} />
                          <label className="sr-only" htmlFor={`rank-${r.id}`}>
                            Rang
                          </label>
                          <input id={`rank-${r.id}`} name="rank" type="number" min={1} defaultValue={r.reserveRank ?? ""} style={{ width: 70, minHeight: 34 }} />
                          <button className="btn small">Rang</button>
                        </form>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        {(
                          [
                            ["accepted", "Accepter", "ok"],
                            ["reserve", "Réserviste", ""],
                            ["refused", "Refuser", "danger"],
                          ] as const
                        )
                          .filter(([d]) => d !== r.status && r.status !== "withdrawn")
                          .map(([d, label, tone]) => (
                            <form key={d} action={decideRegistrationAction}>
                              <Hidden values={{ ...h, registrationId: r.id, decision: d }} />
                              <button className={`btn small ${tone}`}>{label}</button>
                            </form>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-title">
          <h2>Manches</h2>
        </div>
        <div className="stack">
          {rounds.map((r) => (
            <Link key={r.id} href={`/c/${slug}/admin/rounds/${r.id}`} className="card row between" style={{ textDecoration: "none" }}>
              <span>
                <strong>
                  M{r.number} · {r.name}
                </strong>{" "}
                <span className="muted">{r.track}</span>
              </span>
              <span className="row">
                <When date={r.startsAt} tz={tz} />
                <Pill value={r.status} />
                <span className="muted">{r.confirmed} confirmés</span>
              </span>
            </Link>
          ))}
        </div>
        <details className="section">
          <summary>Ajouter une manche</summary>
          <form action={createRoundAction} className="body form">
            <Hidden values={{ ...h, championshipId: c.id }} />
            <div className="cols">
              <label>
                Nom *
                <input name="name" required placeholder={`Manche ${rounds.length + 1}`} />
              </label>
              <label>
                Circuit *
                <input name="track" required />
              </label>
              <label>
                Configuration
                <input name="trackConfig" />
              </label>
              <label>
                Départ de la course ({tz}) *
                <input name="startsAt" type="datetime-local" required />
              </label>
              <label>
                Capacité <span className="hint">Vide = capacité du championnat ({c.capacity}).</span>
                <input name="capacity" type="number" min={1} />
              </label>
            </div>
            <div className="cols">
              <label className="check">
                <input type="checkbox" name="withPractice" defaultChecked /> Essais
              </label>
              <label>
                Essais : début (min avant)
                <input name="practiceOffset" type="number" defaultValue={45} />
              </label>
              <label>
                Essais : durée (min)
                <input name="practiceDuration" type="number" defaultValue={20} />
              </label>
            </div>
            <div className="cols">
              <label className="check">
                <input type="checkbox" name="withQualifying" defaultChecked /> Qualifications (pole)
              </label>
              <label>
                Qualifs : début (min avant)
                <input name="qualifyingOffset" type="number" defaultValue={20} />
              </label>
              <label>
                Qualifs : durée (min)
                <input name="qualifyingDuration" type="number" defaultValue={15} />
              </label>
            </div>
            <div className="cols">
              <label>
                Nombre de courses
                <input name="races" type="number" min={1} max={4} defaultValue={1} />
              </label>
              <label>
                Durée d’une course (min)
                <input name="raceDuration" type="number" min={1} defaultValue={45} />
              </label>
              <label className="check">
                <input type="checkbox" name="jokerEligible" defaultChecked /> Peut être retirée comme joker
              </label>
            </div>
            <label>
              Informations serveur spécifiques (protégées)
              <textarea name="serverInfo" rows={2} />
            </label>
            <label>
              Notes publiques
              <textarea name="notes" rows={2} />
            </label>
            <button className="btn primary">Créer la manche</button>
          </form>
        </details>
      </section>

      <section className="section">
        <h2>Exports CSV</h2>
        <div className="row">
          {(
            [
              ["registrations", "Inscriptions"],
              ["attendance", "Présences"],
              ["results", "Résultats"],
              ["standings", "Classement"],
            ] as const
          ).map(([k, label]) => (
            <a key={k} className="btn small" href={`/api/export?slug=${slug}&championship=${c.id}&kind=${k}`}>
              {label}
            </a>
          ))}
        </div>
      </section>

      <details className="section">
        <summary>Paramètres, règlement et barème</summary>
        <form action={updateChampionshipAction} className="body form">
          <Hidden values={{ ...h, championshipId: c.id }} />
          <ChampionshipFields c={c} tz={tz} />
          <button className="btn primary">Enregistrer (recalcul automatique des classements)</button>
        </form>
      </details>
    </>
  );
}
