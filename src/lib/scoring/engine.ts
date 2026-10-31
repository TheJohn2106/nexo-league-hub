// Moteur de points déterministe : même entrée → même sortie, aucun accès base/horloge.
import type {
  DriverStanding,
  EffectiveResult,
  EngineInput,
  EngineOutput,
  EngineResult,
  EngineSession,
  ResultStatus,
  SessionLine,
  TeamStanding,
  UnappliedPenalty,
} from "./types.ts";

const statusOrder: Record<ResultStatus, number> = { classified: 0, dnf: 1, dns: 2, dsq: 3 };

function applyCorrections(input: EngineInput): EngineResult[] {
  return input.results.map((original) => {
    const r = { ...original };
    for (const c of input.corrections.filter((c) => c.resultId === r.id)) {
      const v = c.newValue;
      const num = v == null || v === "" ? null : Number(v);
      switch (c.field) {
        case "finish_position":
          if (num != null && num > 0) r.finishPosition = num;
          break;
        case "status":
          if (v && v in statusOrder) r.status = v as ResultStatus;
          break;
        case "laps":
          r.laps = num;
          break;
        case "best_lap_ms":
          r.bestLapMs = num;
          break;
        case "incidents":
          r.incidents = num;
          break;
        case "total_time_ms":
          r.totalTimeMs = num;
          break;
        case "start_position":
          r.startPosition = num;
          break;
        case "user_id":
          r.userId = v || null;
          break;
      }
    }
    return r;
  });
}

/** Temps comparable pour une pénalité en temps : total si connu, sinon écart au leader dans le même tour. */
function comparableTime(r: EngineResult, leaderTotal: number | null): number | null {
  if (r.totalTimeMs != null) return r.totalTimeMs;
  if (r.gapMs != null && r.gapMs >= 0 && (r.gapLaps ?? 0) === 0 && leaderTotal != null) return leaderTotal + r.gapMs;
  if (r.gapMs != null && r.gapMs >= 0 && (r.gapLaps ?? 0) === 0) return r.gapMs;
  return null;
}

