import { App } from "@slack/bolt";
import Database from "better-sqlite3";

const HIGH_PAWS_CHANNEL_ID = process.env.HIGH_PAWS_CHANNEL_ID;

// Persist DB on Render disk
const DB_PATH = process.env.DB_PATH || "/data/high-paws.sqlite";
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    user_id TEXT PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    giver_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function nowIso() {
  return new Date().toISOString();
}

function getScore(userId) {
  const row = db.prepare("SELECT score FROM scores WHERE user_id=?").get(userId);
  return row?.score ?? 0;
}

function getTop(limit) {
  return db
    .prepare(
      `
    SELECT user_id, score
    FROM scores
    ORDER BY score DESC
    LIMIT ?
  `
    )
    .all(limit);
}

function alreadyCounted(eventId) {
  return !!db.prepare("SELECT 1 FROM events WHERE id=?").get(eventId);
}

function incrementScore(userId) {
  const row = db.prepare("SELECT score FROM scores WHERE user_id=?").get(userId);
  const next = (row?.score ?? 0) + 1;

  db.prepare(`
    INSERT INTO scores (user_id, score, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET score=excluded.score, updated_at=excluded.updated_at
  `).run(userId, next, nowIso());

  return next;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN, // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN, // xapp-...
  socketMode: true,
});

app.message(async ({ message, client }) => {
  // Helpful runtime visibility in Render logs
  console.log("EVENT message:", {
    channel: message.channel,
    user: message.user,
    text: message.text,
    ts: message.ts,
  });

  if (!message.text || message.subtype) return;

  // Only operate inside the High-Paws channel
  if (HIGH_PAWS_CHANNEL_ID && message.channel !== HIGH_PAWS_CHANNEL_ID) return;

  // ---- High-Paws commands (message-based) ----
  // Supported:
  //   paws me
  //   paws top 3
  //   paws top 10
  //   paws all
  const raw = message.text.trim();
  const lower = raw.toLowerCase();

  const isPawsCommand =
    lower === "paws me" || lower === "paws all" || lower.startsWith("paws top ");

  if (isPawsCommand) {
    const reply = async (t) =>
      client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: t,
      });

    if (lower === "paws me") {
      const score = getScore(message.user);
      await reply(`🐾 You have *${score}* high-paws!`);
      return;
    }

    let limit = 3;

    if (lower === "paws all") {
      limit = 50; // safety cap; add pagination later if you want
    } else {
      // "paws top 10"
      const n = parseInt(lower.split(" ")[2], 10);
      if (!isNaN(n) && n > 0) limit = Math.min(n, 50);
    }

    const rows = getTop(limit);
    if (rows.length === 0) {
      await reply("🐾 No high-paws yet");
      return;
    }

    const lines = rows.map(
      (r, i) => `${i + 1}. <@${r.user_id}> — *${r.score}* 🐾`
    );

    await reply(`🐕‍🦺 *Top ${rows.length} High-Paws* 🐾\n${lines.join("\n")}`);
    return;
  }
  // ---- end commands ----

  // ---- High-Paws awarding ----
  const giverId = message.user;
  const text = message.text;

  // Must include a "++"
  if (!text.includes("++")) return;

  // Extract mentioned users like <@U123>
  const mentioned = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
  if (mentioned.length === 0) return;

  for (const receiverId of mentioned) {
    // NOTE: you temporarily allowed self-awards for testing by commenting this out.
    // Re-enable later:
    // if (receiverId === giverId) continue;

    const eventId = `${message.ts}:${receiverId}`;
    if (alreadyCounted(eventId)) continue;

    db.prepare(`
      INSERT INTO events (id, giver_id, receiver_id, channel_id, message_ts, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, giverId, receiverId, message.channel, message.ts, nowIso());

    const total = incrementScore(receiverId);

    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `🐾 High-paws for <@${receiverId}>! Total paws: *${total}* :bear:`,
    });
  }
});

(async () => {
  await app.start();
  console.log("🐾 High-Paws bot running");
})();
