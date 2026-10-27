import Link from "next/link";
import { redirect } from "next/navigation";
import { loadLeague } from "@/lib/league";
import { can } from "@/lib/permissions";

export default async function AdminLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { user, role } = await loadLeague(slug);
  const base = `/c/${slug}/admin`;
  if (!user) redirect(`/login?next=${encodeURIComponent(base)}`);
  // Contrôle serveur : chaque page et chaque action revérifient aussi la permission précise.
  if (!can(role, "protests.view") && !can(role, "members.review")) redirect(`/c/${slug}?error=${encodeURIComponent("Accès réservé à l’équipe d’organisation.")}`);
  const links: [string, string, boolean][] = [
    [base, "Tableau de bord", can(role, "championship.manage")],
    [`${base}/members`, "Membres", can(role, "members.review")],
    [`${base}/championships/new`, "Nouveau championnat", can(role, "championship.manage")],
    [`${base}/protests`, "Réclamations", can(role, "protests.view")],
    [`${base}/settings`, "Ligue & Discord", can(role, "community.manage")],
    [`${base}/audit`, "Journal", can(role, "audit.view")],
  ];
  return (
    <>
      <nav className="tabs" aria-label="Administration">
        {links
          .filter(([, , ok]) => ok)
          .map(([href, label]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
      </nav>
      {children}
    </>
  );
}
