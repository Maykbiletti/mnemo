#!/usr/bin/env node
/**
 * Mnemo Daemon — always-on PM2 service that:
 *   1. Polls Telegram Bot API directly (independent of editor hooks)
 *   2. Exposes HTTP /ingest endpoint so any agent on any server can POST events
 *   3. Runs daily reflection cycle at 23:00 local
 *   4. Health-check every 5 min — updates writer_health table
 *   5. Watches /root/mnemo/sources/ for new files (e.g. dropped session jsonl)
 *
 * Listens on localhost:7117 by default. Tailscale-IP for cross-server agents.
 *
 * Env:
 *   MNEMO_DB             default /root/mnemo/mnemo.db
 *   MNEMO_HTTP_PORT      default 7117
 *   MNEMO_HTTP_HOST      default 0.0.0.0
 *   TELEGRAM_BOT_TOKEN   required for Telegram poller
 *   OWNER_CHAT_ID         optional, restrict ingest to this chat
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Strip <private>...</private> blocks from text before persisting. Owner can
// mark sensitive snippets in any inbound content (briefs, wishes, transcripts,
// mem_add). The marker survives display in the original message but never
// reaches the SQLite store. Multiline + case-insensitive. Returns a tuple-ish
// { text, hadPrivate } so callers can decide whether to flag the row.
function stripPrivate(text) {
  if (typeof text !== "string" || !text) return { text, hadPrivate: false };
  const re = /<private>[\s\S]*?<\/private>/gi;
  if (!re.test(text)) return { text, hadPrivate: false };
  return { text: text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]"), hadPrivate: true };
}
const crypto = require("crypto");
const zlib = require("zlib");
const Database = require("better-sqlite3");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const PORT = parseInt(process.env.MNEMO_HTTP_PORT || "7117", 10);
const HOST = process.env.MNEMO_HTTP_HOST || "127.0.0.1";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const OWNER_CHAT_ID = process.env.MNEMO_OWNER_CHAT_ID || process.env.OWNER_CHAT_ID || null;
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";
const TG_OFFSET_FILE = process.env.MNEMO_TG_OFFSET_FILE || path.join(__dirname, ".tg_offset");
const TZ_OFFSET_HOURS = parseInt(process.env.MNEMO_TZ_OFFSET_HOURS || "0", 10);
const QUIET_START = parseInt(process.env.MNEMO_QUIET_START || "23", 10);
const QUIET_END = parseInt(process.env.MNEMO_QUIET_END || "7", 10);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
// Mnemo Connect schema bootstrap (idempotent)
db.exec(`
CREATE TABLE IF NOT EXISTS agent_brief (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, source_agent TEXT,
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at TEXT, done_at TEXT, outcome TEXT, meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_brief_agent_status ON agent_brief(agent_name, status);
CREATE TABLE IF NOT EXISTS agent_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT,
  result_json TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  latency_ms INTEGER,
  session_id TEXT,
  topic TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_agent_started ON agent_action(agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_kind ON agent_action(action_kind);
CREATE INDEX IF NOT EXISTS idx_action_topic ON agent_action(topic);

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_name TEXT PRIMARY KEY, display_name TEXT, host TEXT, pid INTEGER, skills_json TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json TEXT
);
CREATE TABLE IF NOT EXISTS channel (
  name TEXT PRIMARY KEY, description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS channel_subscription (
  channel_name TEXT NOT NULL REFERENCES channel(name) ON DELETE CASCADE,
  agent_name TEXT NOT NULL REFERENCES agent_registry(agent_name) ON DELETE CASCADE,
  subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_name, agent_name)
);
`);
try {
  const cols = db.prepare("PRAGMA table_info(agent_brief)").all().map(c => c.name);
  if (!cols.includes("channel")) db.exec("ALTER TABLE agent_brief ADD COLUMN channel TEXT");
  if (!cols.includes("parent_id")) db.exec("ALTER TABLE agent_brief ADD COLUMN parent_id INTEGER");
  if (!cols.includes("supersedes_id")) db.exec("ALTER TABLE agent_brief ADD COLUMN supersedes_id INTEGER");
  if (!cols.includes("superseded_by_id")) db.exec("ALTER TABLE agent_brief ADD COLUMN superseded_by_id INTEGER");
  const rcols = db.prepare("PRAGMA table_info(agent_registry)").all().map(c => c.name);
  if (!rcols.includes("notify_webhook")) db.exec("ALTER TABLE agent_registry ADD COLUMN notify_webhook TEXT");
  if (!rcols.includes("notify_telegram_chat")) db.exec("ALTER TABLE agent_registry ADD COLUMN notify_telegram_chat TEXT");
  if (!rcols.includes("peer_endpoint")) db.exec("ALTER TABLE agent_registry ADD COLUMN peer_endpoint TEXT");
  if (!rcols.includes("idle_after_min")) db.exec("ALTER TABLE agent_registry ADD COLUMN idle_after_min INTEGER");
  // Phase 1: agent_proposal
  db.exec("CREATE TABLE IF NOT EXISTS agent_proposal (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, idea TEXT NOT NULL, project TEXT, project_fit TEXT, user_fit TEXT, cost TEXT, score INTEGER, ship_eligible INTEGER DEFAULT 0, status TEXT DEFAULT 'queued', reason TEXT, brief_id INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), shipped_at TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_agent_status ON agent_proposal(agent_name, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposal_score ON agent_proposal(score DESC)");
  // Phase 2: project_state_snapshot
  db.exec("CREATE TABLE IF NOT EXISTS project_state_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshot_project_kind ON project_state_snapshot(project, kind, created_at DESC)");
  // Phase 3: idle_loop config
  db.exec("CREATE TABLE IF NOT EXISTS agent_idle_config (agent_name TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, interval_min INTEGER DEFAULT 30, last_cycle_at TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  // Phase 4: agent_mode (vacation gate)
  db.exec("CREATE TABLE IF NOT EXISTS agent_mode (agent_name TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'active', until TEXT, digest_chat_id TEXT, last_digest_at TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE TABLE IF NOT EXISTS skill_outcome (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_name TEXT NOT NULL, proposal_id INTEGER, brief_id INTEGER, reaction TEXT, metric_json TEXT, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_outcome_skill ON skill_outcome(skill_name, recorded_at DESC)");
  // Phase 6: agent_project + shared_task
  db.exec("CREATE TABLE IF NOT EXISTS agent_project (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, owner_agent TEXT NOT NULL, goal_text TEXT, status TEXT DEFAULT 'active', current_milestone TEXT, blocker TEXT, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_project_owner_status ON agent_project(owner_agent, status)");
  db.exec("CREATE TABLE IF NOT EXISTS shared_task (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, title TEXT NOT NULL, description TEXT, claim_agent TEXT, status TEXT DEFAULT 'open', priority TEXT DEFAULT 'M', skills_required TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), claimed_at TEXT, done_at TEXT, blocker_reason TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_status ON shared_task(status, priority)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_project ON shared_task(project_id, status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_claim ON shared_task(claim_agent, status)");
  // Phase 6 Sprint 2: watchdog + escalation
  db.exec("CREATE TABLE IF NOT EXISTS watchdog (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, check_kind TEXT NOT NULL DEFAULT 'http', owner_agent TEXT, threshold_json TEXT, enabled INTEGER DEFAULT 1, last_check_at TEXT, last_status TEXT, consecutive_failures INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_watchdog_enabled ON watchdog(enabled)");
  db.exec("CREATE TABLE IF NOT EXISTS watchdog_incident (id INTEGER PRIMARY KEY AUTOINCREMENT, watchdog_id INTEGER NOT NULL, opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), closed_at TEXT, status TEXT DEFAULT 'open', notes TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS escalation (id INTEGER PRIMARY KEY AUTOINCREMENT, source_agent TEXT, kind TEXT, urgency TEXT DEFAULT 'M', summary TEXT, requested_authority TEXT, status TEXT DEFAULT 'open', resolution TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), resolved_at TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_escalation_status ON escalation(status, urgency)");
  // Phase 6 Sprint 3: rename active→autonomous (idempotent)
  try { db.exec("UPDATE agent_mode SET mode = 'autonomous' WHERE mode = 'active'"); } catch (e) {}
  // Phase 7: open_problem + problem_attempt + peer_consult + meeting
  db.exec("CREATE TABLE IF NOT EXISTS open_problem (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, project_id INTEGER, status TEXT DEFAULT 'open', severity TEXT DEFAULT 'M', owner_agent TEXT, opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), solved_at TEXT, resolution TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS problem_attempt (id INTEGER PRIMARY KEY AUTOINCREMENT, problem_id INTEGER NOT NULL, agent_name TEXT NOT NULL, approach TEXT, outcome TEXT, failure_reason TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_problem_status ON open_problem(status, severity)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attempt_problem ON problem_attempt(problem_id, created_at DESC)");
  db.exec("CREATE TABLE IF NOT EXISTS peer_consult (id INTEGER PRIMARY KEY AUTOINCREMENT, source_agent TEXT NOT NULL, target_agent TEXT NOT NULL, question TEXT NOT NULL, context TEXT, response TEXT, status TEXT DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), answered_at TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_consult_target ON peer_consult(target_agent, status)");
  db.exec("CREATE TABLE IF NOT EXISTS meeting (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, project_id INTEGER, problem_id INTEGER, status TEXT DEFAULT 'open', created_by TEXT, decision_summary TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), closed_at TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS meeting_turn (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id INTEGER NOT NULL, agent_name TEXT NOT NULL, content TEXT, turn_kind TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_meeting_turn ON meeting_turn(meeting_id, created_at)");
  // Phase 7 #4: codex_consult — programming-specialist queue
  db.exec("CREATE TABLE IF NOT EXISTS codex_consult (id INTEGER PRIMARY KEY AUTOINCREMENT, requesting_agent TEXT NOT NULL, problem_id INTEGER, question TEXT NOT NULL, context_files TEXT, proposed_solution TEXT, used_in_attempt_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), answered_at TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_codex_status ON codex_consult(status, created_at DESC)");
  // Phase 8 #1: transcript — verbatim episodic log of every interaction (telegram inbound/outbound, briefs, decisions)
  db.exec("CREATE TABLE IF NOT EXISTS transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, channel TEXT, direction TEXT NOT NULL, speaker TEXT, content TEXT NOT NULL, meta_json TEXT, occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ref_kind TEXT, ref_id TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_transcript_occurred ON transcript(occurred_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_transcript_speaker ON transcript(speaker, occurred_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_transcript_source_channel ON transcript(source, channel, occurred_at DESC)");
  db.exec("CREATE TABLE IF NOT EXISTS agent_brief_reaction (id INTEGER PRIMARY KEY AUTOINCREMENT, brief_id INTEGER NOT NULL, agent_name TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_reaction_brief ON agent_brief_reaction(brief_id)");
  // FTS5 virtual table for cross-source search (briefs + actions + memory)
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mnemo_search_fts USING fts5(scope, ref_id UNINDEXED, agent_name, summary, content, tokenize='porter unicode61')");
  // Backfill briefs into FTS if empty
  try {
    const fts_count = db.prepare("SELECT COUNT(*) c FROM mnemo_search_fts").get().c;
    if (fts_count === 0) {
      const briefs = db.prepare("SELECT id, agent_name, source_agent, content FROM agent_brief").all();
      const ins = db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('brief', ?, ?, ?, ?)");
      const t = db.transaction(rows => { for (const r of rows) ins.run(String(r.id), r.agent_name || '', r.source_agent || '', (r.content || '').slice(0, 8000)); });
      t(briefs);
      console.log("[migrate] FTS5 backfilled with " + briefs.length + " briefs");
    }
  } catch (e) { console.error("[migrate-fts-backfill]", e.message); }
  // Phase 8 #2: backfill transcripts into FTS (idempotent — only if scope='transcript' empty)
  try {
    const tCount = db.prepare("SELECT COUNT(*) c FROM mnemo_search_fts WHERE scope='transcript'").get().c;
    if (tCount === 0) {
      const tranRows = db.prepare("SELECT id, source, channel, direction, speaker, content FROM transcript").all();
      const ins = db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)");
      const t = db.transaction(rows => { for (const r of rows) ins.run(String(r.id), r.speaker || r.source || '', r.direction + (r.channel ? ' @ ' + r.channel : ''), (r.content || '').slice(0, 8000)); });
      t(tranRows);
      if (tranRows.length) console.log("[migrate] FTS5 backfilled with " + tranRows.length + " transcripts");
    }
  } catch (e) { console.error("[migrate-transcript-fts-backfill]", e.message); }
  // Phase-3 #4 Auto-Backfill: incremental FTS catch-up. Runs on every daemon
  // start, idempotent. Catches rows inserted via raw SQL or imports that
  // bypassed the normal hooks.
  try {
    const briefMissing = db.prepare("SELECT b.id, b.agent_name, b.source_agent, b.content FROM agent_brief b LEFT JOIN mnemo_search_fts f ON f.scope='brief' AND f.ref_id=CAST(b.id AS TEXT) WHERE f.rowid IS NULL").all();
    if (briefMissing.length) {
      const ins = db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('brief', ?, ?, ?, ?)");
      for (const r of briefMissing) ins.run(String(r.id), r.agent_name || "", r.source_agent || "", (r.content || "").slice(0, 8000));
      console.log("[migrate] auto-backfill brought " + briefMissing.length + " briefs into FTS");
    }
    const transcriptMissing = db.prepare("SELECT t.id, t.speaker, t.source, t.direction, t.channel, t.content FROM transcript t LEFT JOIN mnemo_search_fts f ON f.scope='transcript' AND f.ref_id=CAST(t.id AS TEXT) WHERE f.rowid IS NULL").all();
    if (transcriptMissing.length) {
      const ins = db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)");
      for (const r of transcriptMissing) ins.run(String(r.id), r.speaker || r.source || "", (r.direction || "") + (r.channel ? " @ " + r.channel : ""), (r.content || "").slice(0, 8000));
      console.log("[migrate] auto-backfill brought " + transcriptMissing.length + " transcripts into FTS");
    }
  } catch (e) { console.error("[migrate-auto-backfill]", e.message); }
  // Brief templates
  db.exec("CREATE TABLE IF NOT EXISTS brief_template (name TEXT PRIMARY KEY, body_template TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  // Seed default templates if empty
  try {
    if (db.prepare("SELECT COUNT(*) c FROM brief_template").get().c === 0) {
      const seed = db.prepare("INSERT INTO brief_template (name, body_template, description) VALUES (?,?,?)");
      seed.run("patch-delta", "# Brief PATCH-DELTA — {{file}}\n\n{{diffs}}\n\n## Test-Hinweis\n{{test_hint}}\n", "diff-style file patch with test hint");
      seed.run("file-drop", "# Brief — {{title}}\n\n=== FILE: {{path}} ===\n{{content}}\n=== END FILE ===\n", "single file drop wrapper");
      seed.run("status-update", "# {{topic}} — {{date}}\n\nStatus: {{status}}\n\n{{notes}}\n", "lightweight status report");
      seed.run("question", "# Frage an {{recipient}}\n\n{{question}}\n\nKontext: {{context}}\n", "structured question");
    }
  } catch (e) { console.error("[migrate-template-seed]", e.message); }
  db.exec("CREATE TABLE IF NOT EXISTS skill_registry (name TEXT PRIMARY KEY, description TEXT, trigger_phrases TEXT, sandbox TEXT DEFAULT 'none', requires_confirmation INTEGER DEFAULT 0, sensitive_data TEXT, body TEXT, source_path TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE TABLE IF NOT EXISTS skill_invocation (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_name TEXT NOT NULL, agent_name TEXT, input TEXT, output TEXT, exit_code INTEGER, duration_ms INTEGER, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT, status TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_invoc_skill ON skill_invocation(skill_name, started_at DESC)");
  // #17 hierarchical layers on memory
  const mcols = db.prepare("PRAGMA table_info(memory)").all().map(c => c.name);
  if (!mcols.includes("layer")) {
    db.exec("ALTER TABLE memory ADD COLUMN layer TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory(layer)");
    // backfill: derive layer from kind
    db.exec("UPDATE memory SET layer = CASE WHEN kind IN ('tool_call','ssh_cmd','web_fetch','skill','skill_run') THEN 'procedural' WHEN kind IN ('memory_md','decision','scar','manual','dream') THEN 'semantic' WHEN kind IN ('message','edit') THEN 'episodic' ELSE 'episodic' END WHERE layer IS NULL");
    console.log("[migrate] memory.layer added + backfilled");
  }
} catch (e) { console.error("[migrate]", e.message); }

// Auto-load skills from /root/mnemo/packages/core/skills/*/SKILL.md on startup
try {
  const skillsDir = path.join(__dirname, "skills");
  if (fs.existsSync(skillsDir)) {
    const dirs = fs.readdirSync(skillsDir).filter(d => {
      try { return fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, "SKILL.md")); } catch { return false; }
    });
    const upsert = db.prepare("INSERT INTO skill_registry (name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, body, source_path, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET description=excluded.description, trigger_phrases=excluded.trigger_phrases, sandbox=excluded.sandbox, requires_confirmation=excluded.requires_confirmation, sensitive_data=excluded.sensitive_data, body=excluded.body, source_path=excluded.source_path, status=excluded.status, updated_at=excluded.updated_at");
    for (const dname of dirs) {
      try {
        const fp = path.join(skillsDir, dname, "SKILL.md");
        const text = fs.readFileSync(fp, "utf8");
        const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
        if (!fm) continue;
        const meta = {};
        for (const raw of fm[1].split(/\n/)) {
          const line = raw.trim(); if (!line || line.startsWith("#")) continue;
          const idx = line.indexOf(":"); if (idx < 0) continue;
          const k = line.slice(0,idx).trim(); let v = line.slice(idx+1).trim();
          if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1,-1).split(",").map(x=>x.trim().replace(/^['"]|['"]$/g,"")).filter(Boolean);
          else if (v === "true") v = true; else if (v === "false") v = false;
          else if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1,-1);
          meta[k] = v;
        }
        const body = fm[2];
        const triggers = Array.isArray(meta.trigger_phrases) ? meta.trigger_phrases : [];
        // Also handle YAML list block: lines starting with -
        if (!triggers.length) {
          const tpMatch = fm[1].match(/trigger_phrases:\s*\n((?:\s*-\s+.+\n?)+)/);
          if (tpMatch) for (const ln of tpMatch[1].split(/\n/)) {
            const m = ln.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/); if (m) triggers.push(m[1]);
          }
        }
        const sensitive = Array.isArray(meta.sensitive_data) ? meta.sensitive_data : [];
        upsert.run(meta.name || dname, meta.description || "", JSON.stringify(triggers), meta.sandbox || "none", meta.requires_confirmation ? 1 : 0, JSON.stringify(sensitive), body, fp, meta.status || "active");
      } catch (e) { console.error("[skill-load]", dname, e.message); }
    }
    const cnt = db.prepare("SELECT COUNT(*) c FROM skill_registry").get().c;
    console.log("[skills] " + cnt + " skills in registry");
  }
} catch (e) { console.error("[skills-init]", e.message); }
db.pragma("synchronous = NORMAL");

// ---------- Multi-tenant pool ----------
// Each tenant gets its own SQLite file at TENANT_ROOT/<id>/mnemo.db
// Pool keeps DB handles open; falls back to host db when no tenant header.
const TENANT_ROOT = process.env.MNEMO_TENANT_ROOT || path.join(__dirname, "tenants");
if (!fs.existsSync(TENANT_ROOT)) fs.mkdirSync(TENANT_ROOT, { recursive: true });
const tenantPool = new Map();
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }
function tenantDb(id) {
  const safe = safeId(id);
  if (!safe) return null;
  if (tenantPool.has(safe)) return tenantPool.get(safe);
  const dir = path.join(TENANT_ROOT, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, "mnemo.db");
  const tdb = new Database(dbFile);
  tdb.pragma("journal_mode = WAL");
  tdb.pragma("synchronous = NORMAL");
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    if (fs.existsSync(schemaPath)) tdb.exec(fs.readFileSync(schemaPath, "utf8"));
  } catch (e) { console.error("[tenant-bootstrap]", safe, e.message); }
  tenantPool.set(safe, tdb);
  return tdb;
}
function dbForRequest(req) {
  const tid = req.headers["x-tenant-id"];
  if (!tid) return db;
  const t = tenantDb(tid);
  return t || db;
}

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const upsertWriter = db.prepare(`
  INSERT INTO writer_health (writer, last_write_at, rows_written, status, last_check_at)
  VALUES (?,?,?,?,?)
  ON CONFLICT(writer) DO UPDATE SET
    last_write_at=excluded.last_write_at,
    rows_written=writer_health.rows_written + excluded.rows_written,
    status=excluded.status,
    last_check_at=excluded.last_check_at
`);

