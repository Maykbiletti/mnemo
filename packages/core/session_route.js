"use strict";
/**
 * session_route.js — per-session active-channel routing.
 *
 * Lets a single conversational session reroute its outbound messages to a
 * different channel mid-thread without losing context. Owner says
 * "/dock_whatsapp" and subsequent agent replies leave via the WhatsApp
 * adapter instead of Telegram, while the session itself + its memory rows
 * stay continuous.
 *
 * V1 stores the current route per session_id; full mid-thread switching
 * lands when the WSS-session layer ships in Phase 2 (BLUN Agent OS).
 * Until then the data model + MCP tool are in place so callers can already
 * record and read the route.
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS session_route (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  channel      TEXT NOT NULL,                            -- telegram | whatsapp | email | <future>
  recipient    TEXT NOT NULL,                            -- chat_id / phone / email
  set_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  set_by       TEXT,                                     -- 'owner' | 'agent' | 'system'
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_route_session ON session_route(session_id, set_at);
`);

function set({ session_id, channel, recipient, set_by = "owner", notes = null }) {
  const r = db.prepare(`
    INSERT INTO session_route (session_id, channel, recipient, set_by, notes)
    VALUES (?,?,?,?,?)
  `).run(session_id, channel, recipient, set_by, notes);
  return { id: r.lastInsertRowid, session_id, channel, recipient };
}

function current(session_id) {
  return db.prepare(`
    SELECT channel, recipient, set_at, set_by FROM session_route
    WHERE session_id = ?
    ORDER BY set_at DESC LIMIT 1
  `).get(session_id) || null;
}

function history(session_id, limit = 20) {
  return db.prepare(`
    SELECT channel, recipient, set_at, set_by, notes FROM session_route
    WHERE session_id = ?
    ORDER BY set_at DESC LIMIT ?
  `).all(session_id, Math.min(limit, 100));
}

module.exports = { set, current, history, db };
