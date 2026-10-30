// File de notifications (outbox) : chaque message a une clé de déduplication unique.
// L'envoi Discord passe par un webhook configuré par le propriétaire de la ligue. Sans webhook,
// les messages sont marqués « skipped » (jamais « sent ») et l'application reste utilisable.
import type { Db } from "../db.ts";
import { formatDateTime } from "../time.ts";

export async function enqueue(db: Db, communityId: string, kind: string, dedupeKey: string, payload: Record<string, unknown>) {
  const r = await db.query(
    "INSERT INTO notification_outbox(community_id, kind, dedupe_key, payload) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id",
    [communityId, kind, dedupeKey, JSON.stringify(payload)],
  );
  return r.rowCount === 1;
}

/** Planifie les rappels pour les pilotes sans réponse (une seule fois par manche et par pilote). */
export async function scheduleReminders(db: Db, now = new Date()) {
  const rows = (
    await db.query(
      `SELECT r.id AS round_id, c.community_id, reg.user_id
       FROM rounds r JOIN championships c ON c.id=r.championship_id JOIN communities co ON co.id=c.community_id
       JOIN registrations reg ON reg.championship_id=c.id AND reg.status IN ('accepted','reserve')
       LEFT JOIN attendances a ON a.round_id=r.id AND a.user_id=reg.user_id
       WHERE r.status IN ('scheduled','postponed')
         AND r.starts_at - make_interval(hours => c.presence_deadline_hours) > $1
         AND r.starts_at - make_interval(hours => c.presence_deadline_hours) - make_interval(hours => co.discord_reminder_hours) <= $1
         AND COALESCE(a.response,'none')='none'`,
      [now],
    )
  ).rows;
  let created = 0;
  for (const r of rows)
    if (await enqueue(db, r.community_id, "presence_reminder", `reminder:${r.round_id}:${r.user_id}`, { roundId: r.round_id, userId: r.user_id })) created++;
  return created;
}

export type Transport = typeof fetch;

async function mention(db: Db, userId: string) {
  const r = (
    await db.query("SELECT u.display_name, d.discord_id FROM users u LEFT JOIN discord_identities d ON d.user_id=u.id WHERE u.id=$1", [userId])
  ).rows[0];
  if (!r) return "pilote";
  return r.discord_id ? `<@${r.discord_id}>` : `**${r.display_name}**`;
}

async function roundInfo(db: Db, roundId: string) {
  return (
    await db.query(
      `SELECT r.name, r.number, r.track, r.track_config, r.cars, r.starts_at, c.name AS champ, c.slug AS champ_slug, co.slug, co.timezone
       FROM rounds r JOIN championships c ON c.id=r.championship_id JOIN communities co ON co.id=c.community_id WHERE r.id=$1`,
      [roundId],
    )
  ).rows[0];
}

export async function renderMessage(db: Db, kind: string, payload: Record<string, unknown>, appOrigin: string) {
  const link = (path: string) => (appOrigin ? new URL(path, appOrigin).href : path);
  if (kind === "presence_reminder" || kind === "seat_offer" || kind === "round_announcement") {
    const r = await roundInfo(db, String(payload.roundId));
    if (!r) return null;
    const when = formatDateTime(r.starts_at, r.timezone);
    const url = link(`/c/${r.slug}/me`);
    if (kind === "presence_reminder")
      return `⏰ ${await mention(db, String(payload.userId))}, indique ta présence pour **${r.champ} — Manche ${r.number} : ${r.name}** (${when}) : ${url}`;
    if (kind === "seat_offer")
      return `🎟️ ${await mention(db, String(payload.userId))}, une place se libère pour **${r.champ} — Manche ${r.number}** (${when}). Accepte-la avant ${formatDateTime(String(payload.expiresAt), r.timezone)} : ${url}`;
    return `🏁 **${r.champ} — Manche ${r.number} : ${r.name}**\n📍 ${r.track}${r.track_config ? ` (${r.track_config})` : ""}${r.cars?.length ? `\n🚗 ${r.cars.join(", ")}` : ""}\n🕗 ${when}\nRéponds présent : ${url}`;
  }
  if (kind === "results_published") {
    const s = (
      await db.query(
        `SELECT s.label, r.number, r.name, c.name AS champ, c.slug AS champ_slug, co.slug FROM round_sessions s JOIN rounds r ON r.id=s.round_id
         JOIN championships c ON c.id=r.championship_id JOIN communities co ON co.id=c.community_id WHERE s.id=$1`,
        [payload.sessionId],
      )
    ).rows[0];
    if (!s) return null;
    const top = (
      await db.query("SELECT display_name FROM results WHERE session_id=$1 AND status='classified' ORDER BY finish_position LIMIT 3", [payload.sessionId])
    ).rows.map((x, i) => `${["🥇", "🥈", "🥉"][i]} ${x.display_name}`);
    return `📊 Résultats ${payload.final ? "définitifs" : "provisoires"} — **${s.champ}, manche ${s.number} (${s.label})**\n${top.join("\n")}\nClassement : ${link(`/c/${s.slug}/championships/${s.champ_slug}`)}`;
  }
  return null;
}