function recordWrite(writer, rowsAdded, status = "alive") {
  upsertWriter.run(writer, rowsAdded > 0 ? now() : null, rowsAdded, status, now());
}

function ingestEvent(target, { kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta }) {
  if (!kind || !text || typeof text !== "string") return { ok: false, error: "missing kind or text" };
  const occurred = occurred_at || now();
  const hash = sha([kind, source_ref || "", occurred, text].join("|"));
  const stmt = target.prepare(`
    INSERT OR IGNORE INTO memory
      (kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta_json, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  const r = stmt.run(
    kind, source || "http", source_ref || null, occurred,
    actor || null, actor_id || null, topic || null,
    importance ?? 5, text, meta ? JSON.stringify(meta) : null, hash
  );
  return { ok: true, inserted: r.changes > 0, hash };
}

// ---------- HTTP server ----------

function sanitizeFtsQuery(q) {
  // Quote each whitespace-separated token to avoid FTS5 operator interpretation
  // (hyphen parses as NOT, colon as column-restrict). Already-quoted phrase passed through.
  if (!q) return q;
  if (/^".*"$/.test(q.trim())) return q;
  return q.split(/\s+/).filter(Boolean).map(t => {
    if (/^[A-Za-z0-9_]+$/.test(t)) return t;
    return '"' + t.replace(/"/g, '""') + '"';
  }).join(' ');
}

function sendJson(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const ae = String((req && req.headers && req.headers["accept-encoding"]) || "");
  if (body.length > 4096 && /gzip/.test(ae)) {
    const gz = zlib.gzipSync(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
  return res.end(body);
}

const CORS_ALLOWED_ORIGINS = new Set([
  "https://blun.ai",
  "https://www.blun.ai",
  "https://listing.blun.ai",
  "https://send.blun.ai",
  "https://shop.blun.ai",
]);
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-tenant-id");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

const server = http.createServer((req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tdb = dbForRequest(req);
  const tenantId = req.headers["x-tenant-id"] || null;
  if (req.method === "GET" && url.pathname === "/health") {
    const stats = {
      tenant: tenantId,
      memory_rows: tdb.prepare("SELECT COUNT(*) c FROM memory").get().c,
      writers: tdb.prepare("SELECT writer, status, last_write_at, rows_written FROM writer_health").all(),
      uptime_sec: Math.round(process.uptime()),
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats, null, 2));
  }
  if (req.method === "POST" && url.pathname === "/ingest") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const events = Array.isArray(payload) ? payload : [payload];
        const results = events.map(e => ingestEvent(tdb, e));
        const added = results.filter(r => r.inserted).length;
        if (!tenantId) recordWrite("http_ingest", added);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tenant: tenantId, accepted: events.length, inserted: added, results }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: String(e.message) }));
      }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/recall") {
    const q = url.searchParams.get("q");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
    if (!q) {
      res.writeHead(400); return res.end(JSON.stringify({ error: "q required" }));
    }
    try {
      const rows = tdb.prepare(`
        SELECT m.id, m.kind, m.actor, m.occurred_at, substr(m.text,1,300) preview, bm25(memory_fts) rank
        FROM memory_fts JOIN memory m ON m.id=memory_fts.rowid
        WHERE memory_fts MATCH ?
        ORDER BY rank ASC LIMIT ?
      `).all(sanitizeFtsQuery(q), limit);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(rows));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: String(e.message) }));
    }
  }
  if (req.method === "POST" && url.pathname === "/memory-tool") {
    // Mnemo Memory Frontdoor: a small virtual /memories filesystem mapped onto
    // the same Firm-OS tables used by the MCP/HTTP tools. It is intentionally
    // not a second memory store; reads render Mnemo state, writes call Mnemo
    // tools so every change stays auditable and queryable.
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let a = {};
      try { a = body ? JSON.parse(body) : {}; } catch { a = {}; }
      const cmd = String(a.command || "view").toLowerCase();
      const p = String(a.path || a.old_path || "/memories").replace(/\/+$/, "") || "/memories";
      const agent = a.agent || a.agent_name || "dieter";
      const ok = (text, meta) => sendJson(req, res, 200, Object.assign({ content: text }, meta || {}));
      const okJson = (obj) => sendJson(req, res, 200, obj);
      const err = (msg) => sendJson(req, res, 200, { error: msg });
      const parseContent = () => {
        if (a.content !== undefined) {
          if (typeof a.content === "object" && a.content !== null) return a.content;
          const raw = String(a.content || "").trim();
          if (!raw) return {};
          try { return JSON.parse(raw); } catch {}
          const out = { body: raw };
          for (const line of raw.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/);
            if (m) out[m[1]] = m[2];
          }
          return out;
        }
        return {};
      };
      const projectNameFrom = (match) => decodeURIComponent(match[1]).replace(/_/g, " ");
      const renderJson = (obj) => "```json\n" + JSON.stringify(obj || {}, null, 2) + "\n```";
      if (!p.startsWith("/memories")) return err("path must start with /memories");
      try {
        if (["create", "update", "write", "append"].includes(cmd)) {
          const content = parseContent();
          if (p === "/memories/focus.md") {
            const focus = content.focus || content.mode || String(content.body || "").trim();
            if (!focus) return err("focus required");
            return okJson(handleTool(tdb, "mem_focus_set", { agent_name: content.agent_name || agent, focus, reason: content.reason || null }));
          }
          const regMatch = p.match(/^\/memories\/projects\/(.+)\/registry\.md$/);
          if (regMatch) {
            const name = projectNameFrom(regMatch);
            return okJson(handleTool(tdb, "mem_project_registry_upsert", Object.assign({}, content, { name, updated_by: content.updated_by || agent })));
          }
          const liveMatch = p.match(/^\/memories\/projects\/(.+)\/live-check\.md$/);
          if (liveMatch) {
            const name = projectNameFrom(liveMatch);
            const checklist = content.health_checklist || content.checklist || content;
            const up = handleTool(tdb, "mem_project_registry_upsert", { name, health_checklist: checklist, updated_by: agent });
            const check = handleTool(tdb, "mem_project_live_check", { name, agent_name: agent, required_gates: content.required_gates });
            return okJson({ ok: !up.error, project: name, update: up, live_check: check });
          }
          const decisionMatch = p.match(/^\/memories\/projects\/(.+)\/decisions\.md$/);
          if (decisionMatch) {
            const project = projectNameFrom(decisionMatch);
            const body = content.body || "";
            const title = content.title || String(body).split(/\r?\n/).find(Boolean) || "Project decision";
            return okJson(handleTool(tdb, "mem_decision_log", {
              title,
              body,
              decided_by: content.decided_by || agent,
              scope: content.scope || project,
              agents_involved: content.agents_involved,
              files_affected: content.files_affected,
              meta: Object.assign({}, content.meta || {}, { source: "memory-frontdoor" })
            }));
          }
          const statusMatch = p.match(/^\/memories\/agents\/(.+)\/status\.md$/);
          if (statusMatch) {
            const target = projectNameFrom(statusMatch);
            return okJson(handleTool(tdb, "mem_agent_status_set", Object.assign({}, content, { agent_name: target })));
          }
          const handoffMatch = p.match(/^\/memories\/agents\/(.+)\/handoff\.md$/);
          if (handoffMatch) {
            const sourceAgent = projectNameFrom(handoffMatch);
            const handoff = content.body || JSON.stringify(content, null, 2);
            const log = handleTool(tdb, "mem_transcript_log", {
              source: "memory-frontdoor",
              channel: "handoff",
              direction: "outbound",
              speaker: sourceAgent,
              content: handoff,
              ref_kind: "agent_handoff",
              meta: { path: p }
            });
            return okJson({ ok: !log.error, handoff_id: log.id, agent_name: sourceAgent });
          }
          return err("write path not mapped: " + p);
        }
        if (["delete", "remove"].includes(cmd)) {
          return err("delete is protected; mark items superseded/released through the mapped Mnemo tools");
        }
        if (cmd !== "view" && cmd !== "read" && cmd !== "list") return err("unknown command: " + cmd);
        if (p === "/memories" || p === "/memories/") {
          const lines = [
            "/memories",
            "  today.md",
            "  inbox.md",
            "  identity.md",
            "  focus.md",
            "  promises.md",
            "  company/",
            "    brand.md",
            "    legal.md",
            "    pricing.md",
            "  decisions/",
            "    today.md",
            "  agents/",
            "    <agent>/status.md",
            "    <agent>/handoff.md",
            "  projects/",
            "    <project>/registry.md",
            "    <project>/live-check.md",
            "    <project>/decisions.md",
            "    <project>/files.md"
          ];
          try {
            const projs = tdb.prepare("SELECT name FROM project_registry ORDER BY name").all();
            for (const r of projs) lines.push("  projects/" + r.name.replace(/\s+/g,'_') + "/");
          } catch {}
          return ok(lines.join("\n"));
        }
        if (p === "/memories/today.md") {
          const t = handleTool(tdb, "mem_today_view", {});
          return ok(`# Today (${t.date})\n\nactions: ${t.actions?.count} | briefs: ${t.briefs?.count} | decisions: ${t.decisions?.count} | wishes: ${t.wishes?.count} | file_edits: ${t.file_edits?.count}\n\n## Recent decisions\n` + (t.decisions?.items||[]).map(d=>`- ${d.title} (${d.decided_by})`).join("\n"));
        }
        if (p === "/memories/inbox.md") {
          const r = handleTool(tdb, "mem_brief_pull", { agent_name: a.agent || "dieter", peek: true, limit: 10 });
          const briefs = r.briefs || [];
          if (!briefs.length) return ok("Inbox empty.");
          return ok(briefs.map(b => `## #${b.id} from ${b.source_agent || '?'}\n${(b.content||'').slice(0, 500)}`).join("\n\n"));
        }
        if (p === "/memories/identity.md") {
          const r = handleTool(tdb, "mem_session_brief", { token_budget: 250 });
          return ok(JSON.stringify(r.identity || {}, null, 2));
        }
        if (p === "/memories/focus.md") {
          const r = handleTool(tdb, "mem_focus_get", { agent_name: agent });
          return ok(`# Focus\n\nCurrent: ${r.focus}\nSet at: ${r.set_at || 'never'}\nReason: ${r.reason || '-'}\n\n## Slice\n${JSON.stringify(r.slice, null, 2)}`);
        }
        if (p === "/memories/company/brand.md" || p === "/memories/company/legal.md" || p === "/memories/company/pricing.md") {
          const topic = p.split("/").pop().replace(".md", "");
          const r = handleTool(tdb, "mem_company_fact_get", { scope: a.scope || "blun", topic });
          return ok(`# ${topic}\n\n` + renderJson(r.value || r));
        }
        if (p === "/memories/promises.md") {
          const r = handleTool(tdb, "mem_promise_open", { limit: 30 });
          const items = r.promises || [];
          return ok("# Open promises\n\n" + items.map(x => `- ${x.text}`).join("\n"));
        }
        if (p === "/memories/decisions/today.md") {
          const t = handleTool(tdb, "mem_today_view", {});
          const items = t.decisions?.items || [];
          return ok("# Decisions today\n\n" + items.map(d => `- ${d.title} - ${d.decided_by} @ ${d.decided_at}`).join("\n"));
        }
        const projectRoot = p.match(/^\/memories\/projects\/([^/]+)$/);
        if (projectRoot) {
          const name = projectNameFrom(projectRoot);
          return ok([`/memories/projects/${projectRoot[1]}`, "  registry.md", "  live-check.md", "  decisions.md", "  files.md", "  doc.md"].join("\n"), { project: name });
        }
        const regView = p.match(/^\/memories\/projects\/(.+)\/registry\.md$/);
        if (regView) {
          const name = projectNameFrom(regView);
          const r = handleTool(tdb, "mem_project_registry_get", { name });
          if (r.error) return err(r.error);
          return ok(`# ${name} registry\n\n` + renderJson(r));
        }
        const liveView = p.match(/^\/memories\/projects\/(.+)\/live-check\.md$/);
        if (liveView) {
          const name = projectNameFrom(liveView);
          const r = handleTool(tdb, "mem_project_live_check", { name, agent_name: agent, required_gates: a.required_gates });
          return ok(`# ${name} live-check\n\nStatus: ${r.status}\n\n` + renderJson(r));
        }
        const decisionsView = p.match(/^\/memories\/projects\/(.+)\/decisions\.md$/);
        if (decisionsView) {
          const name = projectNameFrom(decisionsView);
          const r = handleTool(tdb, "mem_decision_get", { scope: name, limit: a.limit || 30 });
          return ok(`# ${name} decisions\n\n` + ((r.decisions || []).map(d => `- #${d.id} ${d.title} (${d.decided_by}, ${d.decided_at})`).join("\n") || "No decisions."));
        }
        const filesView = p.match(/^\/memories\/projects\/(.+)\/files\.md$/);
        if (filesView) {
          const name = projectNameFrom(filesView);
          const lens = handleTool(tdb, "mem_lens_view", { project: name, limit: a.limit || 20 });
          return ok(`# ${name} files\n\n## Active claims\n` + ((lens.active_claims?.items || []).map(c => `- #${c.id} ${c.file_path} - ${c.agent_name}: ${c.summary || ""}`).join("\n") || "None.") + "\n\n## Recent edits\n" + ((lens.recent_file_edits?.items || []).map(f => `- ${f.file_path} - ${f.last_edit_agent || "?"} @ ${f.last_edit_at || "?"}`).join("\n") || "None."));
        }
        const projectDoc = p.match(/^\/memories\/projects\/(.+)\/doc\.md$/);
        if (projectDoc) {
          const name = projectNameFrom(projectDoc);
          const r = handleTool(tdb, "mem_project_doc_render", { name, include_legal: a.include_legal });
          if (r.error) return err(r.error);
          return ok(r.doc);
        }
        const statusView = p.match(/^\/memories\/agents\/(.+)\/status\.md$/);
        if (statusView) {
          const target = projectNameFrom(statusView);
          const r = handleTool(tdb, "mem_agent_status_get", { agent_name: target });
          return ok(`# ${target} status\n\n` + renderJson(r));
        }
        const projMatch = p.match(/^\/memories\/projects\/([^/]+)\.md$/);
        if (projMatch) {
          const name = projectNameFrom(projMatch);
          const r = handleTool(tdb, "mem_project_doc_render", { name });
          if (r.error) return err(r.error);
          return ok(r.doc);
        }
        return err("path not mapped: " + p);
      } catch (e) {
        return err("memory frontdoor error: " + e.message);
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
    const tool = url.pathname.slice("/tool/".length);
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let args = {};
      try { args = body ? JSON.parse(body) : {}; }
      catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid JSON: " + e.message }));
      }
      try {
        const result = handleTool(tdb, tool, args);
        injectContext(tdb, tool, args, result);
        return sendJson(req, res, 200, { tool, result });
      } catch (e) {
        return sendJson(req, res, 500, { error: String(e.message), tool });
      }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

// ---------- Push hook: fires telegram/webhook on brief insert/reaction ----------
function scoreProposal(project_fit, user_fit, cost) {
  const fit = { H: 3, M: 2, L: 1 };
  const costInverted = { L: 3, M: 2, H: 1 };
  const pf = fit[project_fit] || 1;
  const uf = fit[user_fit] || 1;
  const cs = costInverted[cost] || 1;
  return pf + uf + cs; // 3..9
}

function deriveLayer(kind) {
  if (!kind) return 'episodic';
  if (['tool_call','ssh_cmd','web_fetch','skill','skill_run'].includes(kind)) return 'procedural';
  if (['memory_md','decision','scar','manual','dream'].includes(kind)) return 'semantic';
  return 'episodic';
}

function tryPeerDeliver(tdb, agentName, payload) {
  try {
    const ag = tdb.prepare("SELECT peer_endpoint FROM agent_registry WHERE agent_name=?").get(agentName);
    if (!ag || !ag.peer_endpoint) return false;
    const url = new URL(ag.peer_endpoint);
    const lib = url.protocol === "https:" ? require("https") : require("http");
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise(resolve => {
      const req = lib.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { "Content-Type": "application/json", "Content-Length": body.length }, timeout: 1500 }, rs => { rs.resume(); resolve(rs.statusCode >= 200 && rs.statusCode < 300); });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(body); req.end();
    });
  } catch (e) { return false; }
}

function fireBriefHook(tdb, briefId, eventType, ctx) {

  try {
    const brief = tdb.prepare("SELECT id, agent_name, source_agent, channel, substr(content,1,500) AS preview FROM agent_brief WHERE id=?").get(briefId);
    if (!brief) return;
    const agent = tdb.prepare("SELECT notify_webhook, notify_telegram_chat FROM agent_registry WHERE agent_name=?").get(brief.agent_name);
    if (!agent) return;
    const payload = { event: eventType, brief_id: briefId, agent_name: brief.agent_name, source_agent: brief.source_agent, channel: brief.channel, preview: brief.preview, ctx: ctx || null, ts: new Date().toISOString() };
    if (agent.notify_webhook) {
      try {
        const url = new URL(agent.notify_webhook);
        const lib = url.protocol === "https:" ? require("https") : require("http");
        const body = Buffer.from(JSON.stringify(payload));
        const req = lib.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { "Content-Type": "application/json", "Content-Length": body.length } }, (rs) => { rs.resume(); });
        req.on("error", () => {}); req.write(body); req.end();
      } catch (e) {}
    }
    if (agent.notify_telegram_chat) {
      try {
        const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE || "/root/.dieter/telegram_bot_token";
        let token = process.env.TELEGRAM_BOT_TOKEN || "";
        if (!token && require("fs").existsSync(tokenFile)) token = require("fs").readFileSync(tokenFile,"utf8").trim();
        if (token) {
          const text = "[mnemo " + eventType + "] #" + briefId + " -> " + brief.agent_name + "\nfrom: " + (brief.source_agent || "?") + "\nchannel: " + (brief.channel || "-") + "\n\n" + ((brief.preview || "").slice(0,200));
          const https = require("https");
          const data = JSON.stringify({ chat_id: agent.notify_telegram_chat, text, disable_notification: false });
          const req = https.request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (rs) => { rs.resume(); });
          req.on("error", () => {}); req.write(data); req.end();
        }
      } catch (e) {}
    }
  } catch (e) { /* hook never throws */ }
}

function matchSkillsForText(tdb, text) {
  if (!text) return [];

  const skills = tdb.prepare("SELECT name, description, trigger_phrases FROM skill_registry WHERE status IN ('active','stub')").all();
  const matches = [];
  for (const sk of skills) {
    let triggers = [];
    try { triggers = JSON.parse(sk.trigger_phrases || "[]"); } catch {}
    for (const tp of triggers) {
      try {
        const re = new RegExp(tp, "i");
        if (re.test(text)) { matches.push({ name: sk.name, description: sk.description, matched: tp }); break; }
      } catch {}
    }
  }
  return matches;
}

function ftsIndex(tdb, scope, refId, agentName, summary, content) {
  try {
    tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES (?,?,?,?,?)")
       .run(scope, String(refId), agentName || '', (summary || '').slice(0, 200), (content || '').slice(0, 8000));
  } catch (e) { /* silent */ }
}

// ---------- Phase 8 #3: auto-inject relevant context into tool responses ----------
// Tools we never auto-inject for (recall-style, status-views, high-volume noise, recursion-risk)
const AUTO_INJECT_SKIP = new Set([
  "mem_recall","mem_recall_ids","mem_recall_layered","mem_recall_at_time","mem_recall_on_date","mem_recall_between",
  "mem_search","mem_question_answer","mem_neighbors","mem_get","mem_who_am_i",
  "mem_health","mem_brief_health","mem_brief_status","mem_brief_list","mem_brief_pull","mem_brief_done",
  "mem_action_log","mem_action_finish","mem_actions_recent","mem_actions_search",
  "mem_transcript_log","mem_transcript_recent",
  "mem_idle_loop_set","mem_idle_loop_status","mem_set_mode","mem_get_mode",
  "mem_connect_register","mem_connect_heartbeat","mem_connect_list","mem_agent_list","mem_agent_register",
  "mem_skill_list","mem_skill_get","mem_skill_match","mem_skill_search","mem_skill_run","mem_skill_record",
  "mem_consults_inbox","mem_consult_codex_pending","mem_consult_codex_status",
  "mem_proposals_pending","mem_project_list","mem_task_available","mem_task_list",
  "mem_watchdog_list","mem_escalations_pending","mem_problems_open","mem_problem_attempts",
  "mem_meeting_turns","mem_brief_template_list","mem_skill_outcome_stats",
]);

