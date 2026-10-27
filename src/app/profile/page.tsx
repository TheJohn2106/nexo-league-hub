import Link from "next/link";
import { passwordAction, profileAction } from "@/app/actions";
import { Flash, type SP } from "@/components/ui";
import { getPool } from "@/lib/db";
import { getProfile } from "@/lib/services/accounts";
import { connectionStatus, iracingApiStatus, iracingMessage } from "@/lib/services/iracing";
import { requireUser } from "@/lib/session";
import { safePath } from "@/lib/web";

export const metadata = { title: "Mon profil" };

export default async function Profile({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const user = await requireUser("/profile");
  const p = await getProfile(getPool(), user.id);
  const back = safePath(typeof sp.back === "string" ? sp.back : "/", "/");
  const api = iracingApiStatus();
  const conn = await connectionStatus(getPool(), user.id);
  const discord = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.APP_ORIGIN);
  const ir = typeof sp.iracing === "string" ? sp.iracing : null;
  return (
    <main className="wrap" style={{ maxWidth: 760, paddingTop: 32 }}>
      <p>
        <Link href={back}>← Retour</Link>
      </p>
      <h1>Mon profil</h1>
      <Flash searchParams={sp} />
      {ir && <div className={`flash ${ir === "linked" ? "ok" : "error"}`}>{ir === "linked" ? "Compte iRacing connecté." : iracingMessage(ir)}</div>}
      <form action={profileAction} className="card form">
        <input type="hidden" name="back" value={back} />
        <div className="cols">
          <label>
            Pseudo public
            <input name="displayName" defaultValue={p.displayName} required minLength={2} maxLength={40} />
          </label>
          <label>
            Identifiant client iRacing
            <span className="hint">Nombre visible dans votre compte iRacing (Customer ID). Sert à associer vos résultats.</span>
            <input name="iracingCustId" inputMode="numeric" pattern="\d*" defaultValue={p.iracingCustId ?? ""} />
          </label>
          <label>
            Numéro préféré
            <input name="preferredNumber" inputMode="numeric" pattern="\d{0,3}" defaultValue={p.preferredNumber ?? ""} />
          </label>
          <label>
            Pays (code)
            <input name="country" maxLength={2} defaultValue={p.country} placeholder="BE" />
          </label>
        </div>
        <label>
          Avatar (lien https, facultatif)
          <input name="avatarUrl" type="url" defaultValue={p.avatarUrl ?? ""} placeholder="https://…" />
        </label>
        <label>
          Contact privé (facultatif)
          <span className="hint">Visible uniquement par vous et les organisateurs (ex. pseudo Discord, téléphone).</span>
          <input name="privateContact" defaultValue={p.privateContact} maxLength={200} />
        </label>
        <button className="btn primary" type="submit">
          Enregistrer
        </button>
      </form>

      <section className="section card">
        <h2>Connexions</h2>
        <p>
          Email : <strong>{p.email ?? "aucun (compte Discord)"}</strong>
        </p>
        <p>
          Discord : {p.discordLinked ? <span className="pill ok">Lié</span> : <span className="pill">Non lié</span>}{" "}
          {!p.discordLinked && discord && (
            <form action="/api/auth/discord/start" method="post" className="inline">
              <input type="hidden" name="next" value="/profile" />
              <button className="btn small" type="submit">
                Lier Discord
              </button>
            </form>
          )}
          {!discord && <span className="muted"> (connexion Discord non configurée sur ce serveur)</span>}
        </p>
        <div>
          <h3>API iRacing (organisateurs)</h3>
          {!api.configured ? (
            <p className="notice">{api.message}</p>
          ) : conn ? (
            <p>
              Compte iRacing {conn.custId} connecté. {conn.lastError && <span className="pill danger">{iracingMessage(conn.lastError)}</span>}
            </p>
          ) : (
            <form action="/api/auth/iracing/start" method="post">
              <p className="muted">Nécessaire seulement pour récupérer les résultats de ligue via l’API.</p>
              <button className="btn" type="submit">
                Connecter mon compte iRacing
              </button>
            </form>
          )}
        </div>
      </section>

      {p.email && (
        <form action={passwordAction} className="section card form">
          <h2>Mot de passe</h2>
          <label>
            Mot de passe actuel
            <input name="current" type="password" autoComplete="current-password" required />
          </label>
          <div className="cols">
            <label>
              Nouveau mot de passe
              <input name="next" type="password" autoComplete="new-password" required minLength={10} />
            </label>
            <label>
              Confirmation
              <input name="next2" type="password" autoComplete="new-password" required minLength={10} />
            </label>
          </div>
          <button className="btn" type="submit">
            Changer le mot de passe
          </button>
        </form>
      )}
    </main>
  );
}
