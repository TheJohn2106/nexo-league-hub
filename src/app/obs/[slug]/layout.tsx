import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getCommunityBySlug } from "@/lib/services/context";

// Vues OBS (source navigateur) : fond transparent, aucune donnée privée, rafraîchissement automatique.
export default async function ObsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let c;
  try {
    c = await getCommunityBySlug(getPool(), slug);
  } catch (e) {
    if (e instanceof AppError) notFound();
    throw e;
  }
  const style = { "--brand": c.branding.primaryColor ?? "#e10600", "--accent": c.branding.accentColor ?? "#ffd400", padding: 8 } as CSSProperties;
  return (
    <div className="obs-root" style={style}>
      {children}
    </div>
  );
}
