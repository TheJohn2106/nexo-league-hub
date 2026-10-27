import Link from "next/link";
import { registerAccountAction } from "@/app/actions";
import { Flash, type SP } from "@/components/ui";
import { safePath } from "@/lib/web";

export const metadata = { title: "Créer un compte" };

export default async function Register({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safePath(typeof sp.next === "string" ? sp.next : "/", "/");
  return (
    <main className="wrap" style={{ maxWidth: 460, paddingTop: 40 }}>
      <h1>Créer un compte</h1>
      <p className="muted">Votre compte vous permet de demander à rejoindre une ligue. Il ne vous inscrit à aucun championnat.</p>
      <Flash searchParams={sp} />
      <form action={registerAccountAction} className="card form">
        <input type="hidden" name="next" value={next} />
        <label>
          Pseudo public
          <span className="hint">Affiché sur les classements. 2 à 40 caractères.</span>
          <input name="displayName" required minLength={2} maxLength={40} autoComplete="nickname" />
        </label>
        <label>
          Email <span className="hint">Privé : jamais affiché publiquement.</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Mot de passe <span className="hint">10 caractères minimum, avec lettres et chiffres.</span>
          <input name="password" type="password" autoComplete="new-password" required minLength={10} />
        </label>
        <label>
          Confirmation
          <input name="password2" type="password" autoComplete="new-password" required minLength={10} />
        </label>
        <button className="btn primary" type="submit">
          Créer mon compte
        </button>
      </form>
      <p style={{ marginTop: 16 }}>
        Déjà inscrit ? <Link href={`/login?next=${encodeURIComponent(next)}`}>Se connecter</Link>
      </p>
    </main>
  );
}
