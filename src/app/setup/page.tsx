import { notFound } from "next/navigation";
import { setupAction } from "@/app/actions";
import { Flash, type SP } from "@/components/ui";
import { getPool } from "@/lib/db";
import { needsSetup } from "@/lib/services/accounts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Installation", robots: { index: false } };

// Première installation sur un serveur vierge : crée le compte propriétaire et la ligue.
// Disponible seulement si SETUP_TOKEN est défini et qu'aucun compte n'existe encore.
export default async function Setup({ searchParams }: { searchParams: SP }) {
  if (!process.env.SETUP_TOKEN || !(await needsSetup(getPool()))) notFound();
  const sp = await searchParams;
  return (
    <main className="wrap" style={{ maxWidth: 520, paddingTop: 40 }}>
      <h1>Installation</h1>
      <p className="muted">Création du compte propriétaire et de la ligue. Cette page disparaît dès que le premier compte existe.</p>
      <Flash searchParams={sp} />
      <form action={setupAction} className="card form">
        <label>
          Jeton d’installation <span className="hint">Variable SETUP_TOKEN de l’hébergement.</span>
          <input name="token" type="password" autoComplete="off" required />
        </label>
        <label>
          Pseudo
          <input name="displayName" required minLength={2} maxLength={40} />
        </label>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Mot de passe <span className="hint">10 caractères minimum, avec une lettre et un chiffre.</span>
          <input name="password" type="password" autoComplete="new-password" required minLength={10} />
        </label>
        <label>
          Confirmation
          <input name="password2" type="password" autoComplete="new-password" required minLength={10} />
        </label>
        <label>
          Nom de la ligue
          <input name="league" required />
        </label>
        <label>
          Adresse de la ligue <span className="hint">Lettres minuscules, chiffres et tirets, ex. : nexo-racing.</span>
          <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,40}" />
        </label>
        <button className="btn primary" type="submit">
          Créer et me connecter
        </button>
      </form>
    </main>
  );
}
