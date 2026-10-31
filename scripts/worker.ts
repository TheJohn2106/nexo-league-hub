// Tâches de fond : rappels de présence, expiration des places proposées, reprise des récupérations iRacing,
// envoi de la file Discord.
//   npm run worker        (boucle, toutes les 60 s)
//   npm run worker:once   (un seul passage, pour un cron externe)
import "dotenv/config";
import { getPool, tx } from "../src/lib/db.ts";
import { rebalance } from "../src/lib/services/attendance.ts";
import { roundIn } from "../src/lib/services/context.ts";
import { deliverPending, scheduleReminders } from "../src/lib/services/notifications.ts";
import { retryDueSyncFailures } from "../src/lib/services/results.ts";

const pool = getPool();
const once = process.argv.includes("--once");
let stopping = false;

async function tick(now = new Date()) {
  const reminders = await tx((db) => scheduleReminders(db, now), pool);
  // Places proposées non acceptées dans le délai : la place passe au réserviste suivant.
  const due = (
    await pool.query(
      `SELECT DISTINCT a.round_id, c.community_id FROM attendances a JOIN rounds r ON r.id=a.round_id JOIN championships c ON c.id=r.championship_id
       WHERE a.seat='offered' AND a.offer_expires_at <= $1 AND r.status IN ('scheduled','postponed')`,
      [now],
    )
  ).rows;
  for (const d of due)
    await tx(async (db) => {
      const round = await roundIn(db, d.community_id, d.round_id, true);
      await rebalance(db, round, null);
    }, pool);
  const iracing = await retryDueSyncFailures(pool, fetch, now);
  const delivery = await tx((db) => deliverPending(db), pool);
  const failures = (await pool.query("SELECT count(*)::int n FROM sync_failures WHERE resolved_at IS NULL")).rows[0].n;
  return { reminders, expiredOfferRounds: due.length, iracingRetries: iracing, ...delivery, unresolvedSyncFailures: failures };
}

async function main() {
  do {
    try {
      const r = await tick();
      console.log(new Date().toISOString(), JSON.stringify(r));
    } catch (e) {
      console.error(new Date().toISOString(), "Échec du passage :", e instanceof Error ? e.message : e);
      if (once) process.exitCode = 1;
    }
    if (!once) await new Promise((r) => setTimeout(r, 60_000));
  } while (!once && !stopping);
  await pool.end();
}
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => (stopping = true));
main();
