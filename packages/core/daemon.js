#!/usr/bin/env node
/**
 * Mnemo Daemon — always-on PM2 service that:
 *   1. Polls Telegram Bot API directly (independent of Claude Code hooks)
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

const server = http.createServer((req, res) => {
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
      const info = tdb.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)"
      ).run(a.agent_name, a.source_agent || null, a.content, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      if (a.supersedes) {
        try { tdb.prepare("UPDATE agent_brief SET superseded_by_id=?, status=CASE WHEN status='pending' THEN 'superseded' ELSE status END WHERE id=?").run(newId, a.supersedes); } catch (e) {}
      }
      try { fireBriefHook(tdb, newId, "drop", { agent_name: a.agent_name }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, a.agent_name, a.source_agent || "", a.content); } catch (e) {}
      try {
        const skMatches = matchSkillsForText(tdb, a.content);
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
      const occurredAt = a.occurred_at || null;
      const info = (occurredAt
        ? tdb.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, a.content, a.meta ? JSON.stringify(a.meta) : null, occurredAt, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
        : tdb.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, a.content, a.meta ? JSON.stringify(a.meta) : null, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
      );
      return { id: info.lastInsertRowid, source: a.source, direction: a.direction, occurred_at: occurredAt };
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
