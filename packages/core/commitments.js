#!/usr/bin/env node
/**
 * commitments.js — inferred follow-ups from owner messages.
 *
 * Distinct from:
 *   - `promise` (things the AGENT said it would do — already tracked by loop_scanner_v2)
 *   - markdown notes (durable observations)
 *
 * A commitment is an OWNER-side obligation that the agent should track and
 * follow up on without being told. Examples:
 *   - "ich hab morgen ein Interview"  → check in afterward, ask how it went
 *   - "wir haben am Donnerstag den Steuertermin"  → reminder day-of
 *   - "a partner sends feedback by Friday" -> check Friday
 *
 * Rules:
 *   - Detected by regex first, refined later with embedding-based scoring.
 *   - Each commitment has an `expected_followup_at` (best-effort parse).
 *   - At follow-up time, the agent should surface this via mem_commitment_due().
 *   - Owner can manually close via mem_commitment_close(id, outcome).
 */
"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";

// --------------------------------------------------------------------------
// Schema
// --------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS commitment (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_name           TEXT NOT NULL,
  origin_memory_id     INTEGER REFERENCES memory(id) ON DELETE CASCADE,
  text                 TEXT NOT NULL,
  category             TEXT,                                 -- meeting | interview | deadline | call | event | trip | other
  expected_followup_at TEXT,                                 -- when agent should check in
  detected_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  surfaced_at          TEXT,                                 -- when agent first surfaced it
  closed_at            TEXT,
  outcome              TEXT,                                 -- happened | postponed | cancelled | unknown
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'open',         -- open | surfaced | closed
  UNIQUE(origin_memory_id, text)
);
CREATE INDEX IF NOT EXISTS idx_commit_status ON commitment(status);
CREATE INDEX IF NOT EXISTS idx_commit_followup ON commitment(expected_followup_at);
`);

// --------------------------------------------------------------------------
// Detection patterns (simple V1 — refine with embeddings later)
// --------------------------------------------------------------------------
// Detection patterns. V1 is keyword-driven; refined over time as the agent
// records new categories via mem_skill_record-style learning. Add patterns
// freely — order matters (first match wins per row).
const PATTERNS = [
  { re: /\b(morgen|übermorgen|tomorrow)\b[^.]*\b(treffen|meeting|interview|gespräch|termin|call|anruf|essen|drink|abendessen|mittagessen|frühstück)\b/i, cat: "meeting" },
  { re: /\b(treffen|meeting|termin|call)\s*(mit|with)\s+\w+[^.]*\b(am|on|um)\b/i, cat: "meeting" },
  { re: /\b(interview|vorstellungsgespräch|pitch)\b[^.]*\b(morgen|am \w+|um \d+|nächste woche)\b/i, cat: "interview" },
  { re: /\b(steuertermin|deadline|abgabefrist|finanzamt|skatteverket|frist)\b[^.]*\b(am|bis|donnerstag|freitag|montag|dienstag|mittwoch|samstag|sonntag|\d{1,2}\.\d{1,2})\b/i, cat: "deadline" },
  { re: /\b(\w+)\s+(schickt|sendet|liefert|antwortet|bringt)\s+[^.]*\bbis\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|morgen|nächste woche|\d{1,2}\.\d{1,2})\b/i, cat: "deadline" },
  { re: /\b(geburtstag|birthday|hochzeit|wedding|jubiläum)\b[^.]*\b(am|on|nächst|next)\b/i, cat: "event" },
  { re: /\b(flug|flight|reise|trip|abflug|landing)\b[^.]*\b(am \w+|nächste woche|next week|morgen|um \d+)\b/i, cat: "trip" },
  { re: /\b(arzt|doctor|zahnarzt|untersuchung|operation)\b[^.]*\b(am \w+|morgen|um \d+)\b/i, cat: "meeting" },
  { re: /\b(prüfung|exam|test|klausur|abgabe)\b[^.]*\b(am \w+|morgen|nächste woche)\b/i, cat: "event" },
];

// Crude time-extractor: returns ISO string for "tomorrow morning" etc, else null.
function inferFollowupAt(text, occurredAt) {
  const base = new Date(occurredAt);
  const lower = text.toLowerCase();
  if (/\b(morgen|tomorrow)\b/.test(lower)) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(18, 0, 0, 0);
    return d.toISOString();
  }
  if (/\b(übermorgen|day after tomorrow)\b/.test(lower)) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + 2);
    d.setUTCHours(18, 0, 0, 0);
    return d.toISOString();
  }
  const dayMap = { montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 0,
                   monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
  for (const [w, n] of Object.entries(dayMap)) {
    if (new RegExp("\\b" + w + "\\b", "i").test(text)) {
      const d = new Date(base);
      const cur = d.getUTCDay();
      let diff = (n - cur + 7) % 7;
      if (diff === 0) diff = 7;
      d.setUTCDate(d.getUTCDate() + diff);
      d.setUTCHours(18, 0, 0, 0);
      return d.toISOString();
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Scanner
// --------------------------------------------------------------------------
function scan({ days = 7, limit = 500 } = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows = db.prepare(`
    SELECT id, occurred_at, text FROM memory
    WHERE actor=? AND kind='message' AND occurred_at > ?
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(OWNER_NAME, since, limit);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO commitment (owner_name, origin_memory_id, text, category, expected_followup_at)
    VALUES (?,?,?,?,?)
  `);

  let added = 0;
  for (const r of rows) {
    for (const p of PATTERNS) {
      if (!p.re.test(r.text)) continue;
      const followupAt = inferFollowupAt(r.text, r.occurred_at);
      const result = insert.run(OWNER_NAME, r.id, r.text.slice(0, 500), p.cat, followupAt);
      if (result.changes > 0) added++;
      break; // first match wins per row
    }
  }
  return { scanned: rows.length, added };
}

// --------------------------------------------------------------------------
// Due-now query
// --------------------------------------------------------------------------
function dueNow({ horizonHours = 6 } = {}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + horizonHours * 3600e3).toISOString();
  return db.prepare(`
    SELECT id, text, category, expected_followup_at, detected_at
    FROM commitment
    WHERE status='open' AND expected_followup_at IS NOT NULL AND expected_followup_at <= ?
    ORDER BY expected_followup_at ASC
  `).all(horizon);
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
if (require.main === module) {
  const action = process.argv[2] || "scan";
  if (action === "scan") {
    console.log("[commitments]", JSON.stringify(scan()));
  } else if (action === "due") {
    const due = dueNow();
    console.log(`${due.length} commitments due in next 6h:`);
    for (const c of due) console.log(`  #${c.id} ${c.expected_followup_at} [${c.category}] ${c.text.slice(0, 80)}`);
  } else if (action === "list") {
    const open = db.prepare("SELECT id, expected_followup_at, category, substr(text,1,80) preview FROM commitment WHERE status='open' ORDER BY detected_at DESC LIMIT 20").all();
    console.log(`${open.length} open commitments:`);
    for (const c of open) console.log(`  #${c.id} ${c.expected_followup_at || '?'} [${c.category}] ${c.preview}`);
  } else {
    console.error("usage: commitments.js scan | due | list");
    process.exit(2);
  }
  db.close();
}

module.exports = { scan, dueNow };
