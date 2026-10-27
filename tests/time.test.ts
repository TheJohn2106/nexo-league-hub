// Fuseau Europe/Brussels et changements d'heure : saisie locale → UTC, affichage, fenêtres de présence et de pointage.
import test from "node:test";
import assert from "node:assert/strict";
import { formatDateTime, utcToZonedLocal, zonedLocalToUtc } from "../src/lib/time.ts";
import { roundWindows } from "../src/lib/services/attendance.ts";

const tz = "Europe/Brussels";
const hm = (d: Date) => formatDateTime(d, tz, { weekday: undefined, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

test("saisie locale → UTC de part et d'autre des changements d'heure", () => {
  // 2026 : heure d'été jusqu'au dimanche 25 octobre 03:00 ; 2027 : heure d'été dès le dimanche 28 mars 02:00.
  assert.equal(zonedLocalToUtc("2026-10-24T20:30", tz).toISOString(), "2026-10-24T18:30:00.000Z"); // UTC+2
  assert.equal(zonedLocalToUtc("2026-10-25T20:30", tz).toISOString(), "2026-10-25T19:30:00.000Z"); // UTC+1, le jour même
  assert.equal(zonedLocalToUtc("2027-03-27T20:30", tz).toISOString(), "2027-03-27T19:30:00.000Z");
  assert.equal(zonedLocalToUtc("2027-03-28T20:30", tz).toISOString(), "2027-03-28T18:30:00.000Z");
  for (const local of ["2026-10-24T20:30", "2026-10-25T20:30", "2027-03-28T20:30", "2026-07-01T00:00", "2026-12-31T23:59"])
    assert.equal(utcToZonedLocal(zonedLocalToUtc(local, tz), tz), local);
});

test("heure sautée refusée, heure doublée déterministe", () => {
  assert.throws(() => zonedLocalToUtc("2027-03-28T02:30", tz), /n’existe pas/);
  assert.equal(zonedLocalToUtc("2027-03-28T03:00", tz).toISOString(), "2027-03-28T01:00:00.000Z");
  // 02:30 existe deux fois le 25 octobre 2026 : on retient l'heure d'hiver (UTC+1).
  assert.equal(zonedLocalToUtc("2026-10-25T02:30", tz).toISOString(), "2026-10-25T01:30:00.000Z");
});

test("fenêtres de présence et de pointage : durées exactes, affichées à l'heure locale", () => {
  // Course le lundi 26 octobre 2026 à 20:30 (heure d'hiver), réponse attendue 48 h avant.
  const w = roundWindows({ starts_at: zonedLocalToUtc("2026-10-26T20:30", tz), presence_deadline_hours: 48, checkin_opens_minutes: 60, checkin_closes_minutes: 10 });
  assert.equal(w.start.getTime() - w.presenceDeadline.getTime(), 48 * 3600000);
  // 48 h réelles avant 20:30 CET, de l'autre côté du changement d'heure, tombent à 21:30 heure d'été : c'est l'heure affichée.
  assert.equal(hm(w.presenceDeadline), "24/10 21:30");
  assert.equal(hm(w.checkinOpens), "26/10 19:30");
  assert.equal(hm(w.checkinCloses), "26/10 20:20");
  // Printemps : 48 h avant le lundi 29 mars 2027 20:30 (heure d'été) → samedi 19:30 (heure d'hiver).
  const s = roundWindows({ starts_at: zonedLocalToUtc("2027-03-29T20:30", tz), presence_deadline_hours: 48, checkin_opens_minutes: 60, checkin_closes_minutes: 10 });
  assert.equal(hm(s.presenceDeadline), "27/03 19:30");
  // Pointage la nuit du changement d'heure : la fenêtre garde sa durée réelle (60 → 10 min = 50 min).
  const n = roundWindows({ starts_at: zonedLocalToUtc("2026-10-25T03:30", tz), presence_deadline_hours: 0, checkin_opens_minutes: 60, checkin_closes_minutes: 10 });
  assert.equal(n.checkinCloses.getTime() - n.checkinOpens.getTime(), 50 * 60000);
  assert.equal(hm(n.checkinOpens), "25/10 02:30");
});
