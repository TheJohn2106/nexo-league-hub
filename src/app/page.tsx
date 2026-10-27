import Link from "next/link";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { listCommunities } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function Home() {
  const communities = await listCommunities(getPool());
  const preferred = process.env.DEFAULT_COMMUNITY;
  if (preferred && communities.some((c) => c.slug === preferred)) redirect(`/c/${preferred}`);
  if (communities.length === 1) redirect(`/c/${communities[0].slug}`);
  return (
    <main className="wrap" style={{ paddingTop: 48 }}>
      <h1>Nexo League Hub</h1>
      <p className="muted">Gestion de ligues simracing. Aucune affiliation officielle avec iRacing.</p>
      {communities.length === 0 ? (
        <div className="notice warn">
          Aucune ligue n’est encore configurée. Créez le propriétaire et la ligue avec <span className="mono">npm run owner:create</span> (voir README).
        </div>
      ) : (
        <div className="grid three">
          {communities.map((c) => (
            <Link key={c.id} href={`/c/${c.slug}`} className="card accent" style={{ textDecoration: "none" }}>
              <h2>{c.name}</h2>
              <p className="muted">{c.tagline}</p>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