function buildContextQuery(name, a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [];
  // Pull text from common fields where agents put their semantic content
  for (const k of ['topic','target','agent_name','source_agent','text','content','summary','title','question','idea','name','goal_text','description','approach','decision_summary']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) parts.push(v);
  }
  return parts.join(' ').slice(0, 500);
}

function injectContext(tdb, name, args, result) {
  if (AUTO_INJECT_SKIP.has(name)) return;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  if (result.error) return;
  if (result._context) return; // don't overwrite if handler already set
  const queryText = buildContextQuery(name, args);
  if (!queryText || queryText.length < 3) return;
  const tokens = queryText
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
    .slice(0, 8)
    .map(t => '"' + t + '"')
    .join(' OR ');
  if (!tokens) return;
  try {
    const rows = tdb.prepare(
      "SELECT scope, ref_id, agent_name, summary, snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 16) AS snippet, rank " +
      "FROM mnemo_search_fts WHERE mnemo_search_fts MATCH ? ORDER BY rank LIMIT 3"
    ).all(tokens);
    if (rows.length) {
      result._context = {
        relevant_memories: rows.map(r => ({
          scope: r.scope, ref_id: r.ref_id, agent: r.agent_name,
          summary: r.summary, snippet: r.snippet
        })),
        hint: "Relevant prior context auto-injected. Read before acting if not already familiar.",
      };
    }
  } catch (e) { /* silent */ }
}

