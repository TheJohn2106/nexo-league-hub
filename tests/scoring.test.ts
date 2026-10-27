import test from "node:test";
import assert from "node:assert/strict";
import { computeStandings } from "../src/lib/scoring/engine.ts";
import { defaultScoring, type EngineInput, type EngineResult, type ScoringConfig } from "../src/lib/scoring/types.ts";

const cfg = (over: Partial<ScoringConfig> = {}): ScoringConfig => ({
  ...defaultScoring,
  pointsByPosition: [10, 8, 6, 4, 2],
  fastestLap: { points: 1, requiresClassified: true, maxPosition: null },
  pole: { points: 1, requiresStart: true },
  ...over,
});
let n = 0;
const res = (sessionId: string, userId: string | null, pos: number, extra: Partial<EngineResult> = {}): EngineResult => ({
  id: `r${++n}`,
  sessionId,
  userId,
  displayName: userId ?? "inconnu",
  finishPosition: pos,
  classPosition: null,
  carClass: null,
  startPosition: null,
  laps: 20,
  bestLapMs: 90000 + pos * 100,
  totalTimeMs: null,
  gapMs: null,
  gapLaps: null,
  incidents: 0,
  status: "classified",
  ...extra,
});
const drivers = ["a", "b", "c", "d"].map((id) => ({ userId: id, displayName: id.toUpperCase(), category: id < "c" ? "Pro" : "Am", teamId: id < "c" ? "t1" : "t2" }));
const base = (over: Partial<EngineInput> = {}): EngineInput => ({
  config: cfg(),
  rounds: [
    { id: "R1", number: 1, jokerEligible: true, cancelled: false },
    { id: "R2", number: 2, jokerEligible: true, cancelled: false },
  ],
  sessions: [
    { id: "Q1", roundId: "R1", kind: "qualifying", label: "Qualif", coefficient: 1, awardsPoints: false, awardsPole: true, resultsStatus: "final" },
    { id: "S1", roundId: "R1", kind: "race", label: "Course", coefficient: 1, awardsPoints: true, awardsPole: false, resultsStatus: "final" },
    { id: "S2", roundId: "R2", kind: "race", label: "Course", coefficient: 1, awardsPoints: true, awardsPole: false, resultsStatus: "final" },
  ],
  results: [],
  corrections: [],
  penalties: [],
  drivers,
  teams: [
    { id: "t1", name: "Alpha" },
    { id: "t2", name: "Bravo" },
  ],
  noShows: [],
  ...over,
});
const pts = (out: ReturnType<typeof computeStandings>, id: string) => out.drivers.find((d) => d.userId === id)!.points;

test("points par position, pole et meilleur tour", () => {
  const out = computeStandings(
    base({
      results: [
        res("Q1", "b", 1),
        res("Q1", "a", 2),
        res("S1", "a", 1, { bestLapMs: 91000 }),
        res("S1", "b", 2, { bestLapMs: 90500 }),
        res("S1", "c", 3, { bestLapMs: 92000 }),
      ],
    }),
  );
  assert.equal(pts(out, "a"), 10);
  assert.equal(pts(out, "b"), 8 + 1 + 1); // P2 + pole + meilleur tour
  assert.equal(pts(out, "c"), 6);
  const lineB = out.lines.find((l) => l.userId === "b")!;
  assert.deepEqual([lineB.positionPoints, lineB.polePoints, lineB.fastestLapPoints], [8, 1, 1]);
});

test("éligibilité du meilleur tour : pilote non classé ou hors top N sans bonus", () => {
  const out = computeStandings(
    base({
      config: cfg({ fastestLap: { points: 1, requiresClassified: true, maxPosition: 2 } }),
      results: [res("S1", "a", 1), res("S1", "b", 2), res("S1", "c", 3, { bestLapMs: 80000 })],
    }),
  );
  assert.equal(pts(out, "c"), 6);
  assert.ok(out.lines.find((l) => l.userId === "c")!.notes.some((n) => n.includes("sans bonus")));
});

test("pole sans départ : pas de point si la règle exige le départ", () => {
  const out = computeStandings(base({ results: [res("Q1", "d", 1), res("S1", "a", 1), res("S1", "d", 2, { status: "dns", laps: 0 })] }));
  assert.equal(pts(out, "d"), 0);
});

test("coefficient appliqué aux points de place, pas aux bonus", () => {
  const input = base({ results: [res("S1", "a", 1, { bestLapMs: 1 }), res("S1", "b", 2)] });
  input.sessions[1].coefficient = 2;
  const out = computeStandings(input);
  assert.equal(pts(out, "a"), 21);
  assert.equal(pts(out, "b"), 16);
});

