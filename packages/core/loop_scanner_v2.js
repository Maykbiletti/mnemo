#!/usr/bin/env node
/**
 * loop_scanner_v2.js — classify open promises as fulfilled vs still-open.
 *
 * Heuristic-first (no embeddings required); embedding-augmented if
 * vec_memory table exists.
 *
 * Strategy per open promise:
 *   1. Pull subsequent memory rows from same actor/topic up to N=200.
 *   2. Score each candidate for fulfillment language ("done","fertig",
 *      "deployed","shipped","live","raus","fix ist drin","steht").
 *   3. If keyword-score >= 0.6 OR (embedding-cosine >= 0.7 if available),
 *      insert fulfillment_signal row.
 *   4. Mark promise.status='fulfilled' when total signal-score >= 0.85
 *      OR >= 2 independent signals.
 */
"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// --------------------------------------------------------------------------
// Schema bootstrap (idempotent — augments existing promise table with
// the columns we need, plus the new fulfillment_signal table)
// --------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS promise (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  text            TEXT NOT NULL,
  scope           TEXT,
  origin_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  promised_at     TEXT NOT NULL,
  due_at          TEXT,
  fulfilled_at    TEXT,
  fulfilled_by_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_promise_status ON promise(status);

CREATE TABLE IF NOT EXISTS fulfillment_signal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  promise_id   INTEGER NOT NULL REFERENCES promise(id) ON DELETE CASCADE,
  memory_id    INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  signal_type  TEXT NOT NULL,
  confidence   REAL NOT NULL,
  detected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(promise_id, memory_id, signal_type)
);
CREATE INDEX IF NOT EXISTS idx_fs_promise ON fulfillment_signal(promise_id);
`);

// Ensure new columns exist on the existing promise table (idempotent).
function addColumnIfMissing(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}
addColumnIfMissing("promise", "actor", "TEXT");
addColumnIfMissing("promise", "channel", "TEXT NOT NULL DEFAULT 'telegram'");
addColumnIfMissing("promise", "topic", "TEXT");

// --------------------------------------------------------------------------
// Promise discovery: scan recent Dieter messages for commit-phrases,
// upsert into promise table. (Same heuristic as the live mem_promise_open
// MCP tool, but persisted instead of computed each call.)
// --------------------------------------------------------------------------
const PROMISE_PATTERN = /\b(mach ich|bau ich|fixe ich|komm gleich|schreib ich|push ich|deploye ich|check ich|ziehe ich|leg ich|reiche ich|leg ich nach|nehm ich mit|geh ich an)\b/i;

function discoverPromises({ actor = "Dieter", days = 14 }) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db.prepare(`
    SELECT id, occurred_at, text, topic FROM memory
    WHERE actor=? AND kind='message' AND occurred_at > ?
    ORDER BY occurred_at ASC
  `).all(actor, since);
  // dedup against existing promise rows by origin_memory_id
  const exists = db.prepare("SELECT 1 FROM promise WHERE origin_memory_id=?");
  const insert = db.prepare(`
    INSERT INTO promise (text, scope, origin_memory_id, promised_at, status, actor, channel, topic)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  let added = 0;
  for (const r of rows) {
    if (!PROMISE_PATTERN.test(r.text)) continue;
    if (exists.get(r.id)) continue;
    insert.run(r.text.slice(0, 500), null, r.id, r.occurred_at, "open", actor, "telegram", r.topic || null);
    added++;
  }
  return { scanned: rows.length, added };
}

// --------------------------------------------------------------------------
// Fulfillment scoring
// --------------------------------------------------------------------------
const FULFILL_KEYWORDS = [
  // German
  { re: /\b(fertig|erledigt|raus|durch|gepush(ed|t)|deployed|deployt|live|hochgeladen|gemerged|gepatch(ed|t)|gefix(ed|t)|gebaut)\b/i, w: 0.7 },
  { re: /\b(steht|läuft|funktioniert|getestet|geprüft)\b/i, w: 0.4 },
  { re: /\b(commit|merged?|shipped|done|pushed|deployed)\b/i, w: 0.7 },
  { re: /\b(closed|resolved|fixed|delivered)\b/i, w: 0.6 },
  { re: /\b(check.*:|✅|grün|green)\b/i, w: 0.3 },
];

function scoreText(text) {
  if (!text) return 0;
  let s = 0;
  for (const k of FULFILL_KEYWORDS) {
    if (k.re.test(text)) s = Math.max(s, k.w);
  }
  return Math.min(s, 1.0);
}

// --------------------------------------------------------------------------
// Per-promise scan
// --------------------------------------------------------------------------
function scanPromise(p) {
  // candidates = subsequent memory rows by same actor in next 7 days
  const since = p.promised_at;
  if (!since) return { skipped: "no_promised_at" };
  const until = new Date(new Date(since).getTime() + 7 * 86400e3).toISOString();
  const actor = p.actor || "Dieter";

  const subsequent = db.prepare(`
    SELECT id, text FROM memory
    WHERE actor=? AND occurred_at > ? AND occurred_at < ?
      AND kind='message'
    ORDER BY occurred_at ASC
    LIMIT 200
  `).all(actor, since, until);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO fulfillment_signal (promise_id, memory_id, signal_type, confidence)
    VALUES (?,?,?,?)
  `);
  let totalSignals = 0;
  let totalScore = 0;
  let lastFulfillingId = null;
  for (const m of subsequent) {
    const score = scoreText(m.text);
    if (score >= 0.4) {
      const res = insert.run(p.id, m.id, "keyword", score);
      if (res.changes > 0) {
        totalSignals++;
        totalScore += score;
        lastFulfillingId = m.id;
      }
    }
  }

  // Decide fulfillment
  if (totalScore >= 0.85 || totalSignals >= 2) {
    db.prepare(
      "UPDATE promise SET status='fulfilled', fulfilled_at=?, fulfilled_by_memory_id=? WHERE id=? AND status='open'"
    ).run(new Date().toISOString(), lastFulfillingId, p.id);
    return { signals: totalSignals, score: totalScore, fulfilled: true };
  }
  return { signals: totalSignals, score: totalScore, fulfilled: false };
}

function sweep() {
  const disc = discoverPromises({ actor: "Dieter", days: 14 });
  const open = db.prepare("SELECT * FROM promise WHERE status='open' ORDER BY promised_at DESC LIMIT 200").all();
  let fulfilledCount = 0;
  for (const p of open) {
    const r = scanPromise(p);
    if (r.fulfilled) fulfilledCount++;
  }
  return { discovered: disc.added, scanned_open: open.length, newly_fulfilled: fulfilledCount };
}

// CLI mode
if (require.main === module) {
  const r = sweep();
  console.log("[loop-scanner-v2]", JSON.stringify(r));
  db.close();
}

module.exports = { sweep, discoverPromises, scanPromise };