// ---------- Connect / Brief tool dispatch (HTTP-callable subset) ----------
function handleTool(tdb, name, a) {
  switch (name) {
    case "mem_connect_register": {
      tdb.prepare(
        "INSERT INTO agent_registry (agent_name, display_name, host, pid, skills_json, status, registered_at, last_seen_at, meta_json) " +
        "VALUES (?,?,?,?,?, 'online', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?) " +
        "ON CONFLICT(agent_name) DO UPDATE SET " +
        "display_name=excluded.display_name, host=excluded.host, pid=excluded.pid, " +
        "skills_json=excluded.skills_json, status='online', " +
        "last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=excluded.meta_json"
      ).run(
        a.agent_name, a.display_name || a.agent_name, a.host || null, a.pid || null,
        JSON.stringify(a.skills || []), a.meta ? JSON.stringify(a.meta) : null
      );
      return { agent_name: a.agent_name, status: "online" };
    }
    case "mem_connect_heartbeat": {
      const r = tdb.prepare(
        "UPDATE agent_registry SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=COALESCE(?, status) WHERE agent_name=?"
      ).run(a.status || null, a.agent_name);
      return { agent_name: a.agent_name, updated: r.changes > 0 };
    }
    case "mem_connect_list": {
      tdb.prepare(
        "UPDATE agent_registry SET status='offline' " +
        "WHERE status<>'offline' AND (julianday('now') - julianday(last_seen_at)) * 86400 > 300"
      ).run();
      const where = a.only_online ? "WHERE status='online'" : "";
      const rows = tdb.prepare(
        "SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json " +
        "FROM agent_registry " + where + " ORDER BY last_seen_at DESC"
      ).all();
      return {
        count: rows.length,
        agents: rows.map(r => Object.assign({}, r, {
          skills: r.skills_json ? JSON.parse(r.skills_json) : [],
          meta: r.meta_json ? JSON.parse(r.meta_json) : null,
        })),
      };
    }
    case "mem_connect_channel_upsert": {
      tdb.prepare(
        "INSERT INTO channel (name, description) VALUES (?,?) " +
        "ON CONFLICT(name) DO UPDATE SET description=COALESCE(excluded.description, channel.description)"
      ).run(a.name, a.description || null);
      return { name: a.name };
    }
    case "mem_connect_channel_subscribe": {
      tdb.prepare("INSERT INTO channel (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(a.channel);
      tdb.prepare("INSERT INTO channel_subscription (channel_name, agent_name) VALUES (?,?) ON CONFLICT DO NOTHING")
        .run(a.channel, a.agent_name);
      return { channel: a.channel, agent_name: a.agent_name, subscribed: true };
    }
    case "mem_connect_channel_post": {
      let subs = tdb.prepare(
        "SELECT s.agent_name, r.skills_json FROM channel_subscription s " +
        "LEFT JOIN agent_registry r ON r.agent_name = s.agent_name " +
        "WHERE s.channel_name = ?"
      ).all(a.channel);
      if (a.require_skill) {
        subs = subs.filter(s => {
          try { return (JSON.parse(s.skills_json || "[]")).includes(a.require_skill); }
          catch { return false; }
        });
      }
      const ids = [];
      const ins = tdb.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?,?,?,?,?)"
      );
      for (const s of subs) {
        const info = ins.run(s.agent_name, a.source_agent || null, a.content, a.channel,
                             a.meta ? JSON.stringify(a.meta) : null);
        ids.push(info.lastInsertRowid);
        try { fireBriefHook(tdb, info.lastInsertRowid, "channel_post", { agent_name: s.agent_name, channel: a.channel, source: a.source_agent || null }); } catch (e) {}
        try { ftsIndex(tdb, "brief", info.lastInsertRowid, s.agent_name, a.source_agent || "", a.content); } catch (e) {}
      }
      return { channel: a.channel, fanout: subs.length, brief_ids: ids };
    }
    case "mem_connect_channel_list": {
      const rows = tdb.prepare(
        "SELECT c.name, c.description, c.created_at, " +
        "(SELECT COUNT(*) FROM channel_subscription s WHERE s.channel_name = c.name) AS subscribers " +
        "FROM channel c ORDER BY c.created_at ASC"
      ).all();
      return { count: rows.length, channels: rows };
    }
    case "mem_brief_drop": {
      const _scrub = stripPrivate(a.content);
      const _content = _scrub.text;
      const info = tdb.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)"
      ).run(a.agent_name, a.source_agent || null, _content, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      if (a.supersedes) {
        try { tdb.prepare("UPDATE agent_brief SET superseded_by_id=?, status=CASE WHEN status='pending' THEN 'superseded' ELSE status END WHERE id=?").run(newId, a.supersedes); } catch (e) {}
      }
      try { fireBriefHook(tdb, newId, "drop", { agent_name: a.agent_name }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, a.agent_name, a.source_agent || "", _content); } catch (e) {}
      try {
        const skMatches = matchSkillsForText(tdb, _content);
        if (skMatches.length) {
          const insR = tdb.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)");
          for (const m of skMatches) insR.run(newId, "mnemo-skills-engine", "skill_suggested", JSON.stringify(m));
        }
      } catch (e) {}
      return { id: newId, agent_name: a.agent_name, status: "pending", supersedes: a.supersedes || null };
    }
    case "mem_brief_pull": {
      const rows = tdb.prepare(
        "SELECT id, source_agent, content, channel, created_at, meta_json FROM agent_brief " +
        "WHERE agent_name=? AND status='pending' ORDER BY created_at ASC LIMIT ?"
      ).all(a.agent_name, Math.min(a.limit || 5, 50));
      if (!a.peek && rows.length) {
        const upd = tdb.prepare("UPDATE agent_brief SET status='dispatched', dispatched_at=? WHERE id=?");
        const now = new Date().toISOString();
        for (const r of rows) upd.run(now, r.id);
      }
      return { count: rows.length, briefs: rows };
    }
    case "mem_brief_done": {
      tdb.prepare("UPDATE agent_brief SET status=?, done_at=?, outcome=? WHERE id=?")
        .run(a.status, new Date().toISOString(), a.outcome || null, a.id);
      return { id: a.id, status: a.status };
    }
    case "mem_query_layer": {
      const layer = a.layer;
      if (!['procedural','semantic','episodic'].includes(layer)) return { error: "layer must be procedural|semantic|episodic" };
      const limit = Math.min(a.limit || 50, 200);
      const rows = tdb.prepare("SELECT id, kind, source, actor, topic, importance, occurred_at, substr(text,1,300) preview FROM memory WHERE layer=? ORDER BY importance DESC, occurred_at DESC LIMIT ?").all(layer, limit);
      return { layer, count: rows.length, rows };
    }
    case "mem_recall_layered": {
      // FTS search across memory, weight by layer per a.bias (default: semantic 1.5x, procedural 1.2x, episodic 1.0x)
      const q = String(a.query || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!q) return { error: "query required" };
      const tokens = q.split(/\s+/).filter(Boolean).map(t => '"' + t + '"').join(" ");
      const limit = Math.min(a.limit || 20, 100);
      const bias = a.bias || { semantic: 1.5, procedural: 1.2, episodic: 1.0 };
      const rows = tdb.prepare("SELECT m.id, m.kind, m.layer, m.actor, m.topic, m.importance, m.occurred_at, substr(m.text,1,400) preview, bm25(memory_fts) raw_rank FROM memory_fts JOIN memory m ON m.id=memory_fts.rowid WHERE memory_fts MATCH ? ORDER BY raw_rank LIMIT ?").all(tokens, limit * 3);
      for (const r of rows) {
        const w = bias[r.layer || 'episodic'] || 1.0;
        r.weighted_rank = (r.raw_rank || 0) / w;
      }
      rows.sort((a, b) => a.weighted_rank - b.weighted_rank);
      return { query: q, count: rows.length, results: rows.slice(0, limit) };
    }
    case "mem_propose": {
      const fit = ['H','M','L'];
      if (!a.idea || !a.agent_name) return { error: "idea + agent_name required" };
      const pf = fit.includes(a.project_fit) ? a.project_fit : 'M';
      const uf = fit.includes(a.user_fit) ? a.user_fit : 'M';
      const cs = fit.includes(a.cost) ? a.cost : 'M';
      const score = scoreProposal(pf, uf, cs);
      const ship_eligible = (score >= 7 && cs === 'L') ? 1 : 0;
      let status = 'queued';
      let reason = null;
      if (score < 5) { status = 'discarded'; reason = 'score_below_threshold'; }
      else if (ship_eligible) { status = 'ship_eligible'; }
      const info = tdb.prepare("INSERT INTO agent_proposal (agent_name, idea, project, project_fit, user_fit, cost, score, ship_eligible, status, reason) VALUES (?,?,?,?,?,?,?,?,?,?)").run(a.agent_name, a.idea, a.project || null, pf, uf, cs, score, ship_eligible, status, reason);
      return { id: info.lastInsertRowid, agent_name: a.agent_name, score, ship_eligible: !!ship_eligible, status, reason };
    }
    case "mem_proposals_pending": {
      const where = ["status IN ('queued','ship_eligible')"];
      const params = [];
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.project) { where.push("project=?"); params.push(a.project); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare("SELECT id, agent_name, idea, project, project_fit, user_fit, cost, score, ship_eligible, status, created_at FROM agent_proposal WHERE " + where.join(" AND ") + " ORDER BY score DESC, created_at DESC LIMIT ?").all(...params);
      return { count: rows.length, proposals: rows };
    }
    case "mem_proposal_update": {
      if (!a.id || !a.status) return { error: "id + status required" };
      tdb.prepare("UPDATE agent_proposal SET status=?, brief_id=COALESCE(?, brief_id), shipped_at=CASE WHEN ?='shipped' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE shipped_at END, reason=COALESCE(?, reason) WHERE id=?").run(a.status, a.brief_id || null, a.status, a.reason || null, a.id);
      return { id: a.id, status: a.status };
    }
    case "mem_project_state_set": {
      if (!a.project || !a.kind || !a.content) return { error: "project + kind + content required" };
      const ttl = a.ttl_hours || 6;
      const expires = new Date(Date.now() + ttl * 3600 * 1000).toISOString();
      const info = tdb.prepare("INSERT INTO project_state_snapshot (project, kind, content, expires_at) VALUES (?,?,?,?)").run(a.project, a.kind, typeof a.content === 'string' ? a.content : JSON.stringify(a.content), expires);
      return { id: info.lastInsertRowid, project: a.project, kind: a.kind, expires_at: expires };
    }
    case "mem_project_state_get": {
      if (!a.project) return { error: "project required" };
      const where = ["project=?"];
      const params = [a.project];
      if (a.kind) { where.push("kind=?"); params.push(a.kind); }
      where.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
      const rows = tdb.prepare("SELECT id, project, kind, content, created_at, expires_at FROM project_state_snapshot WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT 1").all(...params);
      if (!rows.length) return { project: a.project, kind: a.kind || null, stale: true, snapshot: null };
      const r = rows[0];
      const ageMs = Date.now() - new Date(r.created_at).getTime();
      const stale = ageMs > 6 * 3600 * 1000;
      return { project: r.project, kind: r.kind, snapshot: r, age_minutes: Math.round(ageMs / 60000), stale };
    }
    case "mem_idle_loop_set": {
      if (!a.agent_name) return { error: "agent_name required" };
      const enabled = a.enabled ? 1 : 0;
      const interval = parseInt(a.interval_min || 30, 10);
      tdb.prepare("INSERT INTO agent_idle_config (agent_name, enabled, interval_min, updated_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(agent_name) DO UPDATE SET enabled=excluded.enabled, interval_min=excluded.interval_min, updated_at=excluded.updated_at").run(a.agent_name, enabled, interval);
      return { agent_name: a.agent_name, enabled: !!enabled, interval_min: interval };
    }
    case "mem_idle_loop_status": {
      const rows = tdb.prepare("SELECT agent_name, enabled, interval_min, last_cycle_at FROM agent_idle_config ORDER BY agent_name").all();
      return { count: rows.length, agents: rows };
    }
    case "mem_set_mode": {
      if (!a.agent_name || !a.mode) return { error: "agent_name + mode required" };
      const validModes = ['autonomous','meeting','offline','maintenance','active','vacation'];
      if (!validModes.includes(a.mode)) return { error: "mode must be active|vacation|maintenance" };
      tdb.prepare("INSERT INTO agent_mode (agent_name, mode, until, digest_chat_id, updated_at) VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(agent_name) DO UPDATE SET mode=excluded.mode, until=excluded.until, digest_chat_id=COALESCE(excluded.digest_chat_id, agent_mode.digest_chat_id), updated_at=excluded.updated_at").run(a.agent_name, a.mode, a.until || null, a.digest_chat_id ? String(a.digest_chat_id) : null);
      return { agent_name: a.agent_name, mode: a.mode, until: a.until || null };
    }
    case "mem_get_mode": {
      const row = tdb.prepare("SELECT agent_name, mode, until, digest_chat_id, last_digest_at, updated_at FROM agent_mode WHERE agent_name=?").get(a.agent_name);
      if (!row) return { agent_name: a.agent_name, mode: 'active', until: null };
      // Check expiry
      if (row.until && new Date(row.until) < new Date()) {
        tdb.prepare("UPDATE agent_mode SET mode='active', until=NULL WHERE agent_name=?").run(a.agent_name);
        return { agent_name: a.agent_name, mode: 'active', until: null, expired_from: row.mode };
      }
      return row;
    }
    case "mem_skill_outcome_record": {
      if (!a.skill_name || !a.reaction) return { error: "skill_name + reaction required" };
      const info = tdb.prepare("INSERT INTO skill_outcome (skill_name, proposal_id, brief_id, reaction, metric_json) VALUES (?,?,?,?,?)").run(a.skill_name, a.proposal_id || null, a.brief_id || null, a.reaction, a.metric ? JSON.stringify(a.metric) : null);
      return { id: info.lastInsertRowid, skill_name: a.skill_name, reaction: a.reaction };
    }
    case "mem_skill_outcome_stats": {
      const where = []; const params = [];
      if (a.skill_name) { where.push("skill_name=?"); params.push(a.skill_name); }
      if (a.since) { where.push("recorded_at >= ?"); params.push(a.since); }
      const sql = "SELECT skill_name, reaction, COUNT(*) c FROM skill_outcome" + (where.length ? " WHERE " + where.join(" AND ") : "") + " GROUP BY skill_name, reaction ORDER BY skill_name, reaction";
      const rows = tdb.prepare(sql).all(...params);
      const bySkill = {};
      for (const r of rows) {
        if (!bySkill[r.skill_name]) bySkill[r.skill_name] = { skill_name: r.skill_name, reactions: {}, total: 0, success_rate: 0 };
        bySkill[r.skill_name].reactions[r.reaction] = r.c;
        bySkill[r.skill_name].total += r.c;
      }
      for (const k of Object.keys(bySkill)) {
        const obj = bySkill[k];
        const ok = (obj.reactions["done"] || 0) + (obj.reactions["ack"] || 0);
        obj.success_rate = obj.total > 0 ? Math.round(1000 * ok / obj.total) / 1000 : 0;
      }
      return { count: Object.keys(bySkill).length, skills: Object.values(bySkill) };
    }
    case "mem_project_create": {
      if (!a.name || !a.owner_agent) return { error: "name + owner_agent required" };
      try {
        const info = tdb.prepare("INSERT INTO agent_project (name, owner_agent, goal_text, current_milestone) VALUES (?,?,?,?)").run(a.name, a.owner_agent, a.goal_text || null, a.current_milestone || null);
        return { id: info.lastInsertRowid, name: a.name, owner_agent: a.owner_agent, status: "active" };
      } catch (e) {
        if (String(e.message).includes("UNIQUE")) return { error: "project_exists", name: a.name };
        return { error: e.message };
      }
    }
    case "mem_project_update": {
      if (!a.name && !a.id) return { error: "name or id required" };
      const fields = []; const params = [];
      for (const k of ["owner_agent","goal_text","status","current_milestone","blocker"]) {
        if (a[k] !== undefined) { fields.push(k + "=?"); params.push(a[k]); }
      }
      fields.push("last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      if (!fields.length) return { error: "no fields" };
      const where = a.id ? "id=?" : "name=?";
      params.push(a.id || a.name);
      tdb.prepare("UPDATE agent_project SET " + fields.join(", ") + " WHERE " + where).run(...params);
      return { ok: true, identifier: a.id || a.name };
    }
    case "mem_project_list": {
      const where = []; const params = [];
      if (a.owner_agent) { where.push("owner_agent=?"); params.push(a.owner_agent); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      const sql = "SELECT id, name, owner_agent, goal_text, status, current_milestone, blocker, started_at, last_active_at FROM agent_project" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY last_active_at DESC LIMIT ?";
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare(sql).all(...params);
      return { count: rows.length, projects: rows };
    }
    case "mem_project_close": {
      if (!a.name && !a.id) return { error: "name or id required" };
      const where = a.id ? "id=?" : "name=?";
      tdb.prepare("UPDATE agent_project SET status='done', last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE " + where).run(a.id || a.name);
      return { ok: true, identifier: a.id || a.name };
    }
    case "mem_task_create": {
      if (!a.title) return { error: "title required" };
      const skills = Array.isArray(a.skills_required) ? a.skills_required : [];
      const info = tdb.prepare("INSERT INTO shared_task (project_id, title, description, priority, skills_required) VALUES (?,?,?,?,?)").run(a.project_id || null, a.title, a.description || null, a.priority || 'M', JSON.stringify(skills));
      return { id: info.lastInsertRowid, title: a.title, status: "open" };
    }
    case "mem_task_claim": {
      if (!a.task_id || !a.agent_name) return { error: "task_id + agent_name required" };
      const r = tdb.prepare("UPDATE shared_task SET claim_agent=?, status='claimed', claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'").run(a.agent_name, a.task_id);
      if (r.changes === 0) {
        const cur = tdb.prepare("SELECT status, claim_agent FROM shared_task WHERE id=?").get(a.task_id);
        return { error: "claim_failed", current: cur };
      }
      return { ok: true, task_id: a.task_id, agent_name: a.agent_name };
    }
    case "mem_task_release": {
      if (!a.task_id) return { error: "task_id required" };
      tdb.prepare("UPDATE shared_task SET claim_agent=NULL, status='open', claimed_at=NULL WHERE id=?").run(a.task_id);
      return { ok: true, task_id: a.task_id };
    }
    case "mem_task_block": {
      if (!a.task_id || !a.reason) return { error: "task_id + reason required" };
      tdb.prepare("UPDATE shared_task SET status='blocked', blocker_reason=? WHERE id=?").run(a.reason, a.task_id);
      return { ok: true, task_id: a.task_id, status: "blocked" };
    }
    case "mem_task_done": {
      if (!a.task_id) return { error: "task_id required" };
      tdb.prepare("UPDATE shared_task SET status='done', done_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.task_id);
      return { ok: true, task_id: a.task_id };
    }
    case "mem_task_available": {
      const skills = Array.isArray(a.skills) ? a.skills : null;
      const limit = Math.min(a.limit || 20, 100);
      let rows = tdb.prepare("SELECT id, project_id, title, description, priority, skills_required, created_at FROM shared_task WHERE status='open' ORDER BY CASE priority WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at ASC LIMIT ?").all(limit * 3);
      if (skills && skills.length) {
        rows = rows.filter(r => {
          let req = []; try { req = JSON.parse(r.skills_required || "[]"); } catch {}
          if (!req.length) return true;
          return req.some(s => skills.includes(s));
        });
      }
      return { count: rows.slice(0, limit).length, tasks: rows.slice(0, limit) };
    }
    case "mem_task_list": {
      const where = []; const params = [];
      if (a.project_id) { where.push("project_id=?"); params.push(a.project_id); }
      if (a.claim_agent) { where.push("claim_agent=?"); params.push(a.claim_agent); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 50, 200));
      const sql = "SELECT id, project_id, title, claim_agent, status, priority, created_at, claimed_at, done_at FROM shared_task" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT ?";
      const rows = tdb.prepare(sql).all(...params);
      return { count: rows.length, tasks: rows };
    }
    case "mem_watchdog_register": {
      if (!a.target) return { error: "target required" };
      const info = tdb.prepare("INSERT INTO watchdog (target, check_kind, owner_agent, threshold_json, enabled) VALUES (?,?,?,?,?)").run(a.target, a.check_kind || 'http', a.owner_agent || null, a.threshold ? JSON.stringify(a.threshold) : null, a.enabled === false ? 0 : 1);
      return { id: info.lastInsertRowid, target: a.target };
    }
    case "mem_watchdog_list": {
      const rows = tdb.prepare("SELECT id, target, check_kind, owner_agent, enabled, last_check_at, last_status, consecutive_failures FROM watchdog ORDER BY enabled DESC, target").all();
      return { count: rows.length, watchdogs: rows };
    }
    case "mem_watchdog_disable": {
      if (!a.id) return { error: "id required" };
      tdb.prepare("UPDATE watchdog SET enabled=0 WHERE id=?").run(a.id);
      return { ok: true };
    }
    case "mem_watchdog_enable": {
      if (!a.id) return { error: "id required" };
      tdb.prepare("UPDATE watchdog SET enabled=1 WHERE id=?").run(a.id);
      return { ok: true };
    }
    case "mem_watchdog_incidents": {
      const where = []; const params = [];
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.watchdog_id) { where.push("watchdog_id=?"); params.push(a.watchdog_id); }
      params.push(Math.min(a.limit || 50, 200));
      const sql = "SELECT i.id, i.watchdog_id, w.target, i.opened_at, i.closed_at, i.status, i.notes FROM watchdog_incident i LEFT JOIN watchdog w ON w.id=i.watchdog_id" + (where.length ? " WHERE " + where.map(x => "i." + x).join(" AND ") : "") + " ORDER BY i.opened_at DESC LIMIT ?";
      const rows = tdb.prepare(sql).all(...params);
      return { count: rows.length, incidents: rows };
    }
    case "mem_escalate": {
      if (!a.kind || !a.summary) return { error: "kind + summary required" };
      const info = tdb.prepare("INSERT INTO escalation (source_agent, kind, urgency, summary, requested_authority) VALUES (?,?,?,?,?)").run(a.source_agent || null, a.kind, a.urgency || 'M', a.summary, a.requested_authority || 'dieter');
      const id = info.lastInsertRowid;
      // Routing logic
      const route = (() => {
        if (a.kind === 'blocker' && a.urgency === 'H' && a.requested_authority === 'mayk') return 'telegram_immediate';
        if (a.kind === 'customer' && a.urgency === 'H') return 'telegram_immediate';
        if (a.kind === 'decision' && a.requested_authority === 'dieter') return 'brief_to_dieter';
        if (a.urgency === 'L') return 'digest_only';
        return 'brief_to_dieter';
      })();
      // Action based on routing
      try {
        if (route === 'brief_to_dieter') {
          tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run('Dieter', a.source_agent || null, "[ESCALATION #" + id + "] " + a.kind + "/" + a.urgency + ": " + a.summary);
        } else if (route === 'telegram_immediate') {
          const tokenFile = "/root/.dieter/telegram_bot_token";
          let token = "";
          if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile,"utf8").trim();
          if (token) {
            const data = JSON.stringify({ chat_id: "1605241602", text: "[ESCALATION " + a.urgency + "] " + a.kind + " from " + (a.source_agent || "?") + ": " + a.summary });
            const req = require("https").request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, r => r.resume());
            req.on("error", () => {}); req.write(data); req.end();
          }
        }
      } catch (e) {}
      return { id, route, kind: a.kind, urgency: a.urgency };
    }
    case "mem_escalate_resolve": {
      if (!a.id) return { error: "id required" };
      tdb.prepare("UPDATE escalation SET status='resolved', resolution=?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.resolution || null, a.id);
      return { ok: true, id: a.id };
    }
    case "mem_escalations_pending": {
      const where = ["status='open'"]; const params = [];
      if (a.kind) { where.push("kind=?"); params.push(a.kind); }
      if (a.urgency) { where.push("urgency=?"); params.push(a.urgency); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare("SELECT id, source_agent, kind, urgency, summary, requested_authority, created_at FROM escalation WHERE " + where.join(" AND ") + " ORDER BY CASE urgency WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at DESC LIMIT ?").all(...params);
      return { count: rows.length, escalations: rows };
    }
    case "mem_problem_create": {
      if (!a.title) return { error: "title required" };
      const info = tdb.prepare("INSERT INTO open_problem (title, project_id, severity, owner_agent) VALUES (?,?,?,?)").run(a.title, a.project_id || null, a.severity || 'M', a.owner_agent || null);
      return { id: info.lastInsertRowid, title: a.title, status: "open" };
    }
    case "mem_problem_attempt": {
      if (!a.problem_id || !a.agent_name) return { error: "problem_id + agent_name required" };
      const info = tdb.prepare("INSERT INTO problem_attempt (problem_id, agent_name, approach, outcome, failure_reason) VALUES (?,?,?,?,?)").run(a.problem_id, a.agent_name, a.approach || null, a.outcome || null, a.failure_reason || null);
      return { id: info.lastInsertRowid, problem_id: a.problem_id };
    }
    case "mem_problem_attempts": {
      if (!a.problem_id) return { error: "problem_id required" };
      const rows = tdb.prepare("SELECT id, agent_name, approach, outcome, failure_reason, created_at FROM problem_attempt WHERE problem_id=? ORDER BY created_at DESC").all(a.problem_id);
      return { count: rows.length, attempts: rows };
    }
    case "mem_problem_close": {
      if (!a.id) return { error: "id required" };
      tdb.prepare("UPDATE open_problem SET status='closed', solved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution=? WHERE id=?").run(a.resolution || null, a.id);
      return { ok: true, id: a.id };
    }
    case "mem_problems_open": {
      const where = ["status='open'"]; const params = [];
      if (a.owner_agent) { where.push("owner_agent=?"); params.push(a.owner_agent); }
      if (a.project_id) { where.push("project_id=?"); params.push(a.project_id); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare("SELECT id, title, project_id, severity, owner_agent, opened_at FROM open_problem WHERE " + where.join(" AND ") + " ORDER BY CASE severity WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, opened_at DESC LIMIT ?").all(...params);
      return { count: rows.length, problems: rows };
    }
    case "mem_consult_peer": {
      if (!a.source_agent || !a.target_agent || !a.question) return { error: "source_agent + target_agent + question required" };
      const info = tdb.prepare("INSERT INTO peer_consult (source_agent, target_agent, question, context) VALUES (?,?,?,?)").run(a.source_agent, a.target_agent, a.question, a.context || null);
      try { fireBriefHook(tdb, info.lastInsertRowid, "consult_request", { agent_name: a.target_agent, source: a.source_agent }); } catch (e) {}
      return { id: info.lastInsertRowid, target_agent: a.target_agent };
    }
    case "mem_consults_inbox": {
      if (!a.agent_name) return { error: "agent_name required" };
      const rows = tdb.prepare("SELECT id, source_agent, question, context, status, created_at FROM peer_consult WHERE target_agent=? AND status='open' ORDER BY created_at DESC LIMIT ?").all(a.agent_name, Math.min(a.limit || 20, 100));
      return { count: rows.length, consults: rows };
    }
    case "mem_consult_answer": {
      if (!a.id || !a.response) return { error: "id + response required" };
      tdb.prepare("UPDATE peer_consult SET response=?, status='answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.response, a.id);
      return { ok: true, id: a.id };
    }
    case "mem_meeting_open": {
      if (!a.topic) return { error: "topic required" };
      const info = tdb.prepare("INSERT INTO meeting (topic, project_id, problem_id, created_by) VALUES (?,?,?,?)").run(a.topic, a.project_id || null, a.problem_id || null, a.created_by || null);
      return { id: info.lastInsertRowid, topic: a.topic, status: "open" };
    }
    case "mem_meeting_post": {
      if (!a.meeting_id || !a.agent_name || !a.content) return { error: "meeting_id + agent_name + content required" };
      const validKinds = ['propose','agree','disagree','question','synthesis'];
      const kind = validKinds.includes(a.turn_kind) ? a.turn_kind : 'propose';
      const info = tdb.prepare("INSERT INTO meeting_turn (meeting_id, agent_name, content, turn_kind) VALUES (?,?,?,?)").run(a.meeting_id, a.agent_name, a.content, kind);
      return { id: info.lastInsertRowid, meeting_id: a.meeting_id, turn_kind: kind };
    }
    case "mem_meeting_close": {
      if (!a.meeting_id) return { error: "meeting_id required" };
      tdb.prepare("UPDATE meeting SET status='closed', decision_summary=?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.decision_summary || null, a.meeting_id);
      return { ok: true, meeting_id: a.meeting_id };
    }
    case "mem_meeting_turns": {
      if (!a.meeting_id) return { error: "meeting_id required" };
      const rows = tdb.prepare("SELECT id, agent_name, content, turn_kind, created_at FROM meeting_turn WHERE meeting_id=? ORDER BY created_at ASC").all(a.meeting_id);
      return { count: rows.length, turns: rows };
    }
    case "mem_consult_codex": {
      if (!a.requesting_agent || !a.question) return { error: "requesting_agent + question required" };
      const info = tdb.prepare("INSERT INTO codex_consult (requesting_agent, problem_id, question, context_files) VALUES (?,?,?,?)").run(a.requesting_agent, a.problem_id || null, a.question, a.context_files ? JSON.stringify(a.context_files) : null);
      return { id: info.lastInsertRowid, requesting_agent: a.requesting_agent, status: "pending" };
    }
    case "mem_consult_codex_pending": {
      const lim = Math.min(a.limit || 20, 100);
      const rows = tdb.prepare("SELECT id, requesting_agent, problem_id, question, context_files, status, created_at FROM codex_consult WHERE status='pending' ORDER BY created_at ASC LIMIT ?").all(lim);
      for (const r of rows) { if (r.context_files) { try { r.context_files = JSON.parse(r.context_files); } catch (e) {} } }
      return { count: rows.length, consults: rows };
    }
    case "mem_consult_codex_answer": {
      if (!a.id || !a.proposed_solution) return { error: "id + proposed_solution required" };
      tdb.prepare("UPDATE codex_consult SET proposed_solution=?, status='answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.proposed_solution, a.id);
      return { ok: true, id: a.id, status: "answered" };
    }
    case "mem_consult_codex_status": {
      if (!a.id) return { error: "id required" };
      const row = tdb.prepare("SELECT id, requesting_agent, problem_id, question, context_files, proposed_solution, used_in_attempt_id, status, created_at, answered_at FROM codex_consult WHERE id=?").get(a.id);
      if (!row) return { error: "not_found", id: a.id };
      if (row.context_files) { try { row.context_files = JSON.parse(row.context_files); } catch (e) {} }
      return row;
    }
    case "mem_consult_codex_use": {
      if (!a.id) return { error: "id required" };
      tdb.prepare("UPDATE codex_consult SET used_in_attempt_id=?, status='used' WHERE id=?").run(a.attempt_id || null, a.id);
      return { ok: true, id: a.id, status: "used" };
    }
    case "mem_transcript_log": {
      if (!a.source || !a.direction || !a.content) return { error: "source + direction + content required" };
      const _tscrub = stripPrivate(a.content);
      const _tcontent = _tscrub.text;
      const occurredAt = a.occurred_at || null;
      const info = (occurredAt
        ? tdb.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, _tcontent, a.meta ? JSON.stringify(a.meta) : null, occurredAt, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
        : tdb.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, _tcontent, a.meta ? JSON.stringify(a.meta) : null, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
      );
      try { tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)").run(String(info.lastInsertRowid), a.speaker || a.source || '', a.direction + (a.channel ? ' @ ' + a.channel : ''), (_tcontent || '').slice(0, 8000)); } catch (e) {}
      return { id: info.lastInsertRowid, source: a.source, direction: a.direction, occurred_at: occurredAt, private_redacted: _tscrub.hadPrivate };
    }
    case "mem_question_answer": {
      if (!a.question) return { error: "question required" };
      const lim = Math.min(a.limit || 10, 50);
      const scopes = Array.isArray(a.scope) && a.scope.length ? a.scope : ['transcript','brief','memory','action'];
      const raw = String(a.question || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!raw) return { error: "question must contain searchable terms" };
      const tokens = raw.split(/\s+/).filter(t => t.length > 1).map(t => '"' + t + '"').join(" ");
      const placeholders = scopes.map(() => "?").join(",");
      let dateClause = "";
      const dateParams = [];
      if (a.date) {
        dateClause = " AND ref_id IN (SELECT id FROM transcript WHERE date(occurred_at) = ? UNION SELECT id FROM agent_brief WHERE date(created_at) = ? UNION SELECT id FROM agent_action WHERE date(started_at) = ?)";
        dateParams.push(a.date, a.date, a.date);
      }
      try {
        const rows = tdb.prepare("SELECT scope, ref_id, agent_name, summary, snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS snippet, rank FROM mnemo_search_fts WHERE scope IN (" + placeholders + ") AND mnemo_search_fts MATCH ?" + dateClause + " ORDER BY rank LIMIT ?").all(...scopes, tokens, ...dateParams, lim);
        const evidence = rows.map(r => {
          const ev = { scope: r.scope, ref_id: r.ref_id, agent: r.agent_name, summary: r.summary, snippet: r.snippet, rank: r.rank };
          try {
            if (r.scope === 'transcript') {
              const tr = tdb.prepare("SELECT occurred_at, speaker, source, direction, content FROM transcript WHERE id=?").get(r.ref_id);
              if (tr) { ev.occurred_at = tr.occurred_at; ev.speaker = tr.speaker; ev.direction = tr.direction; ev.content = tr.content; }
            } else if (r.scope === 'brief') {
              const br = tdb.prepare("SELECT created_at, agent_name, source_agent FROM agent_brief WHERE id=?").get(r.ref_id);
              if (br) { ev.occurred_at = br.created_at; ev.agent = br.agent_name; ev.source = br.source_agent; }
            }
          } catch (e) {}
          return ev;
        });
        return { question: a.question, count: evidence.length, scopes, date_filter: a.date || null, evidence };
      } catch (e) { return { error: e.message }; }
    }
    case "mem_recall_at_time": {
      if (!a.timestamp) return { error: "timestamp (ISO or YYYY-MM-DDTHH:MM) required" };
      const windowMin = Math.max(1, Math.min(a.window_minutes || 5, 360));
      const lim = Math.min(a.limit || 50, 500);
      const ts = String(a.timestamp);
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id, ABS((julianday(occurred_at) - julianday(?)) * 1440) AS minutes_diff FROM transcript WHERE ABS((julianday(occurred_at) - julianday(?)) * 1440) <= ? ORDER BY occurred_at ASC LIMIT ?").all(ts, ts, windowMin, lim);
      return { count: rows.length, timestamp: ts, window_minutes: windowMin, transcripts: rows };
    }
    case "mem_recall_on_date": {
      if (!a.date) return { error: "date (YYYY-MM-DD) required" };
      const lim = Math.min(a.limit || 200, 1000);
      const date = String(a.date);
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript WHERE date(occurred_at) = ? ORDER BY occurred_at ASC LIMIT ?").all(date, lim);
      return { count: rows.length, date, transcripts: rows };
    }
    case "mem_recall_between": {
      if (!a.start || !a.end) return { error: "start + end (ISO timestamps) required" };
      const lim = Math.min(a.limit || 200, 1000);
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at ASC LIMIT ?").all(String(a.start), String(a.end), lim);
      return { count: rows.length, start: a.start, end: a.end, transcripts: rows };
    }
    case "mem_transcript_recent": {
      const lim = Math.min(a.limit || 20, 200);
      const filters = [];
      const params = [];
      if (a.speaker) { filters.push("speaker = ?"); params.push(a.speaker); }
      if (a.source) { filters.push("source = ?"); params.push(a.source); }
      if (a.channel) { filters.push("channel = ?"); params.push(a.channel); }
      if (a.direction) { filters.push("direction = ?"); params.push(a.direction); }
      const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
      params.push(lim);
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript " + where + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, transcripts: rows };
    }
    case "mem_entity_upsert": {
      if (!a.kind || !a.name) return { error: "kind + name required" };
      const sc = a.scope || "blun";
      const st = a.status || "active";
      const meta_json = a.meta ? JSON.stringify(a.meta) : null;
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS entity (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'blun', owner_agent TEXT, status TEXT NOT NULL DEFAULT 'active', parent_id INTEGER, url TEXT, meta_json TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(kind, name, scope)); CREATE INDEX IF NOT EXISTS idx_entity_kind_status ON entity(kind, status); CREATE INDEX IF NOT EXISTS idx_entity_owner ON entity(owner_agent);`); } catch {}
      const existing = tdb.prepare("SELECT id FROM entity WHERE kind=? AND name=? AND scope=?").get(a.kind, a.name, sc);
      if (existing) {
        tdb.prepare("UPDATE entity SET owner_agent=COALESCE(?, owner_agent), status=?, parent_id=COALESCE(?, parent_id), url=COALESCE(?, url), meta_json=COALESCE(?, meta_json), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.owner_agent || null, st, a.parent_id || null, a.url || null, meta_json, existing.id);
        return { id: existing.id, kind: a.kind, name: a.name, scope: sc, action: "updated" };
      }
      const info = tdb.prepare("INSERT INTO entity (kind, name, scope, owner_agent, status, parent_id, url, meta_json) VALUES (?,?,?,?,?,?,?,?)").run(a.kind, a.name, sc, a.owner_agent || null, st, a.parent_id || null, a.url || null, meta_json);
      return { id: info.lastInsertRowid, kind: a.kind, name: a.name, scope: sc, action: "created" };
    }
    case "mem_entity_get": {
      let row;
      if (a.id) row = tdb.prepare("SELECT * FROM entity WHERE id=?").get(a.id);
      else if (a.kind && a.name) row = tdb.prepare("SELECT * FROM entity WHERE kind=? AND name=? AND scope=?").get(a.kind, a.name, a.scope || "blun");
      else return { error: "id OR (kind+name) required" };
      if (!row) return { error: "not found" };
      if (row.meta_json) try { row.meta = JSON.parse(row.meta_json); } catch {}
      return row;
    }
    case "mem_entity_list": {
      const where = []; const params = [];
      if (a.kind) { where.push("kind=?"); params.push(a.kind); }
      if (a.owner_agent) { where.push("owner_agent=?"); params.push(a.owner_agent); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.scope) { where.push("scope=?"); params.push(a.scope); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const lim = Math.min(a.limit || 100, 500);
      const off = a.offset || 0;
      const rows = tdb.prepare(`SELECT id, kind, name, scope, owner_agent, status, url, updated_at FROM entity ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
      return { count: rows.length, entities: rows };
    }
    case "mem_entity_link": {
      if (!a.from_id || !a.to_id || !a.rel) return { error: "from_id + to_id + rel required" };
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS entity_link (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, rel TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(from_id, to_id, rel));`); } catch {}
      const info = tdb.prepare("INSERT OR IGNORE INTO entity_link (from_id, to_id, rel, meta_json) VALUES (?,?,?,?)").run(a.from_id, a.to_id, a.rel, a.meta ? JSON.stringify(a.meta) : null);
      return { id: info.lastInsertRowid || null, from_id: a.from_id, to_id: a.to_id, rel: a.rel, action: info.changes ? "created" : "exists" };
    }
    case "mem_file_owner_set": {
      if (!a.file_path) return { error: "file_path required" };
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS file_ownership (file_path TEXT PRIMARY KEY, host TEXT, primary_agent TEXT, secondary_agents TEXT, last_edit_agent TEXT, last_edit_at TEXT, last_commit_sha TEXT, project_entity_id INTEGER, meta_json TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`); } catch {}
      const now = new Date().toISOString();
      const existing = tdb.prepare("SELECT * FROM file_ownership WHERE file_path=?").get(a.file_path);
      let secondary = existing && existing.secondary_agents ? JSON.parse(existing.secondary_agents) : [];
      if (a.add_secondary && !secondary.includes(a.add_secondary) && a.add_secondary !== (a.primary_agent || (existing && existing.primary_agent))) secondary.push(a.add_secondary);
      if (existing) {
        tdb.prepare("UPDATE file_ownership SET host=COALESCE(?, host), primary_agent=COALESCE(?, primary_agent), secondary_agents=?, last_edit_agent=COALESCE(?, last_edit_agent), last_edit_at=?, last_commit_sha=COALESCE(?, last_commit_sha), project_entity_id=COALESCE(?, project_entity_id), updated_at=? WHERE file_path=?").run(a.host || null, a.primary_agent || null, JSON.stringify(secondary), a.last_edit_agent || null, now, a.last_commit_sha || null, a.project_entity_id || null, now, a.file_path);
        return { file_path: a.file_path, action: "updated" };
      }
      tdb.prepare("INSERT INTO file_ownership (file_path, host, primary_agent, secondary_agents, last_edit_agent, last_edit_at, last_commit_sha, project_entity_id) VALUES (?,?,?,?,?,?,?,?)").run(a.file_path, a.host || null, a.primary_agent || null, JSON.stringify(secondary), a.last_edit_agent || null, now, a.last_commit_sha || null, a.project_entity_id || null);
      return { file_path: a.file_path, action: "created" };
    }
    case "mem_file_owner_get": {
      if (a.file_path) {
        const row = tdb.prepare("SELECT * FROM file_ownership WHERE file_path=?").get(a.file_path);
        if (!row) return { error: "not found", file_path: a.file_path };
        if (row.secondary_agents) try { row.secondary_agents = JSON.parse(row.secondary_agents); } catch {}
        return row;
      }
      if (a.primary_agent) {
        const rows = tdb.prepare("SELECT file_path, host, last_edit_agent, last_edit_at, last_commit_sha FROM file_ownership WHERE primary_agent=? ORDER BY last_edit_at DESC LIMIT ?").all(a.primary_agent, Math.min(a.limit || 100, 500));
        return { count: rows.length, files: rows };
      }
      return { error: "file_path OR primary_agent required" };
    }
    case "mem_wish_capture": {
      if (!a.captured_text) return { error: "captured_text required" };
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS wish_buffer (id INTEGER PRIMARY KEY AUTOINCREMENT, source_channel TEXT, source_chat_id TEXT, source_message_id TEXT, captured_text TEXT NOT NULL, captured_by_agent TEXT, captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), classification TEXT, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, decision_id INTEGER, meta_json TEXT); CREATE INDEX IF NOT EXISTS idx_wish_status ON wish_buffer(status, captured_at);`); } catch {}
      const _wscrub = stripPrivate(a.captured_text);
      const info = tdb.prepare("INSERT INTO wish_buffer (source_channel, source_chat_id, source_message_id, captured_text, captured_by_agent, classification, meta_json) VALUES (?,?,?,?,?,?,?)").run(a.source_channel || null, a.source_chat_id || null, a.source_message_id || null, _wscrub.text, a.captured_by_agent || null, a.classification || "wish", a.meta ? JSON.stringify(a.meta) : null);
      return { id: info.lastInsertRowid, classification: a.classification || "wish", status: "pending", private_redacted: _wscrub.hadPrivate };
    }
    case "mem_wish_list": {
      const where = []; const params = [];
      where.push("status=?"); params.push(a.status || "pending");
      if (a.classification) { where.push("classification=?"); params.push(a.classification); }
      if (a.since) { where.push("captured_at >= ?"); params.push(a.since); }
      const lim = Math.min(a.limit || 100, 500);
      const rows = tdb.prepare(`SELECT id, captured_text, classification, captured_by_agent, captured_at, status, source_channel FROM wish_buffer WHERE ${where.join(" AND ")} ORDER BY captured_at DESC LIMIT ?`).all(...params, lim);
      return { count: rows.length, wishes: rows };
    }
    case "mem_wish_review": {
      if (!a.id || !a.status) return { error: "id + status required" };
      const info = tdb.prepare("UPDATE wish_buffer SET status=?, reviewed_by=?, reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_id=COALESCE(?, decision_id) WHERE id=?").run(a.status, a.reviewed_by || null, a.decision_id || null, a.id);
      return { id: a.id, status: a.status, updated: info.changes };
    }
    case "mem_decision_log": {
      if (!a.title || !a.decided_by) return { error: "title + decided_by required" };
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS decision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'blun', title TEXT NOT NULL, body TEXT, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), agents_involved TEXT, files_affected TEXT, entities_affected TEXT, parent_decision_id INTEGER, status TEXT NOT NULL DEFAULT 'active', superseded_by INTEGER, meta_json TEXT); CREATE INDEX IF NOT EXISTS idx_decision_decided_at ON decision_log(decided_at);`); } catch {}
      const info = tdb.prepare("INSERT INTO decision_log (scope, title, body, decided_by, agents_involved, files_affected, entities_affected, parent_decision_id, meta_json) VALUES (?,?,?,?,?,?,?,?,?)").run(a.scope || "blun", a.title, a.body || null, a.decided_by, a.agents_involved ? JSON.stringify(a.agents_involved) : null, a.files_affected ? JSON.stringify(a.files_affected) : null, a.entities_affected ? JSON.stringify(a.entities_affected) : null, a.parent_decision_id || null, a.meta ? JSON.stringify(a.meta) : null);
      return { id: info.lastInsertRowid, title: a.title, decided_by: a.decided_by, status: "active" };
    }
    case "mem_decision_get": {
      if (a.id) {
        const row = tdb.prepare("SELECT * FROM decision_log WHERE id=?").get(a.id);
        if (!row) return { error: "not found" };
        for (const k of ["agents_involved", "files_affected", "entities_affected", "meta_json"]) {
          if (row[k]) try { row[k] = JSON.parse(row[k]); } catch {}
        }
        return row;
      }
      const where = []; const params = [];
      if (a.scope) { where.push("scope=?"); params.push(a.scope); }
      if (a.decided_by) { where.push("decided_by=?"); params.push(a.decided_by); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.since) { where.push("decided_at >= ?"); params.push(a.since); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const lim = Math.min(a.limit || 50, 500);
      const rows = tdb.prepare(`SELECT id, scope, title, decided_by, decided_at, status FROM decision_log ${w} ORDER BY decided_at DESC LIMIT ?`).all(...params, lim);
      return { count: rows.length, decisions: rows };
    }
    case "mem_agent_status_set": {
      if (!a.agent_name) return { error: "agent_name required" };
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS agent_status_live (agent_name TEXT PRIMARY KEY, current_task TEXT, current_brief_id INTEGER, blocked_on TEXT, dnd_until TEXT, last_heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), host TEXT, pid INTEGER, meta_json TEXT);`); } catch {}
      const now = new Date().toISOString();
      const existing = tdb.prepare("SELECT agent_name FROM agent_status_live WHERE agent_name=?").get(a.agent_name);
      if (existing) {
        tdb.prepare("UPDATE agent_status_live SET current_task=?, current_brief_id=COALESCE(?, current_brief_id), blocked_on=?, dnd_until=COALESCE(?, dnd_until), host=COALESCE(?, host), pid=COALESCE(?, pid), meta_json=COALESCE(?, meta_json), last_heartbeat_at=? WHERE agent_name=?").run(a.current_task === undefined ? null : a.current_task, a.current_brief_id || null, a.blocked_on || null, a.dnd_until || null, a.host || null, a.pid || null, a.meta ? JSON.stringify(a.meta) : null, now, a.agent_name);
        return { agent_name: a.agent_name, action: "updated", last_heartbeat_at: now };
      }
      tdb.prepare("INSERT INTO agent_status_live (agent_name, current_task, current_brief_id, blocked_on, dnd_until, host, pid, meta_json, last_heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?)").run(a.agent_name, a.current_task || null, a.current_brief_id || null, a.blocked_on || null, a.dnd_until || null, a.host || null, a.pid || null, a.meta ? JSON.stringify(a.meta) : null, now);
      return { agent_name: a.agent_name, action: "created", last_heartbeat_at: now };
    }
    case "mem_agent_status_get": {
      if (a.agent_name) {
        const row = tdb.prepare("SELECT * FROM agent_status_live WHERE agent_name=?").get(a.agent_name);
        if (!row) return { error: "not found", agent_name: a.agent_name };
        const now = Date.now();
        row.dnd_active = row.dnd_until ? Date.parse(row.dnd_until) > now : false;
        return row;
      }
      const rows = tdb.prepare("SELECT * FROM agent_status_live ORDER BY last_heartbeat_at DESC").all();
      const now = Date.now();
      for (const r of rows) r.dnd_active = r.dnd_until ? Date.parse(r.dnd_until) > now : false;
      return { count: rows.length, agents: rows };
    }
    case "mem_today_view": {
      const d = a.date || new Date().toISOString().slice(0, 10);
      const start = d + "T00:00:00.000Z";
      const end = d + "T23:59:59.999Z";
      const aname = a.agent_name || null;
      const actions = tdb.prepare(`SELECT id, agent_name, action_kind, target, status, started_at FROM agent_action WHERE started_at BETWEEN ? AND ? ${aname ? "AND agent_name=?" : ""} ORDER BY started_at DESC LIMIT 200`).all(start, end, ...(aname ? [aname] : []));
      const briefs = tdb.prepare(`SELECT id, agent_name, source_agent, status, created_at FROM agent_brief WHERE created_at BETWEEN ? AND ? ${aname ? "AND (agent_name=? OR source_agent=?)" : ""} ORDER BY created_at DESC LIMIT 100`).all(start, end, ...(aname ? [aname, aname] : []));
      let decisions = []; try { decisions = tdb.prepare("SELECT id, title, decided_by, decided_at, scope, status FROM decision_log WHERE decided_at BETWEEN ? AND ? ORDER BY decided_at DESC LIMIT 50").all(start, end); } catch {}
      let file_edits = []; try { file_edits = tdb.prepare(`SELECT file_path, last_edit_agent, last_edit_at, last_commit_sha FROM file_ownership WHERE last_edit_at BETWEEN ? AND ? ${aname ? "AND last_edit_agent=?" : ""} ORDER BY last_edit_at DESC LIMIT 200`).all(start, end, ...(aname ? [aname] : [])); } catch {}
      let wishes = []; try { wishes = tdb.prepare("SELECT id, captured_text, classification, captured_by_agent, status FROM wish_buffer WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at DESC LIMIT 50").all(start, end); } catch {}
      return { date: d, agent_name: aname, actions: { count: actions.length, items: actions }, briefs: { count: briefs.length, items: briefs }, decisions: { count: decisions.length, items: decisions }, file_edits: { count: file_edits.length, items: file_edits }, wishes: { count: wishes.length, items: wishes } };
    }
    case "mem_company_fact_get": {
      const sc = String(a.scope || "blun").toLowerCase();
      const factsPath = path.join(__dirname, "facts", sc + ".json");
      if (!fs.existsSync(factsPath)) return { error: "no facts file for scope: " + sc, hint: "create packages/core/facts/" + sc + ".json" };
      let data;
      try { data = JSON.parse(fs.readFileSync(factsPath, "utf8")); }
      catch (e) { return { error: "facts json parse error: " + e.message }; }
      if (!a.topic) return { scope: sc, _meta: data._meta, topics: Object.keys(data).filter(k => k !== "_meta") };
      const node = data[a.topic];
      if (node === undefined) return { error: "unknown topic: " + a.topic, available: Object.keys(data).filter(k => k !== "_meta") };
      if (!a.key) return { scope: sc, topic: a.topic, value: node };
      if (Array.isArray(node)) {
        const matches = node.filter(it => it && (it.name === a.key || it.sub_brand === a.key || it.alias === a.key));
        return { scope: sc, topic: a.topic, key: a.key, matches };
      }
      if (typeof node === "object") return { scope: sc, topic: a.topic, key: a.key, value: node[a.key] };
      return { scope: sc, topic: a.topic, key: a.key, value: node };
    }
    case "mem_company_fact_set": {
      if (!a.topic || a.value === undefined) return { error: "topic + value required" };
      const sc = String(a.scope || "blun").toLowerCase();
      const factsDir = path.join(__dirname, "facts");
      try { fs.mkdirSync(factsDir, { recursive: true }); } catch {}
      const factsPath = path.join(factsDir, sc + ".json");
      let data = {};
      if (fs.existsSync(factsPath)) {
        try { data = JSON.parse(fs.readFileSync(factsPath, "utf8")); }
        catch (e) { return { error: "existing facts parse error: " + e.message }; }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        try { fs.copyFileSync(factsPath, factsPath + ".bak-" + ts); } catch {}
      }
      data._meta = data._meta || { scope: sc };
      data._meta.updated = new Date().toISOString().slice(0, 10);
      data._meta.last_actor = a.actor || "unknown";
      data[a.topic] = a.value;
      const tmp = factsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, factsPath);
      try {
        tdb.prepare("INSERT INTO memory (kind, source, actor, topic, importance, layer, text) VALUES ('company_fact_set', 'mnemo:fact-set', ?, ?, 0.9, 'semantic', ?)").run(a.actor || "system", a.topic, "scope=" + sc + " topic=" + a.topic + " value=" + JSON.stringify(a.value).slice(0, 500));
      } catch {}
      return { ok: true, scope: sc, topic: a.topic, updated: data._meta.updated };
    }
    case "mem_pre_action_check": {
      if (!a.action_type || !Array.isArray(a.topics)) return { error: "action_type + topics[] required" };
      const sc = String(a.scope || "blun").toLowerCase();
      const factsPath = path.join(__dirname, "facts", sc + ".json");
      const checked = [];
      const missing = [];
      let data = null;
      if (fs.existsSync(factsPath)) {
        try { data = JSON.parse(fs.readFileSync(factsPath, "utf8")); } catch {}
      }
      if (!data) return { status: "block", reason: "no facts file for scope " + sc, action_type: a.action_type, topics: a.topics };
      for (const t of a.topics) {
        if (data[t] !== undefined) checked.push({ topic: t, ok: true, preview: Array.isArray(data[t]) ? `${data[t].length} entries` : (typeof data[t] === "object" ? Object.keys(data[t]).join(", ") : String(data[t]).slice(0, 80)) });
        else missing.push(t);
      }
      const status = missing.length === 0 ? "ok" : "block";
      try {
        tdb.exec("CREATE TABLE IF NOT EXISTS agent_action (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT, action_kind TEXT, target TEXT, status TEXT, payload_json TEXT, topic TEXT, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
        tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'pre_action_check', ?, ?, ?, 'pre_action_check')").run(a.agent_name || "unknown", a.action_type, status, JSON.stringify({ topics: a.topics, missing, summary: a.summary, scope: sc }));
      } catch {}
      return { status, action_type: a.action_type, scope: sc, agent_name: a.agent_name || null, checked, missing, facts: status === "ok" ? a.topics.reduce((acc, t) => (acc[t] = data[t], acc), {}) : null, hint: status === "block" ? "Add missing topics to facts/" + sc + ".json via mem_company_fact_set before proceeding." : "All required facts present — proceed with canonical values, not memory of memory." };
    }
    case "mem_project_registry_upsert": {
      if (!a.name) return { error: "name required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_by TEXT)"); } catch {}
      const fields = ["name"]; const placeholders = ["?"]; const values = [a.name]; const updates = [];
      const stringKeys = ["domain","repo","server","admin_url","auth_system","stripe_account","vat_status","vat_id","live_status","live_url","staging_url","last_deploy_at","notes","updated_by"];
      const jsonKeys = ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"];
      for (const k of stringKeys) if (a[k] !== undefined) { fields.push(k); placeholders.push("?"); values.push(a[k]); updates.push(k + "=excluded." + k); }
      for (const k of jsonKeys) if (a[k] !== undefined) { fields.push(k); placeholders.push("?"); values.push(JSON.stringify(a[k])); updates.push(k + "=excluded." + k); }
      updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      const sql = "INSERT INTO project_registry (" + fields.join(",") + ") VALUES (" + placeholders.join(",") + ") ON CONFLICT(name) DO UPDATE SET " + updates.join(", ");
      tdb.prepare(sql).run(...values);
      return { ok: true, name: a.name };
    }
    case "mem_project_registry_get": {
      try { tdb.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT, updated_by TEXT)"); } catch {}
      const row = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(a.name);
      if (!row) return { error: "not found", name: a.name };
      for (const k of ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"]) {
        if (row[k]) try { row[k] = JSON.parse(row[k]); } catch {}
      }
      return row;
    }
    case "mem_project_registry_list": {
      try { tdb.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT, updated_by TEXT)"); } catch {}
      const where = []; const params = [];
      if (a.live_status) { where.push("live_status=?"); params.push(a.live_status); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare("SELECT name, domain, server, live_status, live_url, vat_status, updated_at FROM project_registry" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY updated_at DESC LIMIT ?").all(...params);
      return { count: rows.length, projects: rows };
    }
    case "mem_backfill_fts": {
      // Idempotent: for each scope, find source rows that don't have a matching
      // mnemo_search_fts entry and insert them. Cheap to re-run; the daemon
      // also runs this at startup. Returns counts per scope.
      const out = {};
      try {
        const missing = tdb.prepare("SELECT b.id, b.agent_name, b.source_agent, b.content FROM agent_brief b LEFT JOIN mnemo_search_fts f ON f.scope='brief' AND f.ref_id=CAST(b.id AS TEXT) WHERE f.rowid IS NULL").all();
        const ins = tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('brief', ?, ?, ?, ?)");
        for (const r of missing) ins.run(String(r.id), r.agent_name || "", r.source_agent || "", (r.content || "").slice(0, 8000));
        out.briefs = missing.length;
      } catch (e) { out.briefs_error = e.message; }
      try {
        const missing = tdb.prepare("SELECT t.id, t.speaker, t.source, t.direction, t.channel, t.content FROM transcript t LEFT JOIN mnemo_search_fts f ON f.scope='transcript' AND f.ref_id=CAST(t.id AS TEXT) WHERE f.rowid IS NULL").all();
        const ins = tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)");
        for (const r of missing) ins.run(String(r.id), r.speaker || r.source || "", (r.direction || "") + (r.channel ? " @ " + r.channel : ""), (r.content || "").slice(0, 8000));
        out.transcripts = missing.length;
      } catch (e) { out.transcripts_error = e.message; }
      // memory-table backfill skipped here — NOT IN over 63k rows is O(n*m).
      // If needed, use LEFT JOIN with paginated batches; left as future work.
      return out;
    }
    case "mem_history_import": {
      // Bulk-ingest historical transcript entries (Telegram exports, Slack
      // exports, old chat logs) into the transcript table. Caller is
      // responsible for parsing the source format into normalized items.
      // Dedup on (source + occurred_at + speaker + first 200 chars of content).
      if (!a.source || !Array.isArray(a.items)) return { error: "source + items[] required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS history_import_marker (key TEXT PRIMARY KEY, imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"); } catch {}
      let inserted = 0, skipped = 0, errors = 0;
      const ins = tdb.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)");
      const mark = tdb.prepare("INSERT OR IGNORE INTO history_import_marker (key) VALUES (?)");
      const seen = tdb.prepare("SELECT 1 FROM history_import_marker WHERE key=? LIMIT 1");
      const txn = tdb.transaction((items) => {
        for (const it of items) {
          try {
            if (!it || !it.content) { skipped++; continue; }
            const occurred = it.occurred_at || it.ts || null;
            const speaker = it.speaker || it.author || it.user || "unknown";
            const ch = it.channel || a.channel || null;
            const dir = it.direction || "in";
            const key = a.source + "|" + (occurred || "") + "|" + speaker + "|" + String(it.content).slice(0, 200);
            if (seen.get(key)) { skipped++; continue; }
            const _scrub = stripPrivate(String(it.content));
            ins.run(a.source, ch, dir, speaker, _scrub.text, it.meta ? JSON.stringify(it.meta) : null, occurred, it.ref_kind || "history_import", it.ref_id ? String(it.ref_id) : null);
            mark.run(key);
            inserted++;
          } catch (e) { errors++; }
        }
      });
      txn(a.items);
      return { source: a.source, inserted, skipped_duplicates: skipped, errors, total: a.items.length };
    }
    case "mem_file_echo": {
      if (!a.file_path) return { error: "file_path required" };
      const lim = Math.min(a.limit || 5, 20);
      const path_basename = a.file_path.split(/[\\/]/).pop() || a.file_path;
      const ownership = (() => { try { return tdb.prepare("SELECT file_path, last_edit_agent, last_edit_at, last_commit_sha FROM file_ownership WHERE file_path=? OR file_path LIKE ? ORDER BY last_edit_at DESC LIMIT ?").all(a.file_path, '%' + path_basename, lim); } catch { return []; } })();
      const claims = (() => { try { return tdb.prepare("SELECT id, agent_name, summary, expires_at FROM work_claim WHERE (file_path=? OR file_path LIKE ?) AND status='active' ORDER BY claimed_at DESC LIMIT ?").all(a.file_path, '%' + path_basename, lim); } catch { return []; } })();
      const briefs = (() => { try { return tdb.prepare("SELECT id, agent_name, source_agent, substr(content,1,180) AS snippet, created_at FROM agent_brief WHERE content LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT ?").all('%' + a.file_path + '%', '%' + path_basename + '%', lim); } catch { return []; } })();
      const decisions = (() => { try { return tdb.prepare("SELECT title, decided_by, decided_at, summary FROM decision_log WHERE summary LIKE ? OR title LIKE ? ORDER BY decided_at DESC LIMIT ?").all('%' + path_basename + '%', '%' + path_basename + '%', lim); } catch { return []; } })();
      const skills = (() => { try { return tdb.prepare("SELECT name, description FROM skill_registry WHERE source_path LIKE ? OR description LIKE ? LIMIT ?").all('%' + path_basename + '%', '%' + path_basename + '%', lim); } catch { return []; } })();
      return { file_path: a.file_path, basename: path_basename, ownership: { count: ownership.length, items: ownership }, active_claims: { count: claims.length, items: claims }, related_briefs: { count: briefs.length, items: briefs }, related_decisions: { count: decisions.length, items: decisions }, matching_skills: { count: skills.length, items: skills } };
    }
    case "mem_focus_set": {
      if (!a.agent_name || !a.focus) return { error: "agent_name + focus required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS agent_focus (agent_name TEXT PRIMARY KEY, focus TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), reason TEXT)"); } catch {}
      tdb.prepare("INSERT INTO agent_focus (agent_name, focus, reason) VALUES (?,?,?) ON CONFLICT(agent_name) DO UPDATE SET focus=excluded.focus, reason=excluded.reason, set_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").run(a.agent_name, a.focus, a.reason || null);
      return { ok: true, agent_name: a.agent_name, focus: a.focus };
    }
    case "mem_focus_get": {
      if (!a.agent_name) return { error: "agent_name required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS agent_focus (agent_name TEXT PRIMARY KEY, focus TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), reason TEXT)"); } catch {}
      const row = tdb.prepare("SELECT focus, set_at, reason FROM agent_focus WHERE agent_name=?").get(a.agent_name);
      const focus = row ? row.focus : "default";
      // Resolve focus_modes section from facts/blun.json so caller gets the slice config inline.
      let slice = null;
      try {
        const factsPath = path.join(__dirname, "facts", "blun.json");
        if (fs.existsSync(factsPath)) {
          const f = JSON.parse(fs.readFileSync(factsPath, "utf8"));
          slice = (f.focus_modes && (f.focus_modes[focus] || f.focus_modes.default)) || null;
        }
      } catch {}
      return { agent_name: a.agent_name, focus, set_at: row ? row.set_at : null, reason: row ? row.reason : null, slice };
    }
    case "mem_lens_view": {
      if (!a.project) return { error: "project required" };
      const lim = Math.min(a.limit || 10, 50);
      try { tdb.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT, updated_by TEXT)"); } catch {}
      const registry = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(a.project);
      if (registry) {
        for (const k of ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"]) {
          if (registry[k]) try { registry[k] = JSON.parse(registry[k]); } catch {}
        }
      }
      const apr = (() => { try { return tdb.prepare("SELECT name, owner_agent, goal_text, status, current_milestone, blocker FROM agent_project WHERE name=?").get(a.project); } catch { return null; } })();
      const decisions = (() => { try { return tdb.prepare("SELECT id, title, decided_by, decided_at, summary FROM decision_log WHERE scope=? ORDER BY decided_at DESC LIMIT ?").all(a.project, lim); } catch { return []; } })();
      const claims = (() => { try { return tdb.prepare("SELECT id, file_path, agent_name, summary, claimed_at, expires_at FROM work_claim WHERE project=? AND status='active' ORDER BY claimed_at DESC").all(a.project); } catch { return []; } })();
      const briefs = (() => { try { return tdb.prepare("SELECT id, agent_name, source_agent, substr(content,1,200) AS snippet, created_at, status FROM agent_brief WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?").all('%' + a.project + '%', lim); } catch { return []; } })();
      const file_edits = (() => { try { return tdb.prepare("SELECT file_path, last_edit_agent, last_edit_at FROM file_ownership WHERE last_edit_at >= datetime('now','-7 day') AND (file_path LIKE ? OR project=?) ORDER BY last_edit_at DESC LIMIT ?").all('%' + a.project.toLowerCase().replace(/\s+/g, '-') + '%', a.project, lim); } catch { return []; } })();
      const status = (() => { try { return apr ? tdb.prepare("SELECT agent_name, current_task, last_heartbeat_at FROM agent_status_live WHERE agent_name=?").get(apr.owner_agent || '') : null; } catch { return null; } })();
      return { project: a.project, registry, current: apr, owner_status: status, decisions: { count: decisions.length, items: decisions }, active_claims: { count: claims.length, items: claims }, recent_briefs: { count: briefs.length, items: briefs }, recent_file_edits: { count: file_edits.length, items: file_edits } };
    }
    case "mem_project_doc_render": {
      if (!a.name) return { error: "name required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT, updated_by TEXT)"); } catch {}
      const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(a.name);
      const apr = (() => { try { return tdb.prepare("SELECT name, owner_agent, goal_text, status, current_milestone, blocker, last_active_at FROM agent_project WHERE name=?").get(a.name); } catch { return null; } })();
      let factsTeam = null, factsLegal = null;
      try {
        const factsPath = path.join(__dirname, "facts", "blun.json");
        if (fs.existsSync(factsPath)) {
          const f = JSON.parse(fs.readFileSync(factsPath, "utf8"));
          factsTeam = f.team; factsLegal = f.legal;
        }
      } catch {}
      const recentDecisions = (() => { try { return tdb.prepare("SELECT title, decided_by, decided_at, summary FROM decision_log WHERE scope=? ORDER BY decided_at DESC LIMIT 10").all(a.name); } catch { return []; } })();
      const recentBriefs = (() => { try { return tdb.prepare("SELECT id, agent_name, source_agent, substr(content,1,140) AS content, created_at FROM agent_brief WHERE content LIKE ? ORDER BY created_at DESC LIMIT 8").all('%' + a.name + '%'); } catch { return []; } })();
      const claims = (() => { try { return tdb.prepare("SELECT file_path, agent_name, summary, expires_at FROM work_claim WHERE project=? AND status='active' ORDER BY claimed_at DESC").all(a.name); } catch { return []; } })();
      const pad = (s, n) => String(s == null ? "" : s).padEnd(n);
      const lines = [];
      lines.push(`# ${a.name} — Project-Doc`);
      lines.push("");
      lines.push("> Auto-rendered by mem_project_doc_render. Source-of-truth lives in mnemo (project_registry + facts/blun.json + recent decisions). Edit facts not this file.");
      lines.push("");
      if (reg) {
        lines.push("## Operations");
        if (reg.domain) lines.push(`- **Domain:** ${reg.domain}`);
        if (reg.live_url) lines.push(`- **Live:** ${reg.live_url} (status: ${reg.live_status || 'unknown'})`);
        if (reg.staging_url) lines.push(`- **Staging:** ${reg.staging_url}`);
        if (reg.repo) lines.push(`- **Repo:** ${reg.repo}`);
        if (reg.server) lines.push(`- **Server:** ${reg.server}`);
        if (reg.pm2_processes) try { const arr = JSON.parse(reg.pm2_processes); if (arr.length) lines.push(`- **PM2:** ${arr.join(", ")}`); } catch {}
        if (reg.nginx_files) try { const arr = JSON.parse(reg.nginx_files); if (arr.length) lines.push(`- **Nginx:** ${arr.join(", ")}`); } catch {}
        if (reg.admin_url) lines.push(`- **Admin:** ${reg.admin_url}`);
        if (reg.auth_system) lines.push(`- **Auth:** ${reg.auth_system}`);
        if (reg.stripe_account) lines.push(`- **Stripe:** ${reg.stripe_account}`);
        if (reg.vat_status) lines.push(`- **VAT:** ${reg.vat_status}${reg.vat_id ? " (" + reg.vat_id + ")" : ""}`);
        if (reg.langs) try { const arr = JSON.parse(reg.langs); if (arr.length) lines.push(`- **Langs:** ${arr.join(", ")}`); } catch {}
        if (reg.last_deploy_at) lines.push(`- **Last deploy:** ${reg.last_deploy_at}`);
      } else {
        lines.push("## Operations");
        lines.push("_No project_registry row yet. Create via mem_project_registry_upsert._");
      }
      lines.push("");
      if (apr) {
        lines.push("## Current state");
        if (apr.owner_agent) lines.push(`- **Owner:** ${apr.owner_agent}`);
        if (apr.goal_text) lines.push(`- **Goal:** ${apr.goal_text}`);
        if (apr.current_milestone) lines.push(`- **Milestone:** ${apr.current_milestone}`);
        if (apr.blocker) lines.push(`- **Blocker:** ${apr.blocker}`);
        if (apr.status) lines.push(`- **Status:** ${apr.status}`);
        lines.push("");
      }
      if (reg && reg.health_checklist) {
        try {
          const c = JSON.parse(reg.health_checklist);
          const keys = Object.keys(c);
          if (keys.length) {
            lines.push("## Health gates");
            for (const k of keys) lines.push(`- ${pad(k, 18)} ${c[k]}`);
            lines.push("");
          }
        } catch {}
      }
      if (claims.length) {
        lines.push("## Active work-claims");
        for (const c of claims) lines.push(`- \`${c.file_path}\` — ${c.agent_name}${c.summary ? ` (${c.summary})` : ""} until ${c.expires_at}`);
        lines.push("");
      }
      if (recentDecisions.length) {
        lines.push("## Recent decisions");
        for (const d of recentDecisions) lines.push(`- ${d.decided_at?.slice(0,10) || ""} **${d.title}** by ${d.decided_by || "?"}${d.summary ? " — " + String(d.summary).slice(0,160) : ""}`);
        lines.push("");
      }
      if (recentBriefs.length) {
        lines.push("## Recent briefs mentioning this project");
        for (const b of recentBriefs) lines.push(`- #${b.id} ${b.created_at?.slice(0,10) || ""} ${b.source_agent || "?"} → ${b.agent_name}: ${(b.content || '').replace(/\s+/g,' ').slice(0,140)}`);
        lines.push("");
      }
      if (factsLegal && (a.include_legal !== false)) {
        lines.push("## Legal (from facts/blun.json)");
        lines.push(`- Entity: ${factsLegal.entity_type || ""} — ${factsLegal.founder || ""}`);
        if (factsLegal.address) lines.push(`- Address: ${factsLegal.address}`);
        if (factsLegal.do_not_use) lines.push(`- Forbidden: ${(factsLegal.do_not_use || []).join(", ")}`);
        lines.push("");
      }
      lines.push("---");
      lines.push(`Rendered ${new Date().toISOString()} from mnemo project_registry + facts.`);
      return { project: a.name, doc: lines.join("\n"), bytes: lines.join("\n").length };
    }
    case "mem_project_live_check": {
      if (!a.name) return { error: "name required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT, updated_by TEXT)"); } catch {}
      const row = tdb.prepare("SELECT name, live_status, vat_status, health_checklist FROM project_registry WHERE name=?").get(a.name);
      if (!row) return { status: "block", reason: "project_registry has no row for " + a.name, hint: "Create it via mem_project_registry_upsert first." };
      let checklist = {};
      try { checklist = row.health_checklist ? JSON.parse(row.health_checklist) : {}; } catch {}
      const defaults = ["auth","billing","vat","legal","mobile","header_footer","pricing","checkout"];
      const required = Array.isArray(a.required_gates) && a.required_gates.length ? a.required_gates : defaults;
      const passed = []; const blocked = []; const unknown = [];
      for (const g of required) {
        const v = checklist[g];
        if (v === "pass") passed.push(g);
        else if (v === "block") blocked.push(g);
        else unknown.push(g);
      }
      const status = (blocked.length === 0 && unknown.length === 0) ? "ok" : "block";
      try {
        tdb.exec("CREATE TABLE IF NOT EXISTS agent_action (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT, action_kind TEXT, target TEXT, status TEXT, payload_json TEXT, topic TEXT, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
        tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_live_check', ?, ?, ?, 'project_live_check')").run(a.agent_name || "unknown", a.name, status, JSON.stringify({ required, passed, blocked, unknown }));
      } catch {}
      return { status, project: a.name, required, passed, blocked, unknown, hint: status === "block" ? "Resolve blocked + unknown gates via mem_project_registry_upsert health_checklist={...} before flipping live_status to 'live'." : "All required gates pass — safe to deploy." };
    }
    case "mem_work_claim": {
      if (!a.project || !a.file_path || !a.agent_name) return { error: "project + file_path + agent_name required" };
      const ttl = Math.max(1, Math.min(1440, a.ttl_minutes || 240));
      try { tdb.exec("CREATE TABLE IF NOT EXISTS work_claim (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, file_path TEXT NOT NULL, agent_name TEXT NOT NULL, summary TEXT, claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'); CREATE INDEX IF NOT EXISTS idx_work_claim_active ON work_claim(file_path, status, expires_at); CREATE INDEX IF NOT EXISTS idx_work_claim_project ON work_claim(project, status);"); } catch {}
      try { tdb.prepare("UPDATE work_claim SET status='expired' WHERE status='active' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run(); } catch {}
      const existing = tdb.prepare("SELECT * FROM work_claim WHERE file_path=? AND status='active' ORDER BY id DESC LIMIT 1").get(a.file_path);
      if (existing && existing.agent_name !== a.agent_name) {
        return { ok: false, blocked_by: existing.agent_name, claimed_at: existing.claimed_at, expires_at: existing.expires_at, existing_id: existing.id, summary: existing.summary, hint: "Coordinate with " + existing.agent_name + " or wait until " + existing.expires_at + ". If their claim is stale, ask them to mem_work_release." };
      }
      if (existing && existing.agent_name === a.agent_name) {
        const newExp = new Date(Date.now() + ttl * 60000).toISOString();
        tdb.prepare("UPDATE work_claim SET expires_at=?, summary=COALESCE(?, summary) WHERE id=?").run(newExp, a.summary || null, existing.id);
        return { ok: true, id: existing.id, action: "refreshed", expires_at: newExp };
      }
      const expires = new Date(Date.now() + ttl * 60000).toISOString();
      const info = tdb.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, expires_at) VALUES (?,?,?,?,?)").run(a.project, a.file_path, a.agent_name, a.summary || null, expires);
      return { ok: true, id: info.lastInsertRowid, action: "claimed", expires_at: expires };
    }
    case "mem_work_release": {
      try { tdb.exec("CREATE TABLE IF NOT EXISTS work_claim (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, file_path TEXT NOT NULL, agent_name TEXT NOT NULL, summary TEXT, claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"); } catch {}
      let row;
      if (a.id) row = tdb.prepare("SELECT * FROM work_claim WHERE id=?").get(a.id);
      else if (a.file_path && a.agent_name) row = tdb.prepare("SELECT * FROM work_claim WHERE file_path=? AND agent_name=? AND status='active' ORDER BY id DESC LIMIT 1").get(a.file_path, a.agent_name);
      else return { error: "id OR (file_path+agent_name) required" };
      if (!row) return { error: "no active claim found" };
      tdb.prepare("UPDATE work_claim SET status='released', summary=COALESCE(?, summary) WHERE id=?").run(a.outcome ? "released: " + a.outcome : null, row.id);
      return { ok: true, id: row.id, file_path: row.file_path };
    }
    case "mem_work_active": {
      try { tdb.exec("CREATE TABLE IF NOT EXISTS work_claim (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, file_path TEXT NOT NULL, agent_name TEXT NOT NULL, summary TEXT, claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"); } catch {}
      try { tdb.prepare("UPDATE work_claim SET status='expired' WHERE status='active' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run(); } catch {}
      const where = ["status='active'"];
      const params = [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      const lim = Math.min(a.limit || 50, 200);
      params.push(lim);
      const rows = tdb.prepare("SELECT * FROM work_claim WHERE " + where.join(" AND ") + " ORDER BY claimed_at DESC LIMIT ?").all(...params);
      return { count: rows.length, claims: rows };
    }
    case "mem_work_similar": {
      if (!a.file_path) return { error: "file_path required" };
      try { tdb.exec("CREATE TABLE IF NOT EXISTS work_claim (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, file_path TEXT NOT NULL, agent_name TEXT NOT NULL, summary TEXT, claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"); } catch {}
      const lim = Math.min(a.limit || 20, 100);
      const dir = a.file_path.includes('/') ? a.file_path.replace(/\/[^\/]+$/, '/') : a.file_path;
      const pattern = dir + '%';
      const params = [a.file_path, pattern];
      let where = "(file_path=? OR file_path LIKE ?)";
      if (a.project) { where += " AND project=?"; params.push(a.project); }
      where += " AND (status='active' OR claimed_at > datetime('now','-1 day'))";
      params.push(lim);
      const rows = tdb.prepare("SELECT id, project, file_path, agent_name, summary, claimed_at, expires_at, status FROM work_claim WHERE " + where + " ORDER BY claimed_at DESC LIMIT ?").all(...params);
      return { count: rows.length, similar: rows, exact_match_count: rows.filter(r => r.file_path === a.file_path).length };
    }
    case "mem_skill_list": {
      const rows = tdb.prepare("SELECT name, description, sandbox, requires_confirmation, status, source_path, length(body) AS body_len FROM skill_registry ORDER BY name").all();
      return { count: rows.length, skills: rows };
    }
    case "mem_skill_get": {
      const row = tdb.prepare("SELECT name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, body, source_path, status, created_at, updated_at FROM skill_registry WHERE name=?").get(a.name);
      if (!row) return { error: "skill_not_found", name: a.name };
      try { row.trigger_phrases = JSON.parse(row.trigger_phrases || "[]"); } catch {}
      try { row.sensitive_data = JSON.parse(row.sensitive_data || "[]"); } catch {}
      return row;
    }
    case "mem_skill_match": {
      if (!a.text) return { error: "text required" };
      return { matches: matchSkillsForText(tdb, a.text) };
    }
    case "mem_skill_register": {
      const triggers = Array.isArray(a.trigger_phrases) ? a.trigger_phrases : [];
      const sensitive = Array.isArray(a.sensitive_data) ? a.sensitive_data : [];
      tdb.prepare("INSERT INTO skill_registry (name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, body, source_path, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET description=excluded.description, trigger_phrases=excluded.trigger_phrases, sandbox=excluded.sandbox, requires_confirmation=excluded.requires_confirmation, sensitive_data=excluded.sensitive_data, body=excluded.body, source_path=excluded.source_path, status=excluded.status, updated_at=excluded.updated_at").run(a.name, a.description || "", JSON.stringify(triggers), a.sandbox || "none", a.requires_confirmation ? 1 : 0, JSON.stringify(sensitive), a.body || "", a.source_path || null, a.status || "active");
      return { name: a.name, status: "registered" };
    }
    case "mem_skill_run": {
      const sk = tdb.prepare("SELECT name, source_path, sandbox, requires_confirmation FROM skill_registry WHERE name=? AND status='active'").get(a.name);
      if (!sk) return { error: "skill_not_found_or_inactive", name: a.name };
      if (sk.requires_confirmation && !a.confirmed) return { error: "requires_confirmation", name: a.name, hint: "pass confirmed: true to authorize" };
      const skillDir = sk.source_path ? path.dirname(sk.source_path) : null;
      if (!skillDir) return { error: "no_runnable", name: a.name };
      const t0 = Date.now();
      const inv = tdb.prepare("INSERT INTO skill_invocation (skill_name, agent_name, input, status) VALUES (?,?,?,?)").run(a.name, a.agent_name || null, a.input || "", "running");
      const invId = inv.lastInsertRowid;
      try {
        const cp = require("child_process");
        const runScript = path.join(__dirname, "skills", "skill_runner.js");
        const args = [runScript, skillDir];
        if (a.input) { args.push("--input", a.input); }
        if (a.confirmed) { args.push("--allow-confirm"); }
        const out = cp.spawnSync("node", args, { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        const dur = Date.now() - t0;
        const outputCombined = (out.stdout || "") + (out.stderr ? "\n[stderr]\n" + out.stderr : "");
        tdb.prepare("UPDATE skill_invocation SET output=?, exit_code=?, duration_ms=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=? WHERE id=?").run(outputCombined.slice(0, 16384), out.status, dur, out.status === 0 ? "ok" : "error", invId);
        return { invocation_id: invId, name: a.name, exit_code: out.status, duration_ms: dur, output_preview: outputCombined.slice(0, 2000) };
      } catch (e) {
        tdb.prepare("UPDATE skill_invocation SET output=?, exit_code=?, status=? WHERE id=?").run(String(e.message), -1, "error", invId);
        return { error: "run_failed", name: a.name, message: e.message };
      }
    }
    case "mem_skill_invocations": {
      const where = []; const params = [];
      if (a.skill_name) { where.push("skill_name=?"); params.push(a.skill_name); }
      params.push(Math.min(a.limit || 20, 100));
      const sql = "SELECT id, skill_name, agent_name, exit_code, duration_ms, started_at, finished_at, status, substr(input,1,200) AS input_preview, substr(output,1,200) AS output_preview FROM skill_invocation" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY started_at DESC LIMIT ?";
      const rows = tdb.prepare(sql).all(...params);
      return { count: rows.length, invocations: rows };
    }
    case "mem_nudge_check": {
      const N = parseInt(a.threshold || 30, 10);
      const lastReflect = tdb.prepare("SELECT MAX(started_at) ts FROM agent_action WHERE agent_name=? AND topic='reflect'").get(a.agent_name);
      const since = lastReflect && lastReflect.ts ? lastReflect.ts : '1970-01-01';
      const actCount = tdb.prepare("SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND started_at > ? AND status != 'rollup'").get(a.agent_name, since).c;
      return { agent_name: a.agent_name, since, actions_since: actCount, threshold: N, reflect_recommended: actCount >= N };
    }
    case "mem_brief_drop_batch": {
      const items = Array.isArray(a.briefs) ? a.briefs : [];
      if (!items.length) return { error: "briefs array required and non-empty" };
      const ins = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const txn = tdb.transaction(rows => {
        const out = [];
        for (const r of rows) {
          const info = ins.run(r.agent_name, r.source_agent || a.source_agent || null, r.content, r.meta ? JSON.stringify(r.meta) : null, r.parent_id || null, r.supersedes || null);
          out.push({ id: info.lastInsertRowid, agent_name: r.agent_name });
        }
        return out;
      });
      const inserted = txn(items);
      // Fire hooks + FTS outside transaction (best effort)
      for (const r of inserted) {
        try { fireBriefHook(tdb, r.id, "drop_batch", { agent_name: r.agent_name }); } catch (e) {}
        const src = items.find(x => x.agent_name === r.agent_name) || items[0];
        try { ftsIndex(tdb, "brief", r.id, r.agent_name, src.source_agent || "", src.content); } catch (e) {}
      }
      return { count: inserted.length, ids: inserted.map(x => x.id), inserted };
    }
    case "mem_brief_drop_multi": {
      const targets = Array.isArray(a.agent_names) ? a.agent_names : [];
      if (!targets.length || !a.content) return { error: "agent_names array + content required" };
      const ins = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const ids = [];
      const txn = tdb.transaction(names => {
        for (const n of names) {
          const info = ins.run(n, a.source_agent || null, a.content, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
          ids.push({ id: info.lastInsertRowid, agent_name: n });
        }
      });
      txn(targets);
      for (const r of ids) {
        try { fireBriefHook(tdb, r.id, "drop_multi", { agent_name: r.agent_name }); } catch (e) {}
        try { ftsIndex(tdb, "brief", r.id, r.agent_name, a.source_agent || "", a.content); } catch (e) {}
      }
      return { fanout: ids.length, brief_ids: ids.map(x => x.id), inserted: ids };
    }
    case "mem_brief_drop_from_template": {
      const tpl = tdb.prepare("SELECT body_template FROM brief_template WHERE name=?").get(a.template);
      if (!tpl) return { error: "template_not_found", template: a.template };
      let body = tpl.body_template;
      const vars = a.vars || {};
      for (const k of Object.keys(vars)) {
        const re = new RegExp("\\{\\{\\s*" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}\\}", "g");
        body = body.replace(re, String(vars[k] == null ? "" : vars[k]));
      }
      const info = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)").run(a.agent_name, a.source_agent || null, body, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      try { fireBriefHook(tdb, newId, "drop", { agent_name: a.agent_name, template: a.template }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, a.agent_name, a.source_agent || "", body); } catch (e) {}
      return { id: newId, agent_name: a.agent_name, template: a.template };
    }
    case "mem_brief_template_list": {
      const rows = tdb.prepare("SELECT name, description, length(body_template) AS body_len FROM brief_template ORDER BY name").all();
      return { count: rows.length, templates: rows };
    }
    case "mem_brief_template_upsert": {
      tdb.prepare("INSERT INTO brief_template (name, body_template, description) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET body_template=excluded.body_template, description=excluded.description").run(a.name, a.body_template, a.description || null);
      return { name: a.name, status: "ok" };
    }
    case "mem_search": {
      const scopes = Array.isArray(a.scope) && a.scope.length ? a.scope : ["brief"];
      const limit = Math.min(a.limit || 20, 100);
      // Sanitize FTS5 query: strip operators except basic terms, allow phrase quoting
      const raw = String(a.query || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!raw) return { error: "query required" };
      const q = raw.split(/\s+/).filter(Boolean).map(t => '"' + t + '"').join(" ");
      const placeholders = scopes.map(() => "?").join(",");
      const rows = tdb.prepare(
        "SELECT scope, ref_id, agent_name, summary, snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS snippet, rank " +
        "FROM mnemo_search_fts WHERE scope IN (" + placeholders + ") AND mnemo_search_fts MATCH ? " +
        "ORDER BY rank LIMIT ?"
      ).all(...scopes, q, limit);
      return { count: rows.length, query: q, scopes, results: rows };
    }
    case "mem_brief_status": {
      const row = tdb.prepare("SELECT id, agent_name, source_agent, channel, status, created_at, dispatched_at, done_at, outcome, parent_id, supersedes_id, superseded_by_id, length(content) AS content_len FROM agent_brief WHERE id=?").get(a.id);
      if (!row) return { error: "not_found", id: a.id };
      const reactions = tdb.prepare("SELECT id, agent_name, kind, payload, created_at FROM agent_brief_reaction WHERE brief_id=? ORDER BY created_at ASC").all(a.id);
      row.reactions = reactions;
      return row;
    }
    case "mem_brief_react": {
      const info = tdb.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)").run(a.brief_id, a.agent_name, a.kind, a.payload ? (typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload)) : null);
      try { fireBriefHook(tdb, a.brief_id, "reaction", { agent_name: a.agent_name, kind: a.kind }); } catch (e) {}
      return { id: info.lastInsertRowid, brief_id: a.brief_id, agent_name: a.agent_name, kind: a.kind };
    }
    case "mem_agent_set_peer": {
      const cur = tdb.prepare("SELECT agent_name FROM agent_registry WHERE agent_name=?").get(a.agent_name);
      if (!cur) return { error: "agent_not_registered", agent_name: a.agent_name };
      tdb.prepare("UPDATE agent_registry SET peer_endpoint=?, idle_after_min=? WHERE agent_name=?").run(a.peer_endpoint || null, a.idle_after_min || null, a.agent_name);
      return { agent_name: a.agent_name, peer_endpoint: a.peer_endpoint || null, idle_after_min: a.idle_after_min || null };
    }
    case "mem_agent_set_notify": {
      const cur = tdb.prepare("SELECT agent_name FROM agent_registry WHERE agent_name=?").get(a.agent_name);
      if (!cur) return { error: "agent_not_registered", agent_name: a.agent_name };
      tdb.prepare("UPDATE agent_registry SET notify_webhook=?, notify_telegram_chat=? WHERE agent_name=?").run(a.webhook || null, a.telegram_chat ? String(a.telegram_chat) : null, a.agent_name);
      return { agent_name: a.agent_name, webhook: a.webhook || null, telegram_chat: a.telegram_chat || null };
    }
    case "mem_brief_health": {
      const tot = tdb.prepare("SELECT COUNT(*) c FROM agent_brief").get().c;
      const pending = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='pending'").get().c;
      const dispatched = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='dispatched'").get().c;
      const done = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='done' OR status='deploy-issue'").get().c;
      const perAgent = tdb.prepare("SELECT agent_name, COUNT(*) pending FROM agent_brief WHERE status='pending' GROUP BY agent_name ORDER BY 2 DESC").all();
      const lastHour = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE created_at > datetime('now','-1 hour')").get().c;
      return { briefs_total: tot, pending, dispatched, done, last_hour_drops: lastHour, queue_per_agent: perAgent, limits: { payload_max_kb: 4096, drops_per_hour_per_agent: 200, default_pull_limit: 50 } };
    }
    case "mem_brief_list": {
      const where = ["1=1"]; const params = [];
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.status)     { where.push("status=?");     params.push(a.status); }
      params.push(Math.min(a.limit || 20, 200));
      const rows = tdb.prepare(
        "SELECT id, agent_name, source_agent, status, created_at, dispatched_at, done_at, " +
        "substr(content,1,160) AS preview, channel, outcome " +
        "FROM agent_brief WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, briefs: rows };
    }
    case "mem_action_log": {
      const stmt = tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, started_at, session_id, topic, meta_json) VALUES (?,?,?,?,?,?,?,?,?)");
      const r = stmt.run(
        a.agent_name || "dieter",
        a.action_kind,
        a.target || null,
        a.status || "started",
        a.payload ? JSON.stringify(a.payload) : null,
        a.started_at || new Date().toISOString(),
        a.session_id || null,
        a.topic || null,
        a.meta ? JSON.stringify(a.meta) : null
      );
      return { id: r.lastInsertRowid, agent_name: a.agent_name || "dieter", action_kind: a.action_kind };
    }
    case "mem_action_finish": {
      const finishedAt = new Date().toISOString();
      const startedRow = tdb.prepare("SELECT started_at FROM agent_action WHERE id=?").get(a.id);
      let latency = null;
      if (startedRow && startedRow.started_at) {
        latency = Date.parse(finishedAt) - Date.parse(startedRow.started_at);
      }
      tdb.prepare("UPDATE agent_action SET status=?, finished_at=?, latency_ms=?, result_json=? WHERE id=?")
        .run(a.status || "ok", finishedAt, latency, a.result ? JSON.stringify(a.result) : null, a.id);
      return { id: a.id, status: a.status || "ok", latency_ms: latency };
    }
    case "mem_actions_recent": {
      const where = ["1=1"]; const params = [];
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.action_kind) { where.push("action_kind=?"); params.push(a.action_kind); }
      if (a.topic) { where.push("topic=?"); params.push(a.topic); }
      if (a.since) { where.push("started_at >= ?"); params.push(a.since); }
      params.push(Math.min(a.limit || 50, 500));
      const rows = tdb.prepare(
        "SELECT id, agent_name, action_kind, target, status, started_at, finished_at, latency_ms, " +
        "substr(payload_json,1,200) AS payload_preview, substr(result_json,1,200) AS result_preview, " +
        "session_id, topic " +
        "FROM agent_action WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, actions: rows };
    }
    case "mem_actions_search": {
      const q = String(a.q || "").trim();
      if (!q) throw new Error("q required");
      const like = "%" + q + "%";
      const rows = tdb.prepare(
        "SELECT id, agent_name, action_kind, target, status, started_at, latency_ms " +
        "FROM agent_action WHERE target LIKE ? OR payload_json LIKE ? OR result_json LIKE ? OR topic LIKE ? " +
        "ORDER BY started_at DESC LIMIT ?"
      ).all(like, like, like, like, Math.min(a.limit || 30, 200));
      return { count: rows.length, actions: rows };
    }
    case "mem_reflect_now": {
      const agent = a.agent_name || "dieter";
      const sinceIso = a.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const counts = tdb.prepare(
        "SELECT COUNT(*) c, SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) inflight " +
        "FROM agent_action WHERE agent_name=? AND started_at >= ?"
      ).get(agent, sinceIso);
      const topTopics = tdb.prepare(
        "SELECT COALESCE(topic,'(none)') AS topic, COUNT(*) AS n FROM agent_action " +
        "WHERE agent_name=? AND started_at >= ? GROUP BY topic ORDER BY n DESC LIMIT 5"
      ).all(agent, sinceIso);
      const lastFew = tdb.prepare(
        "SELECT id, action_kind, target, status, started_at FROM agent_action " +
        "WHERE agent_name=? AND started_at >= ? ORDER BY started_at DESC LIMIT 5"
      ).all(agent, sinceIso);
      const inflightTop = tdb.prepare(
        "SELECT id, action_kind, target, started_at FROM agent_action " +
        "WHERE agent_name=? AND finished_at IS NULL AND started_at >= ? " +
        "ORDER BY started_at DESC LIMIT 5"
      ).all(agent, sinceIso);
      let pendingBriefs = [];
      try {
        pendingBriefs = tdb.prepare(
          "SELECT id, source_agent, channel, created_at, substr(content,1,160) AS preview " +
          "FROM agent_brief WHERE agent_name=? AND status IN ('pending','dispatched') " +
          "ORDER BY created_at DESC LIMIT 5"
        ).all(agent);
      } catch (e) {}
      let lastReflection = null;
      try {
        lastReflection = tdb.prepare(
          "SELECT date, substr(text,1,400) AS preview FROM daily_reflection ORDER BY date DESC LIMIT 1"
        ).get();
      } catch (e) {}
      return {
        agent_name: agent,
        now: new Date().toISOString(),
        since: sinceIso,
        counts: { actions: counts.c || 0, inflight: counts.inflight || 0, pending_briefs: pendingBriefs.length },
        top_topics: topTopics,
        last_few_actions: lastFew,
        inflight_actions: inflightTop,
        pending_briefs: pendingBriefs,
        last_daily_reflection: lastReflection,
        hint: "actions=total today, inflight=started but not finished. Address inflight + pending_briefs before starting new work.",
      };
    }
    default:
      throw new Error("unknown tool: " + name);
  }
}
server.listen(PORT, HOST, () => {
  console.log(`[mnemo-daemon] HTTP on ${HOST}:${PORT}`);
  recordWrite("daemon_boot", 0, "alive");
});

// ---------- Telegram poller ----------
function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!TG_TOKEN) return reject(new Error("TELEGRAM_BOT_TOKEN missing"));
    const body = JSON.stringify(params || {});
    const req = https.request({
      method: "POST",
      host: "api.telegram.org",
      path: `/bot${TG_TOKEN}/${method}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (resp) => {
      let buf = "";
      resp.on("data", c => buf += c);
      resp.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function loadOffset() {
  try { return parseInt(fs.readFileSync(TG_OFFSET_FILE, "utf8"), 10) || 0; }
  catch { return 0; }
}
function saveOffset(off) {
  try { fs.writeFileSync(TG_OFFSET_FILE, String(off)); } catch {}
}

async function pollTelegram() {
  if (!TG_TOKEN) return;
  let offset = loadOffset();
  try {
    const r = await tgRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    if (!r.ok) {
      recordWrite("telegram_poller", 0, "error: " + (r.description || "unknown"));
      return;
    }
    let added = 0;
    for (const upd of r.result || []) {
      offset = Math.max(offset, upd.update_id + 1);
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat && msg.chat.id);
      if (OWNER_CHAT_ID && chatId !== OWNER_CHAT_ID) continue;
      const userId = String(msg.from && msg.from.id);
      const isOwner = userId === OWNER_CHAT_ID;
      const occurred = new Date((msg.date || 0) * 1000).toISOString();
      const result = ingestEvent({
        kind: "message",
        source: "telegram",
        source_ref: "tg:" + msg.message_id,
        occurred_at: occurred,
        actor: isOwner ? OWNER_NAME : (msg.from && (msg.from.first_name || msg.from.username) || "unknown"),
        actor_id: userId,
        importance: isOwner ? 7 : 5,
        text: msg.text,
        meta: { chat_id: chatId, message_id: msg.message_id, raw_from: msg.from },
      });
      if (result.inserted) added++;
    }
    saveOffset(offset);
    if (added > 0) recordWrite("telegram_poller", added, "alive");
    else recordWrite("telegram_poller", 0, "alive_no_new");
  } catch (e) {
    recordWrite("telegram_poller", 0, "error: " + String(e.message).slice(0, 100));
  }
}

// Long-poll loop
async function telegramLoop() {
  while (true) {
    await pollTelegram();
    await new Promise(r => setTimeout(r, 1000));
  }
}
if (TG_TOKEN) {
  console.log("[mnemo-daemon] starting Telegram poller for chat", OWNER_CHAT_ID || "(any)");
  telegramLoop();
} else {
  console.log("[mnemo-daemon] TELEGRAM_BOT_TOKEN not set, poller disabled");
  recordWrite("telegram_poller", 0, "disabled_no_token");
}

// ---------- Auto-Scar from corrections — every 30s scan new messages ----------
function getHighWater() {
  try {
    const r = db.prepare("SELECT v FROM scar_high_water WHERE k='last_scanned_id'").get();
    return r ? r.v : 0;
  } catch { return 0; }
}
function setHighWater(v) {
  try {
    db.prepare("INSERT INTO scar_high_water (k,v) VALUES ('last_scanned_id',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(v);
  } catch {}
}

const SCAR_DEDUP_WINDOW_MIN = 30;

function autoScarSweep() {
  try {
    const cursor = getHighWater();
    const newMessages = db.prepare(`
      SELECT id, actor, occurred_at, text FROM memory
      WHERE kind='message' AND id > ?
      ORDER BY id ASC
      LIMIT 500
    `).all(cursor);
    if (!newMessages.length) return;
    const patterns = db.prepare("SELECT * FROM correction_pattern").all();
    let scarCount = 0;
    let maxId = cursor;
    for (const msg of newMessages) {
      maxId = Math.max(maxId, msg.id);
      for (const pat of patterns) {
        // Honor actor_scope: only scan messages from the right speaker
        if (pat.actor_scope && pat.actor_scope !== msg.actor) continue;
        let regex;
        try { regex = new RegExp(pat.pattern, "i"); } catch { continue; }
        if (!regex.test(msg.text)) continue;
        // Dedup window: skip if same pattern fired within last 30 min
        const recentHit = db.prepare(`
          SELECT id FROM scar_event
          WHERE pattern_id = ?
            AND occurred_at > datetime('now', '-${SCAR_DEDUP_WINDOW_MIN} minutes')
          LIMIT 1
        `).get(pat.id);
        if (recentHit) continue;
        db.prepare(`INSERT INTO scar_event (scar_slug, triggering_memory_id, pattern_id, trait_delta_applied, notes) VALUES (?,?,?,?,?)`)
          .run(pat.classifier, msg.id, pat.id, pat.delta || 0,
            `Pattern '${pat.pattern}' matched in ${msg.actor}: "${msg.text.slice(0,80)}"`);
        db.prepare(`UPDATE correction_pattern SET hit_count=hit_count+1, last_hit_at=? WHERE id=?`)
          .run(now(), pat.id);
        if (pat.trait_to_adjust && pat.delta) {
          const trait = db.prepare("SELECT name, weight, notes FROM personality_trait WHERE name=?").get(pat.trait_to_adjust);
          if (trait) {
            const isHardCapped = trait.notes && trait.notes.includes("HARD_CAP=0.0");
            if (!isHardCapped) {
              const newWeight = Math.max(0, Math.min(1, trait.weight + pat.delta));
              db.prepare("UPDATE personality_trait SET weight=?, evidence_count=evidence_count+1, last_updated_at=? WHERE name=?")
                .run(newWeight, now(), pat.trait_to_adjust);
              db.prepare(`INSERT INTO trait_event (trait_id, memory_id, delta, reason, classifier) VALUES ((SELECT id FROM personality_trait WHERE name=?),?,?,?,?)`)
                .run(pat.trait_to_adjust, msg.id, pat.delta, `auto-scar from pattern ${pat.id}`, pat.classifier);
            }
          }
        }
        scarCount++;
      }
    }
    setHighWater(maxId);
    recordWrite("auto_scar_scanner", scarCount, "alive");
  } catch (e) {
    recordWrite("auto_scar_scanner", 0, "error: " + String(e.message).slice(0,100));
  }
}
setInterval(autoScarSweep, 30 * 1000);
setTimeout(autoScarSweep, 7000);

// ---------- Sleep-Protect outbound queue flusher ----------
function isInQuietHours() {
  const now_utc = new Date();
  const local_h = (now_utc.getUTCHours() + TZ_OFFSET_HOURS + 24) % 24;
  if (QUIET_START < QUIET_END) {
    return local_h >= QUIET_START && local_h < QUIET_END;
  }
  return local_h >= QUIET_START || local_h < QUIET_END;
}

// Channel registry — abstracts over Telegram/WhatsApp/Email/etc.
let channelRegistry = null;
try { channelRegistry = require("./channels"); }
catch (e) { console.error("[mnemo-daemon] channels registry load failed:", e.message); }

async function flushOutboundQueue() {
  try {
    const now_iso = now();
    const due = db.prepare(`SELECT * FROM outbound_queue WHERE status='queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY priority DESC, queued_at ASC LIMIT 20`).all(now_iso);
    let sent = 0, failed = 0, skipped = 0;
    for (const m of due) {
      if (isInQuietHours() && m.priority < 9) { skipped++; continue; }
      if (!channelRegistry) { skipped++; continue; }
      const ch = channelRegistry.get(m.channel);
      if (!ch || !ch.isEnabled()) { skipped++; continue; }
      try {
        const r = await ch.send(m.recipient, m.text, {});
        db.prepare("UPDATE outbound_queue SET status='delivered', delivered_at=? WHERE id=?")
          .run(now(), m.id);
        sent++;
      } catch (e) {
        db.prepare("UPDATE outbound_queue SET status='failed' WHERE id=?").run(m.id);
        failed++;
      }
    }
    if (sent || failed) recordWrite("outbound_flusher", sent, failed > 0 ? `partial:${failed}_failed` : "alive");
  } catch (e) {}
}
setInterval(() => { flushOutboundQueue().catch(() => {}); }, 60 * 1000);

// ---------- Daily reflection cron ----------
function maybeRunDailyReflection() {
  const d = new Date();
  if (d.getHours() === 23 && d.getMinutes() < 5) {
    const today = d.toISOString().slice(0, 10);
    const exists = db.prepare("SELECT 1 FROM daily_reflection WHERE reflection_date=?").get(today);
    if (!exists) {
      try {
        // simple synthesis (counts only — full LLM-pass added in Phase 2)
        const fromTs = today + "T00:00:00Z";
        const toTs = today + "T23:59:59Z";
        const all = db.prepare(`
          SELECT actor, text FROM memory
          WHERE kind='message' AND occurred_at BETWEEN ? AND ?
        `).all(fromTs, toTs);
        let corrections = 0, praises = 0;
        for (const e of all) {
          if (e.actor !== OWNER_NAME) continue;
          if (/\b(stop|hör auf|nicht so|falsch|kein|fantasi|kacke|scheiße|kaputt)/i.test(e.text)) corrections++;
          if (/\b(geil|super|perfekt|top|stark|hammer|granate)/i.test(e.text)) praises++;
        }
        db.prepare(`
          INSERT INTO daily_reflection (reflection_date, events_examined, corrections, praises, summary)
          VALUES (?,?,?,?,?)
        `).run(today, all.length, corrections, praises,
          `${all.length} messages, ${corrections} corrections, ${praises} praises (auto-cron synthesis).`);
        recordWrite("reflection_cron", 1, "alive");
      } catch (e) {
        recordWrite("reflection_cron", 0, "error: " + String(e.message).slice(0,100));
      }
    }
  }
}

// ---------- URL Watcher — polls tracked_url every 5 min ----------
const url_module = require("url");
function pollUrl(rec) {
  return new Promise((resolve) => {
    try {
      const u = url_module.parse(rec.url);
      const lib = u.protocol === "https:" ? https : http;
      const start = Date.now();
      const req = lib.request({
        method: "HEAD",
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.path || "/",
        timeout: 8000,
        headers: { "user-agent": "Mnemo-URL-Watcher/0.1" },
      }, (res) => {
        const ms = Date.now() - start;
        resolve({ status: res.statusCode || 0, ms });
        res.resume();
      });
      req.on("error", () => resolve({ status: 0, ms: Date.now() - start, error: true }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, ms: Date.now() - start, timeout: true }); });
      req.end();
    } catch (e) { resolve({ status: 0, ms: 0, error: true }); }
  });
}

