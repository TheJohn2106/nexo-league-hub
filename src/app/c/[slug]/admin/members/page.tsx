import { requireLeaguePermission } from "@/lib/league";
import { listMembers } from "@/lib/services/community";
import { Flash, Hidden, Pill, When, labels, type SP } from "@/components/ui";
import { cookies } from "next/headers";
import { decideMemberAction, removeMemberAction, resetLinkAction, setRoleAction } from "@/app/actions";
import { RESET_LINK_COOKIE } from "@/lib/session";
import { can, roles } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Membres" };

function readFresh(raw: string | undefined): { userId: string; url: string } | null {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default async function Members({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/members`;
  const { community, db, user, role } = await requireLeaguePermission(slug, "members.review", here);
  const members = await listMembers(db, community.id, user.id);
  const h = { slug, back: here };
  const fresh = readFresh((await cookies()).get(RESET_LINK_COOKIE)?.value);
  // Mêmes règles que le service (qui reste seul juge) : propriétaire → tout sauf propriétaire ; organisateur → pilotes et capitaines.
  const resettable = (m: (typeof members)[number]) =>
    m.userId !== user.id &&
    !!m.email &&
    (m.status === "accepted" || m.status === "pending") &&
    (role === "owner" ? m.role !== "owner" : m.role === "driver" || m.role === "captain");
  return (
    <>
      <h1>Membres</h1>
      <Flash searchParams={sp} />
      <p className="muted">Les coordonnées (email, contact privé, identifiant iRacing) ne sont visibles que de l’équipe d’organisation.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pseudo</th>
              <th>Contact privé</th>
              <th>iRacing</th>
              <th>Statut</th>
              <th>Rôle</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>
                  <strong>{m.displayName}</strong>
                  <div className="breakdown">
                    Demande : <When date={m.createdAt} tz={community.timezone} />
                  </div>
                  {m.message && <div className="breakdown">« {m.message} »</div>}
                </td>
                <td>
                  <div className="mono">{m.email ?? "—"}</div>
                  {m.privateContact && <div className="breakdown">{m.privateContact}</div>}
                  {m.discordLinked && <span className="pill">Discord lié</span>}
                </td>
                <td className="mono">{m.iracingCustId ?? <span className="muted">non renseigné</span>}</td>
                <td>
                  <Pill value={m.status} />
                </td>
                <td>
                  {can(role, "community.manage") && m.status === "accepted" ? (
                    <form action={setRoleAction} className="row">
                      <Hidden values={{ ...h, userId: m.userId }} />
                      <label className="sr-only" htmlFor={`role-${m.userId}`}>
                        Rôle
                      </label>
                      <select id={`role-${m.userId}`} name="role" defaultValue={m.role} style={{ minWidth: 150 }}>
                        {roles.map((r) => (
                          <option key={r} value={r}>
                            {labels[r]}
                          </option>
                        ))}
                      </select>
                      <button className="btn small">OK</button>
                    </form>
                  ) : (
                    labels[m.role]
                  )}
                </td>
                <td>
                  {m.status === "pending" && (
                    <div className="row">
                      <form action={decideMemberAction}>
                        <Hidden values={{ ...h, userId: m.userId, decision: "accepted" }} />
                        <button className="btn small ok">Accepter</button>
                      </form>
                      <form action={decideMemberAction}>
                        <Hidden values={{ ...h, userId: m.userId, decision: "refused" }} />
                        <button className="btn small danger">Refuser</button>
                      </form>
                    </div>
                  )}
                  {m.status === "accepted" && m.role !== "owner" && m.userId !== user.id && (
                    <details>
                      <summary>Retirer</summary>
                      <form action={removeMemberAction} className="body form">
                        <Hidden values={{ ...h, userId: m.userId }} />
                        <input name="reason" placeholder="Motif" required minLength={3} />
                        <button className="btn small danger">Retirer de la ligue</button>
                      </form>
                    </details>
                  )}
                  {fresh && fresh.userId === m.userId ? (
                    <div className="flash ok" style={{ marginTop: 8 }}>
                      <label>
                        Lien à transmettre en privé (24 h, usage unique)
                        <input readOnly value={fresh.url} className="mono" />
                      </label>
                    </div>
                  ) : (
                    resettable(m) && (
                      <form action={resetLinkAction} style={{ marginTop: 6 }}>
                        <Hidden values={{ ...h, userId: m.userId }} />
                        <button className="btn small">Lien mot de passe</button>
                      </form>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
