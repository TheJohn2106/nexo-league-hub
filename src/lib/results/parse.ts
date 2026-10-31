// Analyse des sources de résultats vers un format normalisé commun.
// Sources : réponse JSON de la Data API iRacing /data/results/get, modèle CSV interne Nexo, saisie manuelle.
import { z } from "zod";
import { parseLapTime } from "../time.ts";

export type ParsedStatus = "classified" | "dnf" | "dns" | "dsq";
export interface ParsedRow {
  entryKey: string;
  custId: number | null;
  displayName: string;
  teamName: string | null;
  crew: { custId: number; displayName: string }[];
  car: string | null;
  carClass: string | null;
  carNumber: string | null;
  finishPosition: number;
  classPosition: number | null;
  startPosition: number | null;
  laps: number | null;
  lapsLed: number | null;
  bestLapMs: number | null;
  bestLapNumber: number | null;
  totalTimeMs: number | null;
  gapMs: number | null;
  gapLaps: number | null;
  incidents: number | null;
  status: ParsedStatus;
  reasonOut: string | null;
}
export interface ParsedSession {
  sourceLabel: string;
  subsessionId: number | null;
  simsessionNumber: number | null;
  simsessionName: string | null;
  track: string | null;
  startTime: string | null;
  rows: ParsedRow[];
  warnings: string[];
  availableSessions: { number: number; name: string }[];
}

// Les unités iRacing : positions à partir de 0, temps en dix-millièmes de seconde.
const num = z.number().nullable().optional();
const irDriver = z
  .object({ cust_id: z.number().int(), display_name: z.string().optional(), best_lap_time: num, laps_complete: num, incidents: num })
  .passthrough();
const irRow = z
  .object({
    cust_id: z.number().int().optional(),
    team_id: z.number().int().optional(),
    display_name: z.string().optional(),
    finish_position: z.number().int(),
    finish_position_in_class: num,
    starting_position: num,
    laps_complete: num,
    laps_lead: num,
    best_lap_time: num,
    best_lap_num: num,
    interval: num,
    incidents: num,
    reason_out: z.string().nullable().optional(),
    reason_out_id: num,
    car_name: z.string().nullable().optional(),
    car_class_short_name: z.string().nullable().optional(),
    car_class_name: z.string().nullable().optional(),
    livery: z.object({ car_number: z.string().nullable().optional() }).passthrough().nullable().optional(),
    driver_results: z.array(irDriver).optional(),
  })
  .passthrough();
const irSession = z
  .object({
    simsession_number: z.number().int(),
    simsession_type: z.number().int().optional(),
    simsession_type_name: z.string().optional(),
    simsession_name: z.string().optional(),
    results: z.array(irRow),
  })
  .passthrough();
const irResult = z
  .object({
    subsession_id: z.number().int().positive(),
    start_time: z.string().optional(),
    track: z.object({ track_name: z.string().optional(), config_name: z.string().nullable().optional() }).passthrough().optional(),
    session_results: z.array(irSession).min(1),
  })
  .passthrough();

const pos = (v: number | null | undefined) => (v == null || v < 0 ? null : v + 1);
const tenK = (v: number | null | undefined) => (v == null || v <= 0 ? null : Math.round(v / 10));

function sessionKindMatch(s: z.infer<typeof irSession>, kind: "practice" | "qualifying" | "race") {
  const name = `${s.simsession_type_name ?? ""} ${s.simsession_name ?? ""}`.toLowerCase();
  if (kind === "race") return /race|course/.test(name) || (!name.trim() && s.simsession_type === 6);
  if (kind === "qualifying") return /qualif/.test(name);
  return /practice|essai|warmup/.test(name);
}