function sessionEffective(
  results: EngineResult[],
  penalties: EngineInput["penalties"],
  unapplied: UnappliedPenalty[],
): EffectiveResult[] {
  let order: EffectiveResult[] = [...results]
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.finishPosition - b.finishPosition || a.id.localeCompare(b.id))
    .map((r) => ({ ...r, originalPosition: r.finishPosition, appliedPenalties: [] }));
  const byUser = (userId: string) => order.find((r) => r.userId === userId);
  const sorted = [...penalties].sort((a, b) => a.id.localeCompare(b.id));

  for (const p of sorted.filter((p) => p.kind === "dsq")) {
    const r = byUser(p.userId);
    if (!r) {
      unapplied.push({ penaltyId: p.id, reason: "Pilote absent des résultats de la session." });
      continue;
    }
    r.status = "dsq";
    r.appliedPenalties.push(p.id);
  }

  // Pénalités en temps : uniquement si tous les pilotes du même tour ont un temps comparable.
  const timePenalties = sorted.filter((p) => p.kind === "time");
  if (timePenalties.length) {
    const added = new Map<string, number>();
    for (const p of timePenalties) {
      const r = byUser(p.userId);
      if (!r || r.status !== "classified") {
        unapplied.push({ penaltyId: p.id, reason: "Pénalité en temps applicable uniquement à un pilote classé." });
        continue;
      }
      const leader = order.find((x) => x.status === "classified");
      const leaderTotal = leader?.totalTimeMs ?? null;
      const sameLap = order.filter((x) => x.status === "classified" && x.laps != null && x.laps === r.laps);
      const complete = r.laps != null && sameLap.every((x) => comparableTime(x, leaderTotal) != null);
      if (!complete) {
        unapplied.push({
          penaltyId: p.id,
          reason: "Temps de course incomplets : l’ordre ne peut pas être recalculé. Décision explicite requise (pénalité en positions).",
        });
        continue;
      }
      added.set(r.id, (added.get(r.id) ?? 0) + p.value * 1000);
      r.appliedPenalties.push(p.id);
    }
    if (added.size) {
      const leaderTotal = order.find((x) => x.status === "classified")?.totalTimeMs ?? null;
      const classified = order.filter((x) => x.status === "classified");
      const rest = order.filter((x) => x.status !== "classified");
      // Ordre : tours décroissants, puis temps ajusté au sein du même tour.
      const key = (x: EffectiveResult) => {
        const t = comparableTime(x, leaderTotal);
        return t == null ? null : t + (added.get(x.id) ?? 0);
      };
      const groups = new Map<number, EffectiveResult[]>();
      for (const x of classified) {
        const k = x.laps ?? -1;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(x);
      }
      const reordered: EffectiveResult[] = [];
      for (const lapCount of [...groups.keys()].sort((a, b) => b - a)) {
        const g = groups.get(lapCount)!;
        const touched = g.some((x) => added.has(x.id));
        if (touched && g.every((x) => key(x) != null))
          g.sort((a, b) => key(a)! - key(b)! || a.originalPosition - b.originalPosition);
        reordered.push(...g);
      }
      order = [...reordered, ...rest];
    }
  }

  // Pénalités en positions : recul de N places parmi les pilotes non disqualifiés.
  for (const p of sorted.filter((p) => p.kind === "positions")) {
    const idx = order.findIndex((r) => r.userId === p.userId);
    if (idx < 0 || order[idx].status === "dsq") {
      unapplied.push({ penaltyId: p.id, reason: "Pilote absent ou disqualifié : pénalité en positions sans effet." });
      continue;
    }
    const lastEligible = order.filter((r) => r.status !== "dsq").length - 1;
    const [r] = order.splice(idx, 1);
    order.splice(Math.min(lastEligible, idx + Math.max(0, p.value)), 0, r);
    r.appliedPenalties.push(p.id);
  }

  order.sort((a, b) => {
    const da = a.status === "dsq" ? 1 : 0,
      db = b.status === "dsq" ? 1 : 0;
    return da - db;
  });
  order.forEach((r, i) => (r.finishPosition = i + 1));
  const classCounters = new Map<string, number>();
  for (const r of order) {
    const k = r.carClass ?? "";
    const n = (classCounters.get(k) ?? 0) + 1;
    classCounters.set(k, n);
    r.classPosition = n;
  }
  return order;
}

/** Regroupe les lignes par classe de voiture (ordre d'arrivée conservé), ou un seul groupe. */
function byClass<T extends { carClass: string | null }>(rows: T[], split: boolean): T[][] {
  if (!split) return [rows];
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.carClass ?? "", [...(m.get(r.carClass ?? "") ?? []), r]);
  return [...m.values()];
}

function points(table: number[], position: number) {
  return position >= 1 && position <= table.length ? table[position - 1] : 0;
}