test("DNF : classé si distance suffisante, sinon zéro ; DNS et DSQ à zéro", () => {
  const out = computeStandings(
    base({
      results: [
        res("S1", "a", 1, { laps: 20 }),
        res("S1", "b", 2, { status: "dnf", laps: 16 }),
        res("S1", "c", 3, { status: "dnf", laps: 5 }),
        res("S1", "d", 4, { status: "dsq" }),
      ],
    }),
  );
  assert.equal(pts(out, "b"), 8);
  assert.equal(pts(out, "c"), 0);
  assert.equal(pts(out, "d"), 0);
});

test("égalité départagée par victoires puis countback, ex aequo sinon", () => {
  const out = computeStandings(
    base({
      config: cfg({ fastestLap: { points: 0, requiresClassified: true, maxPosition: null }, pole: { points: 0, requiresStart: true } }),
      results: [res("S1", "a", 1), res("S1", "b", 2), res("S2", "b", 1), res("S2", "a", 2), res("S1", "c", 3), res("S2", "d", 3)],
    }),
  );
  const [first, second] = out.drivers;
  assert.equal(first.points, 18);
  assert.equal(second.points, 18);
  // Victoires égales (1-1), countback égal → départage dernière manche : B a gagné R2.
  assert.equal(first.userId, "b");
  assert.equal(first.tied, false);
  const tied = computeStandings(
    base({
      config: cfg({ tiebreak: ["wins"], fastestLap: { points: 0, requiresClassified: true, maxPosition: null }, pole: { points: 0, requiresStart: true } }),
      results: [res("S1", "a", 1), res("S1", "b", 2), res("S2", "b", 1), res("S2", "a", 2)],
    }),
  );
  assert.equal(tied.drivers[0].rank, 1);
  assert.equal(tied.drivers[1].rank, 1);
  assert.ok(tied.drivers[0].tied);
});

test("joker : la plus mauvaise manche est retirée, pénalités non retirables", () => {
  const out = computeStandings(
    base({
      config: cfg({ dropWorst: 1, fastestLap: { points: 0, requiresClassified: true, maxPosition: null } }),
      results: [res("S1", "b", 1), res("S1", "c", 2), res("S1", "d", 3), res("S1", "a", 4), res("S2", "a", 1)],
      penalties: [{ id: "p1", sessionId: "S2", userId: "a", kind: "points", value: 3, scope: "session" }],
    }),
  );
  const a = out.drivers.find((d) => d.userId === "a")!;
  assert.deepEqual(a.droppedRoundIds, ["R1"]);
  assert.equal(a.points, 10 - 3);
  assert.equal(a.grossPoints, 14);
});

test("manche non courue comptée à zéro pour le joker", () => {
  const out = computeStandings(base({ config: cfg({ dropWorst: 1 }), results: [res("S1", "a", 1, { bestLapMs: 1 }), res("S1", "b", 2), res("S2", "a", 1)] }));
  const b = out.drivers.find((d) => d.userId === "b")!;
  assert.equal(b.points, 8);
  assert.deepEqual(b.droppedRoundIds, ["R2"]);
});

test("pénalité en positions : recul et recalcul des points", () => {
  const out = computeStandings(
    base({
      config: cfg({ fastestLap: { points: 0, requiresClassified: true, maxPosition: null } }),
      results: [res("S1", "a", 1), res("S1", "b", 2), res("S1", "c", 3)],
      penalties: [{ id: "p1", sessionId: "S1", userId: "a", kind: "positions", value: 2, scope: "session" }],
    }),
  );
  assert.deepEqual(out.effective.S1.map((r) => r.userId), ["b", "c", "a"]);
  assert.equal(pts(out, "a"), 6);
  assert.equal(pts(out, "b"), 10);
  assert.equal(out.effective.S1[2].originalPosition, 1);
});

test("pénalité en temps : appliquée si les temps sont complets", () => {
  const out = computeStandings(
    base({
      config: cfg({ fastestLap: { points: 0, requiresClassified: true, maxPosition: null } }),
      results: [
        res("S1", "a", 1, { totalTimeMs: 1_800_000 }),
        res("S1", "b", 2, { totalTimeMs: 1_803_000 }),
        res("S1", "c", 3, { totalTimeMs: 1_810_000 }),
        res("S1", "d", 4, { laps: 19, totalTimeMs: 1_790_000 }),
      ],
      penalties: [{ id: "p1", sessionId: "S1", userId: "a", kind: "time", value: 5, scope: "session" }],
    }),
  );
  assert.deepEqual(out.effective.S1.map((r) => r.userId), ["b", "a", "c", "d"]);
  assert.equal(out.unappliedPenalties.length, 0);
});

