// Dates stockées en UTC ; conversions vers/depuis le fuseau de la communauté sans dépendance externe.
export const DEFAULT_TZ = "Europe/Brussels";

function offsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return (asUtc - date.getTime()) / 60000;
}

/** "2026-11-14T20:30" saisi dans le fuseau tz → Date UTC. */
export function zonedLocalToUtc(local: string, timeZone = DEFAULT_TZ): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) throw new Error("Date invalide (format attendu AAAA-MM-JJTHH:MM).");
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = naive - offsetMinutes(new Date(naive), timeZone) * 60000;
  // Second passage pour les changements d'heure.
  guess = naive - offsetMinutes(new Date(guess), timeZone) * 60000;
  // Heure sautée au passage à l'heure d'été (ex. 02:30 le dernier dimanche de mars) : refusée plutôt que décalée en silence.
  // Heure doublée à l'automne (02:30 existe deux fois) : la seconde occurrence (heure d'hiver) est retenue.
  if (utcToZonedLocal(new Date(guess), timeZone) !== local.trim())
    throw new Error(`L’heure ${m[4]}:${m[5]} n’existe pas le ${m[3]}/${m[2]}/${m[1]} (passage à l’heure d’été) : choisissez une autre heure.`);
  return new Date(guess);
}

/** Date UTC → valeur pour <input type="datetime-local"> dans le fuseau tz. */
export function utcToZonedLocal(date: Date | string, timeZone = DEFAULT_TZ) {
  const d = new Date(date);
  const local = new Date(d.getTime() + offsetMinutes(d, timeZone) * 60000);
  return local.toISOString().slice(0, 16);
}

export function formatDateTime(date: Date | string | null | undefined, timeZone = DEFAULT_TZ, opts?: Intl.DateTimeFormatOptions) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("fr-BE", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...opts,
  }).format(new Date(date));
}
export function formatDate(date: Date | string | null | undefined, timeZone = DEFAULT_TZ) {
  return formatDateTime(date, timeZone, { weekday: undefined, hour: undefined, minute: undefined, year: "numeric" });
}
export function lapTime(ms: number | null | undefined) {
  if (ms == null || ms <= 0) return "non fourni";
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}
/** "1:32.456", "92.456", "92456" (ms) → ms. */
export function parseLapTime(input: string): number | null {
  const v = input.trim().replace(",", ".");
  if (!v) return null;
  let m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(v);
  if (m) return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number((m[3] ?? "0").padEnd(3, "0"));
  m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(v);
  if (m) return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number((m[4] ?? "0").padEnd(3, "0"));
  if (/^\d+\.\d{1,3}$/.test(v)) return Math.round(Number(v) * 1000);
  if (/^\d+$/.test(v)) return Number(v);
  throw new Error(`Temps invalide : « ${input} »`);
}