export function parseIracingResult(
  input: unknown,
  options: { kind: "practice" | "qualifying" | "race"; simsessionNumber?: number | null; expectedSubsessionId?: number | null },
): ParsedSession {
  const parsed = irResult.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Format non reconnu : le fichier doit être la réponse JSON de la Data API iRacing « results/get » (champ session_results attendu).",
    );
  const data = parsed.data;
  if (options.expectedSubsessionId && data.subsession_id !== options.expectedSubsessionId)
    throw new Error(
      `Sous-session ${data.subsession_id} différente de celle associée à cette session (${options.expectedSubsessionId}).`,
    );
  const warnings: string[] = [];
  const available = data.session_results.map((s) => ({
    number: s.simsession_number,
    name: s.simsession_type_name ?? s.simsession_name ?? `Session ${s.simsession_number}`,
  }));
  let chosen = options.simsessionNumber != null ? data.session_results.find((s) => s.simsession_number === options.simsessionNumber) : undefined;
  if (options.simsessionNumber != null && !chosen) throw new Error(`Simsession ${options.simsessionNumber} absente de ce résultat.`);
  if (!chosen) {
    const candidates = data.session_results.filter((s) => sessionKindMatch(s, options.kind));
    if (candidates.length > 1) {
      // Plusieurs courses (ex. manches qualificatives + finale) : prendre la principale (numéro le plus élevé) et prévenir.
      chosen = [...candidates].sort((a, b) => b.simsession_number - a.simsession_number)[0];
      warnings.push(
        `Plusieurs sessions de ce type dans la sous-session (${candidates.map((c) => c.simsession_number).join(", ")}). Session ${chosen.simsession_number} retenue : précisez le numéro si besoin.`,
      );
    } else chosen = candidates[0];
  }
  if (!chosen) throw new Error("Aucune session de ce type dans le résultat iRacing. Indiquez le numéro de simsession.");

  const leaderLaps = chosen.results.reduce((m, r) => Math.max(m, r.laps_complete ?? 0), 0);
  const rows: ParsedRow[] = chosen.results
    .slice()
    .sort((a, b) => a.finish_position - b.finish_position)
    .map((r) => {
      // Course en équipage : ligne de voiture (team_id, identifiant pilote absent ou négatif) avec ses pilotes dans driver_results.
      const crew = r.driver_results ?? [];
      const isTeam = r.team_id != null && (r.cust_id == null || r.cust_id < 0 || crew.length > 0);
      // Meilleur tour ou incidents absents au niveau de la voiture : repli sur les pilotes de l'équipage.
      const crewBest = crew.map((d) => d.best_lap_time ?? -1).filter((v) => v > 0);
      const bestLap = r.best_lap_time != null && r.best_lap_time > 0 ? r.best_lap_time : crewBest.length ? Math.min(...crewBest) : null;
      const crewInc = crew.filter((d) => d.incidents != null);
      const incidents = r.incidents ?? (crewInc.length ? crewInc.reduce((t, d) => t + (d.incidents ?? 0), 0) : null);
      const laps = r.laps_complete ?? null;
      const reason = r.reason_out ?? null;
      let status: ParsedStatus;
      if (reason && /disqual/i.test(reason)) status = "dsq";
      else if (laps === 0 && options.kind === "race") status = "dns";
      else if (!reason || /^running$/i.test(reason) || options.kind !== "race") status = "classified";
      else status = "dnf";
      const gapLaps = laps != null && leaderLaps ? leaderLaps - laps : null;
      const interval = r.interval ?? null;
      if (r.cust_id == null && r.team_id == null) warnings.push(`Ligne sans identifiant pilote ni équipe (P${r.finish_position + 1}).`);
      return {
        entryKey: isTeam ? `team:${r.team_id}` : `cust:${r.cust_id ?? `p${r.finish_position}`}`,
        custId: isTeam ? null : (r.cust_id ?? null),
        displayName: r.display_name ?? (isTeam ? `Équipe ${r.team_id}` : `Pilote ${r.cust_id}`),
        teamName: isTeam ? (r.display_name ?? null) : null,
        crew: crew.map((d) => ({ custId: d.cust_id, displayName: d.display_name ?? String(d.cust_id) })),
        car: r.car_name ?? null,
        carClass: r.car_class_short_name ?? r.car_class_name ?? null,
        carNumber: r.livery?.car_number ?? null,
        finishPosition: r.finish_position + 1,
        classPosition: pos(r.finish_position_in_class),
        startPosition: pos(r.starting_position),
        laps,
        lapsLed: r.laps_lead ?? null,
        bestLapMs: tenK(bestLap),
        bestLapNumber: r.best_lap_num != null && r.best_lap_num > 0 ? r.best_lap_num : null,
        // iRacing ne fournit pas le temps total par pilote dans ce résultat : seul l'écart au leader (interval) existe.
        totalTimeMs: null,
        gapMs: interval != null && interval >= 0 && gapLaps === 0 ? Math.round(interval / 10) : null,
        gapLaps,
        incidents,
        status,
        reasonOut: reason,
      };
    });
  if (rows.some((r) => r.custId == null && r.entryKey.startsWith("team:")))
    warnings.push("Course en équipage : chaque voiture est rattachée au pilote inscrit de son équipage ; à confirmer si plusieurs pilotes inscrits partagent la voiture.");
  if (!rows.length) warnings.push("Session sans participant.");
  return {
    sourceLabel: "Data API iRacing — results/get",
    subsessionId: data.subsession_id,
    simsessionNumber: chosen.simsession_number,
    simsessionName: chosen.simsession_type_name ?? chosen.simsession_name ?? null,
    track: [data.track?.track_name, data.track?.config_name].filter(Boolean).join(" — ") || null,
    startTime: data.start_time ?? null,
    rows,
    warnings,
    availableSessions: available,
  };
}

