import { requireLeaguePermission } from "@/lib/league";
import { auditEntries } from "@/lib/services/read";
import { When } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Journal d’audit" };

export default async function Audit({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { community, db } = await requireLeaguePermission(slug, "audit.view", `/c/${slug}/admin/audit`);
  const entries = await auditEntries(db, community.id);
  return (
    <>
      <h1>Journal d’audit</h1>
      <p className="muted">Les 200 dernières actions sensibles (décisions, imports, corrections, pénalités, réglages).</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Auteur</th>
              <th>Action</th>
              <th>Cible</th>
              <th>Détail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>
                  <When date={e.createdAt} tz={community.timezone} />
                </td>
                <td>{e.actor ?? "système"}</td>
                <td className="mono">{e.action}</td>
                <td className="mono breakdown">
                  {e.targetType} {e.targetId ? String(e.targetId).slice(0, 8) : ""}
                </td>
                <td className="mono breakdown" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                  {e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