async function urlSweep() {
  const urls = db.prepare("SELECT * FROM tracked_url").all();
  for (const u of urls) {
    const r = await pollUrl(u);
    const success = r.status === u.expected_status;
    const failures = success ? 0 : (u.consecutive_failures || 0) + 1;
    db.prepare(`UPDATE tracked_url SET last_checked_at=?, last_status=?, last_response_ms=?, last_failure_at=?, consecutive_failures=? WHERE id=?`)
      .run(now(), r.status, r.ms, success ? u.last_failure_at : now(), failures, u.id);
    // If 3 consecutive failures, queue a next_action
    if (failures === 3) {
      db.prepare(`INSERT INTO next_action (title, rationale, source, source_ref, priority, suggested_agent, meta_json) VALUES (?,?,?,?,?,?,?)`)
        .run(
          `URL down: ${u.url}`,
          `Returned ${r.status} (expected ${u.expected_status}) for 3 consecutive checks. Topic: ${u.topic || "unknown"}.`,
          "url_failed", String(u.id), 8, "dieter",
          JSON.stringify({ url: u.url, status: r.status, ms: r.ms })
        );
    }
  }
  recordWrite("url_watcher", urls.length, "alive");
}
setInterval(() => { urlSweep().catch(() => {}); }, 5 * 60 * 1000);
// Immediate first sweep
setTimeout(() => { urlSweep().catch(() => {}); }, 5000);