// ---- Modèle CSV interne (format Nexo, PAS un export officiel iRacing) ----
export const csvTemplateHeader = "position;cust_id;pseudo;classe;voiture;depart;tours;meilleur_tour;temps_total;incidents;statut";
const statusAliases: Record<string, ParsedStatus> = {
  classe: "classified",
  "classé": "classified",
  classified: "classified",
  arrive: "classified",
  abandon: "dnf",
  dnf: "dnf",
  "non-partant": "dns",
  "non partant": "dns",
  dns: "dns",
  disqualifie: "dsq",
  "disqualifié": "dsq",
  dsq: "dsq",
};

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseCsvTemplate(text: string): ParsedSession {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("Fichier vide : une ligne d’en-tête et au moins un résultat sont attendus.");
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = splitCsvLine(lines[0], sep).map((h) => h.toLowerCase());
  const expected = csvTemplateHeader.split(";");
  const missing = expected.filter((h) => !header.includes(h));
  if (missing.length) throw new Error(`Colonnes manquantes dans le modèle Nexo : ${missing.join(", ")}.`);
  const col = (cells: string[], name: string) => cells[header.indexOf(name)] ?? "";
  const int = (v: string, label: string, line: number) => {
    if (!v) return null;
    if (!/^-?\d+$/.test(v)) throw new Error(`Ligne ${line} : ${label} invalide (« ${v} »).`);
    return Number(v);
  };
  const seen = new Set<string>();
  const rows: ParsedRow[] = lines.slice(1).map((line, i) => {
    const n = i + 2;
    const c = splitCsvLine(line, sep);
    const position = int(col(c, "position"), "position", n);
    if (!position || position < 1) throw new Error(`Ligne ${n} : position obligatoire.`);
    const custId = int(col(c, "cust_id"), "cust_id", n);
    const name = col(c, "pseudo");
    if (!custId && !name) throw new Error(`Ligne ${n} : cust_id ou pseudo obligatoire.`);
    const statusRaw = col(c, "statut").toLowerCase() || "classe";
    const status = statusAliases[statusRaw];
    if (!status) throw new Error(`Ligne ${n} : statut inconnu « ${statusRaw} » (classe, abandon, non-partant, disqualifie).`);
    let best: number | null, total: number | null;
    try {
      best = parseLapTime(col(c, "meilleur_tour"));
      total = parseLapTime(col(c, "temps_total"));
    } catch (e) {
      throw new Error(`Ligne ${n} : ${(e as Error).message}`);
    }
    const key = custId ? `cust:${custId}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Ligne ${n} : participant en double.`);
    seen.add(key);
    return {
      entryKey: key,
      custId,
      displayName: name || `Pilote ${custId}`,
      teamName: null,
      crew: [],
      car: col(c, "voiture") || null,
      carClass: col(c, "classe") || null,
      carNumber: null,
      finishPosition: position,
      classPosition: null,
      startPosition: int(col(c, "depart"), "depart", n),
      laps: int(col(c, "tours"), "tours", n),
      lapsLed: null,
      bestLapMs: best,
      bestLapNumber: null,
      totalTimeMs: total,
      gapMs: null,
      gapLaps: null,
      incidents: int(col(c, "incidents"), "incidents", n),
      status,
      reasonOut: null,
    };
  });
  const positions = rows.map((r) => r.finishPosition);
  if (new Set(positions).size !== positions.length) throw new Error("Positions en double dans le fichier.");
  return finalizeManual(rows, "Modèle CSV Nexo (format interne)");
}

