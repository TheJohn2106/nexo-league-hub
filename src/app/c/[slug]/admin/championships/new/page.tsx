import { requireLeaguePermission } from "@/lib/league";
import { createChampionshipAction } from "@/app/actions";
import { ChampionshipFields } from "@/components/championship-form";
import { Flash, Hidden, type SP } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nouveau championnat" };

export default async function NewChampionship({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const here = `/c/${slug}/admin/championships/new`;
  const { community } = await requireLeaguePermission(slug, "championship.manage", here);
  return (
    <div style={{ maxWidth: 900 }}>
      <h1>Nouveau championnat</h1>
      <Flash searchParams={sp} />
      <form action={createChampionshipAction} className="form">
        <Hidden values={{ slug, back: here }} />
        <ChampionshipFields tz={community.timezone} />
        <button className="btn primary">Créer (brouillon)</button>
      </form>
    </div>
  );
}