// ---------- Health-checker every 5 min ----------
function healthSweep() {
  const writers = db.prepare("SELECT writer, last_write_at FROM writer_health").all();
  const now_ms = Date.now();
  for (const w of writers) {
    if (!w.last_write_at) continue;
    const ageMs = now_ms - new Date(w.last_write_at).getTime();
    let status = "alive";
    if (ageMs > 24 * 3600 * 1000) status = "dead";
    else if (ageMs > 2 * 3600 * 1000) status = "stale";
    db.prepare("UPDATE writer_health SET status=?, last_check_at=? WHERE writer=?")
      .run(status, now(), w.writer);
  }
}

setInterval(healthSweep, 5 * 60 * 1000);
setInterval(maybeRunDailyReflection, 60 * 1000);

// #9 TTL job + #10 action-log rollup
const BRIEF_TTL_HOURS = parseInt(process.env.BRIEF_TTL_HOURS || "168", 10);
const ROLLUP_AFTER_HOURS = parseInt(process.env.ROLLUP_AFTER_HOURS || "24", 10);
function runMaintenanceCycle() {
  try {
    const ttlInfo = db.prepare("UPDATE agent_brief SET status='stale' WHERE status='pending' AND created_at < datetime('now', '-' || ? || ' hours')").run(BRIEF_TTL_HOURS);
    if (ttlInfo.changes > 0) console.log("[ttl] flipped " + ttlInfo.changes + " briefs to stale");
  } catch (e) { console.error("[ttl]", e.message); }
  try {
    const cutoff = new Date(Date.now() - ROLLUP_AFTER_HOURS * 3600 * 1000).toISOString();
    const groups = db.prepare("SELECT agent_name, action_kind, topic, COUNT(*) c FROM agent_action WHERE started_at < ? AND topic IN ('brief-poll','heartbeat','poll') AND status != 'rollup' GROUP BY agent_name, action_kind, topic HAVING COUNT(*) > 10").all(cutoff);
    for (const g of groups) {
      const ids = db.prepare("SELECT id FROM agent_action WHERE agent_name=? AND action_kind=? AND topic=? AND started_at < ? AND status != 'rollup'").all(g.agent_name, g.action_kind, g.topic, cutoff);
      const idList = ids.map(r => r.id);
      const txn = db.transaction(() => {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, topic, status, payload_json, started_at) VALUES (?,?,?,?,?, ?)").run(g.agent_name, g.action_kind, g.topic, "rollup", JSON.stringify({ rollup: true, hours: ROLLUP_AFTER_HOURS, count: g.c, original_ids: idList.slice(0,500) }), cutoff);
        const placeholders = idList.map(() => "?").join(",");
        if (idList.length) db.prepare("DELETE FROM agent_action WHERE id IN (" + placeholders + ")").run(...idList);
      });
      txn();
      console.log("[rollup] " + g.agent_name + "/" + g.topic + ": " + g.c + " rows -> 1 rollup");
    }
  } catch (e) { console.error("[rollup]", e.message); }
}
setTimeout(runMaintenanceCycle, 30 * 1000);
setInterval(runMaintenanceCycle, 60 * 60 * 1000);