export interface ManualRowInput {
  userId: string;
  custId: number | null;
  displayName: string;
  position: number;
  status: ParsedStatus;
  laps: number | null;
  bestLap: string;
  totalTime: string;
  incidents: number | null;
  /** Classe de voiture (championnat multiclasse). */
  carClass?: string | null;
}
export function parseManualRows(input: ManualRowInput[]): ParsedSession {
  if (!input.length) throw new Error("Saisissez au moins un résultat.");
  const positions = input.map((r) => r.position);
  if (positions.some((p) => !Number.isInteger(p) || p < 1)) throw new Error("Chaque ligne doit avoir une position ≥ 1.");
  if (new Set(positions).size !== positions.length) throw new Error("Positions en double.");
  if (new Set(input.map((r) => r.userId)).size !== input.length) throw new Error("Pilote saisi deux fois.");
  const rows = input.map<ParsedRow>((r) => ({
    entryKey: `user:${r.userId}`,
    custId: r.custId,
    displayName: r.displayName,
    teamName: null,
    crew: [],
    car: null,
    carClass: r.carClass?.trim() || null,
    carNumber: null,
    finishPosition: r.position,
    classPosition: null,
    startPosition: null,
    laps: r.laps,
    lapsLed: null,
    bestLapMs: parseLapTime(r.bestLap),
    bestLapNumber: null,
    totalTimeMs: parseLapTime(r.totalTime),
    gapMs: null,
    gapLaps: null,
    incidents: r.incidents,
    status: r.status,
    reasonOut: null,
  }));
  return finalizeManual(rows, "Saisie manuelle");
}

function finalizeManual(rows: ParsedRow[], label: string): ParsedSession {
  rows.sort((a, b) => a.finishPosition - b.finishPosition);
  // Place en classe, déduite de l'ordre au général quand une classe est indiquée (multiclasse).
  if (rows.some((r) => r.carClass)) {
    const counters = new Map<string, number>();
    for (const r of rows) {
      const k = r.carClass ?? "";
      counters.set(k, (counters.get(k) ?? 0) + 1);
      r.classPosition = counters.get(k)!;
    }
  }
  const leader = rows.find((r) => r.status === "classified");
  for (const r of rows) {
    if (leader?.laps != null && r.laps != null) r.gapLaps = leader.laps - r.laps;
    if (leader?.totalTimeMs != null && r.totalTimeMs != null && r.gapLaps === 0) r.gapMs = r.totalTimeMs - leader.totalTimeMs;
  }
  return {
    sourceLabel: label,
    subsessionId: null,
    simsessionNumber: null,
    simsessionName: null,
    track: null,
    startTime: null,
    rows,
    warnings: [],
    availableSessions: [],
  };
}
