import type { ReactNode } from "react";
import { formatDateTime, lapTime } from "@/lib/time";

export function Flash({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const ok = typeof searchParams.ok === "string" ? searchParams.ok : null;
  const error = typeof searchParams.error === "string" ? searchParams.error : null;
  if (!ok && !error) return null;
  return (
    <div className={`flash ${error ? "error" : "ok"}`} role={error ? "alert" : "status"}>
      {error ?? ok}
    </div>
  );
}

const pillTone: Record<string, string> = {
  accepted: "ok", confirmed: "ok", open: "ok", final: "ok", started: "ok", classified: "ok", yes: "ok", decided: "ok", applied: "ok", sent: "ok", scheduled: "info",
  pending: "warn", reserve: "info", waitlist: "info", offered: "warn", maybe: "warn", provisional: "warn", submitted: "warn", under_review: "warn", preview: "warn", postponed: "warn", draft: "",
  refused: "danger", withdrawn: "", removed: "danger", cancelled: "danger", no: "danger", dnf: "warn", dns: "", dsq: "danger", no_show: "danger", failed: "danger", dismissed: "", released: "", skipped: "",
  closed: "", finished: "", completed: "", superseded: "", discarded: "", none: "",
};
export const labels: Record<string, string> = {
  pending: "En attente", accepted: "Accepté", reserve: "Réserviste", refused: "Refusé", withdrawn: "Retiré", removed: "Retiré",
  draft: "Brouillon", open: "Inscriptions ouvertes", closed: "Inscriptions fermées", finished: "Terminé", cancelled: "Annulé",
  scheduled: "Prévue", postponed: "Reportée", completed: "Terminée",
  none: "Sans réponse", yes: "Présent", no: "Absent", maybe: "Incertain",
  confirmed: "Place confirmée", waitlist: "Liste d’attente", offered: "Place proposée", released: "Place libérée",
  started: "Au départ", no_show: "Absent au départ",
  classified: "Classé", dnf: "Abandon", dns: "Non partant", dsq: "Disqualifié",
  provisional: "Provisoire", final: "Définitif",
  submitted: "Déposée", under_review: "En examen", decided: "Décidée", dismissed: "Rejetée",
  preview: "Aperçu", applied: "Validé", superseded: "Remplacé", discarded: "Abandonné", failed: "Échec",
  sent: "Envoyé", skipped: "Non envoyé",
  practice: "Essais", qualifying: "Qualifications", race: "Course",
  owner: "Propriétaire", organizer: "Organisateur", steward: "Commissaire", captain: "Capitaine", driver: "Pilote",
  iracing_api: "API iRacing", iracing_json: "Fichier JSON (Data API iRacing)", csv_template: "Modèle CSV Nexo (format interne)", manual: "Saisie manuelle",
  time: "Temps", positions: "Places", points: "Points", warning: "Avertissement", session: "Course", championship: "Championnat",
};
export function Pill({ value, children }: { value: string; children?: ReactNode }) {
  return <span className={`pill ${pillTone[value] ?? ""}`}>{children ?? labels[value] ?? value}</span>;
}
export function Pos({ n }: { n: number | null | undefined }) {
  if (n == null) return <span className="pos">–</span>;
  return <span className={`pos ${n <= 3 ? `p${n}` : ""}`}>{n}</span>;
}
export function When({ date, tz }: { date: Date | string | null | undefined; tz: string }) {
  if (!date) return <>—</>;
  return <time dateTime={new Date(date).toISOString()}>{formatDateTime(date, tz)}</time>;
}
export function Lap({ ms }: { ms: number | null | undefined }) {
  const v = lapTime(ms);
  return v === "non fourni" ? <span className="muted">non fourni</span> : <span className="mono">{v}</span>;
}
export function Val({ v }: { v: unknown }) {
  return v == null || v === "" ? <span className="muted">non fourni</span> : <>{String(v)}</>;
}
export function Hidden({ values }: { values: Record<string, string | number | null | undefined> }) {
  return (
    <>
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v == null ? "" : String(v)} />
      ))}
    </>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export type SP = Promise<Record<string, string | string[] | undefined>>;
