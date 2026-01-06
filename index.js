import { App } from "@slack/bolt";
import Database from "better-sqlite3";

const PLUSPLUS_CHANNEL_ID = process.env.PLUSPLUS_CHANNEL_ID;

const db = new Database("plusplus.sqlite");
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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

function nowIso() {
  return new Date().toISOString();
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

app.message(async ({ message, client }) => {
  if (!message.text || message.subtype) return;

  // Only count in the ++ channel
  if (PLUSPLUS_CHANNEL_ID && message.channel !== PLUSPLUS_CHANNEL_ID) return;

  const giverId = message.user;
  const text = message.text;

  // Must include a ++ token somewhere
  if (!text.includes("++")) return;

  // Extract mentioned users like <@U123>
  const mentioned = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map(m => m[1]);
  if (mentioned.length === 0) return;

  // Award exactly +1 per mentioned user (in this message)
  for (const receiverId of mentioned) {
   // if (receiverId === giverId) continue; // no self-awards

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

app.command("/kudos", async ({ command, ack, respond }) => {
  await ack();

  const text = command.text.trim();

  // Default: top 3
  let limit = 3;

  if (text.startsWith("top")) {
    const n = parseInt(text.split(" ")[1], 10);
    if (!isNaN(n)) limit = n;
  }

  if (text === "all") {
    limit = 100; // safety cap
  }

  if (text === "me") {
    const row = db
      .prepare("SELECT score FROM scores WHERE user_id=?")
      .get(command.user_id);

    const score = row?.score ?? 0;

    await respond({
      response_type: "ephemeral",
      text:'🐾 You have *${score}* high-paws!'
    });
    return;
  }

  const rows = db.prepare(`
    SELECT user_id, score
    FROM scores
    ORDER BY score DESC
    LIMIT ?
  `).all(limit);

  if (rows.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: "No ++ recorded yet.",
    });
    return;
  }

  const lines = rows.map(
    (r, i) => `${i + 1}. <@${r.user_id}> — *${r.score}* ++ 🐾`
  );

  await respond({
    response_type: "ephemeral",
    text: `🏆 *Top ${rows.length}*\n` + lines.join("\n"),
  });
});


(async () => {
  await app.start();
  console.log("++ bot running");
})();
