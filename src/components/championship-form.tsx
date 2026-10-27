import { defaultScoring, type ScoringConfig } from "@/lib/scoring/types";
import { utcToZonedLocal } from "@/lib/time";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function ChampionshipFields({ c, tz }: { c?: Row; tz: string }) {
  const s: ScoringConfig = c?.scoring ?? defaultScoring;
  return (
    <>
      <fieldset className="form">
        <legend>Présentation</legend>
        <div className="cols">
          <label>
            Nom *
            <input name="name" required defaultValue={c?.name} maxLength={100} />
          </label>
          <label>
            Identifiant d’URL
            <span className="hint">Laisser vide pour le générer.</span>
            <input name="champSlug" defaultValue={c?.slug} pattern="[a-z0-9][a-z0-9\-]{1,60}" />
          </label>
        </div>
        <label>
          Description
          <textarea name="description" defaultValue={c?.description} maxLength={4000} />
        </label>
        <label>
          Règlement
          <span className="hint">Texte libre. Toute modification peut créer une nouvelle version à accepter par les pilotes.</span>
          <textarea name="rulesMd" defaultValue={c?.rules_md} rows={10} />
        </label>
        {c && (
          <label className="check">
            <input type="checkbox" name="newRulesVersion" defaultChecked />
            <span>Si le règlement change, créer la version {c.rules_version + 1} (les pilotes devront l’accepter).</span>
          </label>
        )}
      </fieldset>
      <fieldset className="form">
        <legend>Inscriptions</legend>
        <div className="cols">
          <label>
            Capacité (titulaires) *
            <input name="capacity" type="number" min={1} max={200} required defaultValue={c?.capacity ?? 20} />
          </label>
          <label>
            Date limite d’inscription ({tz})
            <input name="registrationDeadline" type="datetime-local" defaultValue={c?.registration_deadline ? utcToZonedLocal(c.registration_deadline, tz) : ""} />
          </label>
          <label>
            Numéros de course
            <select name="numberPolicy" defaultValue={c?.number_policy ?? "unique"}>
              <option value="unique">Uniques dans le championnat</option>
              <option value="free">Libres (doublons permis)</option>
              <option value="none">Pas de numéro</option>
            </select>
          </label>
        </div>
        <div className="cols">
          <label>
            Catégories <span className="hint">Séparées par des virgules (ex. Pro, Am).</span>
            <input name="categories" defaultValue={(c?.categories ?? []).join(", ")} />
          </label>
          <label>
            Voitures / classes autorisées <span className="hint">Séparées par des virgules.</span>
            <input name="cars" defaultValue={(c?.cars ?? []).join(", ")} />
          </label>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" name="requireCategory" defaultChecked={c?.require_category} /> Catégorie obligatoire
          </label>
          <label className="check">
            <input type="checkbox" name="requireCar" defaultChecked={c?.require_car} /> Voiture obligatoire
          </label>
          <label className="check">
            <input type="checkbox" name="requireTeam" defaultChecked={c?.require_team} /> Équipe obligatoire
          </label>
        </div>
      </fieldset>
      <fieldset className="form">
        <legend>Présences et réclamations</legend>
        <div className="cols">
          <label>
            Réponse de présence (h avant départ)
            <input name="presenceDeadlineHours" type="number" min={0} max={720} defaultValue={c?.presence_deadline_hours ?? 48} />
          </label>
          <label>
            Ouverture du pointage (min avant)
            <input name="checkinOpensMinutes" type="number" min={0} max={1440} defaultValue={c?.checkin_opens_minutes ?? 60} />
          </label>
          <label>
            Fermeture du pointage (min avant)
            <input name="checkinClosesMinutes" type="number" min={0} max={1440} defaultValue={c?.checkin_closes_minutes ?? 10} />
          </label>
          <label>
            Délai pour accepter une place (h)
            <input name="offerTtlHours" type="number" min={1} max={168} defaultValue={c?.offer_ttl_hours ?? 12} />
          </label>
          <label>
            Délai de réclamation (h après la course)
            <input name="protestWindowHours" type="number" min={1} max={336} defaultValue={c?.protest_window_hours ?? 48} />
          </label>
        </div>
        <label>
          Informations serveur (protégées)
          <span className="hint">Nom du serveur, mot de passe… Visible des pilotes confirmés et des organisateurs uniquement.</span>
          <textarea name="serverInfo" defaultValue={c?.server_info} rows={3} />
        </label>
      </fieldset>
      <fieldset className="form">
        <legend>Barème</legend>
        <label>
          Points par position (1re, 2e, …)
          <input name="pointsByPosition" defaultValue={s.pointsByPosition.join(" ")} required />
        </label>
        <div className="cols">
          <label>
            Base de position
            <select name="positionBasis" defaultValue={s.positionBasis}>
              <option value="overall">Classement général</option>
              <option value="class">Position dans la classe (multi-classe)</option>
            </select>
          </label>
          <label>
            Points de participation
            <input name="participationPoints" type="number" step="0.5" min={0} defaultValue={s.participationPoints} />
          </label>
          <label>
            Bonus pole
            <input name="polePoints" type="number" step="0.5" min={0} defaultValue={s.pole.points} />
          </label>
          <label>
            Bonus meilleur tour
            <input name="fastestLapPoints" type="number" step="0.5" min={0} defaultValue={s.fastestLap.points} />
          </label>
          <label>
            Meilleur tour : top N requis
            <input name="fastestLapMaxPosition" type="number" min={1} defaultValue={s.fastestLap.maxPosition ?? ""} placeholder="aucune limite" />
          </label>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" name="poleRequiresStart" defaultChecked={s.pole.requiresStart} /> Pole : le pilote doit prendre le départ
          </label>
          <label className="check">
            <input type="checkbox" name="fastestLapRequiresClassified" defaultChecked={s.fastestLap.requiresClassified} /> Meilleur tour : pilote classé
          </label>
        </div>
        <div className="cols">
          <label>
            Abandon (DNF)
            <select name="dnfMode" defaultValue={s.dnf.mode}>
              <option value="position">Points de la place si distance suffisante</option>
              <option value="zero">Aucun point</option>
            </select>
          </label>
          <label>
            Distance minimale (% des tours du vainqueur)
            <input name="dnfMinLapsPercent" type="number" min={0} max={100} defaultValue={s.dnf.minLapsPercent} />
          </label>
          <label>
            Jokers (plus mauvaises manches retirées)
            <input name="dropWorst" type="number" min={0} max={20} defaultValue={s.dropWorst} />
          </label>
          <label>
            Équipes : résultats comptés par course
            <input name="teamCountBest" type="number" min={1} max={10} defaultValue={s.teams.countBest} />
          </label>
          <label>
            Départage (ordre)
            <span className="hint">wins, countback, lastRound, fewestIncidents</span>
            <input name="tiebreak" defaultValue={s.tiebreak.join(", ")} />
          </label>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" name="absenceRule" defaultChecked={s.absencePenaltyPoints != null} />
            <span>Activer une pénalité pour absence au départ non annoncée (désactivée par défaut)</span>
          </label>
          <label>
            Points retirés
            <input name="absencePenaltyPoints" type="number" min={0} defaultValue={s.absencePenaltyPoints ?? 0} style={{ maxWidth: 120 }} />
          </label>
        </div>
      </fieldset>
    </>
  );
}
