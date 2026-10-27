import Link from "next/link";
import { resetPasswordAction } from "@/app/actions";
import { Flash, type SP } from "@/components/ui";
import { getPool } from "@/lib/db";
import { passwordResetValid } from "@/lib/services/accounts";

export const dynamic = "force-dynamic";
// Le jeton est dans l'URL : ne jamais le transmettre en référent.
export const metadata = { title: "Nouveau mot de passe", referrer: "no-referrer", robots: { index: false } };

export default async function Reset({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const valid = await passwordResetValid(getPool(), token);
  return (
    <main className="wrap" style={{ maxWidth: 460, paddingTop: 40 }}>
      <h1>Nouveau mot de passe</h1>
      <Flash searchParams={sp} />
      {valid ? (
        <form action={resetPasswordAction} className="card form">
          <input type="hidden" name="token" value={token} />
          <label>
            Nouveau mot de passe
            <input name="next" type="password" autoComplete="new-password" required minLength={10} />
          </label>
          <label>
            Confirmation
            <input name="next2" type="password" autoComplete="new-password" required minLength={10} />
          </label>
          <p className="muted">10 caractères minimum, avec au moins une lettre et un chiffre. Vos autres sessions seront fermées.</p>
          <button className="btn primary" type="submit">
            Enregistrer et me connecter
          </button>
        </form>
      ) : (
        <div className="card">
          <p>Ce lien est invalide, expiré ou déjà utilisé.</p>
          <p className="muted">Demandez un nouveau lien à l’organisation de votre ligue. Un lien est valable 24 heures et ne sert qu’une fois.</p>
          <Link href="/login">Retour à la connexion</Link>
        </div>
      )}
    </main>
  );
}