function compareDesc(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function computeStandings(input: EngineInput): EngineOutput {
  const cfg = input.config;
  const rounds = input.rounds.filter((r) => !r.cancelled).sort((a, b) => a.number - b.number);
  const roundIds = new Set(rounds.map((r) => r.id));
  const sessions = input.sessions.filter((s) => roundIds.has(s.roundId) && s.resultsStatus !== "none");
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const corrected = applyCorrections(input).filter((r) => sessionById.has(r.sessionId));
  const unapplied: UnappliedPenalty[] = [];
  const effective: Record<string, EffectiveResult[]> = {};
  for (const s of sessions) {
    effective[s.id] = sessionEffective(
      corrected.filter((r) => r.sessionId === s.id),
      input.penalties.filter((p) => p.sessionId === s.id && p.scope === "session"),
      unapplied,
    );
  }
  const known = new Set(input.drivers.map((d) => d.userId));
  const lines: SessionLine[] = [];
  const lineFor = (s: EngineSession, r: EffectiveResult): SessionLine => ({
    sessionId: s.id,
    roundId: s.roundId,
    userId: r.userId!,
    position: r.finishPosition,
    classPosition: r.classPosition,
    status: r.status,
    positionPoints: 0,
    participationPoints: 0,
    fastestLapPoints: 0,
    polePoints: 0,
    coefficient: s.coefficient,
    penaltyPoints: 0,
    total: 0,
    notes: [],
  });

  for (const s of sessions.filter((s) => s.awardsPoints)) {
    const rows = effective[s.id];
    const winnerLaps = rows.find((r) => r.status === "classified")?.laps ?? null;
    for (const r of rows) {
      if (!r.userId || !known.has(r.userId)) continue;
      const line = lineFor(s, r);
      const pos = cfg.positionBasis === "class" ? (r.classPosition ?? r.finishPosition) : r.finishPosition;
      if (r.status === "classified") line.positionPoints = points(cfg.pointsByPosition, pos);
      else if (r.status === "dnf") {
        const enough =
          winnerLaps != null && r.laps != null && winnerLaps > 0 && r.laps * 100 >= winnerLaps * cfg.dnf.minLapsPercent;
        if (cfg.dnf.mode === "position" && enough) {
          line.positionPoints = points(cfg.pointsByPosition, pos);
          line.notes.push("Abandon classé (distance suffisante)");
        } else line.notes.push("Abandon non classé : 0 point de place");
      } else line.notes.push(r.status === "dns" ? "Non partant" : "Disqualifié");
      if (r.status === "classified" || r.status === "dnf") line.participationPoints = cfg.participationPoints;
      lines.push(line);
    }
    // Meilleur tour : plus petit temps, départage par ordre d'arrivée. Bonus perdu si le détenteur est inéligible.
    // Multi-classe (base « classe ») : un meilleur tour par classe.
    if (cfg.fastestLap.points)
      for (const group of byClass(rows, cfg.positionBasis === "class")) {
        const best = group
          .filter((r) => r.bestLapMs != null && r.bestLapMs > 0 && r.status !== "dsq")
          .sort((a, b) => a.bestLapMs! - b.bestLapMs! || a.finishPosition - b.finishPosition)[0];
        if (best?.userId) {
          const line = lines.find((l) => l.sessionId === s.id && l.userId === best.userId);
          const pos = cfg.positionBasis === "class" ? (best.classPosition ?? best.finishPosition) : best.finishPosition;
          const eligible =
            (!cfg.fastestLap.requiresClassified || best.status === "classified") &&
            (cfg.fastestLap.maxPosition == null || pos <= cfg.fastestLap.maxPosition);
          if (line && eligible) {
            line.fastestLapPoints = cfg.fastestLap.points;
            line.notes.push("Meilleur tour");
          } else if (line) line.notes.push("Meilleur tour sans bonus (conditions non remplies)");
        }
      }
  }

  // Pole : 1re place d'une session de qualification marquée, rattachée à la première course à points de la manche.
  // Multi-classe (base « classe ») : une pole par classe.
  for (const q of sessions.filter((s) => s.awardsPole))
    for (const group of byClass(effective[q.id], cfg.positionBasis === "class")) {
      const pole = group.find((r) => r.status !== "dsq" && r.status !== "dns");
      if (!pole?.userId || !known.has(pole.userId) || !cfg.pole.points) continue;
      const race = sessions.filter((s) => s.roundId === q.roundId && s.awardsPoints)[0];
      if (!race) continue;
      const line = lines.find((l) => l.sessionId === race.id && l.userId === pole.userId);
      const started = line && (line.status === "classified" || line.status === "dnf");
      if (line && (!cfg.pole.requiresStart || started)) {
        line.polePoints = cfg.pole.points;
        line.notes.push("Pole position");
      } else if (!line && !cfg.pole.requiresStart) {
        const ghost = lineFor(race, { ...pole, status: "dns" });
        ghost.polePoints = cfg.pole.points;
        ghost.notes.push("Pole position (non partant)");
        lines.push(ghost);
      }
    }

  // Coefficient : appliqué aux points de place et de participation, pas aux bonus.
  for (const l of lines) {
    const base = (l.positionPoints + l.participationPoints) * l.coefficient;
    l.total = Math.round((base + l.fastestLapPoints + l.polePoints) * 100) / 100;
  }

  // Pénalités en points (portée session : affichées sur la ligne ; jamais retirées par un joker).
  const champPenalty = new Map<string, number>();
  for (const p of input.penalties.filter((p) => p.kind === "points")) {
    if (!sessionById.has(p.sessionId)) continue;
    if (p.scope === "session") {
      const line = lines.find((l) => l.sessionId === p.sessionId && l.userId === p.userId);
      if (line) {
        line.penaltyPoints += p.value;
        line.notes.push(`Pénalité −${p.value} pt`);
      } else {
        unapplied.push({ penaltyId: p.id, reason: "Aucune ligne de points pour ce pilote dans la session." });
        continue;
      }
    }
    champPenalty.set(p.userId, (champPenalty.get(p.userId) ?? 0) + p.value);
  }
  if (cfg.absencePenaltyPoints != null && cfg.absencePenaltyPoints > 0) {
    for (const a of input.noShows) {
      if (!roundIds.has(a.roundId) || !known.has(a.userId)) continue;
      champPenalty.set(a.userId, (champPenalty.get(a.userId) ?? 0) + cfg.absencePenaltyPoints);
    }
  }

  const scoredRounds = rounds.filter((r) => sessions.some((s) => s.roundId === r.id && s.awardsPoints));
  const plannedRounds = rounds.filter((r) => input.sessions.some((s) => s.roundId === r.id && s.awardsPoints));
  const standings: DriverStanding[] = input.drivers.map((d) => {
    const mine = lines.filter((l) => l.userId === d.userId);
    const roundPoints: Record<string, number> = {};
    for (const r of scoredRounds)
      roundPoints[r.id] = Math.round(mine.filter((l) => l.roundId === r.id).reduce((s, l) => s + l.total, 0) * 100) / 100;
    // « Meilleurs résultats sur N manches » : les manches prévues non encore courues comptent 0 et
    // sont retirées en premier, si bien qu'aucun résultat réel n'est retiré avant d'en avoir assez.
    const droppable = plannedRounds
      .filter((r) => r.jokerEligible)
      .sort((a, b) => (roundPoints[a.id] ?? 0) - (roundPoints[b.id] ?? 0) || b.number - a.number);
    const dropped = droppable.slice(0, Math.max(0, Math.min(cfg.dropWorst, droppable.length))).map((r) => r.id);
    const gross = Object.values(roundPoints).reduce((s, v) => s + v, 0);
    const kept = scoredRounds.filter((r) => !dropped.includes(r.id)).reduce((s, r) => s + roundPoints[r.id], 0);
    const penaltyPoints = champPenalty.get(d.userId) ?? 0;
    const finishes = mine.filter((l) => l.status === "classified");
    return {
      rank: 0,
      userId: d.userId,
      displayName: d.displayName,
      category: d.category,
      teamId: d.teamId,
      points: Math.round((kept - penaltyPoints) * 100) / 100,
      grossPoints: Math.round(gross * 100) / 100,
      droppedRoundIds: dropped,
      penaltyPoints,
      wins: finishes.filter((l) => l.position === 1).length,
      podiums: finishes.filter((l) => l.position <= 3).length,
      starts: mine.filter((l) => l.status === "classified" || l.status === "dnf").length,
      roundPoints,
      tied: false,
    };
  });

  const finishVector = (userId: string) => {
    const v: number[] = [];
    for (const l of lines.filter((l) => l.userId === userId && l.status === "classified")) v[l.position - 1] = (v[l.position - 1] ?? 0) + 1;
    return Array.from({ length: v.length }, (_, i) => v[i] ?? 0);
  };
  const incidents = (userId: string) =>
    Object.values(effective)
      .flat()
      .filter((r) => r.userId === userId && sessionById.get(r.sessionId)?.awardsPoints)
      .reduce((s, r) => s + (r.incidents ?? 0), 0);
  const lastRoundOrder = [...scoredRounds].reverse();
  const tiebreakCompare = (a: DriverStanding, b: DriverStanding) => {
    for (const t of input.config.tiebreak) {
      let d = 0;
      if (t === "wins") d = b.wins - a.wins;
      else if (t === "countback") d = compareDesc(finishVector(a.userId), finishVector(b.userId));
      else if (t === "fewestIncidents") d = incidents(a.userId) - incidents(b.userId);
      else if (t === "lastRound")
        for (const r of lastRoundOrder) {
          d = (b.roundPoints[r.id] ?? 0) - (a.roundPoints[r.id] ?? 0);
          if (d) break;
        }
      if (d) return d;
    }
    return 0;
  };
  const rank = (list: DriverStanding[]) => {
    const out = list
      .map((s) => ({ ...s }))
      .sort((a, b) => b.points - a.points || tiebreakCompare(a, b) || a.displayName.localeCompare(b.displayName, "fr") || a.userId.localeCompare(b.userId));
    out.forEach((s, i) => {
      const prev = out[i - 1];
      if (prev && prev.points === s.points && tiebreakCompare(prev, s) === 0) {
        s.rank = prev.rank;
        s.tied = prev.tied = true;
      } else s.rank = i + 1;
    });
    return out;
  };
  const drivers = rank(standings);

  const categories: Record<string, DriverStanding[]> = {};
  for (const c of [...new Set(input.drivers.map((d) => d.category).filter((c): c is string => !!c))].sort())
    categories[c] = rank(standings.filter((s) => s.category === c));

  // Équipes : meilleurs résultats nets de chaque course (countBest), pénalités de session incluses.
  const teamPoints = new Map<string, number>(input.teams.map((t) => [t.id, 0]));
  const teamOf = new Map(input.drivers.map((d) => [d.userId, d.teamId]));
  for (const s of sessions.filter((s) => s.awardsPoints)) {
    const perTeam = new Map<string, number[]>();
    for (const l of lines.filter((l) => l.sessionId === s.id)) {
      const t = teamOf.get(l.userId);
      if (!t || !teamPoints.has(t)) continue;
      if (!perTeam.has(t)) perTeam.set(t, []);
      perTeam.get(t)!.push(l.total - l.penaltyPoints);
    }
    for (const [t, pts] of perTeam)
      teamPoints.set(t, teamPoints.get(t)! + pts.sort((a, b) => b - a).slice(0, cfg.teams.countBest).reduce((x, y) => x + y, 0));
  }
  const teams: TeamStanding[] = input.teams
    .map((t) => ({ rank: 0, teamId: t.id, name: t.name, points: Math.round(teamPoints.get(t.id)! * 100) / 100, tied: false }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "fr"));
  teams.forEach((t, i) => {
    const prev = teams[i - 1];
    if (prev && prev.points === t.points) {
      t.rank = prev.rank;
      t.tied = prev.tied = true;
    } else t.rank = i + 1;
  });

  // Les lignes portent le total après pénalité de session pour l'affichage.
  for (const l of lines) l.total = Math.round((l.total - l.penaltyPoints) * 100) / 100;
  return {
    effective,
    lines,
    drivers,
    teams,
    categories,
    unappliedPenalties: unapplied,
    provisional: sessions.some((s) => s.awardsPoints && s.resultsStatus === "provisional"),
  };
}
