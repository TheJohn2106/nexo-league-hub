// Types du moteur de points. Aucune dépendance à la base ni à l'affichage.

export type TieBreak = "wins" | "countback" | "lastRound" | "fewestIncidents";

export interface ScoringConfig {
  /** Points par position (index 0 = 1re place). Au-delà : 0. */
  pointsByPosition: number[];
  /** Base de position : classement général ou classement de la classe (multi-classe). */
  positionBasis: "overall" | "class";
  /** Points attribués à tout partant (classé ou abandon). */
  participationPoints: number;
  pole: { points: number; requiresStart: boolean };
  fastestLap: { points: number; requiresClassified: boolean; maxPosition: number | null };
  /** Abandon : "position" = points de la place si le pilote a couvert minLapsPercent des tours du vainqueur. */
  dnf: { mode: "position" | "zero"; minLapsPercent: number };
  /** Nombre de manches retirées (jokers / moins bons résultats). */
  dropWorst: number;
  /** Retrait de points pour absence au départ sans prévenir. null = règle désactivée. */
  absencePenaltyPoints: number | null;
  tiebreak: TieBreak[];
  teams: { countBest: number };
}

export const defaultScoring: ScoringConfig = {
  pointsByPosition: [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  positionBasis: "overall",
  participationPoints: 0,
  pole: { points: 1, requiresStart: true },
  fastestLap: { points: 1, requiresClassified: true, maxPosition: 10 },
  dnf: { mode: "position", minLapsPercent: 75 },
  dropWorst: 0,
  absencePenaltyPoints: null,
  tiebreak: ["wins", "countback", "lastRound"],
  teams: { countBest: 2 },
};

export type ResultStatus = "classified" | "dnf" | "dns" | "dsq";

export interface EngineRound {
  id: string;
  number: number;
  jokerEligible: boolean;
  cancelled: boolean;
}
export interface EngineSession {
  id: string;
  roundId: string;
  kind: "practice" | "qualifying" | "race";
  label: string;
  coefficient: number;
  awardsPoints: boolean;
  awardsPole: boolean;
  resultsStatus: "none" | "provisional" | "final";
}
export interface EngineResult {
  id: string;
  sessionId: string;
  userId: string | null;
  displayName: string;
  finishPosition: number;
  classPosition: number | null;
  carClass: string | null;
  startPosition: number | null;
  laps: number | null;
  bestLapMs: number | null;
  totalTimeMs: number | null;
  gapMs: number | null;
  gapLaps: number | null;
  incidents: number | null;
  status: ResultStatus;
}
export interface EngineCorrection {
  resultId: string;
  field: "finish_position" | "status" | "laps" | "best_lap_ms" | "incidents" | "user_id" | "total_time_ms" | "start_position";
  newValue: string | null;
}
export interface EnginePenalty {
  id: string;
  sessionId: string;
  userId: string;
  kind: "time" | "positions" | "points" | "dsq" | "warning";
  value: number;
  scope: "session" | "championship";
}
export interface EngineDriver {
  userId: string;
  displayName: string;
  category: string | null;
  teamId: string | null;
}
export interface EngineTeam {
  id: string;
  name: string;
}
export interface EngineInput {
  config: ScoringConfig;
  rounds: EngineRound[];
  sessions: EngineSession[];
  results: EngineResult[];
  corrections: EngineCorrection[];
  penalties: EnginePenalty[];
  drivers: EngineDriver[];
  teams: EngineTeam[];
  /** Absences au départ constatées (start_status = no_show). */
  noShows: { roundId: string; userId: string }[];
}

export interface SessionLine {
  sessionId: string;
  roundId: string;
  userId: string;
  position: number;
  classPosition: number | null;
  status: ResultStatus;
  positionPoints: number;
  participationPoints: number;
  fastestLapPoints: number;
  polePoints: number;
  coefficient: number;
  penaltyPoints: number;
  total: number;
  notes: string[];
}
export interface EffectiveResult extends EngineResult {
  originalPosition: number;
  appliedPenalties: string[];
}
export interface UnappliedPenalty {
  penaltyId: string;
  reason: string;
}
export interface DriverStanding {
  rank: number;
  userId: string;
  displayName: string;
  category: string | null;
  teamId: string | null;
  points: number;
  grossPoints: number;
  droppedRoundIds: string[];
  penaltyPoints: number;
  wins: number;
  podiums: number;
  starts: number;
  roundPoints: Record<string, number>;
  tied: boolean;
}
export interface TeamStanding {
  rank: number;
  teamId: string;
  name: string;
  points: number;
  tied: boolean;
}
export interface EngineOutput {
  effective: Record<string, EffectiveResult[]>;
  lines: SessionLine[];
  drivers: DriverStanding[];
  teams: TeamStanding[];
  categories: Record<string, DriverStanding[]>;
  unappliedPenalties: UnappliedPenalty[];
  provisional: boolean;
}
