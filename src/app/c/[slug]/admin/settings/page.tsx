import { requireLeaguePermission } from "@/lib/league";
import { outboxFor } from "@/lib/services/notifications";
import { Flash, Hidden, Pill, When, type SP } from "@/components/ui";
import { brandingAction, deliverNowAction, discordSettingsAction } from "@/app/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Réglages de la ligue" };

const kinds: Record<string, string> = {
  round_announcement: "Annonce de manche",
  presence_reminder: "Rappel de présence",
  seat_offer: "Place proposée",
  results_published: "Résultats publiés",
};

export default async function Settings({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/settings`;
  const { community: c, db } = await requireLeaguePermission(slug, "community.manage", here);
  const outbox = await outboxFor(db, c.id);
  const b = c.branding ?? {};
  const h = { slug, back: here };
  return (
    <>
      <h1>Réglages de la ligue</h1>
      <Flash searchParams={sp} />

      <section className="card section">
        <h2>Identité</h2>
        <form action={brandingAction} className="form">
          <Hidden values={h} />
          <div className="cols">
            <label>
              Nom *
              <input name="name" required defaultValue={c.name} maxLength={80} />
            </label>
            <label>
              Accroche
              <input name="tagline" defaultValue={c.tagline} maxLength={160} />
            </label>
            <label>
              Logo (URL https)
              <input name="logoUrl" type="url" defaultValue={b.logoUrl ?? ""} />
            </label>
            <label>
              Couleur principale
              <input name="primaryColor" type="color" defaultValue={b.primaryColor ?? "#e10600"} />
            </label>
            <label>
              Couleur d’accent
              <input name="accentColor" type="color" defaultValue={b.accentColor ?? "#00b3ff"} />
            </label>
            <label>
              Fuseau horaire
              <input name="timezone" defaultValue={c.timezone} required />
            </label>
            <label>
              Adhésions
              <select name="joinPolicy" defaultValue={c.joinPolicy}>
                <option value="approval">Sur demande, validée par l’organisation</option>
                <option value="closed">Fermées</option>
              </select>
            </label>
          </div>
          <div className="cols">
            <label>
              Twitch
              <input name="twitchUrl" type="url" defaultValue={b.twitchUrl ?? ""} />
            </label>
            <label>
              Serveur Discord (invitation)
              <input name="discordUrl" type="url" defaultValue={b.discordUrl ?? ""} />
            </label>
            <label>
              Site web
              <input name="websiteUrl" type="url" defaultValue={b.websiteUrl ?? ""} />
            </label>
          </div>
          <label>
            Partenaires <span className="hint">Une ligne par partenaire : nom|url|logo (url et logo facultatifs).</span>
            <textarea name="partners" rows={3} defaultValue={(b.partners ?? []).map((p) => [p.name, p.url ?? "", p.logoUrl ?? ""].join("|")).join("\n")} />
          </label>
          <button className="btn primary">Enregistrer l’identité</button>
        </form>
      </section>

      <section className="card section">
        <h2>Discord</h2>
        <p>
          État :{" "}
          {c.discordConfigured ? <span className="pill ok">Webhook configuré</span> : <span className="pill">Non configuré : aucune notification n’est envoyée</span>}
        </p>
        <form action={discordSettingsAction} className="form">
          <Hidden values={h} />
          <div className="cols">
            <label>
              Webhook du salon <span className="hint">Laisser vide pour conserver l’actuel ; « - » pour le supprimer. Jamais affiché.</span>
              <input name="webhookUrl" type="password" autoComplete="off" placeholder="https://discord.com/api/webhooks/…" />
            </label>
            <label>
              Rappel avant une manche (heures)
              <input name="reminderHours" type="number" min={1} max={336} defaultValue={c.discordReminderHours} />
            </label>
          </div>
          <button className="btn primary">Enregistrer</button>
        </form>
        <div className="section-title section">
          <h3>File d’envoi</h3>
          <form action={deliverNowAction}>
            <Hidden values={h} />
            <button className="btn small">Traiter la file maintenant</button>
          </form>
        </div>
        <p className="breakdown">Le worker traite la file automatiquement (npm run worker). Un message n’est marqué « Envoyé » qu’après une réponse positive de Discord.</p>
        {outbox.length === 0 ? (
          <p className="empty">File vide.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Créé</th>
                  <th>Type</th>
                  <th>Statut</th>
                  <th className="num">Essais</th>
                  <th>Erreur</th>
                </tr>
              </thead>
              <tbody>
                {outbox.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <When date={o.createdAt} tz={c.timezone} />
                    </td>
                    <td>{kinds[o.kind] ?? o.kind}</td>
                    <td>
                      <Pill value={o.status} />
                    </td>
                    <td className="num">{o.attempts}</td>
                    <td className="breakdown">{o.lastError ?? ""}</td>
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
