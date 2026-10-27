import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { championshipBySlug } from "@/lib/services/context";
import { getProfile } from "@/lib/services/accounts";
import { registerChampionshipAction } from "@/app/actions";
import { Flash, type SP } from "@/components/ui";
import { AppError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inscription au championnat" };

export default async function RegisterChampionship({ params, searchParams }: { params: Promise<{ slug: string; champ: string }>; searchParams: SP }) {
  const { slug, champ } = await params;
  const sp = await searchParams;
  const { community, db, user, role, membership } = await loadLeague(slug);
  const here = `/c/${slug}/championships/${champ}/register`;
  if (!user) redirect(`/login?next=${encodeURIComponent(here)}`);
  let c;
  try {
    c = await championshipBySlug(db, community.id, champ);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const profile = await getProfile(db, user.id);
  const teams = (await db.query("SELECT id, name FROM teams WHERE championship_id=$1 ORDER BY name", [c.id])).rows;
  const taken = c.number_policy === "unique" ? (await db.query("SELECT race_number FROM registrations WHERE championship_id=$1 AND status IN ('pending','accepted','reserve') AND race_number IS NOT NULL AND user_id<>$2 ORDER BY race_number", [c.id, user.id])).rows.map((r) => r.race_number) : [];
  const blockers: string[] = [];
  if (!role) blockers.push(membership?.status === "pending" ? "Votre adhésion à la ligue est en attente de validation." : "Vous devez d’abord être membre accepté de la ligue (demande depuis l’accueil).");
  if (!profile.iracingCustId) blockers.push("Renseignez votre identifiant client iRacing dans votre profil.");
  if (c.status !== "open") blockers.push("Les inscriptions ne sont pas ouvertes.");
  return (
    <div style={{ maxWidth: 720 }}>
      <p>
        <Link href={`/c/${slug}/championships/${c.slug}`}>← {c.name}</Link>
      </p>
      <h1>Inscription</h1>
      <Flash searchParams={sp} />
      <p className="muted">Votre inscription sera examinée par un organisateur : elle ne vous donne pas automatiquement une place.</p>
      {blockers.length > 0 && (
        <div className="notice warn stack">
          {blockers.map((b) => (
            <div key={b}>{b}</div>
          ))}
          {!profile.iracingCustId && (
            <Link className="btn small" href={`/profile?back=${encodeURIComponent(here)}`}>
              Compléter mon profil
            </Link>
          )}
        </div>
      )}
      <form action={registerChampionshipAction} className="card form section">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="back" value={here} />
        <input type="hidden" name="championshipId" value={c.id} />
        <input type="hidden" name="rulesVersion" value={c.rules_version} />
        <p>
          Pilote : <strong>{profile.displayName}</strong> · iRacing <span className="mono">{profile.iracingCustId ?? "non renseigné"}</span>
        </p>
        <div className="cols">
          {c.categories.length > 0 && (
            <label>
              Catégorie {c.require_category && "*"}
              <select name="category" required={c.require_category} defaultValue="">
                <option value="">—</option>
                {c.categories.map((x: string) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
          {c.cars.length > 0 && (
            <label>
              Voiture {c.require_car && "*"}
              <select name="car" required={c.require_car} defaultValue="">
                <option value="">—</option>
                {c.cars.map((x: string) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
          {c.number_policy !== "none" && (
            <label>
              Numéro de course
              <span className="hint">{c.number_policy === "unique" ? `Unique dans le championnat.${taken.length ? ` Déjà pris : ${taken.join(", ")}` : ""}` : "Libre."}</span>
              <input name="raceNumber" inputMode="numeric" pattern="\d{0,3}" defaultValue={profile.preferredNumber ?? ""} />
            </label>
          )}
        </div>
        <fieldset>
          <legend>Équipe {c.require_team ? "*" : "(facultatif)"}</legend>
          <div className="cols">
            <label>
              Rejoindre une équipe
              <select name="teamId" defaultValue="">
                <option value="">—</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ou créer une équipe
              <input name="newTeamName" maxLength={60} />
            </label>
          </div>
        </fieldset>
        <label>
          Message (facultatif)
          <input name="note" maxLength={500} />
        </label>
        <details>
          <summary>Lire le règlement (version {c.rules_version})</summary>
          <div className="body rules">{c.rules_md || "Règlement non publié."}</div>
        </details>
        <label className="check">
          <input type="checkbox" name="acceptRules" required />
          <span>J’accepte le règlement version {c.rules_version} (la date d’acceptation est enregistrée).</span>
        </label>
        <button className="btn primary" type="submit" disabled={blockers.length > 0}>
          Envoyer mon inscription
        </button>
      </form>
    </div>
  );
}