test("pénalité en temps : refusée si les temps manquent (décision explicite)", () => {
  const out = computeStandings(
    base({
      results: [res("S1", "a", 1, { totalTimeMs: 1_800_000 }), res("S1", "b", 2)],
      penalties: [{ id: "p1", sessionId: "S1", userId: "a", kind: "time", value: 5, scope: "session" }],
    }),
  );
  assert.deepEqual(out.effective.S1.map((r) => r.userId), ["a", "b"]);
  assert.equal(out.unappliedPenalties[0].penaltyId, "p1");
});

test("pénalité en temps via écarts iRacing (gap au leader, même tour)", () => {
  const out = computeStandings(
    base({
      results: [res("S1", "a", 1, { gapMs: 0, gapLaps: 0 }), res("S1", "b", 2, { gapMs: 2000, gapLaps: 0 })],
      penalties: [{ id: "p1", sessionId: "S1", userId: "a", kind: "time", value: 5, scope: "session" }],
    }),
  );
  assert.deepEqual(out.effective.S1.map((r) => r.userId), ["b", "a"]);
});

test("DSQ par décision : dernier, zéro point, résultat original conservé", () => {
  const input = base({
    results: [res("S1", "a", 1), res("S1", "b", 2)],
    penalties: [{ id: "p1", sessionId: "S1", userId: "a", kind: "dsq", value: 0, scope: "session" }],
  });
  const out = computeStandings(input);
  assert.equal(out.effective.S1[1].userId, "a");
  assert.equal(out.effective.S1[1].status, "dsq");
  assert.equal(input.results[0].status, "classified");
  assert.equal(pts(out, "a"), 0);
});

test("correction de résultat recalculée sans modifier l'original", () => {
  const input = base({ results: [res("S1", "a", 1), res("S1", "b", 2)] });
  const id = input.results[0].id;
  input.corrections = [{ resultId: id, field: "status", newValue: "dnf" }, { resultId: id, field: "laps", newValue: "2" }];
  const out = computeStandings(input);
  assert.equal(pts(out, "a"), 0);
  assert.equal(input.results[0].status, "classified");
});

test("classements par catégorie et par équipe (meilleurs résultats comptés)", () => {
  const out = computeStandings(
    base({
      config: cfg({ teams: { countBest: 1 }, fastestLap: { points: 0, requiresClassified: true, maxPosition: null } }),
      results: [res("S1", "a", 1), res("S1", "c", 2), res("S1", "b", 3), res("S1", "d", 4)],
    }),
  );
  assert.deepEqual(out.categories.Am.map((d) => d.userId), ["c", "d"]);
  assert.equal(out.categories.Am[0].rank, 1);
  assert.deepEqual(out.teams.map((t) => [t.name, t.points]), [["Alpha", 10], ["Bravo", 8]]);
});

test("multi-classe : points selon la position de classe", () => {
  const out = computeStandings(
    base({
      config: cfg({ positionBasis: "class", fastestLap: { points: 0, requiresClassified: true, maxPosition: null } }),
      results: [res("S1", "a", 1, { carClass: "GT3" }), res("S1", "c", 2, { carClass: "GT4" }), res("S1", "b", 3, { carClass: "GT3" })],
    }),
  );
  assert.equal(pts(out, "c"), 10);
  assert.equal(pts(out, "b"), 8);
});

test("participants inconnus ignorés, absence sanctionnée seulement si la règle est active", () => {
  const input = base({ results: [res("S1", null, 1), res("S1", "a", 2)], noShows: [{ roundId: "R1", userId: "b" }] });
  let out = computeStandings(input);
  assert.equal(pts(out, "b"), 0);
  assert.equal(out.lines.length, 1);
  out = computeStandings({ ...input, config: cfg({ absencePenaltyPoints: 2 }) });
  assert.equal(pts(out, "b"), -2);
});

test("résultats provisoires signalés, manches annulées ignorées", () => {
  const input = base({ results: [res("S1", "a", 1), res("S2", "a", 1)] });
  input.sessions[1].resultsStatus = "provisional";
  input.rounds[1].cancelled = true;
  const out = computeStandings(input);
  assert.equal(out.provisional, true);
  assert.equal(out.drivers.find((d) => d.userId === "a")!.points, 11);
});

test("déterministe : même entrée, même sortie", () => {
  const input = base({ results: [res("S1", "a", 1), res("S1", "b", 2), res("S2", "c", 1)] });
  assert.deepEqual(computeStandings(input), computeStandings(structuredClone(input)));
});
