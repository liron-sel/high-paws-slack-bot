import fs from "node:fs";
import { App } from "@slack/bolt";
import Database from "better-sqlite3";

const DB_PATH = "/data/high-paws.sqlite";
const HIGH_PAWS_CHANNEL_ID = process.env.HIGH_PAWS_CHANNEL_ID;
const HIGH_PAWS_ADMIN_USER_ID = process.env.HIGH_PAWS_ADMIN_USER_ID;

// Persist DB on Render disk
// ✅ THEN LOG
console.log("🐾 DB_PATH =", DB_PATH);
console.log("🐾 DB exists?", fs.existsSync(DB_PATH));
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

function decrementScore(userId) {
  const row = db.prepare("SELECT score FROM scores WHERE user_id=?").get(userId);
  const next = Math.max((row?.score ?? 0) - 1, 0);

  db.prepare(`
    INSERT INTO scores (user_id, score, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET score=excluded.score, updated_at=excluded.updated_at
  `).run(userId, next, nowIso());

  return next;
}

function getFirstMention(text) {
  const match = text.match(/<@([A-Z0-9]+)>/);
  return match ? match[1] : null;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN, // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN, // xapp-...
  socketMode: true,
});

// Slash command: /highpaws [me|all|top 3]
app.command("/highpaws", async ({ command, ack, respond }) => {
  // Always ack immediately to avoid dispatch_failed/timeouts
  await ack();

  const text = (command.text || "").trim().toLowerCase();

  // /highpaws me
  if (text === "me") {
    const score = getScore(command.user_id);
    await respond({
      response_type: "ephemeral",
      text: `🐾 You have *${score}* high-paws!`,
    });
    return;
  }

  // /highpaws all  -> show up to 50 (safety cap)
  if (text === "all") {
    const rows = getTop(50);
    if (rows.length === 0) {
      await respond({
        response_type: "ephemeral",
        text: "🐾 No high-paws yet",
      });
      return;
    }

    const lines = rows.map(
      (r, i) => `${i + 1}. <@${r.user_id}> — *${r.score}* 🐾`
    );

    await respond({
      response_type: "ephemeral",
      text: `*All High-Paws* 🐾 (showing ${rows.length})\n${lines.join("\n")}`,
    });
    return;
  }

  // Default: top 3 (supports "/highpaws" or "/highpaws top 3")
  let limit = 3;
  if (text.startsWith("top")) {
    const n = parseInt(text.split(/\s+/)[1], 10);
    if (!isNaN(n) && n > 0) limit = Math.min(n, 50);
  } else if (text !== "") {
    // Unknown arg
    await respond({
      response_type: "ephemeral",
      text: "Try `/highpaws me`, `/highpaws top 3`, or `/highpaws all`.",
    });
    return;
  }

  const rows = getTop(limit);
  if (rows.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: "🐾 No high-paws yet",
    });
    return;
  }

  const lines = rows.map(
    (r, i) => `${i + 1}. <@${r.user_id}> — *${r.score}* 🐾`
  );

  await respond({
    response_type: "ephemeral",
    text: `*Top ${rows.length} High-Paws* 🐾\n${lines.join("\n")}`,
  });
});

app.message(async ({ message, client }) => {
  // Helpful runtime visibility in Render logs
  console.log("EVENT message:", {
    channel: message.channel,
    user: message.user,
    text: message.text,
    ts: message.ts,
  });

  if (!message.text) return;

  const isEdited =
    message.subtype === "message_changed" && message.message && message.message.text;
  const isFileShare = message.subtype === "file_share";
  if (message.subtype && !isEdited && !isFileShare) return;

  // Only operate inside the High-Paws channel
  if (HIGH_PAWS_CHANNEL_ID && message.channel !== HIGH_PAWS_CHANNEL_ID) return;

  // ---- High-Paws awarding ----
  const giverId = isEdited ? message.message.user : message.user;
  const text = isEdited ? message.message.text : (message.text || "");
  const messageTs = isEdited ? message.message.ts : message.ts;

  // Only count when ++ is directly before/after a mention (optional space).
  const matchedMentions = [
    ...text.matchAll(/(?:\+\+\s*<@([A-Z0-9]+)>|<@([A-Z0-9]+)>\s*\+\+)/g),
  ].map((m) => m[1] || m[2]);
  if (matchedMentions.length === 0) return;

  for (const receiverId of matchedMentions) {
    // NOTE: you temporarily allowed self-awards for testing by commenting this out.
    // Re-enable later:
     if (receiverId === giverId) continue;

    const eventId = `${messageTs}:${receiverId}`;
    if (alreadyCounted(eventId)) continue;

    db.prepare(`
      INSERT INTO events (id, giver_id, receiver_id, channel_id, message_ts, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receiverId ? eventId : eventId, giverId, receiverId, message.channel, messageTs, nowIso());

    const total = incrementScore(receiverId);

    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: messageTs,
      text: `🐾 High-paws for <@${receiverId}>! Total paws: *${total}* :bear:`,
    });
  }
});

app.event("reaction_added", async ({ event, client }) => {
  console.log("EVENT reaction_added:", event);
  if (event.reaction !== "point_down") return;
  if (!HIGH_PAWS_ADMIN_USER_ID || event.user !== HIGH_PAWS_ADMIN_USER_ID) return;
  if (HIGH_PAWS_CHANNEL_ID && event.item.channel !== HIGH_PAWS_CHANNEL_ID) return;
  if (event.item.type !== "message") return;

  const replies = await client.conversations.replies({
    channel: event.item.channel,
    ts: event.item.ts,
    inclusive: true,
    limit: 1,
  });

  const target = replies.messages?.[0];
  console.log("reaction target:", target);
  if (!target || (!target.bot_id && target.subtype !== "bot_message")) return;
  if (!target.text) return;

  const receiverId = getFirstMention(target.text);
  if (!receiverId) return;

  const eventId = `undo:${event.item.ts}:${receiverId}`;
  if (alreadyCounted(eventId)) return;

  db.prepare(`
    INSERT INTO events (id, giver_id, receiver_id, channel_id, message_ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eventId, event.user, receiverId, event.item.channel, event.item.ts, nowIso());

  const total = decrementScore(receiverId);
  const threadTs = target.thread_ts || target.ts;

  await client.chat.postMessage({
    channel: event.item.channel,
    thread_ts: threadTs,
    text: `Tiny correction for <@${receiverId}>: adjusted paws, Total paws: *${total}* :bear:`,
  });
});

(async () => {
  await app.start();
  console.log("🐾 High-Paws bot running");
})();
