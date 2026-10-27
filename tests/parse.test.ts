import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsvTemplate, parseIracingResult, parseManualRows, csvTemplateHeader } from "../src/lib/results/parse.ts";
import { parseLapTime, zonedLocalToUtc, utcToZonedLocal } from "../src/lib/time.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/iracing-results-get.synthetic.json", import.meta.url), "utf8"));

test("Data API results/get : course, conversions d'unités et statuts", () => {
  const s = parseIracingResult(fixture, { kind: "race", expectedSubsessionId: 81234567 });
  assert.equal(s.simsessionNumber, 0);
  assert.equal(s.rows.length, 5);
  const [p1, p2, , p4, p5] = s.rows;
  assert.equal(p1.custId, 900002);
  assert.equal(p1.finishPosition, 1);
  assert.equal(p1.startPosition, 2);
  assert.equal(p2.bestLapMs, 138410);
  assert.equal(p2.gapMs, 2123);
  assert.equal(p4.gapLaps, 1);
  assert.equal(p4.gapMs, null);
  assert.equal(p5.status, "dnf");
  assert.equal(p5.reasonOut, "Disconnected");
  assert.equal(p1.totalTimeMs, null);
});

test("Data API : qualification sélectionnée par type, simsession explicite", () => {
  const q = parseIracingResult(fixture, { kind: "qualifying" });
  assert.equal(q.simsessionNumber, -1);
  assert.equal(q.rows[0].custId, 900001);
  assert.equal(parseIracingResult(fixture, { kind: "race", simsessionNumber: -1 }).rows[0].custId, 900001);
  assert.throws(() => parseIracingResult(fixture, { kind: "race", simsessionNumber: 3 }), /absente/);
});

test("Data API : refus d'un format inconnu ou d'une autre sous-session", () => {
  assert.throws(() => parseIracingResult({ foo: 1 }, { kind: "race" }), /Format non reconnu/);
  assert.throws(() => parseIracingResult(fixture, { kind: "race", expectedSubsessionId: 1 }), /différente/);
});

test("Modèle CSV Nexo : lecture, validations et doublons", () => {
  const csv = `${csvTemplateHeader}\n1;900001;Alex;GT3;BMW;2;20;1:38.410;32:10.500;2;classe\n2;;Invité;GT3;BMW;1;19;1:39.000;;4;abandon`;
  const s = parseCsvTemplate(csv);
  assert.equal(s.rows[0].bestLapMs, 98410);
  assert.equal(s.rows[0].totalTimeMs, 1930500);
  assert.equal(s.rows[1].status, "dnf");
  assert.equal(s.rows[1].entryKey, "name:invité");
  assert.throws(() => parseCsvTemplate(`${csvTemplateHeader}\n1;1;A;;;;;;;;classe\n1;2;B;;;;;;;;classe`), /double/);
  assert.throws(() => parseCsvTemplate("position;nom\n1;A"), /Colonnes manquantes/);
  assert.throws(() => parseCsvTemplate(`${csvTemplateHeader}\n1;1;A;;;;;xx;;;classe`), /Temps invalide/);
});

test("saisie manuelle : écarts calculés et contrôles", () => {
  const s = parseManualRows([
    { userId: "u1", custId: 1, displayName: "A", position: 1, status: "classified", laps: 10, bestLap: "1:30.000", totalTime: "15:00.000", incidents: 0 },
    { userId: "u2", custId: 2, displayName: "B", position: 2, status: "classified", laps: 10, bestLap: "", totalTime: "15:04.500", incidents: 1 },
  ]);
  assert.equal(s.rows[1].gapMs, 4500);
  assert.throws(() => parseManualRows([]), /au moins/);
});

test("temps et fuseau horaire Europe/Brussels (heure d'hiver/été)", () => {
  assert.equal(parseLapTime("1:02.5"), 62500);
  assert.equal(parseLapTime("1:00:00.000"), 3600000);
  assert.equal(zonedLocalToUtc("2026-11-14T20:30").toISOString(), "2026-11-14T19:30:00.000Z");
  assert.equal(zonedLocalToUtc("2026-07-01T20:30").toISOString(), "2026-07-01T18:30:00.000Z");
  assert.equal(utcToZonedLocal("2026-11-14T19:30:00Z"), "2026-11-14T20:30");
});
