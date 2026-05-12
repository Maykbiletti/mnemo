#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const SRC_FILE = process.argv[2];
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "Owner";
const OWNER_USER_ID = process.env.MNEMO_OWNER_USER_ID || "user_owner_1";

if (!SRC_FILE || !fs.existsSync(SRC_FILE)) {
  console.error("Usage: node backfill_telegram_export.js <path-to-result.json>");
  process.exit(1);
}

const SHARP = (s) => crypto.createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();

function flattenText(t) {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map(p => typeof p === "string" ? p : (p && p.text) || "").join("");
  return "";
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const data = JSON.parse(fs.readFileSync(SRC_FILE, "utf8"));
const chatId = data.id || "unknown";
const chatType = data.type || "unknown";
const chatName = data.name || "unknown";
const msgs = Array.isArray(data.messages) ? data.messages : [];

console.log(JSON.stringify({
  source: SRC_FILE,
  channel_id: chatId,
  chat_type: chatType,
  chat_name: chatName,
  total_messages: msgs.length,
  first_date: msgs[0] && msgs[0].date,
  last_date: msgs[msgs.length-1] && msgs[msgs.length-1].date
}));

const insertMem = db.prepare(`
  INSERT OR IGNORE INTO memory
    (kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta_json, hash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

let seen = 0, added = 0, skipped = 0, errors = 0, dup = 0;
const participants = new Set();
const tx = db.transaction(() => {
  for (const m of msgs) {
    seen++;
    try {
      if (!m || typeof m !== "object") { skipped++; continue; }
      const text = flattenText(m.text || m.text_entities || "").trim();
      if (!text) { skipped++; continue; }
      const occurred = m.date_unixtime
        ? new Date(parseInt(m.date_unixtime, 10) * 1000).toISOString()
        : (m.date ? new Date(m.date).toISOString() : nowIso());
      const isOwner = OWNER_USER_ID && m.from_id === OWNER_USER_ID;
      const actor = isOwner ? OWNER_NAME : (m.from || "unknown");
      participants.add(actor);
      const sourceRef = `tgexp:${chatId}:${m.id}`;
      const hash = SHARP(["message", sourceRef, occurred, text].join("|"));
      const meta = JSON.stringify({
        channel_id: chatId,
        chat_type: chatType,
        chat_name: chatName,
        msg_id: m.id,
        from: m.from,
        from_id: m.from_id
      });
      const r = insertMem.run(
        "message", "telegram", sourceRef, occurred,
        actor, m.from_id || null, null, isOwner ? 6 : 5,
        text, meta, hash
      );
      if (r.changes > 0) added++;
      else dup++;
    } catch (e) {
      errors++;
    }
  }
});
tx();
db.close();

console.log(JSON.stringify({
  seen, added, dup, skipped, errors,
  participants: [...participants],
  done: true
}));
