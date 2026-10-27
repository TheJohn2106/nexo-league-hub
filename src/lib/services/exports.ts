// Exports CSV (séparateur « ; », UTF-8 avec BOM pour Excel). Réservés aux organisateurs.
import type { Db } from "../db.ts";
import { AppError } from "../errors.ts";
import { lapTime } from "../time.ts";
import { championshipIn, requirePermission } from "./context.ts";
import { championshipStandings } from "./standings.ts";

function cell(v: unknown) {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise l'injection de formules dans les tableurs.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: unknown[][]) {
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

export type ExportKind = "registrations" | "attendance" | "results" | "standings";

export async function exportCsv(db: Db, communityId: string, actorId: string, championshipId: string, kind: ExportKind) {
  await requirePermission(db, communityId, actorId, "data.export");
  const c = await championshipIn(db, communityId, championshipId);
  if (kind === "registrations") {
    const rows = (
      await db.query(
        `SELECT u.display_name, p.iracing_cust_id, r.status, r.category, r.car, t.name team, r.race_number, r.rules_version, r.rules_accepted_at, r.reserve_rank, r.created_at
         FROM registrations r JOIN users u ON u.id=r.user_id JOIN driver_profiles p ON p.user_id=r.user_id LEFT JOIN teams t ON t.id=r.team_id
         WHERE r.championship_id=$1 ORDER BY r.status, u.display_name`,
        [c.id],
      )
    ).rows;
    return toCsv(
      ["pseudo", "iracing_cust_id", "statut", "categorie", "voiture", "equipe", "numero", "version_reglement", "reglement_accepte_le_utc", "rang_reserve", "inscrit_le_utc"],
      rows.map((r) => [r.display_name, r.iracing_cust_id, r.status, r.category, r.car, r.team, r.race_number, r.rules_version, r.rules_accepted_at, r.reserve_rank, r.created_at]),
    );
  }
  if (kind === "attendance") {
    const rows = (
      await db.query(
        `SELECT rd.number, rd.name, u.display_name, a.response, a.responded_at, a.seat, a.waitlist_position, a.checked_in_at, a.start_status
         FROM attendances a JOIN rounds rd ON rd.id=a.round_id JOIN users u ON u.id=a.user_id WHERE rd.championship_id=$1 ORDER BY rd.number, u.display_name`,
        [c.id],
      )
    ).rows;
    return toCsv(
      ["manche", "nom_manche", "pseudo", "reponse", "repondu_le_utc", "place", "rang_attente", "pointe_le_utc", "constat_depart"],
      rows.map((r) => [r.number, r.name, r.display_name, r.response, r.responded_at, r.seat, r.waitlist_position, r.checked_in_at, r.start_status]),
    );
  }
  if (kind === "results") {
    const { output, input } = await championshipStandings(db, communityId, c.id);
    const sessions = new Map(input.sessions.map((s) => [s.id, s]));
    const roundNo = new Map(input.rounds.map((r) => [r.id, r.number]));
    const line = new Map(output.lines.map((l) => [`${l.sessionId}:${l.userId}`, l]));
    const rows: unknown[][] = [];
    for (const [sid, list] of Object.entries(output.effective))
      for (const r of list) {
        const s = sessions.get(sid)!;
        const l = r.userId ? line.get(`${sid}:${r.userId}`) : undefined;
        rows.push([roundNo.get(s.roundId), s.label, s.resultsStatus, r.finishPosition, r.originalPosition, r.displayName, r.status, r.laps, lapTime(r.bestLapMs), r.incidents, l?.total ?? "", r.userId ? "" : "non rattaché"]);
      }
    return toCsv(["manche", "session", "statut_resultats", "position", "position_origine", "pilote", "statut", "tours", "meilleur_tour", "incidents", "points", "remarque"], rows);
  }
  if (kind === "standings") {
    const { output, input } = await championshipStandings(db, communityId, c.id);
    return toCsv(
      ["rang", "pilote", "categorie", "points", "points_bruts", "penalites", ...input.rounds.map((r) => `M${r.number}`)],
      output.drivers.map((d) => [d.rank, d.displayName, d.category, d.points, d.grossPoints, d.penaltyPoints, ...input.rounds.map((r) => d.roundPoints[r.id] ?? "")]),
    );
  }
  throw new AppError("Export inconnu.");
}
