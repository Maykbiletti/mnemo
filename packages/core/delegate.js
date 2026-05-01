"use strict";
/**
 * delegate.js — agent identity + on-behalf-of relationship layer.
 *
 * Each Mnemo instance can host multiple agent identities. Each agent has its
 * own name, contact channels, and may act "on behalf of" one or more
 * principals (humans or other agents). The agent never impersonates the
 * principal — when sending, it signs as itself and references the principal.
 *
 * Use cases:
 *   - A single Mnemo runs personal-Mayk + work-Mayk + Felix + Rille agents.
 *     Each has its own SOUL + channel routing + delegated authority.
 *   - A team Mnemo where one agent is the "ops bot" acting on behalf of
 *     everyone in the team.
 *   - The same agent may have a different on-behalf-of when writing to
 *     different recipients ("on behalf of you" to your client, "on behalf
 *     of the company" to a vendor).
 *
 * V1: schema + helpers. Acting-on-behalf-of is a metadata tag on outbound
 * messages and skill executions; the channel adapters honor it when
 * formatting signatures.
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agent_identity (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,                     -- internal handle, e.g. 'dieter', 'felix', 'ops_bot'
  display_name TEXT NOT NULL,                            -- how it signs ("Dieter", "Felix")
  email        TEXT,                                     -- own contact email if any
  channels     TEXT,                                     -- JSON list of {channel, recipient} pairs the agent owns
  soul_path    TEXT,                                     -- optional path to a SOUL.md that overrides the global one
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status       TEXT NOT NULL DEFAULT 'active'            -- active | dormant | archived
);

CREATE TABLE IF NOT EXISTS delegation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name    TEXT NOT NULL REFERENCES agent_identity(name) ON DELETE CASCADE,
  principal     TEXT NOT NULL,                           -- name of person/org the agent acts for
  scope         TEXT NOT NULL,                           -- 'all' | 'comms' | 'finance' | comma-list of skill names
  granted_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    TEXT,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_deleg_agent ON delegation(agent_name);
CREATE INDEX IF NOT EXISTS idx_deleg_principal ON delegation(principal);
`);

function registerAgent({ name, display_name, email = null, channels = null, soul_path = null }) {
  const r = db.prepare(`
    INSERT OR IGNORE INTO agent_identity (name, display_name, email, channels, soul_path)
    VALUES (?,?,?,?,?)
  `).run(name, display_name, email, channels ? JSON.stringify(channels) : null, soul_path);
  return { id: r.lastInsertRowid || null, name, inserted: r.changes > 0 };
}

function listAgents({ active_only = true } = {}) {
  const where = active_only ? "WHERE status='active'" : "";
  return db.prepare(`SELECT name, display_name, email, channels, soul_path, status FROM agent_identity ${where} ORDER BY name`).all()
    .map(r => ({ ...r, channels: r.channels ? JSON.parse(r.channels) : [] }));
}

function grantDelegation({ agent_name, principal, scope = "all", notes = null }) {
  const r = db.prepare(`
    INSERT INTO delegation (agent_name, principal, scope, notes)
    VALUES (?,?,?,?)
  `).run(agent_name, principal, scope, notes);
  return { id: r.lastInsertRowid, agent_name, principal, scope };
}

function revokeDelegation(id) {
  db.prepare("UPDATE delegation SET revoked_at=? WHERE id=?")
    .run(new Date().toISOString(), id);
  return { id, revoked: true };
}

function activeDelegations({ agent_name, principal } = {}) {
  const where = ["revoked_at IS NULL"];
  const params = [];
  if (agent_name) { where.push("agent_name=?"); params.push(agent_name); }
  if (principal) { where.push("principal=?"); params.push(principal); }
  return db.prepare(
    `SELECT id, agent_name, principal, scope, granted_at, notes
     FROM delegation WHERE ${where.join(" AND ")} ORDER BY granted_at DESC`
  ).all(...params);
}

function formatSignature({ agent_name, principal = null }) {
  const a = db.prepare("SELECT display_name FROM agent_identity WHERE name=?").get(agent_name);
  if (!a) return agent_name;
  if (principal) return `${a.display_name} (im Auftrag von ${principal})`;
  return a.display_name;
}

module.exports = {
  registerAgent,
  listAgents,
  grantDelegation,
  revokeDelegation,
  activeDelegations,
  formatSignature,
  db,
};
