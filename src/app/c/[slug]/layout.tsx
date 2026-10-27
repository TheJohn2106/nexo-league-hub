import Link from "next/link";
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { loadLeague } from "@/lib/league";
import { can } from "@/lib/permissions";
import { logoutAction } from "@/app/actions";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { community } = await loadLeague((await params).slug);
  return { title: { default: community.name, template: `%s · ${community.name}` }, description: community.tagline || undefined };
}

export default async function LeagueLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { community, user, role } = await loadLeague(slug);
  const b = community.branding;
  const style = { "--brand": b.primaryColor ?? "#e10600", "--accent": b.accentColor ?? "#ffd400" } as CSSProperties;
  const base = `/c/${slug}`;
  const staff = can(role, "championship.manage") || can(role, "protests.view") || can(role, "members.review");
  return (
    <div style={style} className="league">
      <a className="skip" href="#contenu">Aller au contenu</a>
      <header className="site-header">
        <div className="wrap bar">
          <Link href={base} className="brand">
            {b.logoUrl ? <img src={b.logoUrl} alt="" /> : <span className="stripe" aria-hidden />}
            <span>{community.name}</span>
          </Link>
          <nav className="nav" aria-label="Navigation principale">
            <Link href={base}>Accueil</Link>
            <Link href={`${base}/calendar`}>Calendrier</Link>
            {user && <Link href={`${base}/me`}>Mon espace</Link>}
            {staff && <Link href={`${base}/admin`}>Administration</Link>}
            {user ? (
              <>
                <Link href={`/profile?back=${encodeURIComponent(base + "/me")}`}>Profil</Link>
                <form action={logoutAction} className="inline">
                  <button type="submit">Déconnexion</button>
                </form>
              </>
            ) : (
              <Link href={`/login?next=${encodeURIComponent(base + "/me")}`}>Connexion</Link>
            )}
          </nav>
        </div>
      </header>
      <main id="contenu" className="wrap">
        {children}
      </main>
      <footer className="site-footer">
        <div className="wrap">
          {!!b.partners?.length && (
            <div className="partners" aria-label="Partenaires">
              {b.partners.map((p) => {
                const inner = p.logoUrl ? <img src={p.logoUrl} alt={p.name} /> : <span>{p.name}</span>;
                return p.url ? (
                  <a key={p.name} href={p.url} rel="noopener noreferrer sponsored" target="_blank">
                    {inner}
                  </a>
                ) : (
                  <span key={p.name}>{inner}</span>
                );
              })}
            </div>
          )}
          <div className="row between">
            <span>
              {b.twitchUrl && (
                <a href={b.twitchUrl} rel="noopener noreferrer" target="_blank">
                  Twitch
                </a>
              )}
              {b.twitchUrl && b.discordUrl && " · "}
              {b.discordUrl && (
                <a href={b.discordUrl} rel="noopener noreferrer" target="_blank">
                  Discord
                </a>
              )}
            </span>
            <span>
              Propulsé par Nexo League Hub · Nexotech Digital. Ligue communautaire indépendante, sans affiliation officielle avec iRacing.
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
