import Link from "next/link";
import { loginAction } from "@/app/actions";
import { Flash, type SP } from "@/components/ui";
import { safePath } from "@/lib/web";

export const metadata = { title: "Connexion" };

export default async function Login({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safePath(typeof sp.next === "string" ? sp.next : "/", "/");
  const discord = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.APP_ORIGIN);
  return (
    <main className="wrap" style={{ maxWidth: 460, paddingTop: 40 }}>
      <h1>Connexion</h1>
      <Flash searchParams={sp} />
      {sp.discord === "failed" && <div className="flash error">Connexion Discord impossible. Réessayez ou utilisez votre email.</div>}
      <form action={loginAction} className="card form">
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Mot de passe
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button className="btn primary" type="submit">
          Se connecter
        </button>
      </form>
      {discord && (
        <form action="/api/auth/discord/start" method="post" style={{ marginTop: 12 }}>
          <input type="hidden" name="next" value={next} />
          <button className="btn" type="submit" style={{ width: "100%" }}>
            Continuer avec Discord
          </button>
        </form>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        Mot de passe oublié ? Demandez à l’organisation de votre ligue un lien de réinitialisation (valable 24 heures, usage unique).
      </p>
      <p>
        Pas encore de compte ? <Link href={`/register?next=${encodeURIComponent(next)}`}>Créer un compte</Link>
      </p>
    </main>
  );
}