// Phase 7 Sprint 0: anti-loop detector — every 30 min scan repeat failures
async function antiLoopCycle() {
  try {
    const groups = db.prepare("SELECT agent_name, action_kind, target, COUNT(*) c FROM agent_action WHERE status='error' AND started_at > datetime('now','-1 hour') GROUP BY agent_name, action_kind, target HAVING COUNT(*) >= 3").all();
    for (const g of groups) {
      const title = g.agent_name + " repeated failure: " + g.action_kind + (g.target ? " on " + g.target : "");
      const exists = db.prepare("SELECT id FROM open_problem WHERE title=? AND status='open'").get(title);
      if (exists) continue;
      const info = db.prepare("INSERT INTO open_problem (title, severity, owner_agent) VALUES (?,?,?)").run(title, 'M', g.agent_name);
      console.log("[anti-loop] auto-created problem #" + info.lastInsertRowid + " for " + g.agent_name);
      // Brief to agent + Dieter
      db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run(g.agent_name, "mnemo-anti-loop", "[ANTI-LOOP] " + title + " (" + g.c + " errors in last hour). Pause repeating, investigate or escalate via mem_consult_peer / mem_consult_codex / mem_meeting_open.");
    }
  } catch (e) { console.error("[anti-loop]", e.message); }
}
setInterval(() => { antiLoopCycle().catch(() => {}); }, 30 * 60 * 1000);

