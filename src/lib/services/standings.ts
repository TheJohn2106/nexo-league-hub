import type { Db } from "../db.ts";
import { computeStandings } from "../scoring/engine.ts";
import type { EngineInput, ScoringConfig } from "../scoring/types.ts";
import { championshipIn } from "./context.ts";

/** Construit l'entrée du moteur à partir de la base (résultats validés, corrections et pénalités actives). */
export async function loadEngineInput(db: Db, communityId: string, championshipId: string): Promise<EngineInput & { championship: Record<string, unknown> }> {
  const c = await championshipIn(db, communityId, championshipId);
  const rounds = (await db.query("SELECT id, number, is_joker_eligible, status FROM rounds WHERE championship_id=$1 ORDER BY number", [c.id])).rows;
  const sessions = (
    await db.query(
      `SELECT s.id, s.round_id, s.kind, s.label, s.coefficient, s.awards_points, s.awards_pole, s.results_status
       FROM round_sessions s JOIN rounds r ON r.id=s.round_id WHERE r.championship_id=$1 ORDER BY r.number, s.starts_at, s.ordinal`,
      [c.id],
    )
  ).rows;
  const results = (
    await db.query(
      `SELECT res.* FROM results res JOIN round_sessions s ON s.id=res.session_id JOIN rounds r ON r.id=s.round_id WHERE r.championship_id=$1
       ORDER BY r.number, s.starts_at, s.ordinal, res.finish_position`,
      [c.id],
    )
  ).rows;
  const corrections = (
    await db.query(
      `SELECT rc.result_id, rc.field, rc.new_value FROM result_corrections rc JOIN results res ON res.id=rc.result_id
       JOIN round_sessions s ON s.id=res.session_id JOIN rounds r ON r.id=s.round_id
       WHERE r.championship_id=$1 AND rc.revoked_at IS NULL ORDER BY rc.created_at, rc.id`,
      [c.id],
    )
  ).rows;
  const penalties = (
    await db.query(
      `SELECT p.id, p.session_id, p.user_id, p.kind, p.value, p.scope FROM penalties p JOIN round_sessions s ON s.id=p.session_id
       JOIN rounds r ON r.id=s.round_id WHERE r.championship_id=$1 AND p.revoked_at IS NULL`,
      [c.id],
    )
  ).rows;
  const drivers = (
    await db.query(
      `SELECT r.user_id, u.display_name, r.category, r.team_id FROM registrations r JOIN users u ON u.id=r.user_id
       WHERE r.championship_id=$1 AND (r.status IN ('accepted','reserve') OR EXISTS (
         SELECT 1 FROM results res JOIN round_sessions s ON s.id=res.session_id JOIN rounds rd ON rd.id=s.round_id
         WHERE rd.championship_id=$1 AND res.user_id=r.user_id))`,
      [c.id],
    )
  ).rows;
  const teams = (await db.query("SELECT id, name FROM teams WHERE championship_id=$1 ORDER BY name", [c.id])).rows;
  // Multiclasse : un pilote inscrit sans catégorie est classé dans la classe de voiture où il a le plus couru (la plus récente en cas d'égalité).
  // Seulement si les résultats comptent au moins deux classes ; sinon un classement par catégorie ferait doublon avec le général.
  const classFallback = new Map<string, string>();
  if (new Set(results.map((r) => r.car_class).filter(Boolean)).size >= 2) {
    const counts = new Map<string, Map<string, number>>();
    for (const r of results) {
      if (!r.user_id || !r.car_class) continue;
      const m = counts.get(r.user_id) ?? new Map<string, number>();
      m.set(r.car_class, (m.get(r.car_class) ?? 0) + 1);
      counts.set(r.user_id, m);
    }
    for (const [userId, m] of counts) {
      let best: string | null = null;
      for (const [k, n] of m) if (best === null || n >= m.get(best)!) best = k;
      if (best) classFallback.set(userId, best);
    }
  }
  const noShows = (
    await db.query("SELECT a.round_id, a.user_id FROM attendances a JOIN rounds r ON r.id=a.round_id WHERE r.championship_id=$1 AND a.start_status='no_show'", [c.id])
  ).rows;
  return {
    championship: c,
    config: c.scoring as ScoringConfig,
    rounds: rounds.map((r) => ({ id: r.id, number: r.number, jokerEligible: r.is_joker_eligible, cancelled: r.status === "cancelled" })),
    sessions: sessions.map((s) => ({
      id: s.id,
      roundId: s.round_id,
      kind: s.kind,
      label: s.label,
      coefficient: Number(s.coefficient),
      awardsPoints: s.awards_points,
      awardsPole: s.awards_pole,
      resultsStatus: s.results_status,
    })),
    results: results.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      userId: r.user_id,
      displayName: r.display_name,
      finishPosition: r.finish_position,
      classPosition: r.class_position,
      carClass: r.car_class,
      startPosition: r.start_position,
      laps: r.laps,
      bestLapMs: r.best_lap_ms,
      totalTimeMs: r.total_time_ms == null ? null : Number(r.total_time_ms),
      gapMs: r.gap_ms == null ? null : Number(r.gap_ms),
      gapLaps: r.gap_laps,
      incidents: r.incidents,
      status: r.status,
    })),
    corrections: corrections.map((x) => ({ resultId: x.result_id, field: x.field, newValue: x.new_value })),
    penalties: penalties.map((p) => ({ id: p.id, sessionId: p.session_id, userId: p.user_id, kind: p.kind, value: p.value, scope: p.scope })),
    drivers: drivers.map((d) => ({ userId: d.user_id, displayName: d.display_name, category: d.category ?? classFallback.get(d.user_id) ?? null, teamId: d.team_id })),
    teams,
    noShows: noShows.map((n) => ({ roundId: n.round_id, userId: n.user_id })),
  };
}

export async function championshipStandings(db: Db, communityId: string, championshipId: string) {
  const input = await loadEngineInput(db, communityId, championshipId);
  return { input, output: computeStandings(input) };
}