/**
 * Envoie les messages en attente. Retourne le nombre envoyé/ignoré/échoué.
 * transport injectable pour les tests ; jamais appelé sans webhook configuré.
 */
export async function deliverPending(db: Db, transport: Transport = fetch, limit = 20, communityId: string | null = null) {
  const appOrigin = process.env.APP_ORIGIN ?? "";
  const items = (
    await db.query(
      `SELECT o.*, co.discord_webhook_url FROM notification_outbox o JOIN communities co ON co.id=o.community_id
       WHERE o.status='pending' AND o.next_attempt_at <= now() AND ($2::uuid IS NULL OR o.community_id=$2)
       ORDER BY o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
      [limit, communityId],
    )
  ).rows;
  const stats = { sent: 0, skipped: 0, failed: 0 };
  for (const item of items) {
    if (!item.discord_webhook_url) {
      await db.query("UPDATE notification_outbox SET status='skipped', last_error='Discord non configuré : aucun message envoyé.' WHERE id=$1", [item.id]);
      stats.skipped++;
      continue;
    }
    const content = await renderMessage(db, item.kind, item.payload, appOrigin);
    if (!content) {
      await db.query("UPDATE notification_outbox SET status='skipped', last_error='Contenu introuvable (objet supprimé).' WHERE id=$1", [item.id]);
      stats.skipped++;
      continue;
    }
    try {
      const res = await transport(item.discord_webhook_url + "?wait=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // allowed_mentions limite les mentions aux pilotes concernés (jamais @everyone).
        body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: ["users"] } }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") ?? "5");
        await db.query(
          "UPDATE notification_outbox SET attempts=attempts+1, next_attempt_at=now()+make_interval(secs => $2), last_error='Limite Discord (429)' WHERE id=$1",
          [item.id, Math.min(Math.max(retry, 1), 3600)],
        );
        stats.failed++;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await db.query("UPDATE notification_outbox SET status='sent', sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1", [item.id]);
      stats.sent++;
    } catch (e) {
      const attempts = item.attempts + 1;
      await db.query(
        `UPDATE notification_outbox SET attempts=$2, last_error=$3, status=CASE WHEN $2 >= 5 THEN 'failed' ELSE 'pending' END,
           next_attempt_at=now()+make_interval(mins => $2 * $2) WHERE id=$1`,
        [item.id, attempts, String((e as Error).message).slice(0, 300)],
      );
      stats.failed++;
    }
  }
  return stats;
}

export async function outboxFor(db: Db, communityId: string, limit = 30) {
  return (
    await db.query(
      `SELECT id, kind, status, attempts, last_error AS "lastError", created_at AS "createdAt", sent_at AS "sentAt"
       FROM notification_outbox WHERE community_id=$1 ORDER BY id DESC LIMIT $2`,
      [communityId, limit],
    )
  ).rows;
}