// Phase 6 Sprint 2: watchdog runner — 5 min cycle, http checks
async function watchdogCycle() {
  try {
    const wds = db.prepare("SELECT id, target, check_kind, owner_agent, threshold_json, consecutive_failures FROM watchdog WHERE enabled=1").all();
    for (const w of wds) {
      try {
        if (w.check_kind !== 'http') continue;
        const url = new URL(w.target);
        const lib = url.protocol === "https:" ? require("https") : require("http");
        const ok = await new Promise(resolve => {
          const req = lib.request({ method: "GET", hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 5000 }, rs => { rs.resume(); resolve(rs.statusCode >= 200 && rs.statusCode < 400); });
          req.on("error", () => resolve(false));
          req.on("timeout", () => { req.destroy(); resolve(false); });
          req.end();
        });
        if (ok) {
          db.prepare("UPDATE watchdog SET last_check_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status='ok', consecutive_failures=0 WHERE id=?").run(w.id);
          // Auto-close any open incident
          const open = db.prepare("SELECT id FROM watchdog_incident WHERE watchdog_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1").get(w.id);
          if (open) db.prepare("UPDATE watchdog_incident SET status='resolved', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(open.id);
        } else {
          const fails = (w.consecutive_failures || 0) + 1;
          db.prepare("UPDATE watchdog SET last_check_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status='fail', consecutive_failures=? WHERE id=?").run(fails, w.id);
          // Open incident on first fail
          if (fails === 1) {
            db.prepare("INSERT INTO watchdog_incident (watchdog_id, notes) VALUES (?,?)").run(w.id, "auto-detected by watchdog cycle");
            // Drop brief to owner
            if (w.owner_agent) {
              db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run(w.owner_agent, "mnemo-watchdog", "[WATCHDOG] " + w.target + " is failing. Investigate.");
            }
          }
        }
      } catch (e) { console.error("[watchdog]", w.target, e.message); }
    }
  } catch (e) { console.error("[watchdog]", e.message); }
}
setInterval(() => { watchdogCycle().catch(() => {}); }, 5 * 60 * 1000);

// Phase 3+4 BLUN-OS: idle_loop driver + daily digest cron
async function idleLoopCycle() {
  try {
    const cfg = db.prepare("SELECT agent_name, interval_min, last_cycle_at FROM agent_idle_config WHERE enabled=1").all();
    const now = Date.now();
    for (const c of cfg) {
      try {
        const lastMs = c.last_cycle_at ? new Date(c.last_cycle_at).getTime() : 0;
        if (now - lastMs < c.interval_min * 60 * 1000) continue;
        // Mode-gate
        const mode = handleTool(db, "mem_get_mode", { agent_name: c.agent_name });
        if (mode.mode === 'maintenance') continue;
        // Mark cycle
        db.prepare("UPDATE agent_idle_config SET last_cycle_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_name=?").run(c.agent_name);
        // Drop a brief to the agent itself with idle_cycle marker — agent picks up + acts
        const briefId = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)").run(c.agent_name, "mnemo-idle-loop", "[IDLE-CYCLE] Pull project_state, generate proposals via mem_propose, ship if ship_eligible. Mode: " + mode.mode + ".", JSON.stringify({ idle_cycle: true, mode: mode.mode })).lastInsertRowid;
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, topic, status, payload_json, started_at) VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(c.agent_name, "idle_loop_cycle", "idle_loop", "fired", JSON.stringify({ brief_id: briefId, mode: mode.mode }));
        console.log("[idle-loop] " + c.agent_name + " cycle fired (mode=" + mode.mode + ")");
      } catch (e) { console.error("[idle-loop]", c.agent_name, e.message); }
    }
  } catch (e) { console.error("[idle-loop]", e.message); }
}
setInterval(() => { idleLoopCycle().catch(() => {}); }, 60 * 1000);

// ============================================================
// Hub→Local brief sync — the autonomous core.
// Every HUB_SYNC_INTERVAL_SEC the daemon pulls briefs from the cross-host
// hub at HUB_URL for each LOCAL_AGENT and mirrors them into the local
// agent_brief table. This lets agents on this PC see cross-machine briefs
// even when no local agent session is open.
//
// Disable: MNEMO_HUB_URL="" or MNEMO_HUB_SYNC=off.
// ============================================================
const HUB_URL = process.env.MNEMO_HUB_URL ?? "https://listing.blun.ai/mnemo";
const HUB_SYNC_ENABLED = (process.env.MNEMO_HUB_SYNC || "on").toLowerCase() !== "off";
const HUB_SYNC_INTERVAL_SEC = parseInt(process.env.MNEMO_HUB_SYNC_INTERVAL_SEC || "300", 10);
const LOCAL_AGENTS_DAEMON = String(process.env.MNEMO_LOCAL_AGENTS || "angel")
  .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);

async function hubPullForAgent(agentName) {
  if (!HUB_URL) return { count: 0 };
  try {
    const res = await fetch(`${HUB_URL}/tool/mem_brief_pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_name: agentName, limit: 25, peek: false }),
    });
    if (!res.ok) throw new Error(`hub HTTP ${res.status}`);
    const j = await res.json();
    const briefs = (j && j.result && j.result.briefs) || [];
    let inserted = 0;
    const ins = db.prepare(
      "INSERT INTO agent_brief (agent_name, source_agent, content, status, dispatched_at, meta_json) VALUES (?, ?, ?, 'pending', NULL, ?)"
    );
    const dedup = db.prepare(
      "SELECT 1 FROM agent_brief WHERE agent_name=? AND content=? AND created_at > datetime('now','-7 days') LIMIT 1"
    );
    for (const b of briefs) {
      const exists = dedup.get(agentName, b.content);
      if (exists) continue;
      const meta = b.meta_json ? (typeof b.meta_json === "string" ? JSON.parse(b.meta_json) : b.meta_json) : {};
      meta._mirrored_from_hub = true;
      meta._hub_id = b.id;
      meta._hub_pulled_at = new Date().toISOString();
      ins.run(agentName, b.source_agent || null, b.content, JSON.stringify(meta));
      inserted++;
    }
    return { count: briefs.length, inserted };
  } catch (e) {
    return { count: 0, error: String(e.message || e) };
  }
}

async function hubSyncCycle() {
  if (!HUB_SYNC_ENABLED || !HUB_URL) return;
  for (const agent of LOCAL_AGENTS_DAEMON) {
    try {
      const r = await hubPullForAgent(agent);
      if (r.inserted) {
        console.log(`[hub-sync] ${agent}: pulled ${r.count} from hub, ${r.inserted} new local rows`);
        try {
          recordWrite("hub_sync", r.inserted, "alive");
        } catch {}
      } else if (r.error) {
        console.error(`[hub-sync] ${agent}: ${r.error}`);
      }
    } catch (e) {
      console.error(`[hub-sync] ${agent}: ${e.message}`);
    }
  }
}
setInterval(() => { hubSyncCycle().catch(() => {}); }, HUB_SYNC_INTERVAL_SEC * 1000);
// Run once shortly after boot so sync starts without waiting a full interval.
setTimeout(() => { hubSyncCycle().catch(() => {}); }, 8000);

async function dailyDigestCycle() {
  try {
    // Run once between 06:00-06:05 user-tz (UTC+2 default = 04:00-04:05 UTC). Check minute 0-5.
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    if (utcHour !== 4 || utcMin > 5) return;
    const modes = db.prepare("SELECT agent_name, mode, digest_chat_id, last_digest_at FROM agent_mode WHERE digest_chat_id IS NOT NULL").all();
    const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE || "/root/.dieter/telegram_bot_token";
    let token = process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token && fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile,"utf8").trim();
    if (!token) return;
    const today = now.toISOString().slice(0,10);
    for (const m of modes) {
      if (m.last_digest_at && m.last_digest_at.slice(0,10) === today) continue;
      const shipped = db.prepare("SELECT COUNT(*) c FROM agent_proposal WHERE agent_name=? AND status='shipped' AND shipped_at > datetime('now','-24 hours')").get(m.agent_name).c;
      const queued = db.prepare("SELECT COUNT(*) c FROM agent_proposal WHERE agent_name=? AND status='queued'").get(m.agent_name).c;
      const blocked = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE agent_name=? AND status IN ('pending','dispatched') AND id IN (SELECT brief_id FROM agent_brief_reaction WHERE kind='blocker')").get(m.agent_name).c;
      const decisions = db.prepare("SELECT idea FROM agent_proposal WHERE agent_name=? AND status='shipped' AND shipped_at > datetime('now','-24 hours') ORDER BY score DESC LIMIT 5").all(m.agent_name).map(r => "  - " + r.idea).join("\n");
      const text = "[mnemo digest 24h] " + m.agent_name + " (mode=" + m.mode + ")\n\nshipped: " + shipped + "\nqueued: " + queued + "\nblocked: " + blocked + (decisions ? "\n\nrecent ships:\n" + decisions : "");
      try {
        const data = JSON.stringify({ chat_id: m.digest_chat_id, text });
        const req = require("https").request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, r => r.resume());
        req.on("error", () => {});
        req.write(data); req.end();
        db.prepare("UPDATE agent_mode SET last_digest_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE agent_name=?").run(m.agent_name);
        console.log("[digest] sent to " + m.agent_name);
      } catch (e) { console.error("[digest-send]", e.message); }
    }
  } catch (e) { console.error("[digest]", e.message); }
}
setInterval(() => { dailyDigestCycle().catch(() => {}); }, 60 * 1000);

// #16 auto-reflect: every 10 min, check each registered agent, trigger reflect if nudge says so
async function autoReflectCycle() {
  try {
    const agents = db.prepare("SELECT agent_name FROM agent_registry WHERE status='online'").all();
    for (const ag of agents) {
      try {
        const res = handleTool(db, "mem_nudge_check", { agent_name: ag.agent_name, threshold: 50 });
        if (res && res.reflect_recommended) {
          const out = handleTool(db, "mem_reflect_now", { agent_name: ag.agent_name });
          db.prepare("INSERT INTO agent_action (agent_name, action_kind, topic, status, started_at, payload_json) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)").run(ag.agent_name, "reflect", "reflect", "ok", JSON.stringify({ auto: true, summary_len: (out && out.summary || "").length }));
          console.log("[auto-reflect] " + ag.agent_name + " (actions_since=" + res.actions_since + ")");
        }
      } catch (e) { /* per-agent best effort */ }
    }
  } catch (e) { console.error("[auto-reflect]", e.message); }
}
setInterval(() => { autoReflectCycle().catch(() => {}); }, 10 * 60 * 1000);

process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT", () => { db.close(); process.exit(0); });
