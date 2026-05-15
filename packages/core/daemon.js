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
 *   TELEGRAM_BOT_TOKEN   Telegram poller token
 *   TELEGRAM_BOT_TOKEN_FILE optional file containing Telegram poller token
 *   MNEMO_TELEGRAM_POLL_ENABLED set to 0 when another process owns getUpdates
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
const { handleCodeReadTool } = require("./code_read_tools");
const { handleContextPreviewTool } = require("./context_preview_tools");
const { LOOP_DOCTOR_TOOL_DEFS, handleLoopDoctorTool } = require("./loop_doctor_tools");
const { TIMELINE_REPORT_TOOL_DEFS, handleTimelineReportTool } = require("./timeline_report_tools");
const { ensureTeamQualityTables, handleTeamQualityTool } = require("./team_quality_ops");
const { memoryHealth } = require("./memory_health_tools");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const PORT = parseInt(process.env.MNEMO_HTTP_PORT || "7117", 10);
const HOST = process.env.MNEMO_HTTP_HOST || "127.0.0.1";
const TELEGRAM_BOT_TOKEN_FILE = process.env.TELEGRAM_BOT_TOKEN_FILE || "";
const TELEGRAM_POLL_ENABLED = process.env.MNEMO_TELEGRAM_POLL_ENABLED !== "0";
function readSecretFile(file) {
  if (!file) return "";
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  } catch {}
  return "";
}
const TG_TOKEN = TELEGRAM_POLL_ENABLED ? (process.env.TELEGRAM_BOT_TOKEN || readSecretFile(TELEGRAM_BOT_TOKEN_FILE) || null) : null;
const OWNER_CHAT_ID = process.env.MNEMO_OWNER_CHAT_ID || process.env.OWNER_CHAT_ID || null;
const OWNER_TELEGRAM_USER_ID = process.env.MNEMO_OWNER_TELEGRAM_USER_ID || process.env.OWNER_TELEGRAM_USER_ID || null;
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";
const TELEGRAM_INGEST_ALL_DMS = process.env.MNEMO_TELEGRAM_INGEST_ALL_DMS !== "0";
const TG_OFFSET_FILE = process.env.MNEMO_TG_OFFSET_FILE || path.join(__dirname, ".tg_offset");
const TZ_OFFSET_HOURS = parseInt(process.env.MNEMO_TZ_OFFSET_HOURS || "0", 10);
const QUIET_START = parseInt(process.env.MNEMO_QUIET_START || "23", 10);
const QUIET_END = parseInt(process.env.MNEMO_QUIET_END || "7", 10);
const { collectBody } = require("./http_utils");
const { parseMaybeJson, deepMergePlain, uniqueIntegers, stripPrivate, parseAgentCsv, normalizeAgentName, jsonSafe, compactContent, parseMetaJson, isoOrNull, parseBriefTitle, TEAM_BRIEF_ALIASES, BRIEF_CONTRACT_VERSION, BRIEF_REQUIRED_HEADINGS, cleanScope, uniqueAgentNames, isTeamBriefTarget, hasCanonicalBriefShape, normalizeBriefMeta, normalizeBriefContent, baseName, extensionName, inferMediaKind, inferMediaType, uniqueStrings, boolFlag, isoAgeDays, freshnessFromAgeDays, capabilityMatrixForDepartments, AUTH_CONTRACT_REQUIRED_FIELDS, UI_CONTRACT_REQUIRED_FIELDS, authSensitiveTask, uiSensitiveTask, authContractReport, uiContractReport, normalizeReminderText, parseReminderTime, applyReminderTime, parseReminderDue, reminderTitleFromText, reminderRow, buildMediaTitle, buildCanonicalMediaFileName, slugFilePart } = require("./shared_utils");
const briefCoordination = require("./brief_coordination");
const { ensureAgentMailTables, handleAgentMailTool, dispatchInboundBriefs } = require("./agent_mail");
const DEFAULT_AGENT = process.env.MNEMO_DEFAULT_AGENT || process.env.MNEMO_AGENT || "agent";
const DEFAULT_SCOPE = cleanScope(process.env.MNEMO_DEFAULT_SCOPE || "default");
const FACTS_DIR = process.env.MNEMO_FACTS_DIR || path.join(__dirname, "facts");

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function factsPathFor(scope, suffix) {
  return path.join(FACTS_DIR, scopeName(scope) + (suffix || "") + ".json");
}

function resolveTeamBriefTargets(tdb) {
  const configured = uniqueAgentNames(parseAgentCsv(process.env.MNEMO_TEAM_AGENTS || process.env.MNEMO_LOCAL_AGENTS));
  if (configured.length) return configured;
  try {
    const online = tdb.prepare("SELECT agent_name FROM agent_registry WHERE status='online' ORDER BY agent_name").all().map((r) => r.agent_name);
    const resolved = uniqueAgentNames(online);
    if (resolved.length) return resolved;
  } catch {}
  try {
    return uniqueAgentNames(tdb.prepare("SELECT agent_name FROM agent_registry ORDER BY last_seen_at DESC, agent_name ASC LIMIT 20").all().map((r) => r.agent_name));
  } catch {
    return [];
  }
}
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function bootstrapBaseSchema(target, label) {
  for (const f of ["schema.sql", "identity_schema.sql"]) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    target.exec(fs.readFileSync(p, "utf8"));
  }
  if (label) console.log("[schema] base schema ready for " + label);
}

function ensureConnectSchema(target) {
  target.exec(`
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
CREATE TABLE IF NOT EXISTS agent_brief_reaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reaction_brief ON agent_brief_reaction(brief_id);
  `);
  const bcols = target.prepare("PRAGMA table_info(agent_brief)").all().map(c => c.name);
  if (!bcols.includes("channel")) target.exec("ALTER TABLE agent_brief ADD COLUMN channel TEXT");
  if (!bcols.includes("parent_id")) target.exec("ALTER TABLE agent_brief ADD COLUMN parent_id INTEGER");
  if (!bcols.includes("supersedes_id")) target.exec("ALTER TABLE agent_brief ADD COLUMN supersedes_id INTEGER");
  if (!bcols.includes("superseded_by_id")) target.exec("ALTER TABLE agent_brief ADD COLUMN superseded_by_id INTEGER");
  const rcols = target.prepare("PRAGMA table_info(agent_registry)").all().map(c => c.name);
  if (!rcols.includes("notify_webhook")) target.exec("ALTER TABLE agent_registry ADD COLUMN notify_webhook TEXT");
  if (!rcols.includes("notify_telegram_chat")) target.exec("ALTER TABLE agent_registry ADD COLUMN notify_telegram_chat TEXT");
  if (!rcols.includes("peer_endpoint")) target.exec("ALTER TABLE agent_registry ADD COLUMN peer_endpoint TEXT");
  if (!rcols.includes("idle_after_min")) target.exec("ALTER TABLE agent_registry ADD COLUMN idle_after_min INTEGER");
}

const { ensureUniversalJournalSchema, ensureProjectRegistryTable, ensureFirmOpsTables } = require("./journal_schema");

bootstrapBaseSchema(db, "host");
ensureAgentMailTables(db);
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
  // Phase 7 #4: agent_consult — programming-specialist queue
  db.exec("CREATE TABLE IF NOT EXISTS agent_consult (id INTEGER PRIMARY KEY AUTOINCREMENT, requesting_agent TEXT NOT NULL, problem_id INTEGER, question TEXT NOT NULL, context_files TEXT, proposed_solution TEXT, used_in_attempt_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), answered_at TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agent_status ON agent_consult(status, created_at DESC)");
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
  ensureUniversalJournalSchema(db);
} catch (e) { console.error("[migrate]", e.message); }
try { ensureUniversalJournalSchema(db); } catch (e) { console.error("[journal-schema]", e.message); }

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
    bootstrapBaseSchema(tdb, "tenant:" + safe);
    ensureConnectSchema(tdb);
    ensureUniversalJournalSchema(tdb);
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

function journalEvent(tdb, event) {
  if (!event || !event.event_kind) return null;
  try { ensureUniversalJournalSchema(tdb); } catch {}
  const content = compactContent(event.content, event.max_content_chars || 8000);
  const payload = event.payload_json !== undefined ? event.payload_json : jsonSafe(event.payload, event.max_payload_chars || 12000);
  const meta = event.meta_json !== undefined ? event.meta_json : jsonSafe(event.meta, event.max_meta_chars || 12000);
  try {
    const r = tdb.prepare(
      "INSERT INTO mnemo_event_journal (source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      event.source || "mnemo",
      event.channel || null,
      event.direction || "internal",
      event.actor || null,
      event.actor_id || null,
      event.event_kind,
      event.ref_kind || null,
      event.ref_id != null ? String(event.ref_id) : null,
      event.thread_id || null,
      event.status || null,
      content,
      payload,
      meta,
      event.occurred_at || now()
    );
    return { id: r.lastInsertRowid };
  } catch (e) {
    try { recordWrite("event_journal", 0, "error: " + String(e.message || e).slice(0, 100)); } catch {}
    return null;
  }
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
  journalEvent(target, {
    source: source || "http",
    channel: topic || null,
    direction: "inbound",
    actor,
    actor_id,
    event_kind: "memory_ingest",
    ref_kind: "memory",
    ref_id: r.lastInsertRowid || null,
    thread_id: source_ref || null,
    status: r.changes > 0 ? "inserted" : "duplicate",
    content: text,
    meta: Object.assign({}, meta || {}, { kind, hash })
  });
  return { ok: true, inserted: r.changes > 0, hash };
}

function captureDedupeKey(a, contentHash) {
  if (a.dedupe_key) return String(a.dedupe_key);
  if (a.source_ref) return sha(["capture", a.source || "", a.channel || "", a.source_ref].join("|"));
  if (a.ref_id != null) return sha(["capture", a.source || "", a.channel || "", a.ref_kind || "", String(a.ref_id)].join("|"));
  return sha(["capture", a.source || "", a.channel || "", a.direction || "", a.actor_id || a.actor || "", a.occurred_at || "", contentHash || ""].join("|"));
}

function mediaCaptureDetails(a = {}) {
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const payload = a.payload && typeof a.payload === "object" ? a.payload : {};
  const mediaPath = a.media_path || meta.media_path || payload.media_path || a.file_path || meta.file_path || payload.file_path || "";
  const originalFileName = a.file_name || meta.file_name || payload.file_name || baseName(mediaPath);
  const fileName = originalFileName;
  const ext = extensionName(fileName || mediaPath);
  const mediaKind = inferMediaKind(a, meta, payload, fileName, ext);
  const mediaType = a.media_type || meta.media_type || payload.media_type || inferMediaType(ext, mediaKind);
  const project = a.project || meta.project || payload.project || "";
  const pageUrl = a.page_url || meta.page_url || payload.page_url || meta.url || payload.url || "";
  const route = a.route || meta.route || payload.route || "";
  const actor = a.actor || a.speaker || meta.actor || "";
  const contextText = a.context_text || a.content || a.text || meta.context_text || meta.caption || meta.message_text || meta.notes || payload.context_text || payload.caption || payload.message_text || payload.notes || "";
  const labels = uniqueStrings([]
    .concat(a.labels || [])
    .concat(meta.labels || [])
    .concat(payload.labels || [])
    .concat(project ? [project] : [])
    .concat(route ? [route] : [])
    .concat(mediaKind ? [mediaKind] : [])
    .concat(mediaType ? [mediaType] : [])
    .concat(actor ? [actor] : [])
    .concat(a.channel ? [a.channel] : []));
  const title = buildMediaTitle(Object.assign({}, a, { meta, payload, project, media_kind: mediaKind, route, page_url: pageUrl, file_name: fileName, context_text: contextText }));
  const canonicalName = buildCanonicalMediaFileName({ source: a.source, channel: a.channel, occurred_at: a.occurred_at, title, file_ext: ext || extensionName(mediaPath), file_name: fileName, media_path: mediaPath });
  return {
    media_path: mediaPath,
    file_name: canonicalName,
    original_file_name: originalFileName || null,
    canonical_name: canonicalName,
    file_ext: ext,
    media_kind: mediaKind,
    media_type: mediaType,
    project,
    page_url: pageUrl,
    route,
    labels,
    title: title || `${mediaKind || "media"} | ${a.source || "capture"}`,
    context_text: contextText || null
  };
}

function materializeMediaFile(details, occurred) {
  if (process.env.MNEMO_MEDIA_STORE === "0") return null;
  const sourcePath = details && details.media_path ? String(details.media_path) : "";
  if (!sourcePath || (/^[a-z]+:/i.test(sourcePath) && !/^[a-z]:[\\/]/i.test(sourcePath))) return null;
  let realSource;
  let stat;
  try {
    realSource = path.resolve(sourcePath);
    stat = fs.statSync(realSource);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const maxBytes = Math.max(1024, parseInt(process.env.MNEMO_MEDIA_COPY_MAX_BYTES || String(25 * 1024 * 1024), 10));
  if (stat.size > maxBytes) return null;
  const root = process.env.MNEMO_MEDIA_DIR || path.join(__dirname, "media");
  const datePart = String(occurred || now()).slice(0, 10) || "undated";
  const projectPart = slugFilePart(details.project || "unassigned", 80);
  const destDir = path.join(root, projectPart, datePart);
  const destPath = path.join(destDir, details.canonical_name || details.file_name || baseName(realSource));
  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (path.resolve(destPath) !== realSource && !fs.existsSync(destPath)) fs.copyFileSync(realSource, destPath);
    return destPath;
  } catch {
    return null;
  }
}

function ensureMediaAssetRuntimeSchema(target) {
  target.exec(`
CREATE TABLE IF NOT EXISTS media_asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE,
  source TEXT NOT NULL,
  channel TEXT,
  thread_id TEXT,
  actor TEXT,
  event_kind TEXT,
  media_kind TEXT NOT NULL,
  media_type TEXT,
  title TEXT NOT NULL,
  file_name TEXT,
  original_file_name TEXT,
  canonical_name TEXT,
  file_ext TEXT,
  media_path TEXT,
  storage_path TEXT,
  content_ref TEXT,
  page_url TEXT,
  route TEXT,
  project TEXT,
  labels_json TEXT,
  notes TEXT,
  ref_kind TEXT,
  ref_id TEXT,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'captured',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
  const cols = target.prepare("PRAGMA table_info(media_asset)").all().map((c) => c.name);
  if (!cols.includes("original_file_name")) target.exec("ALTER TABLE media_asset ADD COLUMN original_file_name TEXT");
  if (!cols.includes("canonical_name")) target.exec("ALTER TABLE media_asset ADD COLUMN canonical_name TEXT");
  if (!cols.includes("storage_path")) target.exec("ALTER TABLE media_asset ADD COLUMN storage_path TEXT");
  if (!cols.includes("content_ref")) target.exec("ALTER TABLE media_asset ADD COLUMN content_ref TEXT");
  target.exec(`
CREATE INDEX IF NOT EXISTS idx_media_occurred ON media_asset(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_project ON media_asset(project, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media_asset(media_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_thread ON media_asset(thread_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_canonical ON media_asset(canonical_name);
`);
}

function upsertMediaAssetFromCapture(tdb, a = {}, dedupeKey, occurred, meta) {
  const details = mediaCaptureDetails(Object.assign({}, a, { occurred_at: a.occurred_at || occurred }));
  if (!details.media_path && !details.file_name && !details.media_kind) return null;
  ensureMediaAssetRuntimeSchema(tdb);
  const storagePath = materializeMediaFile(details, occurred);
  const contentRef = a.ref_kind && a.ref_id != null ? `${a.ref_kind}:${a.ref_id}` : (a.source_ref || a.thread_id || a.session_id || null);
  const existing = tdb.prepare("SELECT id FROM media_asset WHERE dedupe_key=?").get(dedupeKey);
  const payload = {
    dedupe_key: dedupeKey,
    source: a.source || "capture",
    channel: a.channel || null,
    thread_id: a.thread_id || a.session_id || null,
    actor: a.actor || a.speaker || null,
    event_kind: a.event_kind || "message",
    media_kind: details.media_kind || "file",
    media_type: details.media_type || null,
    title: details.title,
    file_name: details.file_name || null,
    original_file_name: details.original_file_name || null,
    canonical_name: details.canonical_name || details.file_name || null,
    file_ext: details.file_ext || null,
    media_path: details.media_path || null,
    storage_path: storagePath || null,
    content_ref: contentRef || null,
    page_url: details.page_url || null,
    route: details.route || null,
    project: details.project || null,
    labels_json: JSON.stringify(details.labels || []),
    notes: a.notes || (meta && meta.notes) || null,
    ref_kind: a.ref_kind || null,
    ref_id: a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
    occurred_at: occurred,
    status: a.status || "captured",
    meta_json: JSON.stringify(Object.assign({}, meta || {}, { media_indexed: true, original_file_name: details.original_file_name || null, canonical_name: details.canonical_name || null, storage_path: storagePath || null, context_text: details.context_text || null }))
  };
  if (existing) {
    tdb.prepare("UPDATE media_asset SET source=?, channel=?, thread_id=?, actor=?, event_kind=?, media_kind=?, media_type=?, title=?, file_name=?, original_file_name=?, canonical_name=?, file_ext=?, media_path=?, storage_path=?, content_ref=?, page_url=?, route=?, project=?, labels_json=?, notes=?, ref_kind=?, ref_id=?, occurred_at=?, status=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dedupe_key=?")
      .run(payload.source, payload.channel, payload.thread_id, payload.actor, payload.event_kind, payload.media_kind, payload.media_type, payload.title, payload.file_name, payload.original_file_name, payload.canonical_name, payload.file_ext, payload.media_path, payload.storage_path, payload.content_ref, payload.page_url, payload.route, payload.project, payload.labels_json, payload.notes, payload.ref_kind, payload.ref_id, payload.occurred_at, payload.status, payload.meta_json, dedupeKey);
    return { id: existing.id, status: "updated", title: payload.title, media_kind: payload.media_kind };
  }
  const info = tdb.prepare("INSERT INTO media_asset (dedupe_key, source, channel, thread_id, actor, event_kind, media_kind, media_type, title, file_name, original_file_name, canonical_name, file_ext, media_path, storage_path, content_ref, page_url, route, project, labels_json, notes, ref_kind, ref_id, occurred_at, status, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(payload.dedupe_key, payload.source, payload.channel, payload.thread_id, payload.actor, payload.event_kind, payload.media_kind, payload.media_type, payload.title, payload.file_name, payload.original_file_name, payload.canonical_name, payload.file_ext, payload.media_path, payload.storage_path, payload.content_ref, payload.page_url, payload.route, payload.project, payload.labels_json, payload.notes, payload.ref_kind, payload.ref_id, payload.occurred_at, payload.status, payload.meta_json);
  return { id: info.lastInsertRowid, status: "created", title: payload.title, media_kind: payload.media_kind };
}

function insertCaptureMemory(tdb, a, content, dedupeKey, meta) {
  const kind = a.memory_kind || a.kind || "message";
  const source = a.source || "capture";
  const sourceRef = a.source_ref || (a.ref_kind && a.ref_id != null ? `${a.ref_kind}:${a.ref_id}` : dedupeKey);
  const occurred = a.occurred_at || now();
  const hash = sha([kind, sourceRef || "", occurred, content].join("|"));
  const info = tdb.prepare(`
    INSERT OR IGNORE INTO memory
      (kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta_json, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    kind,
    source,
    sourceRef,
    occurred,
    a.actor || a.speaker || null,
    a.actor_id || null,
    a.topic || a.channel || null,
    a.importance ?? 4,
    content,
    meta ? JSON.stringify(meta) : null,
    hash
  );
  if (info.changes > 0) return info.lastInsertRowid;
  const row = tdb.prepare("SELECT id FROM memory WHERE hash=?").get(hash);
  return row ? row.id : null;
}

function captureHasMedia(a = {}) {
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const payload = a.payload && typeof a.payload === "object" ? a.payload : {};
  return !!(
    a.media_path || a.file_path || a.file_name ||
    meta.media_path || meta.file_path || meta.file_name ||
    payload.media_path || payload.file_path || payload.file_name
  );
}

function validateCaptureEnvelope(a = {}, content) {
  const source = String(a.source || "").trim().toLowerCase();
  const channel = String(a.channel || "").trim().toLowerCase();
  const refKind = String(a.ref_kind || "").trim().toLowerCase();
  const refId = a.ref_id != null ? String(a.ref_id).trim() : "";
  const threadId = String(a.thread_id || a.session_id || "").trim();
  const actor = String(a.actor || a.speaker || "").trim();
  const actorId = String(a.actor_id || "").trim();
  const occurredAt = String(a.occurred_at || "").trim();
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const hasMedia = captureHasMedia(a);
  const chatId = String(meta.chat_id || "").trim();
  const messageId = meta.message_id != null ? String(meta.message_id).trim() : "";
  const isTelegram = source === "telegram" || channel.startsWith("telegram-");
  if (!isTelegram) return { ok: true, errors: [] };
  const errors = [];
  const isChatScoped = channel.startsWith("telegram-chat:") || channel.startsWith("telegram-dm:");
  if (!channel) errors.push("channel required");
  if (!actor) errors.push("actor/speaker required");
  if (!occurredAt) errors.push("occurred_at required");
  if (!threadId) errors.push("thread_id/session_id required");
  if (!content && !hasMedia) errors.push("content or media attachment required");
  if (isChatScoped || refKind === "telegram_message") {
    if (!actorId) errors.push("actor_id required for telegram message");
    if (!chatId) errors.push("meta.chat_id required for telegram message");
    if (!messageId && !refId) errors.push("meta.message_id or ref_id required for telegram message");
    if (refKind && refKind !== "telegram_message") errors.push("ref_kind must be telegram_message for telegram message capture");
  }
  if (hasMedia) {
    if (!threadId) errors.push("thread binding required for media capture");
    if (!chatId) errors.push("meta.chat_id required for telegram media");
    if (!messageId && !refId) errors.push("meta.message_id or ref_id required for telegram media");
  }
  return { ok: errors.length === 0, errors, isTelegram, isChatScoped, hasMedia };
}

function captureIngest(tdb, a = {}) {
  try { ensureUniversalJournalSchema(tdb); } catch {}
  if (!a.source) return { ok: false, error: "source required" };
  const eventKind = a.event_kind || "message";
  const occurred = a.occurred_at || now();
  const direction = a.direction || "internal";
  const content = compactContent(a.content !== undefined ? a.content : a.text, a.max_content_chars || 8000) || "";
  const validation = validateCaptureEnvelope(Object.assign({}, a, { occurred_at: occurred, direction }), content);
  if (!validation.ok) {
    const error = `capture_validation_failed: ${validation.errors.join("; ")}`;
    try {
      journalEvent(tdb, {
        source: a.source || "capture",
        channel: a.channel || null,
        direction,
        actor: a.actor || a.speaker || null,
        actor_id: a.actor_id || null,
        event_kind: "capture_validation_failed",
        ref_kind: a.ref_kind || null,
        ref_id: a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
        thread_id: a.thread_id || a.session_id || null,
        status: "error",
        content,
        payload: a.payload || null,
        meta: Object.assign({}, a.meta || {}, { validation_errors: validation.errors }),
        occurred_at: occurred
      });
    } catch {}
    try { if (tdb === db) recordWrite(`capture:${a.source}`, 0, error.slice(0, 120)); } catch {}
    return { ok: false, error, validation_errors: validation.errors };
  }
  const contentHash = content ? sha(content) : null;
  const dedupeKey = captureDedupeKey(Object.assign({}, a, { occurred_at: occurred, direction }), contentHash);
  const existing = tdb.prepare("SELECT dedupe_key, event_id, transcript_id, memory_id, seen_count FROM capture_receipt WHERE dedupe_key=?").get(dedupeKey);
  const meta = Object.assign({}, a.meta || {}, {
    dedupe_key: dedupeKey,
    source_ref: a.source_ref || null,
    capture_policy: "capture-by-default"
  });

  if (existing) {
    tdb.prepare("UPDATE capture_receipt SET seen_count=seen_count+1, last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status='duplicate' WHERE dedupe_key=?").run(dedupeKey);
    const duplicateEvent = journalEvent(tdb, {
      source: a.source,
      channel: a.channel || null,
      direction,
      actor: a.actor || a.speaker || null,
      actor_id: a.actor_id || null,
      event_kind: "capture_duplicate",
      ref_kind: a.ref_kind || "capture_receipt",
      ref_id: a.ref_id != null ? String(a.ref_id) : dedupeKey,
      thread_id: a.thread_id || a.session_id || null,
      status: "duplicate",
      content,
      payload: { dedupe_key: dedupeKey, existing },
      meta
    });
    return {
      ok: true,
      status: "duplicate",
      duplicate: true,
      dedupe_key: dedupeKey,
      audit_event_id: duplicateEvent && duplicateEvent.id,
      existing
    };
  }

  let eventId = null;
  let transcriptId = null;
  let memoryId = null;
  let mediaId = null;
  const txn = tdb.transaction(() => {
    const event = journalEvent(tdb, {
      source: a.source,
      channel: a.channel || null,
      direction,
      actor: a.actor || a.speaker || null,
      actor_id: a.actor_id || null,
      event_kind: eventKind,
      ref_kind: a.ref_kind || null,
      ref_id: a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
      thread_id: a.thread_id || a.session_id || null,
      status: a.status || "captured",
      content,
      payload: a.payload || null,
      meta,
      occurred_at: occurred
    });
    eventId = event && event.id;
    if (content && a.promote_transcript !== false) {
      const info = tdb.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(a.source, a.channel || null, direction === "outbound" ? "outbound" : "inbound", a.speaker || a.actor || null, content, JSON.stringify(meta), occurred, a.ref_kind || "capture", a.ref_id != null ? String(a.ref_id) : dedupeKey);
      transcriptId = info.lastInsertRowid;
      try { ftsIndex(tdb, "transcript", transcriptId, a.speaker || a.actor || a.source || "", (direction || "") + (a.channel ? " @ " + a.channel : ""), content); } catch {}
    }
    if (content && (a.promote_memory === true || a.remember === true)) {
      memoryId = insertCaptureMemory(tdb, a, content, dedupeKey, meta);
    }
    const media = upsertMediaAssetFromCapture(tdb, a, dedupeKey, occurred, meta);
    mediaId = media && media.id || null;
    tdb.prepare(`
      INSERT INTO capture_receipt
        (dedupe_key, source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, occurred_at, content_hash, content_preview, event_id, transcript_id, memory_id, status, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      dedupeKey,
      a.source,
      a.channel || null,
      direction,
      a.actor || a.speaker || null,
      a.actor_id || null,
      eventKind,
      a.ref_kind || null,
      a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
      a.thread_id || a.session_id || null,
      occurred,
      contentHash,
      content.slice(0, 500),
      eventId,
      transcriptId,
      memoryId,
      "captured",
      JSON.stringify(meta)
    );
  });
  txn();
  try { if (tdb === db) recordWrite(`capture:${a.source}`, 1, "alive"); } catch {}
  let reminder = null;
  try { reminder = maybeAutoCaptureReminder(tdb, a, content, meta, eventId); } catch {}
  return { ok: true, status: "captured", duplicate: false, dedupe_key: dedupeKey, event_id: eventId, transcript_id: transcriptId, memory_id: memoryId, media_id: mediaId, reminder_id: reminder && reminder.id };
}

function mirrorTranscriptCapture(tdb, a = {}, transcriptId, content, privateRedacted) {
  try { ensureUniversalJournalSchema(tdb); } catch {}
  if (!transcriptId || !a.source || !content) return { ok: false, skipped: true };
  const direction = a.direction || "internal";
  const occurred = a.occurred_at || now();
  const refId = a.ref_id != null ? String(a.ref_id) : null;
  const sourceRef = a.source_ref || (a.ref_kind && refId ? `${a.ref_kind}:${refId}` : `transcript:${transcriptId}`);
  const contentHash = sha(content);
  const threadId = a.thread_id || a.session_id || (a.meta && (a.meta.thread_id || a.meta.console_thread_id)) || null;
  const meta = Object.assign({}, a.meta || {}, {
    dedupe_key: null,
    source_ref: sourceRef,
    capture_policy: "transcript-mirror",
    mirrored_from: "mem_transcript_log",
    transcript_id: transcriptId,
    private_redacted: !!privateRedacted
  });
  const dedupeKey = captureDedupeKey(Object.assign({}, a, {
    occurred_at: occurred,
    direction,
    ref_id: refId,
    source_ref: sourceRef,
    thread_id: threadId
  }), contentHash);
  meta.dedupe_key = dedupeKey;
  const existing = tdb.prepare("SELECT dedupe_key, transcript_id, event_id, memory_id, seen_count, status FROM capture_receipt WHERE dedupe_key=?").get(dedupeKey);
  if (existing) {
    tdb.prepare(
      "UPDATE capture_receipt SET transcript_id=COALESCE(transcript_id, ?), last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), seen_count=seen_count+1, status=CASE WHEN status='captured' THEN status ELSE 'duplicate' END, meta_json=? WHERE dedupe_key=?"
    ).run(transcriptId, JSON.stringify(meta), dedupeKey);
    return { ok: true, duplicate: true, dedupe_key: dedupeKey, existing };
  }
  const event = journalEvent(tdb, {
    source: a.source,
    channel: a.channel || null,
    direction,
    actor: a.speaker || a.actor || null,
    actor_id: a.actor_id || null,
    event_kind: a.event_kind || "transcript",
    ref_kind: a.ref_kind || "transcript",
    ref_id: refId || String(transcriptId),
    thread_id: threadId,
    status: a.status || "captured",
    content,
    payload: a.payload || null,
    meta,
    occurred_at: occurred
  });
  let memoryId = null;
  if (a.remember === true || a.promote_memory === true) {
    memoryId = insertCaptureMemory(tdb, a, content, dedupeKey, meta);
  }
  tdb.prepare(`
    INSERT INTO capture_receipt
      (dedupe_key, source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, occurred_at, content_hash, content_preview, event_id, transcript_id, memory_id, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    dedupeKey,
    a.source,
    a.channel || null,
    direction,
    a.speaker || a.actor || null,
    a.actor_id || null,
    a.event_kind || "transcript",
    a.ref_kind || "transcript",
    refId || String(transcriptId),
    threadId,
    occurred,
    contentHash,
    content.slice(0, 500),
    event && event.id || null,
    transcriptId,
    memoryId,
    "captured",
    JSON.stringify(meta)
  );
  try { if (tdb === db) recordWrite(`capture:${a.source}`, 1, "alive"); } catch {}
  return { ok: true, duplicate: false, dedupe_key: dedupeKey, event_id: event && event.id || null, transcript_id: transcriptId, memory_id: memoryId };
}

function captureBriefConversation(tdb, briefId, agentName, sourceAgent, content, channel, meta, options = {}) {
  if (!briefId || !content) return { ok: false, skipped: true };
  const direction = options.direction || "inbound";
  const actor = direction === "outbound" ? (agentName || sourceAgent || null) : (sourceAgent || agentName || null);
  const captureMeta = Object.assign({}, meta || {}, options.meta || {}, {
    brief_id: briefId,
    brief_agent: agentName || null,
    brief_source_agent: sourceAgent || null
  });
  return captureIngest(tdb, {
    source: options.source || "brief",
    channel: channel || options.channel || "brief",
    direction,
    actor,
    speaker: actor,
    event_kind: options.event_kind || "brief_message",
    ref_kind: "agent_brief",
    ref_id: String(briefId),
    source_ref: `agent_brief:${briefId}`,
    thread_id: captureMeta.thread_id || `brief:${briefId}`,
    occurred_at: options.occurred_at || captureMeta.occurred_at || now(),
    content,
    promote_transcript: true,
    promote_memory: options.promote_memory !== false,
    remember: options.remember !== false,
    importance: options.importance != null ? options.importance : 7,
    meta: captureMeta
  });
}

function ensureReminderTables(tdb) {
  tdb.exec(`
CREATE TABLE IF NOT EXISTS reminder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_name TEXT NOT NULL DEFAULT 'owner',
  agent_name TEXT,
  scope TEXT,
  title TEXT NOT NULL,
  details TEXT,
  due_at TEXT,
  due_text TEXT,
  due_precision TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT,
  source_ref TEXT,
  channel TEXT,
  actor TEXT,
  actor_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  notified_at TEXT,
  notify_count INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT UNIQUE,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_status_due ON reminder(status, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_owner_due ON reminder(owner_name, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_agent_due ON reminder(agent_name, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_source_ref ON reminder(source, source_ref);
`);
}

function wantsReminderCapture(text) {
  const s = normalizeReminderText(text);
  return /\b(erinner(?:e|n)?\s+(?:mich|uns)|kannst du .*erinner|remind me|reminder|merk(?:e)?\s+(?:dir|das)|notier(?:e)?\s+(?:dir|das))\b/.test(s);
}

function insertReminder(tdb, a = {}) {
  ensureReminderTables(tdb);
  const text = a.text || a.details || a.title || "";
  const parsed = a.due_at
    ? { due_at: isoOrNull(a.due_at), due_text: a.due_text || String(a.due_at), due_precision: a.due_precision || "explicit", confidence: "high" }
    : parseReminderDue(text, a.base_time || a.occurred_at);
  const dueAt = parsed.due_at || null;
  const status = a.status || (dueAt ? "open" : "needs_due_at");
  const title = a.title || reminderTitleFromText(text);
  const owner = a.owner_name || OWNER_NAME || "owner";
  const sourceRef = a.source_ref || (a.ref_kind && a.ref_id != null ? `${a.ref_kind}:${a.ref_id}` : null);
  const dedupeKey = a.dedupe_key || sha(["reminder", owner, sourceRef || "", title, dueAt || parsed.due_text || "", text].join("|"));
  const meta = Object.assign({}, a.meta || {}, { confidence: parsed.confidence, captured_from_text: !!a.text });
  const info = tdb.prepare(`
    INSERT OR IGNORE INTO reminder
      (owner_name, agent_name, scope, title, details, due_at, due_text, due_precision, timezone, status, source, source_ref, channel, actor, actor_id, created_by, dedupe_key, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    owner,
    a.agent_name || null,
    a.scope || a.project || null,
    title,
    a.details || text || null,
    dueAt,
    parsed.due_text || a.due_text || null,
    parsed.due_precision || a.due_precision || null,
    a.timezone || null,
    status,
    a.source || null,
    sourceRef,
    a.channel || null,
    a.actor || null,
    a.actor_id || null,
    a.created_by || a.agent_name || a.actor || null,
    dedupeKey,
    JSON.stringify(meta)
  );
  const row = info.changes > 0
    ? tdb.prepare("SELECT * FROM reminder WHERE id=?").get(info.lastInsertRowid)
    : tdb.prepare("SELECT * FROM reminder WHERE dedupe_key=?").get(dedupeKey);
  if (row) {
    try { ftsIndex(tdb, "reminder", row.id, row.agent_name || row.actor || row.owner_name || "", row.title, [row.title, row.details, row.due_text, row.due_at].filter(Boolean).join("\n")); } catch {}
  }
  return Object.assign({ ok: true, inserted: info.changes > 0 }, reminderRow(row));
}

function reminderWhere(a = {}) {
  const where = [];
  const params = [];
  if (a.status) { where.push("status=?"); params.push(String(a.status)); }
  else if (!a.include_done) where.push("status IN ('open','needs_due_at','snoozed')");
  if (a.owner_name) { where.push("owner_name=?"); params.push(String(a.owner_name)); }
  if (a.agent_name) { where.push("(agent_name=? OR agent_name IS NULL)"); params.push(String(a.agent_name)); }
  if (a.scope || a.project) { where.push("scope=?"); params.push(String(a.scope || a.project)); }
  if (a.due_before) { where.push("due_at IS NOT NULL AND due_at<=?"); params.push(isoOrNull(a.due_before) || String(a.due_before)); }
  if (a.due_after) { where.push("due_at IS NOT NULL AND due_at>=?"); params.push(isoOrNull(a.due_after) || String(a.due_after)); }
  if (a.query) { where.push("(title LIKE ? OR details LIKE ? OR meta_json LIKE ?)"); const q = "%" + String(a.query) + "%"; params.push(q, q, q); }
  return { where: where.length ? where : ["1=1"], params };
}

function isValidRuntimeAgentName(name) {
  const s = String(name || "").trim();
  if (!s || s === "null" || s === "undefined") return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (s.length > 80) return false;
  return true;
}

function invalidRuntimeAgentRow(r) {
  return {
    agent_name: r && r.agent_name != null ? String(r.agent_name) : null,
    display_name: r && r.display_name != null ? String(r.display_name) : null,
    host: r && r.host != null ? String(r.host) : null,
    status: r && r.status != null ? String(r.status) : null,
    last_seen_at: r && r.last_seen_at || null,
  };
}

function maybeAutoCaptureReminder(tdb, a, content, meta, eventId) {
  if (!content || a.no_auto_reminder || !wantsReminderCapture(content)) return null;
  return insertReminder(tdb, {
    text: content,
    owner_name: a.owner_name || OWNER_NAME,
    agent_name: a.agent_name || null,
    scope: a.scope || a.project || null,
    source: a.source || "capture",
    source_ref: a.source_ref || (a.ref_id != null ? String(a.ref_id) : null),
    channel: a.channel || null,
    actor: a.actor || a.speaker || null,
    actor_id: a.actor_id || null,
    created_by: "auto-capture",
    occurred_at: a.occurred_at || null,
    meta: Object.assign({}, meta || {}, { auto_captured_from_event_id: eventId || null }),
  });
}

function runtimeHealth(tdb, a = {}) {
  const staleSec = Math.max(60, parseInt(a.stale_sec || 300, 10));
  const nowMs = Date.now();
  ensureUniversalJournalSchema(tdb);
  let registry = [];
  try {
    registry = tdb.prepare("SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json FROM agent_registry ORDER BY agent_name").all();
  } catch {}
  let liveByAgent = new Map();
  try {
    const liveRows = tdb.prepare("SELECT * FROM agent_status_live").all();
    liveByAgent = new Map(liveRows.map((r) => [r.agent_name, r]));
  } catch {}
  let pendingByAgent = new Map();
  try {
    pendingByAgent = new Map(tdb.prepare("SELECT agent_name, COUNT(*) c FROM agent_brief WHERE status='pending' GROUP BY agent_name").all().map(r => [r.agent_name, r.c]));
  } catch {}
  let errorsByAgent = new Map();
  try {
    errorsByAgent = new Map(tdb.prepare("SELECT agent_name, COUNT(*) c FROM agent_action WHERE status IN ('error','failed','auth_failed','completion_guard_missing','regression_guard_missing','site_contract_guard_missing') AND started_at > datetime('now','-1 hour') GROUP BY agent_name").all().map(r => [r.agent_name, r.c]));
  } catch {}
  let dueReminders = 0;
  try {
    ensureReminderTables(tdb);
    dueReminders = tdb.prepare("SELECT COUNT(*) c FROM reminder WHERE status='open' AND due_at IS NOT NULL AND due_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')").get().c || 0;
  } catch {}
  const invalidRegistryRows = [];
  const validRegistry = [];
  for (const raw of registry) {
    const r = Object.assign({}, raw, { agent_name: raw && raw.agent_name != null ? String(raw.agent_name).trim() : "" });
    if (!isValidRuntimeAgentName(r.agent_name)) {
      invalidRegistryRows.push(invalidRuntimeAgentRow(raw));
      continue;
    }
    validRegistry.push(r);
  }
  const agents = validRegistry.map((r) => {
    const meta = parseMetaJson(r.meta_json);
    const live = liveByAgent.get(r.agent_name) || null;
    const liveMeta = live ? parseMetaJson(live.meta_json) : {};
    const preflight = meta.last_runtime_preflight || liveMeta.last_runtime_preflight || null;
    const passport = agentPassportData(tdb, r.agent_name);
    const lastSeenMs = r.last_seen_at ? Date.parse(r.last_seen_at) : 0;
    const ageSec = lastSeenMs ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null;
    const stale = ageSec == null || ageSec > staleSec;
    const dirty = !!(meta.mnemo_dirty || liveMeta.mnemo_dirty);
    const blocked = r.status === "blocked" || !!meta.engine_blocked || !!liveMeta.engine_blocked || !!(live && live.blocked_on) || !!(preflight && preflight.status === "blocked");
    const errorCount = errorsByAgent.get(r.agent_name) || 0;
    const health = stale ? "offline" : (blocked ? "blocked" : (dirty ? "dirty" : (errorCount ? "degraded" : "ok")));
    return {
      agent_name: r.agent_name,
      status: r.status,
      health,
      host: r.host,
      pid: r.pid,
      last_seen_at: r.last_seen_at,
      age_sec: ageSec,
      pending_briefs: pendingByAgent.get(r.agent_name) || 0,
      errors_1h: errorCount,
      current_task: live && live.current_task || null,
      blocked_on: live && live.blocked_on || null,
      loop_version: meta.loop_version || liveMeta.loop_version || null,
      requested_engine: meta.requested_engine || liveMeta.requested_engine || null,
      engine: meta.engine || liveMeta.engine || null,
      engine_command: meta.engine_command || liveMeta.engine_command || null,
      mnemo_git_commit: meta.mnemo_git_commit || liveMeta.mnemo_git_commit || null,
      mnemo_git_branch: meta.mnemo_git_branch || liveMeta.mnemo_git_branch || null,
      mnemo_dirty: dirty,
      workspace: meta.workspace || liveMeta.workspace || null,
      workspace_git_commit: meta.workspace_git_commit || liveMeta.workspace_git_commit || null,
      workspace_dirty: !!(meta.workspace_dirty || liveMeta.workspace_dirty),
      last_runtime_preflight: preflight,
      runtime_preflight_status: preflight && preflight.status || null,
      runtime_preflight_blocked_on: preflight && preflight.blocked_on || null,
      runtime_preflight_degraded_on: preflight && preflight.degraded_on || null,
      passport_source: passport.source_kind,
      passport_status: passport.status,
      passport_lane: passport.lane,
      passport_departments: passport.departments,
      live_write: passport.live_write,
      review_required: passport.review_required,
      approval_class: passport.approval_class,
    };
  });
  const connectors = connectorListData(tdb, { include_derived: true, include_access_routes: false, stale_days: a.connector_stale_days || 30 });
  const explicitPassports = tdb.prepare("SELECT COUNT(*) c FROM agent_passport").get().c || 0;
  const summary = {
    total: agents.length,
    ok: agents.filter(a => a.health === "ok").length,
    dirty: agents.filter(a => a.health === "dirty").length,
    degraded: agents.filter(a => a.health === "degraded").length,
    blocked: agents.filter(a => a.health === "blocked").length,
    offline: agents.filter(a => a.health === "offline").length,
    pending_briefs: agents.reduce((sum, a) => sum + (a.pending_briefs || 0), 0),
    errors_1h: agents.reduce((sum, a) => sum + (a.errors_1h || 0), 0),
    due_reminders: dueReminders,
    invalid_registry_rows: invalidRegistryRows.length,
    connectors_total: connectors.length,
    connectors_stale: connectors.filter((connector) => ["stale", "critical"].includes(connector.freshness_status)).length,
    connectors_unhealthy: connectors.filter((connector) => ["error", "degraded", "stale"].includes(String(connector.health_status || ""))).length,
    explicit_passports: explicitPassports,
    derived_passports: Math.max(0, agents.length - explicitPassports),
  };
  const out = { checked_at: new Date().toISOString(), stale_sec: staleSec, summary, agents };
  if (a.include_invalid) out.invalid_registry_rows = invalidRegistryRows;
  return out;
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

const CORS_ALLOWED_ORIGINS = new Set(
  String(process.env.MNEMO_CORS_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);
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
    collectBody(req, res, (body) => {
      try {
        const payload = JSON.parse(body);
        const events = Array.isArray(payload) ? payload : [payload];
        journalEvent(tdb, {
          source: "http",
          channel: "/ingest",
          direction: "inbound",
          actor: payload && payload.actor || null,
          actor_id: payload && payload.actor_id || null,
          event_kind: "http_ingest_request",
          status: "received",
          content: body,
          payload,
          meta: { tenant: tenantId, count: events.length, remote: req.socket && req.socket.remoteAddress }
        });
        const results = events.map(e => ingestEvent(tdb, e));
        const added = results.filter(r => r.inserted).length;
        if (!tenantId) recordWrite("http_ingest", added);
        journalEvent(tdb, {
          source: "http",
          channel: "/ingest",
          direction: "outbound",
          event_kind: "http_ingest_result",
          status: "ok",
          payload: { tenant: tenantId, accepted: events.length, inserted: added, results }
        });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tenant: tenantId, accepted: events.length, inserted: added, results }));
      } catch (e) {
        journalEvent(tdb, {
          source: "http",
          channel: "/ingest",
          direction: "inbound",
          event_kind: "http_ingest_error",
          status: "error",
          content: body,
          meta: { tenant: tenantId, error: String(e.message), remote: req.socket && req.socket.remoteAddress }
        });
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
      const rows = recallMemories(tdb, { query: q, limit, mode: "hybrid", include_journal: true });
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
    collectBody(req, res, (body) => {
      let a = {};
      try { a = body ? JSON.parse(body) : {}; } catch { a = {}; }
      const cmd = String(a.command || "view").toLowerCase();
      const p = String(a.path || a.old_path || "/memories").replace(/\/+$/, "") || "/memories";
      const agent = a.agent || a.agent_name || DEFAULT_AGENT;
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
            return okJson(handleTool(tdb, "mem_session_handoff", Object.assign({}, content, { agent_name: sourceAgent, summary: handoff })));
          }
          const rulesMatch = p.match(/^\/memories\/projects\/(.+)\/rules\.md$/);
          if (rulesMatch) {
            const name = projectNameFrom(rulesMatch);
            return okJson(handleTool(tdb, "mem_project_rules_set", Object.assign({}, content, { project: name, updated_by: content.updated_by || agent })));
          }
          const findingMatch = p.match(/^\/memories\/projects\/(.+)\/findings\.md$/);
          if (findingMatch) {
            const project = projectNameFrom(findingMatch);
            return okJson(handleTool(tdb, "mem_quality_finding_report", Object.assign({}, content, { project, source_agent: content.source_agent || agent })));
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
            "  top.md",
            "  today.md",
            "  inbox.md",
            "  identity.md",
            "  focus.md",
            "  promises.md",
            "  company/",
            "    brand.md",
            "    legal.md",
            "    pricing.md",
            "  firm/",
            "    readiness.md",
            "  decisions/",
            "    today.md",
            "  agents/",
            "    <agent>/status.md",
            "    <agent>/handoff.md",
            "  projects/",
            "    <project>/registry.md",
            "    <project>/live-check.md",
            "    <project>/rules.md",
            "    <project>/findings.md",
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
        if (p === "/memories/top.md") {
          const session = handleTool(tdb, "mem_session_brief", { agent_name: agent, project: a.project, task: a.task || "current work", token_budget: 900 });
          const recall = recallMemories(tdb, {
            query: [agent, a.project, "rules decisions blockers no-touch current work"].filter(Boolean).join(" "),
            limit: Math.min(a.limit || 12, 30),
            include_journal: true
          });
          const lines = ["# Top Mnemo Context", "", "Weighted context for hooks and agents. Use this instead of reading a huge raw MEMORY.md tail."];
          lines.push("", "## Session brief", renderJson(session));
          lines.push("", "## Top recall hits");
          for (const row of Array.isArray(recall) ? recall : []) {
            lines.push(`- ${row.surface || "memory"}:${row.ref_id || row.id} ${row.kind || ""} ${row.actor || ""} @ ${row.occurred_at || ""} — ${String(row.preview || "").replace(/\s+/g, " ").slice(0, 220)}`);
          }
          return ok(lines.join("\n"));
        }
        if (p === "/memories/inbox.md") {
          const r = handleTool(tdb, "mem_brief_pull", { agent_name: a.agent || DEFAULT_AGENT, peek: true, limit: 10 });
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
          const r = handleTool(tdb, "mem_company_fact_get", { scope: a.scope, topic });
          return ok(`# ${topic}\n\n` + renderJson(r.value || r));
        }
        if (p === "/memories/firm/readiness.md") {
          const r = handleTool(tdb, "mem_firm_readiness_board", { scope: a.scope });
          return ok(r.doc || renderJson(r), { summary: r.summary });
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
          return ok([`/memories/projects/${projectRoot[1]}`, "  registry.md", "  live-check.md", "  rules.md", "  findings.md", "  decisions.md", "  files.md", "  doc.md"].join("\n"), { project: name });
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
        const rulesView = p.match(/^\/memories\/projects\/(.+)\/rules\.md$/);
        if (rulesView) {
          const name = projectNameFrom(rulesView);
          const r = handleTool(tdb, "mem_project_rules_get", { project: name });
          return ok(`# ${name} rules\n\n` + renderJson(r));
        }
        const findingsView = p.match(/^\/memories\/projects\/(.+)\/findings\.md$/);
        if (findingsView) {
          const name = projectNameFrom(findingsView);
          const r = handleTool(tdb, "mem_quality_finding_list", { project: name, status: a.status || "open", limit: a.limit || 50 });
          const items = r.findings || [];
          return ok(`# ${name} findings\n\n` + (items.map(x => `- #${x.id} [${x.severity}] ${x.category}: ${x.title} (${x.status})`).join("\n") || "No open findings."));
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
        const startView = p.match(/^\/memories\/agents\/(.+)\/start\.md$/);
        if (startView) {
          const target = projectNameFrom(startView);
          const r = handleTool(tdb, "mem_session_start", { agent_name: target, project: a.project, task: a.task });
          return ok(`# ${target} session-start\n\n` + renderJson(r));
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
    collectBody(req, res, (body) => {
      const requestAt = now();
      let args = {};
      try { args = body ? JSON.parse(body) : {}; }
      catch (e) {
        journalEvent(tdb, {
          source: "http-tool",
          channel: tool,
          direction: "inbound",
          event_kind: "tool_call_invalid_json",
          status: "error",
          content: body,
          meta: { tenant: tenantId, error: String(e.message), remote: req.socket && req.socket.remoteAddress },
          occurred_at: requestAt
        });
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid JSON: " + e.message }));
      }
      journalEvent(tdb, {
        source: "http-tool",
        channel: tool,
        direction: "inbound",
        actor: args.agent_name || args.source_agent || args.actor || null,
        event_kind: "tool_call",
        status: "started",
        content: args.content || args.text || args.summary || args.question || args.target || null,
        payload: args,
        meta: { tenant: tenantId, remote: req.socket && req.socket.remoteAddress },
        occurred_at: requestAt
      });
      try {
        const result = handleTool(tdb, tool, args);
        injectContext(tdb, tool, args, result);
        journalEvent(tdb, {
          source: "http-tool",
          channel: tool,
          direction: "outbound",
          actor: args.agent_name || args.source_agent || args.actor || null,
          event_kind: "tool_result",
          status: result && result.error ? "error" : "ok",
          ref_kind: result && result.id ? tool : null,
          ref_id: result && result.id ? result.id : null,
          content: result && (result.content || result.text || result.summary || result.outcome) || null,
          payload: result,
          meta: { tenant: tenantId, latency_ms: Date.now() - Date.parse(requestAt) }
        });
        return sendJson(req, res, 200, { tool, result });
      } catch (e) {
        journalEvent(tdb, {
          source: "http-tool",
          channel: tool,
          direction: "outbound",
          actor: args.agent_name || args.source_agent || args.actor || null,
          event_kind: "tool_result",
          status: "exception",
          content: String(e.message),
          meta: { tenant: tenantId, latency_ms: Date.now() - Date.parse(requestAt) }
        });
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
    const lib = url.protocol === "https:" ? https : http;
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
        const lib = url.protocol === "https:" ? https : http;
        const body = Buffer.from(JSON.stringify(payload));
        const req = lib.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { "Content-Type": "application/json", "Content-Length": body.length } }, (rs) => { rs.resume(); });
        req.on("error", (e) => { console.error("[notify-webhook]", agent.notify_webhook, e.message); }); req.write(body); req.end();
      } catch (e) {}
    }
    if (agent.notify_telegram_chat) {
      try {
        const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE || "";
        let token = process.env.TELEGRAM_BOT_TOKEN || "";
        if (!token && fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile,"utf8").trim();
        if (token) {
          const text = "[mnemo " + eventType + "] #" + briefId + " -> " + brief.agent_name + "\nfrom: " + (brief.source_agent || "?") + "\nchannel: " + (brief.channel || "-") + "\n\n" + ((brief.preview || "").slice(0,200));
          const data = JSON.stringify({ chat_id: agent.notify_telegram_chat, text, disable_notification: false });
          const req = https.request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (rs) => { rs.resume(); });
          req.on("error", (e) => { console.error("[notify-telegram]", e.message); }); req.write(data); req.end();
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
  "mem_health","mem_loop_doctor","mem_agent_name_migrate","mem_brief_requeue_stale","mem_brief_reconcile_stale","mem_project_timeline_report","mem_work_report_feed","mem_brief_health","mem_brief_status","mem_brief_list","mem_brief_pull","mem_brief_done",
  "mem_runtime_health","mem_agent_memory_health",
  "mem_action_log","mem_action_finish","mem_actions_recent","mem_actions_search",
  "mem_capture_ingest","mem_capture_ingest_batch","mem_capture_recent","mem_media_capture","mem_media_recent","mem_media_search","mem_media_get","mem_event_log","mem_event_recent","mem_source_coverage","mem_access_list","mem_access_guide","mem_access_event_log",
  "mem_connector_upsert","mem_connector_list","mem_agent_pass_set","mem_agent_pass_get","mem_agent_pass_list","mem_drift_check_report","mem_drift_status",
  "mem_duplicate_work_check","mem_impact_map","mem_write_gate_check",
  "mem_maintenance_window_upsert","mem_maintenance_window_list","mem_maintenance_window_check",
  "mem_override_log","mem_override_list","mem_override_check",
  "mem_artifact_lock_set","mem_artifact_lock_list","mem_artifact_lock_check",
  "mem_secret_rotation_log","mem_secret_rotation_list",
  "mem_freeze_set","mem_freeze_list","mem_freeze_check",
  "mem_incident_report","mem_incident_list","mem_status_board","mem_learning_loop_report","mem_search_reindex",
  "mem_reminder_add","mem_reminder_capture","mem_reminder_list","mem_reminder_due","mem_reminder_done","mem_reminder_snooze",
  "mem_context_preview","mem_code_outline","mem_code_unfold",
  "mem_transcript_log","mem_transcript_recent",
  "mem_idle_loop_set","mem_idle_loop_status","mem_set_mode","mem_get_mode",
  "mem_connect_register","mem_connect_heartbeat","mem_connect_list","mem_agent_list","mem_agent_register",
  "mem_agent_mail_account_upsert","mem_agent_mail_account_list","mem_agent_mail_inbox","mem_agent_mail_outbox","mem_agent_mail_record_inbound","mem_agent_mail_dispatch","mem_agent_mail_queue_outbound","mem_agent_mail_mark",
  "mem_skill_list","mem_skill_get","mem_skill_match","mem_skill_search","mem_skill_run","mem_skill_record",
  "mem_consults_inbox","mem_consult_agent_pending","mem_consult_agent_status",
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

function workReportFeedData(tdb, input = {}) {
  ensureAutonomyTables(tdb);
  const project = input.project ? String(input.project) : null;
  const agentName = input.agent_name ? String(input.agent_name) : null;
  const includeBlocked = !!input.include_blocked;
  const limit = Math.max(1, Math.min(parseInt(input.limit || 20, 10) || 20, 200));

  const handoffWhere = [];
  const handoffParams = [];
  if (project) {
    handoffWhere.push("project=?");
    handoffParams.push(project);
  }
  if (agentName) {
    handoffWhere.push("agent_name=?");
    handoffParams.push(agentName);
  }
  handoffParams.push(limit);
  const reports = tdb.prepare(
    "SELECT id, agent_name, project, summary, changed_files, tests, deploys, blockers, next_actions, claims_released, meta_json, created_at " +
    "FROM session_handoff " +
    (handoffWhere.length ? "WHERE " + handoffWhere.join(" AND ") + " " : "") +
    "ORDER BY created_at DESC LIMIT ?"
  ).all(...handoffParams).map(row => ({
    id: row.id,
    kind: "report",
    at: row.created_at,
    agent_name: row.agent_name,
    project: row.project || null,
    summary: row.summary,
    changed_files: parseMaybeJson(row.changed_files, []),
    tests: parseMaybeJson(row.tests, []),
    deploys: parseMaybeJson(row.deploys, []),
    blockers: parseMaybeJson(row.blockers, []),
    next_actions: parseMaybeJson(row.next_actions, []),
    claims_released: parseMaybeJson(row.claims_released, []),
    meta: parseMaybeJson(row.meta_json, {})
  }));

  const doneStatuses = includeBlocked
    ? ["review", "done", "closed", "resolved", "blocked"]
    : ["review", "done", "closed", "resolved"];
  const taskWhere = ["status IN (" + doneStatuses.map(() => "?").join(",") + ")"];
  const taskParams = [...doneStatuses];
  if (project) {
    taskWhere.push("project=?");
    taskParams.push(project);
  }
  if (agentName) {
    taskWhere.push("(assigned_agent=? OR reviewer_agent=?)");
    taskParams.push(agentName, agentName);
  }
  taskParams.push(limit);
  const completedTasks = tdb.prepare(
    "SELECT id, project, department_name, title, category, severity, status, assigned_agent, reviewer_agent, source_kind, source_id, checklist_json, notes, meta_json, created_at, updated_at, done_at " +
    "FROM autonomy_task WHERE " + taskWhere.join(" AND ") + " " +
    "ORDER BY COALESCE(done_at, updated_at, created_at) DESC LIMIT ?"
  ).all(...taskParams).map(row => ({
    id: row.id,
    kind: "completed_task",
    at: row.done_at || row.updated_at || row.created_at,
    project: row.project,
    department_name: row.department_name,
    title: row.title,
    category: row.category,
    severity: row.severity,
    status: row.status,
    assigned_agent: row.assigned_agent || null,
    reviewer_agent: row.reviewer_agent || null,
    source_kind: row.source_kind || null,
    source_id: row.source_id || null,
    checklist: parseMaybeJson(row.checklist_json, []),
    notes: row.notes || "",
    meta: parseMaybeJson(row.meta_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    done_at: row.done_at || null
  }));

  const feed = reports
    .concat(completedTasks)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, limit);

  return {
    ok: true,
    project,
    agent_name: agentName,
    include_blocked: includeBlocked,
    limit,
    reports_count: reports.length,
    completed_tasks_count: completedTasks.length,
    feed_count: feed.length,
    feed,
    reports,
    completed_tasks: completedTasks,
    protocol: [
      "Read this unified feed before starting new work.",
      "Use the latest reports to avoid duplicate implementation.",
      "If you finish work from a brief, mark that brief done or include it in session_handoff completed_brief_ids."
    ]
  };
}

function loadProjectRuleDefaults(scope) {
  const sc = scopeName(scope);
  const file = factsPathFor(sc, "-project-rules");
  if (!fs.existsSync(file)) return { error: "missing seed file", scope: sc, file };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: "seed file parse error: " + e.message, scope: sc, file };
  }
}

function ensureAutonomyTables(tdb) {
  ensureFirmOpsTables(tdb);
  ensureProjectRegistryTable(tdb);
  tdb.exec(`
CREATE TABLE IF NOT EXISTS department (
  name TEXT PRIMARY KEY,
  mission TEXT NOT NULL,
  lead_agent TEXT,
  review_agent TEXT,
  skills_json TEXT,
  responsibilities_json TEXT,
  required_gates_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS department_member (
  department_name TEXT NOT NULL REFERENCES department(name) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  skills_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (department_name, agent_name)
);
CREATE TABLE IF NOT EXISTS autonomy_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  department_name TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent TEXT,
  reviewer_agent TEXT,
  source_kind TEXT,
  source_id TEXT,
  checklist_json TEXT,
  notes TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  done_at TEXT,
  UNIQUE(project, department_name, title)
);
CREATE INDEX IF NOT EXISTS idx_autonomy_task_status ON autonomy_task(status, department_name, severity);
CREATE INDEX IF NOT EXISTS idx_autonomy_task_agent ON autonomy_task(assigned_agent, status);
CREATE INDEX IF NOT EXISTS idx_autonomy_task_project ON autonomy_task(project, status);
`);
}

function defaultDepartments(agentMap = {}) {
  const coordinator = agentMap.review || agentMap.coordinator || agentMap.default || DEFAULT_AGENT;
  return [
    { name: "strategy-review", mission: "Own final review, cross-project consistency, priorities, and live-readiness sign-off.", lead_agent: coordinator, review_agent: coordinator, skills: ["review","planning","readiness","coordination"], responsibilities: ["final review","verify all gates","prevent duplicate work","route tasks"], required_gates: ["all"] },
    { name: "frontend", mission: "Own landing pages, app chrome, menus, header/footer, responsive UI, i18n, and visual consistency.", lead_agent: agentMap.frontend || agentMap.design || coordinator, review_agent: coordinator, skills: ["frontend","design","navigation","mobile","i18n"], responsibilities: ["landing pages","menus","links","header/footer","mobile","language parity"], required_gates: ["nav","header_footer","links","mobile","i18n","design"] },
    { name: "backend", mission: "Own APIs, auth crossover, account data, sessions, integrations, and security-sensitive flows.", lead_agent: agentMap.backend || coordinator, review_agent: coordinator, skills: ["backend","auth","api","security","integrations"], responsibilities: ["auth","account APIs","data model","webhooks","security"], required_gates: ["auth","api","security","data"] },
    { name: "billing", mission: "Own pricing source of truth, checkout, billing portal, subscriptions, refunds, VAT/OSS, and payment webhooks.", lead_agent: agentMap.billing || agentMap.backend || coordinator, review_agent: coordinator, skills: ["pricing","checkout","stripe","vat","billing"], responsibilities: ["pricing","checkout","billing","VAT/OSS","refunds","webhooks"], required_gates: ["pricing","checkout","billing","vat"] },
    { name: "qa", mission: "Own defect discovery, regression checks, browser/mobile verification, link checks, and language parity checks.", lead_agent: agentMap.qa || coordinator, review_agent: coordinator, skills: ["qa","browser","mobile","links","regression"], responsibilities: ["cross-over checks","bug reports","regressions","verification evidence"], required_gates: ["qa","links","mobile","i18n"] },
    { name: "deploy-ops", mission: "Own environments, server state, deploy gates, monitoring, CORS, secrets, and rollback readiness.", lead_agent: agentMap.ops || agentMap.deploy || coordinator, review_agent: coordinator, skills: ["deploy","server","monitoring","env","cors"], responsibilities: ["deploy","monitoring","server config","CORS","secrets","rollback"], required_gates: ["deploy","monitoring","cors","env"] },
    { name: "content-legal", mission: "Own legal pages, public claims, copy consistency, policy pages, and compliance wording.", lead_agent: agentMap.content || agentMap.legal || coordinator, review_agent: coordinator, skills: ["content","legal","copy","compliance"], responsibilities: ["legal pages","privacy","terms","public claims","copy"], required_gates: ["legal","content","privacy","terms"] }
  ];
}

function gateDepartment(gate) {
  const g = String(gate || "").toLowerCase();
  if (["nav","header_footer","links","mobile","i18n","language","design"].includes(g)) return "frontend";
  if (["auth","api","security","data"].includes(g)) return "backend";
  if (["pricing","checkout","billing","vat","oss","stripe"].includes(g)) return "billing";
  if (["deploy","monitoring","cors","env"].includes(g)) return "deploy-ops";
  if (["legal","content","privacy","terms"].includes(g)) return "content-legal";
  if (["qa","regression"].includes(g)) return "qa";
  return "strategy-review";
}

function categoryDepartment(category) {
  const c = String(category || "").toLowerCase();
  if (["brand","nav","header_footer","links","mobile","language","i18n","design","content"].includes(c)) return c === "content" ? "content-legal" : "frontend";
  if (["auth","api","security","data","bug"].includes(c)) return "backend";
  if (["pricing","checkout","billing","vat","oss","stripe"].includes(c)) return "billing";
  if (["deploy","monitoring","cors","env"].includes(c)) return "deploy-ops";
  if (["legal","privacy","terms"].includes(c)) return "content-legal";
  return "qa";
}

function departmentInfo(tdb, name) {
  ensureAutonomyTables(tdb);
  const row = tdb.prepare("SELECT * FROM department WHERE name=?").get(name);
  if (!row) return null;
  row.skills = parseMaybeJson(row.skills_json, []);
  row.responsibilities = parseMaybeJson(row.responsibilities_json, []);
  row.required_gates = parseMaybeJson(row.required_gates_json, []);
  return row;
}

function taskAssignee(tdb, departmentName) {
  const dep = departmentInfo(tdb, departmentName);
  if (!dep) return { assigned_agent: DEFAULT_AGENT, reviewer_agent: DEFAULT_AGENT };
  return { assigned_agent: dep.lead_agent || DEFAULT_AGENT, reviewer_agent: dep.review_agent || dep.lead_agent || DEFAULT_AGENT };
}

function departmentMembers(tdb, name) {
  ensureAutonomyTables(tdb);
  return tdb.prepare("SELECT agent_name, role, status FROM department_member WHERE department_name=? AND status='active' ORDER BY role, agent_name").all(name);
}

function buildTeamOperatingModel(tdb, agentName = null) {
  ensureAutonomyTables(tdb);
  const departments = tdb.prepare("SELECT name, mission, lead_agent, review_agent, status FROM department WHERE status='active' ORDER BY name").all()
    .map((row) => Object.assign({}, row, { members: departmentMembers(tdb, row.name) }));
  const pausedAgents = new Set(
    tdb.prepare("SELECT agent_name FROM agent_registry WHERE lower(status) IN ('paused','disabled','inactive')").all().map((row) => String(row.agent_name || "").toLowerCase())
  );
  const activeAgentSet = new Set();
  for (const dep of departments) {
    if (dep.lead_agent && !pausedAgents.has(String(dep.lead_agent).toLowerCase())) activeAgentSet.add(dep.lead_agent);
    if (dep.review_agent && !pausedAgents.has(String(dep.review_agent).toLowerCase())) activeAgentSet.add(dep.review_agent);
    for (const member of dep.members) {
      if (member.agent_name && !pausedAgents.has(String(member.agent_name).toLowerCase())) activeAgentSet.add(member.agent_name);
    }
  }
  const coverage = agentName ? departments.filter((dep) => {
    const lower = String(agentName || "").toLowerCase();
    return String(dep.lead_agent || "").toLowerCase() === lower ||
      String(dep.review_agent || "").toLowerCase() === lower ||
      dep.members.some((member) => String(member.agent_name || "").toLowerCase() === lower);
  }).map((dep) => ({
    department_name: dep.name,
    lead_agent: dep.lead_agent,
    review_agent: dep.review_agent,
    roles: dep.members.filter((member) => String(member.agent_name || "").toLowerCase() === String(agentName || "").toLowerCase()).map((member) => member.role || "member")
  })) : [];
  const rosterStatus = agentName
    ? (pausedAgents.has(String(agentName).toLowerCase()) ? "paused" : (activeAgentSet.has(agentName) ? "active" : "unassigned"))
    : null;
  return {
    status: "ok",
    fixed_roster: true,
    active_agents: Array.from(activeAgentSet).sort(),
    paused_agents: Array.from(pausedAgents).sort(),
    departments,
    collaboration_rules: [
      "Read the unified work report feed and recent handoffs before new work.",
      "Stay in your department unless you are the assigned reviewer or the work is explicitly handed off.",
      "One finished task must create one work report or handoff before another agent continues it.",
      "Paused agents do not receive new work."
    ],
    agent_name: agentName || null,
    agent_status: rosterStatus,
    department_coverage: coverage
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return uniqueAgentNames(value.map((item) => String(item || "").trim()));
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return uniqueAgentNames(parsed.map((item) => String(item || "").trim()));
  return uniqueAgentNames(String(value || "").split(/[\n,;]+/).map((item) => item.trim()));
}

function normalizeProjectList(value) {
  return Array.from(new Set(normalizeStringList(value)));
}

function normalizeScopeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DEFAULT_CLAIM_TTL_MINUTES = 240;
const DEFAULT_CLAIM_STALE_SEC = 1800;

function normalizeClaimKind(value) {
  const kind = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!kind || kind === "file_path") return "file";
  return kind;
}

function buildClaimTarget(input = {}) {
  const claimKind = normalizeClaimKind(input.claim_kind || (input.file_path ? "file" : ""));
  const rawValue = input.file_path || input.scope_value || input.route || input.domain || input.server || input.service_name || input.task_key || input.module || "";
  const scopeValue = String(rawValue || "").trim();
  if (!scopeValue) return null;
  const filePath = claimKind === "file"
    ? scopeValue.replace(/\\/g, "/")
    : (input.file_path ? String(input.file_path || "").trim().replace(/\\/g, "/") : scopeValue);
  const scopeKeyBase = claimKind === "file" ? filePath.toLowerCase() : normalizeScopeKey(scopeValue);
  return {
    claim_kind: claimKind,
    scope_value: scopeValue,
    scope_key: `${claimKind}:${scopeKeyBase}`,
    file_path: filePath,
  };
}

function parseClaimMeta(value, fallback = {}) {
  const parsed = parseMaybeJson(value, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

function ensureWorkClaimSchema(tdb) {
  tdb.exec(`
CREATE TABLE IF NOT EXISTS work_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  summary TEXT,
  claim_kind TEXT NOT NULL DEFAULT 'file',
  scope_value TEXT,
  scope_key TEXT,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stale_after_sec INTEGER NOT NULL DEFAULT 1800,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  released_at TEXT,
  takeover_count INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT
);
`);
  const cols = tdb.prepare("PRAGMA table_info(work_claim)").all().map((c) => c.name);
  if (!cols.includes("claim_kind")) tdb.exec("ALTER TABLE work_claim ADD COLUMN claim_kind TEXT NOT NULL DEFAULT 'file'");
  if (!cols.includes("scope_value")) tdb.exec("ALTER TABLE work_claim ADD COLUMN scope_value TEXT");
  if (!cols.includes("scope_key")) tdb.exec("ALTER TABLE work_claim ADD COLUMN scope_key TEXT");
  if (!cols.includes("heartbeat_at")) tdb.exec("ALTER TABLE work_claim ADD COLUMN heartbeat_at TEXT");
  if (!cols.includes("stale_after_sec")) tdb.exec("ALTER TABLE work_claim ADD COLUMN stale_after_sec INTEGER NOT NULL DEFAULT 1800");
  if (!cols.includes("released_at")) tdb.exec("ALTER TABLE work_claim ADD COLUMN released_at TEXT");
  if (!cols.includes("takeover_count")) tdb.exec("ALTER TABLE work_claim ADD COLUMN takeover_count INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("meta_json")) tdb.exec("ALTER TABLE work_claim ADD COLUMN meta_json TEXT");
  try { tdb.prepare("UPDATE work_claim SET claim_kind='file' WHERE claim_kind IS NULL OR trim(claim_kind)=''").run(); } catch {}
  try { tdb.prepare("UPDATE work_claim SET scope_value=file_path WHERE scope_value IS NULL OR trim(scope_value)=''").run(); } catch {}
  try { tdb.prepare("UPDATE work_claim SET scope_key='file:' || lower(replace(file_path, '\\\\', '/')) WHERE scope_key IS NULL OR trim(scope_key)=''").run(); } catch {}
  try { tdb.prepare("UPDATE work_claim SET heartbeat_at=COALESCE(heartbeat_at, claimed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(); } catch {}
  try { tdb.prepare("UPDATE work_claim SET stale_after_sec=COALESCE(stale_after_sec, ?)").run(DEFAULT_CLAIM_STALE_SEC); } catch {}
  try { tdb.prepare("UPDATE work_claim SET takeover_count=COALESCE(takeover_count, 0)").run(); } catch {}
  try { tdb.exec("CREATE INDEX IF NOT EXISTS idx_work_claim_scope_active ON work_claim(project, scope_key, status, expires_at)"); } catch {}
  try { tdb.exec("CREATE INDEX IF NOT EXISTS idx_work_claim_agent_status ON work_claim(agent_name, status, claimed_at DESC)"); } catch {}
  try { tdb.exec("CREATE INDEX IF NOT EXISTS idx_work_claim_kind_status ON work_claim(claim_kind, status, claimed_at DESC)"); } catch {}
}

function cleanupWorkClaims(tdb) {
  ensureWorkClaimSchema(tdb);
  try {
    tdb.prepare("UPDATE work_claim SET status='expired', released_at=COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE status='active' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
  } catch {}
  try {
    tdb.prepare(
      "UPDATE work_claim SET status='stale', released_at=COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
      "WHERE status='active' AND ((julianday('now') - julianday(COALESCE(heartbeat_at, claimed_at))) * 86400.0) > COALESCE(stale_after_sec, ?)"
    ).run(DEFAULT_CLAIM_STALE_SEC);
  } catch {}
}

function workClaimRowData(row) {
  if (!row) return null;
  return Object.assign({}, row, { meta: parseClaimMeta(row.meta_json, {}) });
}

function claimLookupSql(input = {}) {
  if (input.id) return { sql: "SELECT * FROM work_claim WHERE id=?", params: [input.id] };
  const target = buildClaimTarget(input);
  if (!target || !input.agent_name) return null;
  return {
    sql: "SELECT * FROM work_claim WHERE project=? AND scope_key=? AND agent_name=? AND status IN ('active','stale') ORDER BY id DESC LIMIT 1",
    params: [input.project || null, target.scope_key, input.agent_name],
  };
}

function extractClaimTargets(input = {}) {
  const targets = [];
  for (const file of Array.isArray(input.files) ? input.files : []) {
    const target = buildClaimTarget({ claim_kind: "file", file_path: file });
    if (target) targets.push(target);
  }
  for (const claim of Array.isArray(input.claims) ? input.claims : []) {
    const target = buildClaimTarget(claim || {});
    if (target) targets.push(target);
  }
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.scope_key)) return false;
    seen.add(target.scope_key);
    return true;
  });
}

function handleWorkClaim(tdb, input = {}) {
  if (!input.project || !input.agent_name) return { error: "project + agent_name required" };
  const target = buildClaimTarget(input || {});
  if (!target) return { error: "file_path or (claim_kind + scope_value) required" };
  const ttl = Math.max(1, Math.min(1440, input.ttl_minutes || DEFAULT_CLAIM_TTL_MINUTES));
  const staleAfterSec = Math.max(60, Math.min(86400, parseInt(input.stale_after_sec || DEFAULT_CLAIM_STALE_SEC, 10) || DEFAULT_CLAIM_STALE_SEC));
  ensureWorkClaimSchema(tdb);
  cleanupWorkClaims(tdb);
  const existing = tdb.prepare("SELECT * FROM work_claim WHERE project=? AND scope_key=? AND status IN ('active','stale') ORDER BY id DESC LIMIT 1").get(input.project, target.scope_key);
  if (existing && existing.agent_name !== input.agent_name) {
    const staleClaim = String(existing.status || "") === "stale";
    if (!input.allow_takeover || !staleClaim) {
      return {
        ok: false,
        blocked_by: existing.agent_name,
        existing_id: existing.id,
        stale: staleClaim,
        can_takeover: staleClaim,
        claim: workClaimRowData(existing),
        hint: staleClaim ? "Pass allow_takeover:true to recover this stale claim." : "Coordinate with " + existing.agent_name + " or wait until " + existing.expires_at + ".",
      };
    }
    tdb.prepare("UPDATE work_claim SET status='stale_recovered', released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(existing.id);
  }
  const expires = new Date(Date.now() + ttl * 60000).toISOString();
  const now = new Date().toISOString();
  if (existing && existing.agent_name === input.agent_name) {
    tdb.prepare("UPDATE work_claim SET status='active', summary=COALESCE(?, summary), expires_at=?, heartbeat_at=?, stale_after_sec=?, meta_json=COALESCE(?, meta_json), released_at=NULL WHERE id=?")
      .run(input.summary || null, expires, now, staleAfterSec, input.meta ? JSON.stringify(input.meta) : null, existing.id);
    return { ok: true, id: existing.id, action: "refreshed", claim_kind: target.claim_kind, scope_value: target.scope_value, expires_at: expires, heartbeat_at: now };
  }
  const takeoverCount = existing && existing.agent_name !== input.agent_name ? Number(existing.takeover_count || 0) + 1 : 0;
  const meta = Object.assign({}, input.meta || {}, existing && existing.agent_name !== input.agent_name ? { takeover_from_claim_id: existing.id, takeover_from_agent: existing.agent_name } : {});
  const info = tdb.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, claim_kind, scope_value, scope_key, heartbeat_at, stale_after_sec, expires_at, status, released_at, takeover_count, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.project, target.file_path, input.agent_name, input.summary || null, target.claim_kind, target.scope_value, target.scope_key, now, staleAfterSec, expires, "active", null, takeoverCount, JSON.stringify(meta));
  return { ok: true, id: info.lastInsertRowid, action: existing ? "taken_over" : "claimed", claim_kind: target.claim_kind, scope_value: target.scope_value, expires_at: expires, heartbeat_at: now, takeover_from: existing && existing.agent_name !== input.agent_name ? existing.agent_name : null };
}

function handleWorkHeartbeat(tdb, input = {}) {
  ensureWorkClaimSchema(tdb);
  cleanupWorkClaims(tdb);
  const lookup = claimLookupSql(input || {});
  if (!lookup) return { error: "id OR (project + agent_name + file_path/scope) required" };
  const row = tdb.prepare(lookup.sql).get(...lookup.params);
  if (!row) return { error: "no active claim found" };
  const now = new Date().toISOString();
  const expires = input.ttl_minutes ? new Date(Date.now() + Math.max(1, Math.min(1440, input.ttl_minutes)) * 60000).toISOString() : row.expires_at;
  tdb.prepare("UPDATE work_claim SET status='active', heartbeat_at=?, expires_at=?, released_at=NULL WHERE id=?").run(now, expires, row.id);
  return { ok: true, id: row.id, heartbeat_at: now, expires_at: expires, claim_kind: row.claim_kind, scope_value: row.scope_value || row.file_path };
}

function handleWorkHeartbeatBatch(tdb, input = {}) {
  if (!input.agent_name) return { error: "agent_name required" };
  ensureWorkClaimSchema(tdb);
  cleanupWorkClaims(tdb);
  const where = ["status IN ('active','stale')", "agent_name=?"];
  const params = [input.agent_name];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  const rows = tdb.prepare("SELECT id, claim_kind, scope_value, file_path, expires_at FROM work_claim WHERE " + where.join(" AND ")).all(...params);
  if (!rows.length) return { ok: true, refreshed: 0, claims: [] };
  const now = new Date().toISOString();
  const ttl = input.ttl_minutes ? Math.max(1, Math.min(1440, input.ttl_minutes)) : 0;
  const stmt = ttl
    ? tdb.prepare("UPDATE work_claim SET status='active', heartbeat_at=?, expires_at=?, released_at=NULL WHERE id=?")
    : tdb.prepare("UPDATE work_claim SET status='active', heartbeat_at=?, released_at=NULL WHERE id=?");
  const txn = tdb.transaction(() => {
    for (const r of rows) {
      if (ttl) {
        stmt.run(now, new Date(Date.now() + ttl * 60000).toISOString(), r.id);
      } else {
        stmt.run(now, r.id);
      }
    }
  });
  txn();
  return { ok: true, refreshed: rows.length, heartbeat_at: now, claims: rows.map((r) => ({ id: r.id, claim_kind: r.claim_kind, scope_value: r.scope_value || r.file_path })) };
}

function handleWorkRelease(tdb, input = {}) {
  ensureWorkClaimSchema(tdb);
  const lookup = claimLookupSql(input || {});
  if (!lookup) return { error: "id OR (project + agent_name + file_path/scope) required" };
  const row = tdb.prepare(lookup.sql).get(...lookup.params);
  if (!row) return { error: "no active claim found" };
  const status = input.status || "released";
  tdb.prepare("UPDATE work_claim SET status=?, summary=COALESCE(?, summary), released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(status, input.outcome ? "released: " + input.outcome : null, row.id);
  return { ok: true, id: row.id, claim_kind: row.claim_kind, scope_value: row.scope_value || row.file_path, status };
}

function handleWorkActive(tdb, input = {}) {
  ensureWorkClaimSchema(tdb);
  cleanupWorkClaims(tdb);
  const where = [input.include_stale ? "status IN ('active','stale')" : "status='active'"];
  const params = [];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(input.agent_name); }
  if (input.claim_kind) { where.push("claim_kind=?"); params.push(normalizeClaimKind(input.claim_kind)); }
  if (input.scope_value) {
    const target = buildClaimTarget({ claim_kind: input.claim_kind, scope_value: input.scope_value, file_path: input.claim_kind === "file" ? input.scope_value : null });
    if (target) { where.push("scope_key=?"); params.push(target.scope_key); }
  }
  const lim = Math.min(input.limit || 50, 200);
  params.push(lim);
  const rows = tdb.prepare("SELECT * FROM work_claim WHERE " + where.join(" AND ") + " ORDER BY claimed_at DESC LIMIT ?").all(...params).map(workClaimRowData);
  return { count: rows.length, claims: rows };
}

function handleWorkSimilar(tdb, input = {}) {
  ensureWorkClaimSchema(tdb);
  cleanupWorkClaims(tdb);
  const target = buildClaimTarget(input || {});
  if (!target) return { error: "file_path or (claim_kind + scope_value) required" };
  const lim = Math.min(input.limit || 20, 100);
  let rows = [];
  if (target.claim_kind === "file") {
    const dir = target.file_path.includes("/") ? target.file_path.replace(/\/[^\/]+$/, "/") : target.file_path;
    const pattern = dir + "%";
    const params = [target.scope_key, pattern];
    let where = "(scope_key=? OR file_path LIKE ?)";
    if (input.project) { where += " AND project=?"; params.push(input.project); }
    where += " AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day') OR COALESCE(released_at, claimed_at) > datetime('now','-1 day'))";
    params.push(lim);
    rows = tdb.prepare("SELECT * FROM work_claim WHERE " + where + " ORDER BY claimed_at DESC LIMIT ?").all(...params).map(workClaimRowData);
  } else {
    const params = [target.claim_kind, target.scope_key, target.scope_value];
    let where = "claim_kind=? AND (scope_key=? OR scope_value=?)";
    if (input.project) { where += " AND project=?"; params.push(input.project); }
    where += " AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day') OR COALESCE(released_at, claimed_at) > datetime('now','-1 day'))";
    params.push(lim);
    rows = tdb.prepare("SELECT * FROM work_claim WHERE " + where + " ORDER BY claimed_at DESC LIMIT ?").all(...params).map(workClaimRowData);
  }
  return { count: rows.length, similar: rows, exact_match_count: rows.filter((row) => String(row.scope_key || "") === target.scope_key).length };
}

function connectorListData(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const staleDays = Math.max(1, parseInt(input.stale_days || 30, 10) || 30);
  const includeDerived = input.include_derived !== false;
  const includeAccessRoutes = input.include_access_routes !== false;
  const where = [];
  const params = [];
  if (input.scope) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(scopeName(input.scope)); }
  if (input.project) { where.push("project=?"); params.push(String(input.project)); }
  if (input.system_name) { where.push("system_name=?"); params.push(String(input.system_name)); }
  if (input.owner_agent) { where.push("owner_agent=?"); params.push(String(input.owner_agent)); }
  if (input.lifecycle_status) { where.push("lifecycle_status=?"); params.push(String(input.lifecycle_status)); }
  const rows = tdb.prepare(
    "SELECT * FROM connector_registry" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY project, system_name"
  ).all(...params);
  const explicitSystems = new Set();
  const connectors = rows.map((row) => {
    explicitSystems.add(String(row.scope || "default") + "::" + String(row.system_name || ""));
    const allowedAgents = normalizeStringList(row.allowed_agents_json);
    const ageDays = isoAgeDays(row.last_health_at || row.last_verified_at || row.updated_at);
    const freshness = freshnessFromAgeDays(ageDays, staleDays, Math.max(staleDays + 15, staleDays * 2));
    const connector = {
      id: row.id,
      scope: row.scope,
      project: row.project || null,
      system_name: row.system_name,
      owner_agent: row.owner_agent || null,
      auth_type: row.auth_type || null,
      secret_ref: row.secret_ref || null,
      rate_limit: row.rate_limit || null,
      allowed_agents: allowedAgents,
      read_enabled: !!row.read_enabled,
      write_enabled: !!row.write_enabled,
      live_write_enabled: !!row.live_write_enabled,
      lifecycle_status: row.lifecycle_status,
      approval_class: row.approval_class,
      endpoint: row.endpoint || null,
      health_status: row.health_status || "unknown",
      health_summary: row.health_summary || null,
      last_health_at: row.last_health_at || null,
      last_verified_at: row.last_verified_at || null,
      freshness_status: freshness,
      freshness_age_days: ageDays,
      runbook: parseMaybeJson(row.runbook_json, {}),
      dependencies: parseMaybeJson(row.dependency_json, []),
      rollback: parseMaybeJson(row.rollback_json, {}),
      notes: row.notes || null,
      meta: parseMaybeJson(row.meta_json, {}),
      updated_by: row.updated_by || null,
      updated_at: row.updated_at,
      created_at: row.created_at,
      source_kind: "explicit",
    };
    if (includeAccessRoutes) {
      connector.access_routes = tdb.prepare(
        "SELECT id, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at " +
        "FROM access_inventory WHERE scope=? AND system_name=? ORDER BY updated_at DESC"
      ).all(row.scope, row.system_name).map((route) => ({
        id: route.id,
        access_kind: route.access_kind,
        entrypoint: route.entrypoint || null,
        account_hint: route.account_hint || null,
        secret_ref: route.secret_ref || null,
        allowed_agents: normalizeStringList(route.allowed_agents),
        status: route.status,
        last_verified_at: route.last_verified_at || null,
        verification_method: route.verification_method || null,
        notes: route.notes || null,
        updated_by: route.updated_by || null,
        updated_at: route.updated_at,
      }));
    }
    return connector;
  });
  if (includeDerived) {
    const derivedRows = tdb.prepare(
      "SELECT scope, project, system_name, MAX(updated_at) latest_update, MAX(last_verified_at) latest_verify " +
      "FROM access_inventory" +
      (input.scope || input.project || input.system_name ? " WHERE " + [
        input.scope ? "LOWER(COALESCE(scope,''))=?" : null,
        input.project ? "project=?" : null,
        input.system_name ? "system_name=?" : null
      ].filter(Boolean).join(" AND ") : "") +
      " GROUP BY scope, project, system_name ORDER BY project, system_name"
    ).all(...[
      input.scope ? scopeName(input.scope) : null,
      input.project != null ? String(input.project) : null,
      input.system_name != null ? String(input.system_name) : null,
    ].filter((value) => value != null));
    for (const row of derivedRows) {
      const key = String(row.scope || "default") + "::" + String(row.system_name || "");
      if (explicitSystems.has(key)) continue;
      const routes = tdb.prepare(
        "SELECT id, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at " +
        "FROM access_inventory WHERE scope=? AND system_name=? ORDER BY updated_at DESC"
      ).all(row.scope, row.system_name);
      const allowedAgents = uniqueAgentNames(routes.flatMap((route) => normalizeStringList(route.allowed_agents)));
      const ageDays = isoAgeDays(row.latest_verify || row.latest_update);
      const freshness = freshnessFromAgeDays(ageDays, staleDays, Math.max(staleDays + 15, staleDays * 2));
      connectors.push({
        id: null,
        scope: row.scope,
        project: row.project || null,
        system_name: row.system_name,
        owner_agent: null,
        auth_type: null,
        secret_ref: routes.find((route) => route.secret_ref)?.secret_ref || null,
        rate_limit: null,
        allowed_agents: allowedAgents,
        read_enabled: true,
        write_enabled: routes.some((route) => /write|admin|deploy|ssh|db/i.test(String(route.access_kind || ""))),
        live_write_enabled: false,
        lifecycle_status: "verified",
        approval_class: "normal_fix",
        endpoint: routes.find((route) => route.entrypoint)?.entrypoint || null,
        health_status: freshness === "critical" ? "stale" : "unknown",
        health_summary: "derived from access_inventory",
        last_health_at: null,
        last_verified_at: row.latest_verify || null,
        freshness_status: freshness,
        freshness_age_days: ageDays,
        runbook: {},
        dependencies: [],
        rollback: {},
        notes: null,
        meta: {},
        updated_by: routes[0] ? routes[0].updated_by : null,
        updated_at: row.latest_update,
        created_at: row.latest_update,
        source_kind: "derived_access_inventory",
        access_routes: includeAccessRoutes ? routes.map((route) => ({
          id: route.id,
          access_kind: route.access_kind,
          entrypoint: route.entrypoint || null,
          account_hint: route.account_hint || null,
          secret_ref: route.secret_ref || null,
          allowed_agents: normalizeStringList(route.allowed_agents),
          status: route.status,
          last_verified_at: route.last_verified_at || null,
          verification_method: route.verification_method || null,
          notes: route.notes || null,
          updated_by: route.updated_by || null,
          updated_at: route.updated_at,
        })) : [],
      });
    }
  }
  if (input.allowed_agent) {
    const agent = String(input.allowed_agent).toLowerCase();
    return connectors.filter((connector) => connector.allowed_agents.some((name) => String(name || "").toLowerCase() === agent));
  }
  return connectors;
}

function deriveAgentPassport(tdb, agentName) {
  const normalized = normalizeAgentName(agentName);
  const team = buildTeamOperatingModel(tdb, normalized);
  const coverage = team.department_coverage || [];
  const departments = uniqueAgentNames(coverage.map((row) => row.department_name));
  const capabilities = capabilityMatrixForDepartments(departments);
  const connectors = connectorListData(tdb, { include_derived: true, include_access_routes: false, allowed_agent: normalized });
  const allowedSystems = uniqueAgentNames(connectors.map((connector) => connector.system_name));
  const lane = departments.join(", ") || "unassigned";
  const reviewRequired = departments.some((dep) => dep !== "strategy-review");
  const approvalClass = capabilities.production || capabilities.auth || capabilities.billing ? "live_risk" : (capabilities.edit ? "normal_fix" : "read_only");
  return {
    agent_name: normalized,
    display_name: normalized,
    department_name: departments[0] || null,
    lane,
    departments,
    allowed_projects: [],
    allowed_projects_policy: "assigned-by-brief-or-task",
    allowed_systems: allowedSystems,
    allowed_environments: capabilities.production ? ["production", "staging", "dev"] : ["staging", "dev"],
    capability_matrix: capabilities,
    live_write: !!capabilities.edit,
    review_required: reviewRequired,
    needs_handoff: true,
    can_deploy: !!capabilities.deploy,
    can_touch_auth: !!capabilities.auth,
    can_touch_billing: !!capabilities.billing,
    can_manage_production: !!capabilities.production,
    approval_class: approvalClass,
    status: team.agent_status === "active" ? "active" : team.agent_status,
    source_kind: "derived_team_model",
    freshness_status: "fresh",
    meta: { derived: true, coverage },
  };
}

function agentPassportData(tdb, agentName) {
  ensureUniversalJournalSchema(tdb);
  const normalized = normalizeAgentName(agentName);
  const row = tdb.prepare("SELECT * FROM agent_passport WHERE agent_name=?").get(normalized);
  if (!row) return deriveAgentPassport(tdb, normalized);
  const capabilityMatrix = parseMaybeJson(row.capability_matrix_json, {}) || {};
  const ageDays = isoAgeDays(row.updated_at);
  return {
    agent_name: row.agent_name,
    display_name: row.display_name || row.agent_name,
    department_name: row.department_name || null,
    lane: row.lane || null,
    departments: uniqueAgentNames([row.department_name].concat(String(row.lane || "").split(",").map((item) => item.trim())).filter(Boolean)),
    allowed_projects: normalizeProjectList(row.allowed_projects_json),
    allowed_projects_policy: "explicit",
    allowed_systems: normalizeStringList(row.allowed_systems_json),
    allowed_environments: normalizeStringList(row.allowed_environments_json),
    capability_matrix: Object.assign(capabilityMatrix, {
      edit: boolFlag(capabilityMatrix.edit, !!row.live_write),
      deploy: boolFlag(capabilityMatrix.deploy, !!row.can_deploy),
      billing: boolFlag(capabilityMatrix.billing, !!row.can_touch_billing),
      auth: boolFlag(capabilityMatrix.auth, !!row.can_touch_auth),
      production: boolFlag(capabilityMatrix.production, !!row.can_manage_production),
      report: boolFlag(capabilityMatrix.report, true),
      read: boolFlag(capabilityMatrix.read, true),
    }),
    live_write: !!row.live_write,
    review_required: !!row.review_required,
    needs_handoff: !!row.needs_handoff,
    can_deploy: !!row.can_deploy,
    can_touch_auth: !!row.can_touch_auth,
    can_touch_billing: !!row.can_touch_billing,
    can_manage_production: !!row.can_manage_production,
    approval_class: row.approval_class || "read_only",
    status: row.status || "active",
    source_kind: row.source_kind || "manual",
    freshness_status: freshnessFromAgeDays(ageDays, 14, 45),
    freshness_age_days: ageDays,
    updated_by: row.updated_by || null,
    updated_at: row.updated_at,
    created_at: row.created_at,
    meta: parseMaybeJson(row.meta_json, {}),
  };
}

function agentPassportListData(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const explicitRows = tdb.prepare("SELECT agent_name FROM agent_passport ORDER BY agent_name").all().map((row) => row.agent_name);
  const names = new Set(explicitRows.map((name) => normalizeAgentName(name)));
  if (input.include_derived !== false) {
    for (const dep of buildTeamOperatingModel(tdb).active_agents || []) names.add(normalizeAgentName(dep));
  }
  let passports = Array.from(names).map((name) => agentPassportData(tdb, name));
  if (input.status) passports = passports.filter((passport) => passport.status === input.status);
  if (input.department_name) passports = passports.filter((passport) => passport.departments.includes(String(input.department_name)));
  return passports.sort((a, b) => String(a.agent_name).localeCompare(String(b.agent_name)));
}

function buildDriftCheckReport(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const scope = String(input.scope || "default");
  const actor = input.actor || input.agent_name || DEFAULT_AGENT;
  const staleDays = Math.max(1, parseInt(input.stale_days || 30, 10) || 30);
  const runtime = runtimeHealth(tdb, { stale_sec: input.runtime_stale_sec || 300 });
  const findings = [];
  const push = (finding) => findings.push(Object.assign({
    scope,
    project: null,
    system_name: null,
    drift_kind: "unknown",
    severity: "M",
    status: "open",
    freshness_status: "fresh",
    expected: null,
    actual: null,
    details: {},
    source_ref: null,
  }, finding || {}));
  for (const agent of runtime.agents || []) {
    if (["blocked", "offline", "dirty", "degraded"].includes(agent.health)) {
      push({
        project: null,
        system_name: agent.agent_name,
        drift_kind: "agent_runtime",
        severity: agent.health === "blocked" || agent.health === "offline" ? "H" : "M",
        freshness_status: agent.health === "offline" ? "critical" : "stale",
        expected: "agent loop healthy and current",
        actual: `health=${agent.health}${agent.blocked_on ? " blocked_on=" + agent.blocked_on : ""}`,
        details: agent,
      });
    }
  }
  const connectors = connectorListData(tdb, { scope, include_derived: true, include_access_routes: false, stale_days: staleDays });
  for (const connector of connectors) {
    if (["critical", "stale"].includes(connector.freshness_status) || ["error", "degraded", "stale"].includes(String(connector.health_status || ""))) {
      push({
        project: connector.project || null,
        system_name: connector.system_name,
        drift_kind: "connector_freshness",
        severity: connector.freshness_status === "critical" ? "H" : "M",
        freshness_status: connector.freshness_status,
        expected: "connector verified and healthy",
        actual: `health=${connector.health_status || "unknown"} last_verified=${connector.last_verified_at || "never"}`,
        details: connector,
      });
    }
  }
  try {
    const projects = tdb.prepare("SELECT name, live_status, live_url, auth_system, health_checklist, missing_blocks, updated_at FROM project_registry ORDER BY name").all();
    for (const project of projects) {
      const missing = normalizeStringList(project.missing_blocks);
      if ((project.live_status && String(project.live_status).toLowerCase() === "live") && (!project.live_url || !project.auth_system || missing.length)) {
        push({
          project: project.name,
          system_name: project.name,
          drift_kind: "project_registry_gap",
          severity: "M",
          freshness_status: freshnessFromAgeDays(isoAgeDays(project.updated_at), 14, 45),
          expected: "live project has live_url, auth_system, and no missing blocks",
          actual: `live_url=${project.live_url || "missing"} auth_system=${project.auth_system || "missing"} missing_blocks=${missing.join(", ") || "none"}`,
          details: {
            live_status: project.live_status,
            live_url: project.live_url || null,
            auth_system: project.auth_system || null,
            missing_blocks: missing,
            health_checklist: normalizeStringList(project.health_checklist),
            updated_at: project.updated_at,
          },
        });
      }
    }
  } catch {}
  try {
    const writers = tdb.prepare("SELECT writer, status, last_write_at, last_check_at, rows_written FROM writer_health ORDER BY writer").all();
    for (const writer of writers) {
      const ageDays = isoAgeDays(writer.last_write_at || writer.last_check_at);
      const freshness = freshnessFromAgeDays(ageDays, 2, 7);
      if ((writer.status && writer.status !== "ok") || freshness !== "fresh") {
        push({
          system_name: writer.writer,
          drift_kind: "writer_health",
          severity: freshness === "critical" ? "H" : "M",
          freshness_status: freshness,
          expected: "writer recently healthy",
          actual: `status=${writer.status || "unknown"} last_write=${writer.last_write_at || "never"}`,
          details: writer,
        });
      }
    }
  } catch {}
  if (input.persist !== false) {
    const stmt = tdb.prepare(
      "INSERT INTO drift_check_result (scope, project, system_name, drift_kind, severity, status, freshness_status, expected, actual, details_json, source_ref, checked_by, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    );
    for (const finding of findings) {
      stmt.run(
        finding.scope,
        finding.project || null,
        finding.system_name || null,
        finding.drift_kind,
        finding.severity || "M",
        finding.status || "open",
        finding.freshness_status || "fresh",
        finding.expected || null,
        finding.actual || null,
        JSON.stringify(finding.details || {}),
        finding.source_ref || null,
        actor
      );
    }
  }
  const summary = {
    total: findings.length,
    high: findings.filter((finding) => finding.severity === "H").length,
    medium: findings.filter((finding) => finding.severity === "M").length,
    low: findings.filter((finding) => finding.severity === "L").length,
    critical_freshness: findings.filter((finding) => finding.freshness_status === "critical").length,
    stale_freshness: findings.filter((finding) => finding.freshness_status === "stale").length,
  };
  return {
    ok: true,
    scope,
    checked_at: new Date().toISOString(),
    persisted: input.persist !== false,
    runtime_summary: runtime.summary,
    summary,
    findings,
  };
}

function classifyActionRisk(input = {}) {
  const text = [
    input.project,
    input.task,
    input.summary,
    input.action_type,
    Array.isArray(input.topics) ? input.topics.join(" ") : "",
    Array.isArray(input.files) ? input.files.join(" ") : "",
    Array.isArray(input.system_names) ? input.system_names.join(" ") : ""
  ].filter(Boolean).join(" ");
  const normalized = String(text || "").toLowerCase();
  const touchesProduction = /\b(production|prod|live|deploy|pm2|nginx|dns|ssl|cert|rollback)\b/.test(normalized);
  const touchesBilling = /\b(stripe|billing|invoice|pricing|checkout|refund|vat|vies|oss|subscription|plan)\b/.test(normalized);
  const touchesAuth = /\b(auth|login|signup|signin|sign-in|sso|session|cookie|oauth|password|reset|forgot|verify|onboarding|account)\b/.test(normalized);
  const writeIntent = /\b(edit|change|fix|implement|update|deploy|restart|migrate|patch|write|remove|delete|rename|refactor|create|build|rollout)\b/.test(normalized);
  const environment = input.environment || (touchesProduction ? "production" : "staging");
  return {
    text,
    write_intent: writeIntent,
    touches_production: touchesProduction,
    touches_billing: touchesBilling,
    touches_auth: touchesAuth,
    environment,
  };
}

function writeGateCheck(tdb, input = {}) {
  const passport = agentPassportData(tdb, input.agent_name || DEFAULT_AGENT);
  const risk = classifyActionRisk(input);
  const blockers = [];
  const checks = [];
  const explicitProjects = Array.isArray(passport.allowed_projects) ? passport.allowed_projects : [];
  const explicitSystems = Array.isArray(passport.allowed_systems) ? passport.allowed_systems : [];
  const status = String(passport.status || "").toLowerCase();

  checks.push({ name: "passport", source_kind: passport.source_kind, status: passport.status, lane: passport.lane, approval_class: passport.approval_class });
  if (passport.source_kind === "manual" && ["paused", "disabled", "inactive", "onboarding", "probation"].includes(status)) {
    blockers.push(`agent passport status blocks write activity: ${passport.status}`);
  }
  if (risk.write_intent && !passport.live_write) blockers.push("agent passport does not allow live write/edit activity");
  if (risk.touches_production && !passport.can_manage_production) blockers.push("agent passport does not allow production-risk changes");
  if (/deploy/i.test(String(input.action_type || "")) && !passport.can_deploy) blockers.push("agent passport does not allow deploy actions");
  if (risk.touches_auth && !passport.can_touch_auth) blockers.push("agent passport does not allow auth/login work");
  if (risk.touches_billing && !passport.can_touch_billing) blockers.push("agent passport does not allow billing/pricing work");
  const requestedProject = normalizeScopeKey(input.project);
  const explicitProjectKeys = explicitProjects.map(normalizeScopeKey).filter(Boolean);
  if (requestedProject && explicitProjectKeys.length && !explicitProjectKeys.includes(requestedProject)) blockers.push("project is outside explicit passport project scope");

  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const explicitSystemKeys = explicitSystems.map(normalizeScopeKey).filter(Boolean);
  const relevantConnectors = systemNames.length
    ? connectorListData(tdb, { include_derived: true }).filter((connector) => systemNames.includes(connector.system_name))
    : [];
  if (systemNames.length) checks.push({ name: "systems", requested: systemNames, matched: relevantConnectors.map((connector) => connector.system_name) });
  if (explicitSystems.length) {
    const unauthorized = systemNames.filter((name) => !explicitSystemKeys.includes(normalizeScopeKey(name)));
    if (unauthorized.length) blockers.push("systems outside explicit passport scope: " + unauthorized.join(", "));
  }
  for (const connector of relevantConnectors) {
    if (connector.allowed_agents.length && !connector.allowed_agents.some((name) => String(name || "").toLowerCase() === String(passport.agent_name || "").toLowerCase())) {
      blockers.push(`connector ${connector.system_name} does not list ${passport.agent_name} as allowed agent`);
    }
    if (risk.touches_production && !connector.live_write_enabled && connector.source_kind === "explicit" && connector.lifecycle_status === "live") {
      blockers.push(`connector ${connector.system_name} is not approved for live write`);
    }
  }

  const freeze = freezeCheck(tdb, input);
  const windowCheck = maintenanceWindowCheck(tdb, input);
  const artifactLock = artifactLockCheck(tdb, input);
  checks.push({
    name: "dependency_freeze",
    result: freeze.status,
    active_freezes: freeze.active_freezes.length,
    overrides: freeze.overrides.length
  });
  checks.push({
    name: "maintenance_window",
    result: windowCheck.status,
    required: windowCheck.required,
    active_windows: windowCheck.active_windows.length,
    overrides: windowCheck.overrides.length
  });
  checks.push({
    name: "artifact_lock",
    result: artifactLock.status,
    active_locks: artifactLock.active_locks.length,
    overrides: artifactLock.overrides.length
  });
  blockers.push(...freeze.blockers);
  blockers.push(...windowCheck.blockers);
  blockers.push(...artifactLock.blockers);
  return {
    status: blockers.length ? "block" : "ok",
    blockers,
    checks,
    passport,
    risk,
    matched_connectors: relevantConnectors,
    freeze,
    maintenance_window: windowCheck,
    artifact_lock: artifactLock,
  };
}

function extractTaskKeywords(input = {}) {
  const text = [
    input.project,
    input.task,
    input.summary,
    Array.isArray(input.topics) ? input.topics.join(" ") : "",
    Array.isArray(input.files) ? input.files.join(" ") : ""
  ].filter(Boolean).join(" ").toLowerCase();
  return Array.from(new Set((text.match(/[a-z0-9_-]{4,}/g) || [])
    .filter((token) => !["http", "https", "with", "from", "that", "this", "have", "were", "your", "into", "about", "project", "files", "task", "summary"].includes(token))
    .slice(0, 18)));
}

function duplicateWorkCheck(tdb, input = {}) {
  ensureAutonomyTables(tdb);
  cleanupWorkClaims(tdb);
  const project = input.project || null;
  const files = Array.isArray(input.files) ? input.files.map((file) => String(file || "").trim()).filter(Boolean) : [];
  const claimTargets = extractClaimTargets(input);
  const keywords = extractTaskKeywords(input);
  const blockers = [];
  const warnings = [];
  const evidence = { active_claims: [], stale_claims: [], recent_handoffs: [], overlapping_tasks: [], similar_claims: [] };
  for (const target of claimTargets) {
    try {
      const exact = tdb.prepare("SELECT * FROM work_claim WHERE project=? AND scope_key=? AND status IN ('active','stale') ORDER BY claimed_at DESC")
        .all(project || "unknown", target.scope_key)
        .map(workClaimRowData);
      for (const claim of exact) {
        if (String(claim.agent_name || "").toLowerCase() === String(input.agent_name || "").toLowerCase()) continue;
        if (claim.status === "stale") {
          warnings.push(`stale ${claim.claim_kind} claim exists: ${claim.scope_value} by ${claim.agent_name}`);
          evidence.stale_claims.push(claim);
        } else {
          blockers.push(`${claim.claim_kind} already claimed by ${claim.agent_name}: ${claim.scope_value}`);
          evidence.active_claims.push(claim);
        }
      }
    } catch {}
    try {
      if (target.claim_kind === "file") {
        const basename = String(target.file_path || "").split(/[\\/]/).pop();
        const similar = tdb.prepare(
          "SELECT * FROM work_claim WHERE project=? AND (scope_key=? OR file_path LIKE ?) AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day')) ORDER BY claimed_at DESC LIMIT 10"
        ).all(project || "unknown", target.scope_key, "%" + basename).map(workClaimRowData);
        for (const claim of similar) {
          if (String(claim.agent_name || "").toLowerCase() !== String(input.agent_name || "").toLowerCase()) evidence.similar_claims.push(claim);
        }
      } else {
        const similar = tdb.prepare(
          "SELECT * FROM work_claim WHERE project=? AND claim_kind=? AND (scope_key=? OR scope_value=?) AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day')) ORDER BY claimed_at DESC LIMIT 10"
        ).all(project || "unknown", target.claim_kind, target.scope_key, target.scope_value).map(workClaimRowData);
        for (const claim of similar) {
          if (String(claim.agent_name || "").toLowerCase() !== String(input.agent_name || "").toLowerCase()) evidence.similar_claims.push(claim);
        }
      }
    } catch {}
  }
  if (project) {
    try {
      const handoffs = tdb.prepare(
        "SELECT id, agent_name, summary, changed_files, created_at FROM session_handoff WHERE project=? AND created_at >= datetime('now','-3 day') ORDER BY created_at DESC LIMIT 20"
      ).all(project);
      for (const row of handoffs) {
        const changed = parseMaybeJson(row.changed_files, []);
        const overlap = files.length ? changed.filter((file) => files.includes(file)) : [];
        const text = (row.summary || "").toLowerCase();
        const keywordOverlap = keywords.filter((keyword) => text.includes(keyword));
        if (overlap.length || keywordOverlap.length >= 2) {
          evidence.recent_handoffs.push({ id: row.id, agent_name: row.agent_name, summary: row.summary, changed_files: changed, created_at: row.created_at, overlap, keyword_overlap: keywordOverlap });
          if (String(row.agent_name || "").toLowerCase() !== String(input.agent_name || "").toLowerCase()) warnings.push(`recent handoff overlaps this scope: #${row.id} by ${row.agent_name}`);
        }
      }
    } catch {}
    try {
      const tasks = tdb.prepare(
        "SELECT id, department_name, title, status, assigned_agent, reviewer_agent, updated_at FROM autonomy_task " +
        "WHERE project=? AND status IN ('open','claimed','blocked','review') ORDER BY updated_at DESC, created_at DESC LIMIT 30"
      ).all(project);
      for (const task of tasks) {
        const title = String(task.title || "").toLowerCase();
        const overlap = keywords.filter((keyword) => title.includes(keyword));
        if (overlap.length >= 2) {
          evidence.overlapping_tasks.push(Object.assign({}, task, { keyword_overlap: overlap }));
          if (task.assigned_agent && String(task.assigned_agent).toLowerCase() !== String(input.agent_name || "").toLowerCase()) {
            blockers.push(`open autonomy task overlaps this work: #${task.id} assigned to ${task.assigned_agent}`);
          }
        }
      }
    } catch {}
  }
  return {
    status: blockers.length ? "block" : (warnings.length ? "warn" : "ok"),
    blockers: uniqueAgentNames(blockers),
    warnings: uniqueAgentNames(warnings),
    evidence,
    hint: blockers.length ? "Coordinate, reuse the prior work, or pick a different scope before editing." : "No blocking duplicate scope found.",
  };
}

function buildImpactMap(tdb, input = {}) {
  ensureAutonomyTables(tdb);
  const project = input.project || null;
  const risk = classifyActionRisk(input);
  const result = {
    ok: true,
    project,
    domains: [],
    servers: [],
    portals: [],
    agents: [],
    connectors: [],
    auth_projects: [],
    ui_projects: [],
    files: Array.isArray(input.files) ? input.files : [],
    topics: Array.isArray(input.topics) ? input.topics : [],
    environment: risk.environment,
  };
  const addUnique = (list, value) => {
    if (!value) return;
    if (!list.some((item) => JSON.stringify(item) === JSON.stringify(value))) list.push(value);
  };
  let designFamily = null;
  let authScope = null;
  if (project) {
    try {
      const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(project);
      if (reg) {
        addUnique(result.servers, reg.server || null);
        addUnique(result.domains, reg.domain || null);
        addUnique(result.domains, reg.live_url || null);
        addUnique(result.domains, reg.staging_url || null);
        addUnique(result.domains, reg.admin_url || null);
        addUnique(result.portals, { project: reg.name, live_status: reg.live_status || null, auth_system: reg.auth_system || null });
        if (reg.auth_system) addUnique(result.auth_projects, reg.auth_system);
      }
    } catch {}
    try {
      const rulesRow = tdb.prepare("SELECT project, allowed_domains, auth_matrix, design_rules FROM project_rules WHERE project=?").get(project);
      if (rulesRow) {
        for (const domain of parseMaybeJson(rulesRow.allowed_domains, [])) addUnique(result.domains, domain);
        const auth = parseMaybeJson(rulesRow.auth_matrix, {}) || {};
        const design = parseMaybeJson(rulesRow.design_rules, {}) || {};
        authScope = auth.shared_identity_scope || null;
        designFamily = design.shared_ui_family || null;
        addUnique(result.auth_projects, auth.canonical_project || null);
        addUnique(result.ui_projects, design.canonical_brand_project || null);
        addUnique(result.ui_projects, design.canonical_header_project || null);
        addUnique(result.ui_projects, design.canonical_button_project || null);
        for (const portal of [].concat(auth.portals || [], design.portals || [])) addUnique(result.portals, portal);
      }
    } catch {}
  }
  try {
    const connectors = connectorListData(tdb, { include_derived: true, project: project || undefined, include_access_routes: false });
    for (const connector of connectors) {
      addUnique(result.connectors, {
        system_name: connector.system_name,
        project: connector.project || null,
        endpoint: connector.endpoint || null,
        owner_agent: connector.owner_agent || null,
        lifecycle_status: connector.lifecycle_status,
      });
      addUnique(result.servers, connector.endpoint && /@|^\d{1,3}(\.\d{1,3}){3}$|^\/root\//.test(connector.endpoint) ? connector.endpoint : null);
    }
  } catch {}
  try {
    const rows = tdb.prepare("SELECT project, auth_matrix, design_rules FROM project_rules").all();
    for (const row of rows) {
      const auth = parseMaybeJson(row.auth_matrix, {}) || {};
      const design = parseMaybeJson(row.design_rules, {}) || {};
      if (authScope && auth.shared_identity_scope === authScope) addUnique(result.auth_projects, row.project);
      if (designFamily && design.shared_ui_family === designFamily) addUnique(result.ui_projects, row.project);
    }
  } catch {}
  try {
    const team = buildTeamOperatingModel(tdb, input.agent_name || null);
    for (const dep of team.departments || []) {
      if (!project || inferDepartmentTargets(input.task || "", input.topics || [], input.files || []).includes(dep.name)) {
        addUnique(result.agents, { agent_name: dep.lead_agent || null, role: "lead", department: dep.name });
        addUnique(result.agents, { agent_name: dep.review_agent || null, role: "reviewer", department: dep.name });
      }
    }
  } catch {}
  result.summary = {
    domains: result.domains.filter(Boolean).length,
    servers: result.servers.filter(Boolean).length,
    portals: result.portals.filter(Boolean).length,
    agents: result.agents.filter((agent) => agent && agent.agent_name).length,
    connectors: result.connectors.length,
    auth_projects: result.auth_projects.filter(Boolean).length,
    ui_projects: result.ui_projects.filter(Boolean).length,
  };
  return result;
}

function isoNow() {
  return new Date().toISOString();
}

function isoMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function rowMatchesScopeProjectSystem(row, scope, project, systemNames) {
  const sc = String(scope || DEFAULT_SCOPE || "default");
  if (row.scope && row.scope !== sc) return false;
  if (row.project && project && row.project !== project) return false;
  if (row.project && !project && !row.system_name) return false;
  if (row.system_name && systemNames.length) {
    if (!systemNames.includes(String(row.system_name))) return false;
  }
  return true;
}

function normalizeArtifactKind(kind) {
  const raw = String(kind || "").trim().toLowerCase();
  if (["url", "route", "domain", "file", "project", "system", "component", "page", "artifact"].includes(raw)) return raw;
  if (raw === "path") return "file";
  return raw || "artifact";
}

function normalizeArtifactValue(kind, value) {
  const normalizedKind = normalizeArtifactKind(kind);
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (normalizedKind === "file") return raw.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (normalizedKind === "domain") {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .trim()
      .toLowerCase();
  }
  if (normalizedKind === "route") {
    let route = raw;
    try {
      if (/^https?:\/\//i.test(route)) route = new URL(route).pathname || "/";
    } catch {}
    route = route.trim();
    if (!route.startsWith("/")) route = "/" + route.replace(/^\/+/, "");
    route = route.replace(/\/{2,}/g, "/");
    if (route.length > 1) route = route.replace(/\/+$/, "");
    return route.toLowerCase();
  }
  if (normalizedKind === "url") {
    try {
      const parsed = new URL(raw);
      parsed.hash = "";
      let href = parsed.toString();
      if (href.endsWith("/") && parsed.pathname !== "/") href = href.replace(/\/+$/, "");
      return href.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }
  return raw.toLowerCase();
}

function extractArtifactTargets(input = {}) {
  const targets = [];
  const seen = new Set();
  const addTarget = (kind, value, extras = {}) => {
    const artifact_kind = normalizeArtifactKind(kind);
    const artifact_key = normalizeArtifactValue(artifact_kind, value);
    if (!artifact_key) return;
    const dedupeKey = artifact_kind + ":" + artifact_key;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    targets.push(Object.assign({ artifact_kind, artifact_key, artifact_label: String(value || "").trim() || artifact_key }, extras));
  };
  for (const file of Array.isArray(input.files) ? input.files : []) addTarget("file", file);
  for (const domain of Array.isArray(input.domains) ? input.domains : []) addTarget("domain", domain);
  for (const route of Array.isArray(input.routes) ? input.routes : []) addTarget("route", route);
  for (const url of Array.isArray(input.urls) ? input.urls : []) {
    addTarget("url", url);
    addTarget("domain", url);
    addTarget("route", url);
  }
  const freeText = [
    input.task,
    input.summary,
    Array.isArray(input.topics) ? input.topics.join(" ") : "",
  ].filter(Boolean).join(" ");
  const urlMatches = String(freeText || "").match(/https?:\/\/[^\s)>"']+/gi) || [];
  for (const url of urlMatches) {
    addTarget("url", url);
    addTarget("domain", url);
    addTarget("route", url);
  }
  if (input.project) addTarget("project", input.project, { artifact_label: input.project });
  for (const systemName of [].concat(Array.isArray(input.system_names) ? input.system_names : []).concat(Array.isArray(input.connectors) ? input.connectors : [])) {
    addTarget("system", systemName, { artifact_label: systemName });
  }
  return targets;
}

function artifactLockRowMatches(row, project, systemNames, targets) {
  const kind = normalizeArtifactKind(row.artifact_kind);
  const key = normalizeArtifactValue(kind, row.artifact_key);
  if (!key) return false;
  if (kind === "project") return !!project && normalizeScopeKey(project) === normalizeScopeKey(key);
  if (kind === "system") return systemNames.some((name) => normalizeScopeKey(name) === normalizeScopeKey(key));
  return targets.some((target) => target.artifact_kind === kind && target.artifact_key === key);
}

function currentArtifactLockRows(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const scope = scopeName(input.scope);
  const scopes = Array.from(new Set([scope, "default"].filter(Boolean)));
  const project = input.project || null;
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const targets = extractArtifactTargets(input);
  const now = isoMs(input.now || isoNow());
  const placeholders = scopes.map(() => "?").join(",");
  const rows = tdb.prepare(
    "SELECT * FROM artifact_lock WHERE scope IN (" + placeholders + ") AND status='active' ORDER BY started_at DESC"
  ).all(...scopes);
  return rows.filter((row) => {
    if (!rowMatchesScopeProjectSystem(row, row.scope || scope, project, systemNames)) return false;
    const end = isoMs(row.expires_at);
    if (end != null && end < now) return false;
    return artifactLockRowMatches(row, project, systemNames, targets);
  }).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
}

function artifactLockCheck(tdb, input = {}) {
  const locks = currentArtifactLockRows(tdb, input);
  const overrides = currentOverrideRows(tdb, Object.assign({}, input, { gate_kind: "artifact_lock" }));
  const blockers = [];
  if (locks.length && !overrides.length) {
    const labels = locks.slice(0, 5).map((row) => row.artifact_label || row.artifact_key);
    blockers.push("protected final artifact blocks changes: " + labels.join(", "));
  }
  return {
    status: blockers.length ? "block" : "ok",
    blockers,
    active_locks: locks,
    overrides,
    matched_targets: extractArtifactTargets(input),
  };
}

function currentWindowRows(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const scope = scopeName(input.scope);
  const project = input.project || null;
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const now = isoMs(input.now || isoNow());
  const rows = tdb.prepare(
    "SELECT * FROM maintenance_window WHERE scope=? AND status IN ('approved','active','open') ORDER BY starts_at ASC"
  ).all(scope);
  const matched = [];
  const upcoming = [];
  for (const row of rows) {
    if (!rowMatchesScopeProjectSystem(row, scope, project, systemNames)) continue;
    const start = isoMs(row.starts_at);
    const end = isoMs(row.ends_at);
    if (start == null || end == null) continue;
    const shaped = Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) });
    if (start <= now && end >= now) matched.push(shaped);
    else if (start > now) upcoming.push(shaped);
  }
  return { active: matched, upcoming };
}

function currentOverrideRows(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const scope = scopeName(input.scope);
  const project = input.project || null;
  const gateKind = input.gate_kind || null;
  const agentName = normalizeAgentName(input.agent_name || "");
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const now = isoMs(input.now || isoNow());
  const rows = tdb.prepare(
    "SELECT * FROM override_log WHERE scope=? AND status='active' ORDER BY starts_at DESC"
  ).all(scope);
  return rows.filter((row) => {
    if (!rowMatchesScopeProjectSystem(row, scope, project, systemNames)) return false;
    if (gateKind && row.gate_kind !== gateKind && row.gate_kind !== "all") return false;
    if (row.agent_name && normalizeAgentName(row.agent_name) !== agentName) return false;
    const start = isoMs(row.starts_at) ?? now;
    const end = isoMs(row.expires_at);
    if (start > now) return false;
    if (end != null && end < now) return false;
    return true;
  }).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
}

function currentFreezeRows(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const scope = scopeName(input.scope);
  const project = input.project || null;
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const now = isoMs(input.now || isoNow());
  const rows = tdb.prepare(
    "SELECT * FROM dependency_freeze WHERE scope=? AND status='active' ORDER BY started_at DESC"
  ).all(scope);
  return rows.filter((row) => {
    if (!rowMatchesScopeProjectSystem(row, scope, project, systemNames)) return false;
    const end = isoMs(row.expires_at);
    return end == null || end >= now;
  }).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
}

function maintenanceWindowCheck(tdb, input = {}) {
  const risk = classifyActionRisk(input);
  const requiresWindow = !!(risk.write_intent && (risk.touches_production || risk.touches_auth || risk.touches_billing || /deploy/i.test(String(input.action_type || ""))));
  const windows = currentWindowRows(tdb, input);
  const overrides = currentOverrideRows(tdb, Object.assign({}, input, { gate_kind: "maintenance_window" }));
  const blockers = [];
  const warnings = [];
  if (requiresWindow && !windows.active.length && !overrides.length) {
    blockers.push("no active maintenance window for this high-risk change");
  }
  if (requiresWindow && !windows.active.length && windows.upcoming.length) {
    const next = windows.upcoming[0];
    warnings.push("next maintenance window starts at " + next.starts_at);
  }
  return {
    status: blockers.length ? "block" : "ok",
    required: requiresWindow,
    blockers,
    warnings,
    active_windows: windows.active,
    upcoming_windows: windows.upcoming.slice(0, 5),
    overrides,
  };
}

function freezeCheck(tdb, input = {}) {
  const freezes = currentFreezeRows(tdb, input);
  const overrides = currentOverrideRows(tdb, Object.assign({}, input, { gate_kind: "freeze" }));
  const blockers = [];
  if (freezes.length && !overrides.length) {
    blockers.push("active dependency freeze blocks this scope");
  }
  return {
    status: blockers.length ? "block" : "ok",
    blockers,
    active_freezes: freezes,
    overrides,
  };
}

function buildStatusBoard(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const wanted = Array.isArray(input.projects) && input.projects.length ? new Set(input.projects) : null;
  const names = new Set();
  try { for (const row of tdb.prepare("SELECT name FROM project_registry").all()) names.add(row.name); } catch {}
  try { for (const row of tdb.prepare("SELECT project FROM project_rules").all()) names.add(row.project); } catch {}
  try { for (const row of tdb.prepare("SELECT DISTINCT project FROM quality_finding WHERE project IS NOT NULL").all()) names.add(row.project); } catch {}
  try { for (const row of tdb.prepare("SELECT DISTINCT project FROM work_claim WHERE project IS NOT NULL").all()) names.add(row.project); } catch {}
  const board = [];
  for (const name of Array.from(names).sort()) {
    if (wanted && !wanted.has(name)) continue;
    const registry = (() => { try { return tdb.prepare("SELECT name, domain, server, live_status, live_url, updated_at FROM project_registry WHERE name=?").get(name); } catch { return null; } })();
    const openFindings = (() => { try { return tdb.prepare("SELECT COUNT(*) c, SUM(CASE WHEN severity IN ('H','critical') THEN 1 ELSE 0 END) high FROM quality_finding WHERE project=? AND status='open'").get(name); } catch { return { c: 0, high: 0 }; } })();
    const activeClaims = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM work_claim WHERE project=? AND status='active' AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(name); } catch { return { c: 0 }; } })();
    const openDrift = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM drift_check_result WHERE project=? AND status='open'").get(name); } catch { return { c: 0 }; } })();
    const activeFreeze = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM dependency_freeze WHERE project=? AND status='active' AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))").get(name); } catch { return { c: 0 }; } })();
    const activeLocks = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM artifact_lock WHERE project=? AND status='active' AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))").get(name); } catch { return { c: 0 }; } })();
    const activeWindows = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM maintenance_window WHERE project=? AND status IN ('approved','active','open') AND starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ends_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(name); } catch { return { c: 0 }; } })();
    const openIncidents = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM ops_incident WHERE project=? AND status='open'").get(name); } catch { return { c: 0 }; } })();
    board.push({
      project: name,
      live_status: registry && registry.live_status || "unknown",
      live_url: registry && registry.live_url || null,
      domain: registry && registry.domain || null,
      server: registry && registry.server || null,
      last_registry_update_at: registry && registry.updated_at || null,
      open_findings: openFindings.c || 0,
      high_findings: openFindings.high || 0,
      active_claims: activeClaims.c || 0,
      open_drift: openDrift.c || 0,
      active_freezes: activeFreeze.c || 0,
      active_artifact_locks: activeLocks.c || 0,
      active_windows: activeWindows.c || 0,
      open_incidents: openIncidents.c || 0,
    });
  }
  return {
    ok: true,
    count: board.length,
    summary: {
      projects: board.length,
      blocked_projects: board.filter((row) => row.active_freezes || row.active_artifact_locks || row.high_findings || row.open_incidents).length,
      open_findings: board.reduce((sum, row) => sum + row.open_findings, 0),
      open_incidents: board.reduce((sum, row) => sum + row.open_incidents, 0),
      active_artifact_locks: board.reduce((sum, row) => sum + row.active_artifact_locks, 0),
    },
    board,
  };
}

function buildLearningLoopReport(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const days = Math.max(1, Math.min(parseInt(input.days || 14, 10) || 14, 120));
  const since = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
  const drift = (() => { try { return tdb.prepare("SELECT COALESCE(project,'(none)') project, drift_kind, COUNT(*) count FROM drift_check_result WHERE checked_at >= ? GROUP BY project, drift_kind HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20").all(since); } catch { return []; } })();
  const findings = (() => { try { return tdb.prepare("SELECT COALESCE(project,'(none)') project, category, COUNT(*) count FROM quality_finding WHERE created_at >= ? GROUP BY project, category HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20").all(since); } catch { return []; } })();
  const blockedPreflights = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM agent_action WHERE action_kind='agent_preflight' AND status='block' AND started_at >= ?").get(since).c; } catch { return 0; } })();
  const scarPatterns = (() => { try { return tdb.prepare("SELECT COALESCE(pattern_id,0) pattern_id, COUNT(*) count FROM scar_event WHERE occurred_at >= ? GROUP BY pattern_id HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20").all(since); } catch { return []; } })();
  const recommendations = [];
  for (const row of drift.slice(0, 8)) recommendations.push({ type: "drift_rule", project: row.project, key: row.drift_kind, reason: `${row.count} repeated drift checks` });
  for (const row of findings.slice(0, 8)) recommendations.push({ type: "finding_gate", project: row.project, key: row.category, reason: `${row.count} repeated findings` });
  for (const row of scarPatterns.slice(0, 5)) recommendations.push({ type: "scar_prevention", pattern_id: row.pattern_id, reason: `${row.count} repeated scar events` });
  if (blockedPreflights >= 3) recommendations.push({ type: "preflight_noise", reason: `${blockedPreflights} blocked preflights in ${days}d`, action: "tighten rules or add explicit overrides/runbooks" });
  return {
    ok: true,
    since,
    summary: {
      repeated_drift: drift.length,
      repeated_findings: findings.length,
      repeated_scars: scarPatterns.length,
      blocked_preflights: blockedPreflights,
      recommendations: recommendations.length,
    },
    drift,
    findings,
    scar_patterns: scarPatterns,
    recommendations,
  };
}

function runSearchReindex(tdb, input = {}) {
  ensureUniversalJournalSchema(tdb);
  const scopes = Array.isArray(input.scopes) && input.scopes.length ? input.scopes : ["transcript", "brief", "event", "memory"];
  const limit = Math.max(1, Math.min(parseInt(input.limit || 5000, 10) || 5000, 50000));
  const reset = input.reset !== false;
  const inserted = {};
  const per_scope = {};
  const ins = tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES (?,?,?,?,?)");
  const delOne = tdb.prepare("DELETE FROM mnemo_search_fts WHERE scope=? AND ref_id=?");
  const sourceCount = (scope) => {
    try {
      if (scope === "transcript") return tdb.prepare("SELECT COUNT(*) c FROM transcript").get().c;
      if (scope === "brief") return tdb.prepare("SELECT COUNT(*) c FROM agent_brief").get().c;
      if (scope === "event") return tdb.prepare("SELECT COUNT(*) c FROM mnemo_event_journal").get().c;
      if (scope === "memory") return tdb.prepare("SELECT COUNT(*) c FROM memory").get().c;
    } catch {}
    return null;
  };
  for (const scope of scopes) {
    inserted[scope] = 0;
    const available = sourceCount(scope);
    let indexed_before = null;
    let indexed_after = null;
    try { indexed_before = tdb.prepare("SELECT COUNT(*) c FROM mnemo_search_fts WHERE scope=?").get(scope).c; } catch {}
    if (reset) {
      try { tdb.prepare("DELETE FROM mnemo_search_fts WHERE scope=?").run(scope); } catch {}
    }
    if (scope === "transcript") {
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content FROM transcript ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        delOne.run("transcript", String(row.id));
        ins.run("transcript", String(row.id), row.speaker || row.source || "", `${row.direction || ""}${row.channel ? " @ " + row.channel : ""}`, String(row.content || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    } else if (scope === "brief") {
      const rows = tdb.prepare("SELECT id, agent_name, source_agent, content FROM agent_brief ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        delOne.run("brief", String(row.id));
        ins.run("brief", String(row.id), row.agent_name || "", row.source_agent || "", String(row.content || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    } else if (scope === "event") {
      const rows = tdb.prepare("SELECT id, source, channel, actor, event_kind, content, payload_json FROM mnemo_event_journal ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        const content = [row.content, row.payload_json].filter(Boolean).join("\n");
        delOne.run("event", String(row.id));
        ins.run("event", String(row.id), row.actor || row.source || "", `${row.event_kind || ""}${row.channel ? " @ " + row.channel : ""}`, String(content || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    } else if (scope === "memory") {
      const rows = tdb.prepare("SELECT id, actor, source, text FROM memory ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        delOne.run("memory", String(row.id));
        ins.run("memory", String(row.id), row.actor || row.source || "", row.source || "", String(row.text || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    }
    try { indexed_after = tdb.prepare("SELECT COUNT(*) c FROM mnemo_search_fts WHERE scope=?").get(scope).c; } catch {}
    per_scope[scope] = {
      available,
      indexed_before,
      indexed_after,
      inserted: inserted[scope],
      limit_applied: limit,
      has_more: typeof available === "number" ? available > inserted[scope] : null,
      remaining_estimate: typeof available === "number" ? Math.max(0, available - inserted[scope]) : null,
    };
  }
  return {
    ok: true,
    scopes,
    reset,
    inserted,
    per_scope,
    total_inserted: Object.values(inserted).reduce((sum, value) => sum + value, 0),
  };
}

function normalizeJournalRecallScopes(scopes) {
  const allowed = new Set(["transcript", "brief", "event"]);
  const requested = Array.isArray(scopes) && scopes.length ? scopes : ["transcript", "brief", "event"];
  return requested.map((scope) => String(scope || "").trim().toLowerCase()).filter((scope) => allowed.has(scope));
}

function searchJournalRecallRows(tdb, input = {}, limit = 20, queryText = "") {
  if (input.include_journal === false) return [];
  const scopes = normalizeJournalRecallScopes(input.journal_scopes);
  if (!scopes.length || !queryText) return [];
  const lim = Math.max(1, Math.min(limit, 200));
  const rows = [];
  for (const scope of scopes) {
    try {
      if (scope === "transcript") {
        const params = [queryText];
        let sql = `
          SELECT
            'transcript' AS surface,
            CAST(t.id AS TEXT) AS ref_id,
            'transcript' AS kind,
            COALESCE(NULLIF(t.speaker,''), NULLIF(t.source,''), '') AS actor,
            t.occurred_at AS occurred_at,
            COALESCE(mnemo_search_fts.summary, '') AS topic,
            snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS preview,
            bm25(mnemo_search_fts) AS bm25
          FROM mnemo_search_fts
          JOIN transcript t ON mnemo_search_fts.scope='transcript' AND CAST(t.id AS TEXT)=mnemo_search_fts.ref_id
          WHERE mnemo_search_fts.scope='transcript' AND mnemo_search_fts MATCH ?
        `;
        if (input.since) { sql += " AND t.occurred_at >= ?"; params.push(input.since); }
        if (input.actor) { sql += " AND (t.speaker = ? OR t.source = ?)"; params.push(input.actor, input.actor); }
        sql += " ORDER BY bm25 ASC, t.occurred_at DESC LIMIT ?";
        params.push(lim);
        rows.push(...tdb.prepare(sql).all(...params));
      } else if (scope === "brief") {
        const params = [queryText];
        let sql = `
          SELECT
            'brief' AS surface,
            CAST(b.id AS TEXT) AS ref_id,
            'brief' AS kind,
            COALESCE(NULLIF(b.source_agent,''), NULLIF(b.agent_name,''), '') AS actor,
            b.created_at AS occurred_at,
            COALESCE(b.source_agent, b.agent_name, '') AS topic,
            snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS preview,
            bm25(mnemo_search_fts) AS bm25
          FROM mnemo_search_fts
          JOIN agent_brief b ON mnemo_search_fts.scope='brief' AND CAST(b.id AS TEXT)=mnemo_search_fts.ref_id
          WHERE mnemo_search_fts.scope='brief' AND mnemo_search_fts MATCH ?
        `;
        if (input.since) { sql += " AND b.created_at >= ?"; params.push(input.since); }
        if (input.actor) { sql += " AND (b.source_agent = ? OR b.agent_name = ?)"; params.push(input.actor, input.actor); }
        sql += " ORDER BY bm25 ASC, b.created_at DESC LIMIT ?";
        params.push(lim);
        rows.push(...tdb.prepare(sql).all(...params));
      } else if (scope === "event") {
        const params = [queryText];
        let sql = `
          SELECT
            'event' AS surface,
            CAST(e.id AS TEXT) AS ref_id,
            'event' AS kind,
            COALESCE(NULLIF(e.actor,''), NULLIF(e.source,''), '') AS actor,
            e.occurred_at AS occurred_at,
            COALESCE(e.event_kind, '') AS topic,
            snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS preview,
            bm25(mnemo_search_fts) AS bm25
          FROM mnemo_search_fts
          JOIN mnemo_event_journal e ON mnemo_search_fts.scope='event' AND CAST(e.id AS TEXT)=mnemo_search_fts.ref_id
          WHERE mnemo_search_fts.scope='event' AND mnemo_search_fts MATCH ?
        `;
        if (input.since) { sql += " AND e.occurred_at >= ?"; params.push(input.since); }
        if (input.actor) { sql += " AND (e.actor = ? OR e.source = ?)"; params.push(input.actor, input.actor); }
        sql += " ORDER BY bm25 ASC, e.occurred_at DESC LIMIT ?";
        params.push(lim);
        rows.push(...tdb.prepare(sql).all(...params));
      }
    } catch {}
  }
  return rows;
}

function inferDepartmentTargets(task, topics, files) {
  const hits = new Set();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const dep = gateDepartment(topic) || categoryDepartment(topic);
    if (dep) hits.add(dep);
  }
  const text = [task, ...(Array.isArray(files) ? files : [])].filter(Boolean).join(" ").toLowerCase();
  const patterns = [
    { dep: "frontend", re: /\b(header|footer|nav|menu|logo|dark ?mode|light ?mode|mobile|responsive|font|button|layout|ui|design|i18n|language)\b/ },
    { dep: "backend", re: /\b(api|backend|server|db|database|schema|auth|login|session|cookie|token|webhook)\b/ },
    { dep: "billing", re: /\b(stripe|billing|invoice|pricing|checkout|refund|vat|vies|oss|subscription|plan)\b/ },
    { dep: "deploy-ops", re: /\b(deploy|pm2|nginx|env|dns|ssl|cert|monitor|cors)\b/ },
    { dep: "content-legal", re: /\b(copy|content|legal|privacy|terms|impressum|policy)\b/ },
    { dep: "qa", re: /\b(test|qa|verify|regression|audit|smoke)\b/ }
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(text)) hits.add(pattern.dep);
  }
  return Array.from(hits);
}

function preflightDepartmentOwnership(tdb, agentName, task, topics, files) {
  const team = buildTeamOperatingModel(tdb, agentName);
  const blockers = [];
  if (team.agent_status === "paused") blockers.push(agentName + " is paused and must not receive new work");
  if (team.agent_status === "unassigned") blockers.push(agentName + " is not in the active department roster");
  const targetDepartments = inferDepartmentTargets(task, topics, files);
  const owned = new Set((team.department_coverage || []).map((row) => row.department_name));
  const missing = targetDepartments.filter((dep) => !owned.has(dep));
  for (const dep of missing) {
    const info = departmentInfo(tdb, dep);
    blockers.push("work belongs to " + dep + " and must be handled by " + (info && info.lead_agent || "the assigned lead") + (info && info.review_agent ? " with review by " + info.review_agent : ""));
  }
  return { team, target_departments: targetDepartments, blockers };
}

function autonomyTaskResult(row, action) {
  if (!row) return null;
  return Object.assign({}, row, {
    action,
    department: row.department_name,
    checklist: parseMaybeJson(row.checklist_json, null),
    meta: parseMaybeJson(row.meta_json, null),
  });
}

function insertAutonomyTask(tdb, task) {
  ensureAutonomyTables(tdb);
  const assignee = task.assigned_agent ? { assigned_agent: task.assigned_agent, reviewer_agent: task.reviewer_agent || taskAssignee(tdb, task.department_name).reviewer_agent } : taskAssignee(tdb, task.department_name);
  const existing = tdb.prepare("SELECT * FROM autonomy_task WHERE project=? AND department_name=? AND title=?").get(task.project, task.department_name, task.title);
  if (existing) return autonomyTaskResult(existing, "kept");
  const info = tdb.prepare("INSERT INTO autonomy_task (project, department_name, title, category, severity, assigned_agent, reviewer_agent, source_kind, source_id, checklist_json, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(task.project, task.department_name, task.title, task.category || "coordination", task.severity || "M", assignee.assigned_agent || null, assignee.reviewer_agent || null, task.source_kind || null, task.source_id != null ? String(task.source_id) : null, task.checklist ? JSON.stringify(task.checklist) : null, task.notes || null, task.meta ? JSON.stringify(task.meta) : null);
  const row = tdb.prepare("SELECT * FROM autonomy_task WHERE id=?").get(info.lastInsertRowid);
  return autonomyTaskResult(row, "created");
}

function recentAutonomyBriefExists(tdb, agent, taskId, minutes = 30) {
  if (!agent || !taskId) return true;
  const since = `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${Math.max(1, minutes)} minutes')`;
  try {
    const row = tdb.prepare(
      "SELECT id FROM agent_brief WHERE lower(agent_name)=lower(?) " +
      "AND (status='pending' OR created_at > " + since + ") " +
      "AND (meta_json LIKE ? OR meta_json LIKE ? OR meta_json LIKE ? OR content LIKE ? OR content LIKE ?) LIMIT 1"
    ).get(
      agent,
      '%"autonomy_task_id":' + taskId + '%',
      '%"blocked_autonomy_task_id":' + taskId + '%',
      '%"task_id":' + taskId + '%',
      '%Autonomy task #' + taskId + '%',
      '%Blocked autonomy review #' + taskId + '%'
    );
    return !!row;
  } catch {
    return false;
  }
}

function autonomySweepBatchLines(batchInfo) {
  if (!batchInfo || !batchInfo.total_available) return [];
  const lines = [
    "## Sweep batch",
    "- Brief: " + batchInfo.index + " of " + batchInfo.total_available + " eligible tasks in this sweep",
    "- Batch limit: " + batchInfo.batch_limit
  ];
  if (batchInfo.remaining > 0) lines.push("- Remaining after this brief: " + batchInfo.remaining);
  return lines;
}

function autonomyBriefContent(t, agent, batchInfo) {
  const batchLines = autonomySweepBatchLines(batchInfo);
  return [
    "# Autonomy task #" + t.id,
    "",
    ...batchLines,
    ...(batchLines.length ? [""] : []),
    "- Project: " + t.project,
    "- Department: " + t.department,
    "- Title: " + t.title,
    "- Reviewer: " + (t.reviewer_agent || "strategy-review"),
    "",
    "This is an execution brief, not a status ping.",
    "Do not wait for the owner when the next safe action is clear.",
    "Start with `mem_autonomy_next({agent_name:\"" + agent + "\", claim:true, allow_takeover:true})`, load project rules/session context, claim files before edits, verify, then update the task.",
    "If this is not your lane, brief the responsible agent with exact URL/file/evidence and immediately pull the next task in your lane.",
    "Website/front-end Done requires real checks for header/menu/footer, links, light/dark logos, mobile/desktop, locales/languages, allowed domains, pricing/checkout/auth/legal crossover where relevant."
  ].join("\n");
}

function compactReason(value, max = 260) {
  if (value == null) return "";
  if (Array.isArray(value)) value = value.filter(Boolean).join("; ");
  else if (typeof value === "object") value = JSON.stringify(value);
  value = String(value || "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 3) + "..." : value;
}

function firstReasonObject(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const text = compactReason(obj[key]);
    if (text) return text;
  }
  return "";
}

function autonomyBlockedReasonLines(tdb, t) {
  const lines = [];
  const checklist = t.checklist || parseMaybeJson(t.checklist_json, null) || {};
  const meta = t.meta || parseMaybeJson(t.meta_json, null) || {};
  const notes = compactReason(t.notes, 360);
  if (notes) lines.push("- Blocker notes: " + notes);
  const checklistReason = firstReasonObject(checklist, ["blocked_reason", "blocker", "blockers", "missing", "reason", "next_action"]);
  if (checklistReason) lines.push("- Checklist blocker: " + checklistReason);
  const metaReason = firstReasonObject(meta, ["blocked_reason", "blocker", "blockers", "missing", "missing_blocks", "reason", "next_action", "source"]);
  if (metaReason) lines.push("- Meta blocker: " + metaReason);
  const sourceKind = t.source_kind || meta.source_kind || "";
  const sourceId = t.source_id || meta.source_id || (checklist && checklist.finding_id) || "";
  if (String(sourceKind) === "quality_finding" || sourceId) {
    try {
      const f = tdb.prepare("SELECT id, project, category, severity, title, url, expected, actual, status FROM quality_finding WHERE id=?").get(String(sourceId));
      if (f) {
        lines.push("- Source finding: #" + f.id + " [" + (f.severity || "M") + "/" + (f.status || "open") + "] " + compactReason(f.title, 220));
        if (f.url) lines.push("- URL: " + f.url);
        if (f.expected) lines.push("- Expected: " + compactReason(f.expected, 220));
        if (f.actual) lines.push("- Actual: " + compactReason(f.actual, 260));
      }
    } catch {}
  }
  if (!lines.length) {
    lines.push("- Blocker reason: not recorded on the autonomy task yet.");
    lines.push("- First unblock step: inspect source_kind/source_id, then update the task with notes or meta.blocked_reason so the next reviewer does not restart from zero.");
  }
  return lines;
}

function blockedAutonomyReviewContent(t, agent, tdb, batchInfo) {
  const blockerLines = autonomyBlockedReasonLines(tdb, t);
  const batchLines = autonomySweepBatchLines(batchInfo);
  return [
    "# Blocked autonomy review #" + t.id,
    "",
    ...batchLines,
    ...(batchLines.length ? [""] : []),
    "- Project: " + t.project,
    "- Department: " + t.department,
    "- Status: " + (t.status || "blocked"),
    "- Title: " + t.title,
    "- Assigned agent: " + (t.assigned_agent || "unassigned"),
    "- Reviewer: " + (t.reviewer_agent || agent || "strategy-review"),
    "",
    "## Why this is blocked",
    blockerLines.join("\n"),
    "",
    "This is an execution brief, not a status ping and not a passive autonomy pointer.",
    "Read the task/finding/handoff, identify the exact unblock step, and act.",
    "If you can safely fix it, fix it and verify it. If another lane owns it, brief that agent with exact URL/file/evidence. If only owner/server access can unblock it, write one precise blocker with the exact access or decision needed.",
    "After acting, update the task with mem_autonomy_task_update so the blocked state cannot silently stay stale."
  ].join("\n");
}

function resolveAutonomyTaskUpdateId(tdb, inputId) {
  const raw = parseInt(inputId, 10);
  if (!Number.isFinite(raw)) return { id: inputId, error: "invalid id" };
  const direct = tdb.prepare("SELECT id, meta_json FROM autonomy_task WHERE id=?").get(raw);
  if (direct) return { id: raw, resolved_from: "autonomy_task.id" };
  const candidates = [];
  try {
    const brief = tdb.prepare("SELECT id, content, meta_json FROM agent_brief WHERE id=?").get(raw);
    if (brief) {
      const meta = parseMaybeJson(brief.meta_json, {}) || {};
      ["autonomy_task_id", "blocked_autonomy_task_id", "task_id"].forEach((key) => {
        const value = parseInt(meta[key], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "agent_brief.meta." + key });
      });
      const re = /(?:Autonomy task|Blocked autonomy review)\s*#(\d+)/gi;
      let match;
      while ((match = re.exec(String(brief.content || "")))) {
        const value = parseInt(match[1], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "agent_brief.content" });
      }
    }
  } catch {}
  try {
    const mem = tdb.prepare("SELECT id, text, meta_json FROM memory WHERE id=?").get(raw);
    if (mem) {
      const meta = parseMaybeJson(mem.meta_json, {}) || {};
      ["autonomy_task_id", "blocked_autonomy_task_id", "task_id"].forEach((key) => {
        const value = parseInt(meta[key], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "memory.meta." + key });
      });
      const re = /(?:Autonomy task|Blocked autonomy review)\s*#(\d+)/gi;
      let match;
      while ((match = re.exec(String(mem.text || "")))) {
        const value = parseInt(match[1], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "memory.text" });
      }
    }
  } catch {}
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const row = tdb.prepare("SELECT id FROM autonomy_task WHERE id=?").get(candidate.id);
    if (row) return { id: candidate.id, resolved_from: candidate.source, input_id: raw };
  }
  return { id: raw, error: "task not found", candidates };
}

function qualityFindingExists(tdb, project, title) {
  try { return tdb.prepare("SELECT id, status FROM quality_finding WHERE project=? AND title=? ORDER BY id DESC LIMIT 1").get(project, title); } catch { return null; }
}

function createQualityFindingOnce(tdb, finding) {
  const existing = qualityFindingExists(tdb, finding.project, finding.title);
  if (existing && existing.status === "open") return { action: "kept", id: existing.id, status: existing.status };
  const info = tdb.prepare("INSERT INTO quality_finding (project, category, severity, title, url, expected, actual, source_agent, evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(finding.project, finding.category, finding.severity || "M", finding.title, finding.url || null, finding.expected || null, finding.actual || null, finding.source_agent || null, finding.evidence ? JSON.stringify(finding.evidence) : null);
  return { action: "created", id: info.lastInsertRowid, status: "open" };
}

const LIVE_GATES = ["nav", "header_footer", "links", "auth", "pricing", "checkout", "billing", "vat", "legal", "mobile", "i18n", "deploy", "monitoring"];
function blunTopDirectives(project, rulesRow) {
  const auth = parseMaybeJson(rulesRow && rulesRow.auth_matrix, {}) || {};
  const design = parseMaybeJson(rulesRow && rulesRow.design_rules, {}) || {};
  const projectName = String(project || rulesRow && rulesRow.project || "");
  const canonicalLoginUrl = String(auth.canonical_login_url || "");
  const isBlun =
    /blun/i.test(projectName) ||
    auth.canonical_project === "account.blun.ai" ||
    /https?:\/\/account\.blun\.ai(\/|$)/i.test(canonicalLoginUrl) ||
    design.canonical_brand_project === "blun.ai" ||
    design.canonical_header_project === "blun.ai" ||
    design.canonical_button_project === "blun.ai" ||
    design.shared_ui_family === "blun";
  if (!isBlun) return [];
  return [
    "BLUN top directive: account.blun.ai login/auth is canonical. Every public BLUN portal must route account entry through account.blun.ai and must not invent a different login flow, account flow, or session model.",
    "BLUN top directive: shared login does not mean shared pricing. Each portal keeps its own pricing and entitlement model unless an explicit cross-portal bundle is documented.",
    "BLUN top directive: admin.blun.ai is the separate central admin surface. Customer account flows and normal user login behavior stay in account.blun.ai; internal admin, oversight, audit, and portal/customer management stay in admin.blun.ai behind separate role/elevation checks.",
    "BLUN top directive: blun.ai defines the canonical header structure, button system, and light/dark visual behavior for linked portals.",
    "BLUN top directive: language and theme switching belong in account/settings surfaces, not in shared public header chrome. Language defaults to the browser unless account.blun.ai stores an explicit override. Do not add DE/EN toggles or theme toggles to the canonical BLUN header unless project rules declare a written exception.",
    "BLUN top directive: fonts, font sizes, light-logo PNG, dark-logo PNG, button sizing, and header spacing must mirror the canonical BLUN source exactly.",
    "BLUN top directive: no local reinterpretation. If a portal deviates from account.blun.ai auth or blun.ai header/buttons/theme, block the work and fix the contract before coding."
  ];
}

function buildProjectCrossoverCheck(tdb, a) {
  ensureAutonomyTables(tdb);
  const project = a.project || a.name;
  if (!project) return { error: "project required" };
  const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(project) || null;
  const rules = tdb.prepare("SELECT * FROM project_rules WHERE project=?").get(project) || null;
  const checklist = reg ? parseMaybeJson(reg.health_checklist, {}) || {} : {};
  const required = new Set(LIVE_GATES);
  if (rules) for (const gate of parseMaybeJson(rules.required_gates, []) || []) required.add(gate);
  const checks = [];
  const findings = [];
  function addFinding(category, severity, title, expected, actual, evidence) {
    const finding = { project, category, severity, title, expected, actual, evidence, source_agent: a.source_agent || a.agent_name || "crossover-check" };
    findings.push(finding);
    checks.push({ category, status: "finding", severity, title });
  }
  if (!reg) addFinding("deploy", "H", "Project registry missing", "Project has registry row with domain, live_url, server and health checklist.", "No project_registry row found.", {});
  if (!rules) addFinding("coordination", "H", "Project rules missing", "Project has canonical nav, auth, pricing, checkout, VAT, legal, design and deploy rules.", "No project_rules row found.", {});
  if (reg && !reg.live_url) addFinding("deploy", "M", "Live URL missing", "Project registry declares the live URL used for checks.", "live_url is empty.", { registry: reg.name });
  if (reg && !reg.domain) addFinding("deploy", "M", "Domain missing", "Project registry declares canonical domain.", "domain is empty.", { registry: reg.name });
  if (rules) {
    const nav = parseMaybeJson(rules.canonical_nav, []);
    const navItems = Array.isArray(nav) ? nav : [nav?.primary, nav?.items, nav?.menu, nav?.links].find(items => Array.isArray(items)) || [];
    if (navItems.length === 0) addFinding("nav", "H", "Canonical menu missing", "Landing/app pages use the same documented menu items and targets.", "canonical_nav is empty.", {});
    const auth = parseMaybeJson(rules.auth_matrix, {});
    if (!auth || auth.status === "unknown") addFinding("auth", "H", "Auth crossover unknown", "Document whether one login works across related sites and which pages share account state.", "auth_matrix.status is unknown or missing.", auth || {});
    const authContract = authContractReport(tdb, project, ensureFirmOpsTables);
    if (authContract.status === "block") {
      for (const blocker of authContract.blockers || []) {
        addFinding("auth", "H", "Canonical auth contract mismatch", "Every linked portal follows one documented login/SSO contract.", blocker, { canonical_project: authContract.canonical_project, missing: authContract.missing, mismatches: authContract.mismatches });
      }
    } else {
      checks.push({ category: "auth", status: "pass", title: "Canonical auth contract consistent" });
    }
    const pricing = parseMaybeJson(rules.pricing_rules, {});
    if (!pricing || pricing.status === "unknown" || pricing.source_of_truth === "unknown") addFinding("pricing", "H", "Pricing source of truth unknown", "Every pricing page and admin price change points to one source of truth.", "pricing_rules are incomplete.", pricing || {});
    const checkout = parseMaybeJson(rules.checkout_rules, {});
    if (!checkout || checkout.status === "unknown" || checkout.provider === "unknown") addFinding("checkout", "H", "Checkout rules unknown", "Checkout provider, products, prices, customer portal, refunds and webhooks are documented.", "checkout_rules are incomplete.", checkout || {});
    const vat = parseMaybeJson(rules.vat_rules, {});
    if (!vat || vat.status === "unknown") addFinding("vat", "H", "VAT/OSS check unknown", "VAT/OSS/VIES requirements are documented and checked before live.", "vat_rules.status is unknown or missing.", vat || {});
    const language = parseMaybeJson(rules.language_matrix, {});
    if (!language || language.status === "unknown") addFinding("i18n", "M", "Language parity unknown", "Every required language has the same nav, pages and user flow coverage.", "language_matrix.status is unknown or missing.", language || {});
    const uiContract = uiContractReport(tdb, project, ensureFirmOpsTables);
    if (uiContract.status === "block") {
      for (const blocker of uiContract.blockers || []) {
        addFinding("design", "H", "Canonical UI contract mismatch", "Every linked portal follows blun.ai for header structure, buttons, and light/dark behavior.", blocker, { missing: uiContract.missing, mismatches: uiContract.mismatches });
      }
    } else {
      checks.push({ category: "design", status: "pass", title: "Canonical UI contract consistent" });
    }
  }
  for (const gate of required) {
    const status = checklist[gate];
    if (status === "block") addFinding(gate, "H", "Live gate blocked: " + gate, "Gate is pass before live deploy.", "health_checklist." + gate + " is block.", { gate });
    else if (status !== "pass") checks.push({ category: gate, status: "unknown", title: "Gate not passed: " + gate });
  }
  const created = [];
  if (a.create_findings !== false) for (const f of findings) created.push(Object.assign({}, createQualityFindingOnce(tdb, f), { title: f.title, category: f.category, severity: f.severity }));
  const status = findings.some(f => f.severity === "H" || f.severity === "critical") ? "block" : (findings.length || checks.some(c => c.status === "unknown") ? "attention" : "ok");
  return { ok: status === "ok", status, project, checks, findings: created.length ? created : findings, required_gates: Array.from(required) };
}

function runAutonomySweep(tdb, a) {
  ensureAutonomyTables(tdb);
  const depCount = tdb.prepare("SELECT COUNT(*) AS c FROM department WHERE status='active'").get().c;
  if (!depCount) {
    const depStmt = tdb.prepare("INSERT INTO department (name, mission, lead_agent, review_agent, skills_json, responsibilities_json, required_gates_json, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO NOTHING");
    for (const d of defaultDepartments(a.agent_map || {})) {
      depStmt.run(d.name, d.mission, d.lead_agent || null, d.review_agent || null, JSON.stringify(d.skills || []), JSON.stringify(d.responsibilities || []), JSON.stringify(d.required_gates || []), a.agent_name || DEFAULT_AGENT);
    }
  }
  const scope = scopeName(a.scope);
  const board = buildFirmReadinessBoard(tdb, { scope, include_seed: a.include_seed !== false, include_smoke: a.include_smoke === true });
  const tasks = [];
  const projects = a.project ? board.projects.filter(p => p.name === a.project) : board.projects;
  for (const p of projects) {
    const reviewTask = insertAutonomyTask(tdb, { project: p.name, department_name: "strategy-review", title: "Review readiness and coordinate outstanding work for " + p.name, category: "coordination", severity: p.status === "block" ? "H" : "M", checklist: { gates: p.gates, missing: p.missing, findings: p.findings }, meta: { source: "autonomy_sweep", status: p.status } });
    tasks.push(Object.assign({ project: p.name, department: "strategy-review", title: "Review readiness and coordinate outstanding work for " + p.name }, reviewTask));
    for (const gate of p.gates.unknown.concat(p.gates.blocked)) {
      const dep = gateDepartment(gate);
      const t = insertAutonomyTask(tdb, { project: p.name, department_name: dep, title: "Resolve live gate " + gate + " for " + p.name, category: gate, severity: p.gates.blocked.includes(gate) ? "H" : "M", checklist: { gate, expected: "pass", current: p.gates.blocked.includes(gate) ? "block" : "unknown" }, meta: { source: "readiness_board" } });
      tasks.push(Object.assign({ project: p.name, department: dep, title: "Resolve live gate " + gate + " for " + p.name }, t));
    }
    for (const missing of p.missing || []) {
      const dep = missing === "project_rules" || missing === "registry" ? "strategy-review" : gateDepartment(missing);
      const t = insertAutonomyTask(tdb, { project: p.name, department_name: dep, title: "Fill missing " + missing + " for " + p.name, category: missing, severity: missing === "project_rules" || missing === "registry" ? "H" : "M", checklist: { missing }, meta: { source: "readiness_missing" } });
      tasks.push(Object.assign({ project: p.name, department: dep, title: "Fill missing " + missing + " for " + p.name }, t));
    }
  }
  const openFindings = tdb.prepare("SELECT id, project, category, severity, title FROM quality_finding WHERE status='open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at DESC LIMIT ?").all(Math.min(a.finding_limit || 100, 500));
  for (const f of openFindings) {
    if (a.project && f.project !== a.project) continue;
    const dep = categoryDepartment(f.category);
    const t = insertAutonomyTask(tdb, { project: f.project, department_name: dep, title: "Fix finding #" + f.id + ": " + f.title, category: f.category, severity: f.severity, source_kind: "quality_finding", source_id: f.id, checklist: { finding_id: f.id, verify_before_resolve: true }, meta: { source: "quality_finding" } });
    tasks.push(Object.assign({ project: f.project, department: dep, title: "Fix finding #" + f.id + ": " + f.title }, t));
  }
  const created = tasks.filter(t => t.action === "created");
  const briefedTasks = [];
  if (a.drop_briefs) {
    const briefed = new Set();
    const briefLimit = Math.max(1, Math.min(parseInt(a.brief_limit || 25, 10) || 25, 200));
    const briefable = tasks.filter(t => t.action === "created" || t.status === "open" || t.status === "claimed" || t.status === "blocked" || t.status === "review");
    const eligible = [];
    for (const t of briefable) {
      if (briefedTasks.length >= briefLimit) break;
      const reviewRequired = t.status === "blocked" || t.status === "review";
      const agent = reviewRequired ? (t.reviewer_agent || t.assigned_agent) : t.assigned_agent;
      if (!agent || briefed.has(agent + ":" + t.id)) continue;
      if (t.action !== "created" && recentAutonomyBriefExists(tdb, agent, t.id, reviewRequired ? Math.max(30, a.blocked_rebrief_minutes || 120) : 30)) continue;
      briefed.add(agent + ":" + t.id);
      eligible.push({ t, agent, reviewRequired });
    }
    const totalAvailable = eligible.length;
    for (let i = 0; i < Math.min(totalAvailable, briefLimit); i++) {
      const { t, agent, reviewRequired } = eligible[i];
      const batchInfo = {
        index: i + 1,
        total_available: totalAvailable,
        batch_limit: briefLimit,
        remaining: Math.max(0, totalAvailable - i - 1)
      };
      const content = reviewRequired ? blockedAutonomyReviewContent(t, agent, tdb, batchInfo) : autonomyBriefContent(t, agent, batchInfo);
      const meta = reviewRequired
        ? { type: "blocked_autonomy_review", blocked_autonomy_task_id: t.id, department: t.department, project: t.project, task_status: t.status, execution_required: true, sweep_batch: batchInfo }
        : { autonomy_task_id: t.id, department: t.department, project: t.project, sweep_batch: batchInfo };
      try {
        tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)").run(agent, a.agent_name || "autonomy-sweep", content, JSON.stringify(meta));
        briefedTasks.push({ id: t.id, agent, project: t.project, department: t.department, status: t.status, review_required: reviewRequired, sweep_batch: batchInfo });
      } catch {}
    }
  }
  try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'autonomy_sweep', ?, 'done', ?, 'autonomy')").run(a.agent_name || "autonomy-sweep", scope, JSON.stringify({ tasks: tasks.length, created: created.length, briefed: briefedTasks.length, brief_limit: a.drop_briefs ? Math.max(1, Math.min(parseInt(a.brief_limit || 25, 10) || 25, 200)) : 0, board: board.summary })); } catch {}
  return { ok: true, scope, board: board.summary, tasks_count: tasks.length, created_count: created.length, briefed_count: briefedTasks.length, briefed: briefedTasks, tasks };
}

function buildFirmReadinessBoard(tdb, a) {
  ensureFirmOpsTables(tdb);
  ensureProjectRegistryTable(tdb);
  try { tdb.exec("CREATE TABLE IF NOT EXISTS work_claim (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, file_path TEXT NOT NULL, agent_name TEXT NOT NULL, summary TEXT, claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"); } catch {}
  const defaults = ["auth","billing","vat","legal","mobile","header_footer","pricing","checkout"];
  const names = new Set();
  try { for (const r of tdb.prepare("SELECT name FROM project_registry").all()) names.add(r.name); } catch {}
  try { for (const r of tdb.prepare("SELECT project FROM project_rules").all()) names.add(r.project); } catch {}
  try { for (const r of tdb.prepare("SELECT DISTINCT project FROM quality_finding").all()) names.add(r.project); } catch {}
  if (a.include_seed !== false) {
    const seed = loadProjectRuleDefaults(a.scope);
    for (const p of seed.projects || []) names.add(p.name);
  }
  const filter = Array.isArray(a.projects) && a.projects.length ? new Set(a.projects) : null;
  const projects = [];
  for (const name of Array.from(names).sort()) {
    if (filter && !filter.has(name)) continue;
    if (!a.include_smoke && (/^__smoke/i.test(name) || /^Smoke\s/i.test(name))) continue;
    const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(name) || null;
    const rules = tdb.prepare("SELECT * FROM project_rules WHERE project=?").get(name) || null;
    const checklist = reg ? parseMaybeJson(reg.health_checklist, {}) || {} : {};
    const required = rules ? (parseMaybeJson(rules.required_gates, defaults) || defaults) : defaults;
    const passed = [];
    const blocked = [];
    const unknown = [];
    for (const gate of required) {
      const v = checklist[gate];
      if (v === "pass") passed.push(gate);
      else if (v === "block") blocked.push(gate);
      else unknown.push(gate);
    }
    const findings = tdb.prepare("SELECT COUNT(*) AS open, SUM(CASE WHEN severity IN ('H','critical') THEN 1 ELSE 0 END) AS high FROM quality_finding WHERE project=? AND status='open'").get(name) || { open: 0, high: 0 };
    const claims = tdb.prepare("SELECT COUNT(*) AS active FROM work_claim WHERE project=? AND status='active' AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(name) || { active: 0 };
    const missing = [];
    if (!reg) missing.push("registry");
    if (!rules) missing.push("project_rules");
    if (reg && !reg.domain) missing.push("domain");
    if (reg && !reg.server) missing.push("server");
    if (reg && !reg.live_url) missing.push("live_url");
    if (rules && !rules.auth_matrix) missing.push("auth_matrix");
    if (rules && !rules.pricing_rules) missing.push("pricing_rules");
    if (rules && !rules.checkout_rules) missing.push("checkout_rules");
    if (rules && !rules.vat_rules) missing.push("vat_rules");
    let status = "ready";
    if (blocked.length || Number(findings.high || 0) > 0) status = "block";
    else if (unknown.length || missing.length || Number(findings.open || 0) > 0) status = "attention";
    projects.push({
      name,
      status,
      domain: reg ? reg.domain : null,
      live_url: reg ? reg.live_url : null,
      live_status: reg ? reg.live_status : null,
      gates: { required, passed, blocked, unknown },
      findings: { open: Number(findings.open || 0), high: Number(findings.high || 0) },
      active_claims: Number(claims.active || 0),
      missing,
      updated_at: reg && reg.updated_at ? reg.updated_at : (rules ? rules.updated_at : null)
    });
  }
  projects.sort((x, y) => {
    const rank = { block: 0, attention: 1, ready: 2 };
    return (rank[x.status] - rank[y.status]) || x.name.localeCompare(y.name);
  });
  const summary = {
    total: projects.length,
    ready: projects.filter(p => p.status === "ready").length,
    attention: projects.filter(p => p.status === "attention").length,
    block: projects.filter(p => p.status === "block").length,
    open_findings: projects.reduce((n, p) => n + p.findings.open, 0),
    high_findings: projects.reduce((n, p) => n + p.findings.high, 0)
  };
  const lines = ["# Firm readiness board", "", `Total: ${summary.total} | ready: ${summary.ready} | attention: ${summary.attention} | block: ${summary.block}`, ""];
  for (const p of projects) {
    lines.push(`## ${p.name}`);
    lines.push(`- Status: ${p.status}`);
    if (p.live_url) lines.push(`- URL: ${p.live_url}`);
    if (p.gates.blocked.length) lines.push(`- Blocked gates: ${p.gates.blocked.join(", ")}`);
    if (p.gates.unknown.length) lines.push(`- Unknown gates: ${p.gates.unknown.join(", ")}`);
    if (p.findings.open) lines.push(`- Open findings: ${p.findings.open} (${p.findings.high} high/critical)`);
    if (p.active_claims) lines.push(`- Active claims: ${p.active_claims}`);
    if (p.missing.length) lines.push(`- Missing: ${p.missing.join(", ")}`);
    lines.push("");
  }
  return { summary, projects, doc: lines.join("\n") };
}

const RECALL_STOPWORDS = new Set([
  "der", "die", "das", "den", "dem", "und", "oder", "aber", "mit", "fuer", "für", "von", "vom", "zur", "zum", "ist", "sind", "war", "was", "wie", "ich", "du", "wir", "ihr", "sie", "ein", "eine", "einer", "einen", "nicht", "noch", "auch", "auf", "aus", "bei", "nach", "dass", "the", "and", "or", "for", "with", "from", "that", "this", "what", "when", "where", "why", "how"
]);

function recallSearchTokens(query) {
  const raw = String(query || "").toLowerCase();
  const folded = raw.normalize ? raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") : raw;
  const seen = new Set();
  const out = [];
  for (const token of (raw + " " + folded).match(/[\p{L}\p{N}_]{3,}/gu) || []) {
    if (RECALL_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token.slice(0, 48));
    if (out.length >= 10) break;
  }
  return out;
}

function fuzzyFtsQuery(query) {
  const tokens = recallSearchTokens(query).slice(0, 8);
  if (!tokens.length) return "";
  return tokens.map((token) => token + "*").join(" OR ");
}

function memoryFtsRecallRows(tdb, input = {}, limit = 20, ftsQuery = "", matchMode = "fts") {
  if (!ftsQuery) return [];
  try {
    const where = ["memory_fts MATCH ?"];
    const params = [ftsQuery];
    if (input.since) { where.push("m.occurred_at >= ?"); params.push(input.since); }
    if (input.kind) { where.push("m.kind = ?"); params.push(input.kind); }
    if (input.actor) { where.push("m.actor = ?"); params.push(input.actor); }
    const rows = tdb.prepare(`
      SELECT m.id, m.kind, m.actor, m.occurred_at, m.topic, m.importance,
             substr(m.text, 1, 400) AS preview,
             bm25(memory_fts) AS bm25
      FROM memory_fts
      JOIN memory m ON m.id = memory_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY bm25 ASC, m.occurred_at DESC
      LIMIT ?
    `).all(...params, Math.max(1, limit));
    return rows.map((row) => Object.assign({ surface: "memory", ref_id: String(row.id), match_mode: matchMode }, row));
  } catch {
    return [];
  }
}

function memoryLikeRecallRows(tdb, input = {}, limit = 20, queryText = "") {
  const tokens = recallSearchTokens(queryText);
  const phrase = String(queryText || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
  const terms = Array.from(new Set([phrase, ...tokens].filter((term) => term && term.length >= 3))).slice(0, 9);
  if (!terms.length) return [];
  try {
    const where = [];
    const params = [];
    const clauses = [];
    for (const term of terms) {
      clauses.push("(lower(m.text) LIKE ? OR lower(COALESCE(m.topic,'')) LIKE ? OR lower(COALESCE(m.actor,'')) LIKE ?)");
      params.push("%" + term + "%", "%" + term + "%", "%" + term + "%");
    }
    where.push("(" + clauses.join(" OR ") + ")");
    if (input.since) { where.push("m.occurred_at >= ?"); params.push(input.since); }
    if (input.kind) { where.push("m.kind = ?"); params.push(input.kind); }
    if (input.actor) { where.push("m.actor = ?"); params.push(input.actor); }
    params.push(Math.max(1, limit));
    return tdb.prepare(`
      SELECT m.id, m.kind, m.actor, m.occurred_at, m.topic, m.importance,
             substr(m.text, 1, 400) AS preview,
             999.0 AS bm25
      FROM memory m
      WHERE ${where.join(" AND ")}
      ORDER BY m.importance DESC, m.occurred_at DESC
      LIMIT ?
    `).all(...params).map((row) => Object.assign({ surface: "memory", ref_id: String(row.id), match_mode: "like" }, row));
  } catch {
    return [];
  }
}

function journalLikeRecallRows(tdb, input = {}, limit = 20, queryText = "") {
  if (input.include_journal === false) return [];
  const scopes = Array.isArray(input.journal_scopes) && input.journal_scopes.length ? input.journal_scopes : ["transcript", "brief", "event"];
  const allowed = scopes.filter((s) => ["transcript", "brief", "event"].includes(s));
  if (!allowed.length) return [];
  const tokens = recallSearchTokens(queryText);
  const phrase = String(queryText || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
  const terms = Array.from(new Set([phrase, ...tokens].filter((term) => term && term.length >= 3))).slice(0, 9);
  if (!terms.length) return [];
  try {
    const placeholders = allowed.map(() => "?").join(",");
    const params = [...allowed];
    const clauses = [];
    for (const term of terms) {
      clauses.push("(lower(COALESCE(content,'')) LIKE ? OR lower(COALESCE(summary,'')) LIKE ? OR lower(COALESCE(agent_name,'')) LIKE ?)");
      params.push("%" + term + "%", "%" + term + "%", "%" + term + "%");
    }
    if (input.actor) {
      clauses.push("lower(COALESCE(agent_name,'')) LIKE ?");
      params.push("%" + String(input.actor).toLowerCase() + "%");
    }
    params.push(Math.max(1, limit));
    return tdb.prepare(`
      SELECT scope AS kind, scope AS surface, ref_id, agent_name AS actor,
             COALESCE(summary, '') AS topic,
             substr(COALESCE(content, summary, ''), 1, 400) AS preview,
             999.0 AS bm25,
             'journal_like' AS match_mode
      FROM mnemo_search_fts
      WHERE scope IN (${placeholders}) AND (${clauses.join(" OR ")})
      LIMIT ?
    `).all(...params);
  } catch {
    return [];
  }
}

function dedupeRecallRows(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = `${row.surface || "memory"}:${row.ref_id || row.id}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function approxTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function clampLimit(value, fallback, max) {
  const n = parseInt(value || "", 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function recallMemories(tdb, a) {
  const query = String(a.query || "").trim();
  if (!query) return [];
  const limit = clampLimit(a.limit, 20, 200);
  const journalInput = {
    include_journal: a.include_journal !== false,
    journal_scopes: a.journal_scopes,
    since: a.since,
    actor: a.actor,
  };
  try {
    const baseInput = { since: a.since, kind: a.kind, actor: a.actor };
    const exactQuery = sanitizeFtsQuery(query);
    const memoryRows = memoryFtsRecallRows(tdb, baseInput, limit * 2, exactQuery, "fts");
    const journalRows = a.mode === "semantic" ? [] : searchJournalRecallRows(tdb, journalInput, limit * 2, exactQuery);
    let fallbackRows = [];
    if (a.mode !== "semantic" && (memoryRows.length + journalRows.length) < Math.min(limit, 5)) {
      const fuzzyQuery = fuzzyFtsQuery(query);
      const fuzzyRows = fuzzyQuery && fuzzyQuery !== exactQuery
        ? memoryFtsRecallRows(tdb, baseInput, limit * 2, fuzzyQuery, "fuzzy_fts")
        : [];
      fallbackRows = dedupeRecallRows([
        ...fuzzyRows,
        ...memoryLikeRecallRows(tdb, baseInput, limit * 2, query),
        ...journalLikeRecallRows(tdb, journalInput, limit * 2, query)
      ]);
    }
    if (a.mode === "fts") {
      return dedupeRecallRows([...memoryRows, ...journalRows, ...fallbackRows])
        .sort((x, y) => (Number(x.bm25 ?? Number.POSITIVE_INFINITY) - Number(y.bm25 ?? Number.POSITIVE_INFINITY)) || String(y.occurred_at || "").localeCompare(String(x.occurred_at || "")))
        .slice(0, limit);
    }
    if (a.mode === "semantic") {
      return memoryRows.slice(0, limit);
    }
    const RRF_K = 60;
    const score = new Map();
    const meta = new Map();
    const rowKey = (row) => `${row.surface || "memory"}:${row.ref_id || row.id}`;
    [...memoryRows, ...journalRows, ...fallbackRows].forEach((row, i) => {
      const key = rowKey(row);
      score.set(key, (score.get(key) || 0) + 1 / (RRF_K + i + 1));
      meta.set(key, row);
    });
    return Array.from(score.entries())
      .sort((x, y) => y[1] - x[1])
      .slice(0, limit)
      .map(([key, fused]) => Object.assign({}, meta.get(key), { fused_score: Math.round(fused * 10000) / 10000 }));
  } catch (e) {
    return { error: String(e.message || e), query };
  }
}

function sessionBrief(tdb, a) {
  const tokenBudget = clampLimit(a.token_budget, 200, 4000);
  const owner = a.owner_name || OWNER_NAME || "owner";
  const want = new Set(Array.isArray(a.layers) && a.layers.length ? a.layers : ["identity", "traits", "open_loops", "today", "recent_decisions"]);
  const out = { generated_at: new Date().toISOString(), token_budget: tokenBudget, layers: {} };
  let used = 0;

  if (want.has("identity")) {
    try {
      const values = tdb.prepare("SELECT name, statement FROM core_value WHERE is_active=1 ORDER BY name LIMIT 5").all();
      const trait = tdb.prepare("SELECT name, weight FROM personality_trait ORDER BY weight DESC LIMIT 1").get();
      const identity = {
        owner,
        top_values: values.map(v => ({ name: v.name, statement: String(v.statement || "").slice(0, 180) })),
        top_trait: trait ? { name: trait.name, weight: trait.weight } : null,
      };
      out.layers.identity = identity;
      used += approxTokens(JSON.stringify(identity));
    } catch (e) { out.layers.identity = { error: String(e.message || e) }; }
  }

  if (want.has("traits") && used < tokenBudget) {
    try {
      const traits = tdb.prepare("SELECT name, weight, notes FROM personality_trait ORDER BY weight DESC LIMIT 8").all();
      const lastReflection = tdb.prepare("SELECT reflection_date, summary, next_day_focus FROM daily_reflection ORDER BY reflection_date DESC LIMIT 1").get();
      const block = {
        traits: traits.map(t => ({ name: t.name, w: Math.round(Number(t.weight || 0) * 100) / 100, capped: !!(t.notes && /HARD_CAP/.test(t.notes)) })),
        last_reflection: lastReflection || null,
      };
      out.layers.traits = block;
      used += approxTokens(JSON.stringify(block));
    } catch (e) { out.layers.traits = { error: String(e.message || e) }; }
  }

  if (want.has("open_loops") && used < tokenBudget) {
    try {
      let openPromises = [];
      try {
        openPromises = tdb.prepare("SELECT id, substr(text,1,160) preview, promised_at FROM promise WHERE status='open' ORDER BY promised_at DESC LIMIT 8").all();
      } catch {}
      let openCommitments = [];
      try {
        openCommitments = tdb.prepare("SELECT id, substr(text,1,160) preview, category, expected_followup_at FROM commitment WHERE status='open' ORDER BY expected_followup_at ASC NULLS LAST LIMIT 8").all();
      } catch {}
      let openFindings = [];
      try {
        openFindings = tdb.prepare("SELECT id, project, category, severity, title FROM quality_finding WHERE status='open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, updated_at DESC LIMIT 12").all();
      } catch {}
      const block = { open_promises: openPromises, open_commitments: openCommitments, open_quality_findings: openFindings };
      out.layers.open_loops = block;
      used += approxTokens(JSON.stringify(block));
    } catch (e) { out.layers.open_loops = { error: String(e.message || e) }; }
  }

  if (want.has("today") && used < tokenBudget) {
    try {
      const since = new Date(Date.now() - 24 * 3600e3).toISOString();
      const ownerRows = tdb.prepare(
        "SELECT actor, kind, substr(text,1,180) preview, occurred_at, importance FROM memory WHERE occurred_at > ? AND (actor=? OR actor=lower(?)) ORDER BY importance DESC, occurred_at DESC LIMIT 8"
      ).all(since, owner, owner);
      const actionRows = tdb.prepare(
        "SELECT agent_name, action_kind, target, status, started_at, substr(payload_json,1,160) payload_preview FROM agent_action WHERE started_at > ? ORDER BY started_at DESC LIMIT 8"
      ).all(since);
      const block = { window: "last_24h", owner, recent_owner_memory: ownerRows, recent_actions: actionRows };
      out.layers.today = block;
      used += approxTokens(JSON.stringify(block));
    } catch (e) { out.layers.today = { error: String(e.message || e) }; }
  }

  if (want.has("recent_decisions") && used < tokenBudget) {
    try {
      const since = new Date(Date.now() - 7 * 86400e3).toISOString();
      const rows = tdb.prepare(
        "SELECT actor, kind, substr(text,1,220) preview, occurred_at, importance FROM memory WHERE occurred_at > ? AND (kind='decision' OR importance >= 8) ORDER BY occurred_at DESC LIMIT 12"
      ).all(since);
      const block = { window: "last_7d", decisions_or_high_importance: rows };
      out.layers.recent_decisions = block;
      used += approxTokens(JSON.stringify(block));
    } catch (e) { out.layers.recent_decisions = { error: String(e.message || e) }; }
  }

  out.estimated_tokens = used;
  out.over_budget = used > tokenBudget;
  return out;
}

function handleTool(tdb, name, a) {
  if (name === "mem_code_outline" || name === "mem_code_unfold") return handleCodeReadTool(name, a || {});
  if (name === "mem_context_preview") {
    const preview = handleContextPreviewTool(tdb, name, a || {});
    if (preview.handled) return preview.result;
  }
  if (LOOP_DOCTOR_TOOL_DEFS[name]) {
    const doctor = handleLoopDoctorTool(tdb, name, a || {});
    if (doctor.handled) return doctor.result;
  }
  if (TIMELINE_REPORT_TOOL_DEFS[name]) {
    const report = handleTimelineReportTool(tdb, name, a || {});
    if (report.handled) return report.result;
  }
  const teamQuality = handleTeamQualityTool(tdb, name, a || {});
  if (teamQuality.handled) return teamQuality.result;
  const agentMail = handleAgentMailTool(tdb, name, a || {});
  if (agentMail.handled) return agentMail.result;
  switch (name) {
    case "mem_recall": {
      return recallMemories(tdb, a || {});
    }
    case "mem_recall_ids": {
      const rows = recallMemories(tdb, Object.assign({}, a || {}, { limit: Math.min((a && a.limit) || 50, 500) }));
      if (!Array.isArray(rows)) return rows;
      return rows.map(r => ({
        id: (r.surface || "memory") === "memory" ? r.id : null,
        ref_id: r.ref_id || String(r.id),
        surface: r.surface || "memory",
        kind: r.kind,
        score: r.fused_score ?? (r.bm25 != null ? Math.round(r.bm25 * 1000) / 1000 : null),
        snippet: String(r.preview || "").replace(/\s+/g, " ").slice(0, 100),
        at: r.occurred_at,
      }));
    }
    case "mem_get": {
      const ids = Array.isArray(a.ids) && a.ids.length ? a.ids : (a.id != null ? [a.id] : []);
      if (!ids.length) return [];
      const safeIds = ids.map(n => parseInt(n, 10)).filter(Number.isFinite).slice(0, 100);
      if (!safeIds.length) return [];
      const placeholders = safeIds.map(() => "?").join(",");
      return tdb.prepare(`SELECT id, kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json FROM memory WHERE id IN (${placeholders}) ORDER BY occurred_at ASC`).all(...safeIds);
    }
    case "mem_value_get": {
      if (a.name) return tdb.prepare("SELECT * FROM core_value WHERE name=? AND is_active=1").get(a.name) || null;
      return tdb.prepare("SELECT name, statement, scope, set_at FROM core_value WHERE is_active=1 ORDER BY name").all();
    }
    case "mem_who_am_i": {
      const values = tdb.prepare("SELECT name, statement, scope FROM core_value WHERE is_active=1 ORDER BY name").all();
      const traits = tdb.prepare("SELECT name, dimension, weight, evidence_count, notes FROM personality_trait ORDER BY weight DESC").all();
      let lastReflection = null;
      try { lastReflection = tdb.prepare("SELECT * FROM daily_reflection ORDER BY reflection_date DESC LIMIT 1").get() || null; } catch {}
      const stats = {
        memory_rows: tdb.prepare("SELECT COUNT(*) c FROM memory").get().c,
        date_range: tdb.prepare("SELECT MIN(occurred_at) min, MAX(occurred_at) max FROM memory").get(),
      };
      return { values, traits, last_reflection: lastReflection, stats };
    }
    case "mem_session_brief": {
      return sessionBrief(tdb, a || {});
    }
    case "mem_runtime_health": {
      return runtimeHealth(tdb, a || {});
    }
    case "mem_agent_memory_health": {
      return memoryHealth(tdb, a || {});
    }
    case "mem_connect_register": {
      const agentName = normalizeAgentName(a.agent_name);
      tdb.prepare(
        "INSERT INTO agent_registry (agent_name, display_name, host, pid, skills_json, status, registered_at, last_seen_at, meta_json) " +
        "VALUES (?,?,?,?,?, 'online', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?) " +
        "ON CONFLICT(agent_name) DO UPDATE SET " +
        "display_name=excluded.display_name, host=excluded.host, pid=excluded.pid, " +
        "skills_json=excluded.skills_json, status='online', " +
        "last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=excluded.meta_json"
      ).run(
        agentName, a.display_name || a.agent_name, a.host || null, a.pid || null,
        JSON.stringify(a.skills || []), a.meta ? JSON.stringify(a.meta) : null
      );
      return { agent_name: agentName, status: "online" };
    }
    case "mem_connect_heartbeat": {
      const agentName = normalizeAgentName(a.agent_name);
      const meta = a.meta && typeof a.meta === "object" ? JSON.stringify(a.meta) : null;
      const r = tdb.prepare(
        "UPDATE agent_registry SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=COALESCE(?, status), meta_json=COALESCE(?, meta_json) WHERE agent_name=?"
      ).run(a.status || null, meta, agentName);
      return { agent_name: agentName, updated: r.changes > 0 };
    }
    case "mem_connect_list": {
      const marked_offline = briefCoordination.markStaleAgentsOffline(tdb, a.agent_stale_sec || 300);
      const auto_requeue = a.auto_requeue === false ? null : briefCoordination.requeueStaleDispatchedBriefs(tdb, {
        older_than_minutes: a.requeue_after_minutes || process.env.MNEMO_BRIEF_REQUEUE_MIN || 30,
        agent_stale_sec: a.agent_stale_sec || 300,
        limit: a.requeue_limit || 100
      });
      const where = a.only_online ? "WHERE status='online'" : "";
      const rows = tdb.prepare(
        "SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json " +
        "FROM agent_registry " + where + " ORDER BY last_seen_at DESC"
      ).all();
      return {
        count: rows.length,
        marked_offline,
        auto_requeue,
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
      const normalized = normalizeBriefContent(a.content, a.meta, { source_channel: a.channel || null, route: "channel_post" });
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
        const info = ins.run(s.agent_name, a.source_agent || null, normalized.content, a.channel,
                             normalized.meta ? JSON.stringify(normalized.meta) : null);
        ids.push(info.lastInsertRowid);
        try {
          captureBriefConversation(tdb, info.lastInsertRowid, s.agent_name, a.source_agent || null, normalized.content, a.channel, normalized.meta, {
            source: "channel_post",
            channel: a.channel || "channel",
            event_kind: "channel_post_brief",
            importance: 6
          });
        } catch {}
        try { fireBriefHook(tdb, info.lastInsertRowid, "channel_post", { agent_name: s.agent_name, channel: a.channel, source: a.source_agent || null }); } catch (e) {}
        try { ftsIndex(tdb, "brief", info.lastInsertRowid, s.agent_name, a.source_agent || "", normalized.content); } catch (e) {}
      }
      const channelState = (briefCoordination.channelListWithSubscribers(tdb, { active_window_sec: a.active_window_sec || 300 }).channels || []).find((row) => row.name === a.channel) || null;
      return { channel: a.channel, fanout: subs.length, brief_ids: ids, channel_state: channelState };
    }
    case "mem_connect_channel_list": {
      return briefCoordination.channelListWithSubscribers(tdb, a || {});
    }
    case "mem_brief_requeue_stale": {
      return briefCoordination.requeueStaleDispatchedBriefs(tdb, a || {});
    }
    case "mem_brief_drop": {
      const normalized = normalizeBriefContent(a.content, a.meta, { source_channel: a.channel || null });
      const _scrub = stripPrivate(normalized.content);
      const _content = _scrub.text;
      if (isTeamBriefTarget(a.agent_name)) {
        const targets = resolveTeamBriefTargets(tdb);
        if (!targets.length) return { error: "team_brief_no_targets", agent_name: a.agent_name };
        const baseMeta = normalized.meta;
        const meta = JSON.stringify({ ...baseMeta, _team_fanout: true, _team_target: a.agent_name });
        const ins = tdb.prepare(
          "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?,?)"
        );
        const txn = tdb.transaction((names) => names.map((name) => {
          const info = ins.run(name, a.source_agent || null, _content, String(a.agent_name || "team"), meta, a.parent_id || null, a.supersedes || null);
          return { id: info.lastInsertRowid, agent_name: name };
        }));
        const inserted = txn(targets);
        if (a.supersedes && inserted[0]) {
          try { tdb.prepare("UPDATE agent_brief SET superseded_by_id=?, status=CASE WHEN status='pending' THEN 'superseded' ELSE status END WHERE id=?").run(inserted[0].id, a.supersedes); } catch (e) {}
        }
        for (const row of inserted) {
          try {
            captureBriefConversation(tdb, row.id, row.agent_name, a.source_agent || null, _content, String(a.agent_name || "team"), baseMeta, {
              source: "brief",
              event_kind: "brief_drop",
              importance: 7
            });
          } catch {}
          try { fireBriefHook(tdb, row.id, "team_fanout", { agent_name: row.agent_name, team_target: a.agent_name }); } catch (e) {}
          try { ftsIndex(tdb, "brief", row.id, row.agent_name, a.source_agent || "", _content); } catch (e) {}
          try {
            const skMatches = matchSkillsForText(tdb, _content);
            if (skMatches.length) {
              const insR = tdb.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)");
              for (const m of skMatches) insR.run(row.id, "mnemo-skills-engine", "skill_suggested", JSON.stringify(m));
            }
          } catch (e) {}
        }
        return {
          agent_name: a.agent_name,
          status: "pending",
          fanout: inserted.length,
          brief_ids: inserted.map((row) => row.id),
          inserted,
          _routed: "team-fanout",
        };
      }
      const targetAgent = normalizeAgentName(a.agent_name);
      const info = tdb.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?,?)"
      ).run(targetAgent, a.source_agent || null, _content, a.channel || null, normalized.meta ? JSON.stringify(normalized.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      if (a.supersedes) {
        try { tdb.prepare("UPDATE agent_brief SET superseded_by_id=?, status=CASE WHEN status='pending' THEN 'superseded' ELSE status END WHERE id=?").run(newId, a.supersedes); } catch (e) {}
      }
      try {
        captureBriefConversation(tdb, newId, targetAgent, a.source_agent || null, _content, a.channel || null, normalized.meta, {
          source: "brief",
          event_kind: "brief_drop",
          importance: 7
        });
      } catch {}
      try { fireBriefHook(tdb, newId, "drop", { agent_name: targetAgent }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, targetAgent, a.source_agent || "", _content); } catch (e) {}
      try {
        const skMatches = matchSkillsForText(tdb, _content);
        if (skMatches.length) {
          const insR = tdb.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)");
          for (const m of skMatches) insR.run(newId, "mnemo-skills-engine", "skill_suggested", JSON.stringify(m));
        }
      } catch (e) {}
      return { id: newId, agent_name: targetAgent, status: "pending", supersedes: a.supersedes || null };
    }
    case "mem_brief_pull": {
      const targetAgent = normalizeAgentName(a.agent_name);
      const auto_requeue = a.auto_requeue === false ? null : briefCoordination.requeueStaleDispatchedBriefs(tdb, {
        older_than_minutes: a.requeue_after_minutes || process.env.MNEMO_BRIEF_REQUEUE_MIN || 30,
        agent_stale_sec: a.agent_stale_sec || 300,
        limit: a.requeue_limit || 100
      });
      const rows = tdb.prepare(
        "SELECT id, agent_name, source_agent, content, channel, created_at, meta_json FROM agent_brief " +
        "WHERE lower(agent_name)=lower(?) AND status='pending' ORDER BY CASE WHEN lower(COALESCE(meta_json,'')) LIKE '%mission-control-agent-console%' OR lower(COALESCE(meta_json,'')) LIKE '%mission_agent_console%' THEN 0 ELSE 1 END, created_at ASC LIMIT ?"
      ).all(targetAgent, Math.min(a.limit || 5, 50));
      if (!a.peek && rows.length) {
        const upd = tdb.prepare("UPDATE agent_brief SET status='dispatched', dispatched_at=? WHERE id=?");
        const now = new Date().toISOString();
        for (const r of rows) upd.run(now, r.id);
      }
      return { count: rows.length, briefs: rows, auto_requeue };
    }
    case "mem_brief_done": {
      const brief = tdb.prepare("SELECT id, agent_name, channel, meta_json FROM agent_brief WHERE id=?").get(a.id) || null;
      tdb.prepare("UPDATE agent_brief SET status=?, done_at=?, outcome=? WHERE id=?")
        .run(a.status, new Date().toISOString(), a.outcome || null, a.id);
      try {
        const meta = brief && brief.meta_json ? JSON.parse(brief.meta_json) : {};
        const outcomeText = (a.outcome && String(a.outcome).trim()) || `Brief #${a.id} marked ${a.status}.`;
        captureBriefConversation(tdb, a.id, brief && brief.agent_name || null, brief && brief.agent_name || null, outcomeText, brief && brief.channel || null, meta, {
          source: "brief",
          direction: "outbound",
          event_kind: "brief_done",
          importance: a.status === "failed" ? 8 : 6,
          meta: { brief_status: a.status }
        });
      } catch {}
      try { maybeSendTelegramBriefOutcome(tdb, brief, a.status, a.outcome || ""); } catch (e) {}
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
      const authority = a.requested_authority || DEFAULT_AGENT;
      const info = tdb.prepare("INSERT INTO escalation (source_agent, kind, urgency, summary, requested_authority) VALUES (?,?,?,?,?)").run(a.source_agent || null, a.kind, a.urgency || 'M', a.summary, authority);
      const id = info.lastInsertRowid;
      // Routing logic
      const route = (() => {
        if (a.kind === 'blocker' && a.urgency === 'H' && a.requested_authority === OWNER_NAME) return 'telegram_immediate';
        if (a.kind === 'customer' && a.urgency === 'H') return 'telegram_immediate';
        if (a.kind === 'decision') return 'brief_to_coordinator';
        if (a.urgency === 'L') return 'digest_only';
        return 'brief_to_coordinator';
      })();
      // Action based on routing
      try {
        if (route === 'brief_to_coordinator') {
          tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run(authority, a.source_agent || null, "[ESCALATION #" + id + "] " + a.kind + "/" + a.urgency + ": " + a.summary);
        } else if (route === 'telegram_immediate') {
          const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE || "";
          let token = "";
          if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile,"utf8").trim();
          const escalationChatId = process.env.MNEMO_ESCALATION_CHAT_ID || OWNER_CHAT_ID || "";
          if (token && escalationChatId) {
            const data = JSON.stringify({ chat_id: escalationChatId, text: "[ESCALATION " + a.urgency + "] " + a.kind + " from " + (a.source_agent || "?") + ": " + a.summary });
            const req = https.request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, r => r.resume());
            req.on("error", (e) => { console.error("[escalation-telegram]", e.message); }); req.write(data); req.end();
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
    case "mem_consult_agent": {
      if (!a.requesting_agent || !a.question) return { error: "requesting_agent + question required" };
      const info = tdb.prepare("INSERT INTO agent_consult (requesting_agent, problem_id, question, context_files) VALUES (?,?,?,?)").run(a.requesting_agent, a.problem_id || null, a.question, a.context_files ? JSON.stringify(a.context_files) : null);
      return { id: info.lastInsertRowid, requesting_agent: a.requesting_agent, status: "pending" };
    }
    case "mem_consult_agent_pending": {
      const lim = Math.min(a.limit || 20, 100);
      const rows = tdb.prepare("SELECT id, requesting_agent, problem_id, question, context_files, status, created_at FROM agent_consult WHERE status='pending' ORDER BY created_at ASC LIMIT ?").all(lim);
      for (const r of rows) { if (r.context_files) { try { r.context_files = JSON.parse(r.context_files); } catch (e) {} } }
      return { count: rows.length, consults: rows };
    }
    case "mem_consult_agent_answer": {
      if (!a.id || !a.proposed_solution) return { error: "id + proposed_solution required" };
      tdb.prepare("UPDATE agent_consult SET proposed_solution=?, status='answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.proposed_solution, a.id);
      return { ok: true, id: a.id, status: "answered" };
    }
    case "mem_consult_agent_status": {
      if (!a.id) return { error: "id required" };
      const row = tdb.prepare("SELECT id, requesting_agent, problem_id, question, context_files, proposed_solution, used_in_attempt_id, status, created_at, answered_at FROM agent_consult WHERE id=?").get(a.id);
      if (!row) return { error: "not_found", id: a.id };
      if (row.context_files) { try { row.context_files = JSON.parse(row.context_files); } catch (e) {} }
      return row;
    }
    case "mem_consult_agent_use": {
      if (!a.id) return { error: "id required" };
      tdb.prepare("UPDATE agent_consult SET used_in_attempt_id=?, status='used' WHERE id=?").run(a.attempt_id || null, a.id);
      return { ok: true, id: a.id, status: "used" };
    }
    case "mem_capture_ingest": {
      return captureIngest(tdb, a || {});
    }
    case "mem_capture_ingest_batch": {
      const items = Array.isArray(a.items) ? a.items.slice(0, Math.min(a.limit || 500, 1000)) : [];
      if (!items.length) return { error: "items[] required" };
      const out = { count: items.length, captured: 0, duplicate: 0, errors: 0, results: [] };
      for (const item of items) {
        try {
          const r = captureIngest(tdb, item || {});
          if (r && r.duplicate) out.duplicate++;
          else if (r && r.ok) out.captured++;
          else out.errors++;
          if (out.results.length < 50) out.results.push(r);
        } catch (e) {
          out.errors++;
          if (out.results.length < 50) out.results.push({ ok: false, error: String(e.message || e) });
        }
      }
      return out;
    }
    case "mem_capture_recent": {
      const lim = Math.min(a.limit || 50, 500);
      const where = [];
      const params = [];
      if (a.source) { where.push("source=?"); params.push(a.source); }
      if (a.channel) { where.push("channel=?"); params.push(a.channel); }
      if (a.actor) { where.push("actor=?"); params.push(a.actor); }
      if (a.ref_kind) { where.push("ref_kind=?"); params.push(a.ref_kind); }
      if (a.ref_id) { where.push("ref_id=?"); params.push(String(a.ref_id)); }
      if (a.thread_id) { where.push("thread_id=?"); params.push(String(a.thread_id)); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.since) { where.push("occurred_at>=?"); params.push(String(a.since)); }
      params.push(lim);
      const rows = tdb.prepare("SELECT dedupe_key, source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, occurred_at, substr(content_preview,1,300) AS content_preview, event_id, transcript_id, memory_id, status, seen_count, last_seen_at FROM capture_receipt" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC, last_seen_at DESC LIMIT ?").all(...params);
      return { count: rows.length, receipts: rows };
    }
    case "mem_media_capture": {
      if (!a.media_path && !a.file_path && !a.file_name) return { ok: false, error: "media_path, file_path, or file_name required" };
      return captureIngest(tdb, Object.assign({
        source: "manual",
        channel: "chat",
        event_kind: a.media_kind === "document" ? "document_capture" : "screenshot_capture",
        promote_memory: true,
        remember: true
      }, a, {
        media_path: a.media_path || a.file_path,
        content: a.content || a.text || a.notes || ""
      }));
    }
    case "mem_media_recent": {
      ensureMediaAssetRuntimeSchema(tdb);
      const where = [];
      const params = [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.media_kind) { where.push("media_kind=?"); params.push(a.media_kind); }
      if (a.media_type) { where.push("media_type=?"); params.push(a.media_type); }
      if (a.actor) { where.push("actor=?"); params.push(a.actor); }
      if (a.channel) { where.push("channel=?"); params.push(a.channel); }
      if (a.thread_id) { where.push("thread_id=?"); params.push(String(a.thread_id)); }
      params.push(Math.min(a.limit || 50, 500));
      const rows = tdb.prepare("SELECT id, title, media_kind, media_type, project, route, page_url, file_name, original_file_name, canonical_name, media_path, storage_path, content_ref, labels_json, actor, channel, thread_id, occurred_at, status FROM media_asset" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, media: rows.map(r => Object.assign({}, r, { labels: parseMaybeJson(r.labels_json, []) })) };
    }
    case "mem_media_search": {
      ensureMediaAssetRuntimeSchema(tdb);
      if (!a.query) return { error: "query required" };
      const q = "%" + String(a.query || "").trim() + "%";
      const where = ["(title LIKE ? OR file_name LIKE ? OR original_file_name LIKE ? OR canonical_name LIKE ? OR media_path LIKE ? OR storage_path LIKE ? OR content_ref LIKE ? OR page_url LIKE ? OR route LIKE ? OR labels_json LIKE ? OR notes LIKE ?)"];
      const params = [q, q, q, q, q, q, q, q, q, q, q];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.media_kind) { where.push("media_kind=?"); params.push(a.media_kind); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare("SELECT id, title, media_kind, media_type, project, route, page_url, file_name, original_file_name, canonical_name, media_path, storage_path, content_ref, labels_json, actor, channel, occurred_at, status FROM media_asset WHERE " + where.join(" AND ") + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, media: rows.map(r => Object.assign({}, r, { labels: parseMaybeJson(r.labels_json, []) })) };
    }
    case "mem_media_get": {
      ensureMediaAssetRuntimeSchema(tdb);
      const row = a.id
        ? tdb.prepare("SELECT * FROM media_asset WHERE id=?").get(a.id)
        : (a.dedupe_key ? tdb.prepare("SELECT * FROM media_asset WHERE dedupe_key=?").get(String(a.dedupe_key)) : null);
      if (!row) return { error: "not found" };
      row.labels = parseMaybeJson(row.labels_json, []);
      row.meta = parseMaybeJson(row.meta_json, {});
      delete row.labels_json;
      delete row.meta_json;
      return row;
    }
    case "mem_reminder_add": {
      if (!a.title && !a.text && !a.details) return { error: "title, text, or details required" };
      if (!a.due_at) return { error: "due_at required for mem_reminder_add; use mem_reminder_capture for natural language" };
      const dueAt = isoOrNull(a.due_at);
      if (!dueAt) return { error: "due_at must be ISO-like date/time" };
      return insertReminder(tdb, Object.assign({}, a, { due_at: dueAt }));
    }
    case "mem_reminder_capture": {
      if (!a.text && !a.title && !a.details) return { error: "text required" };
      return insertReminder(tdb, a || {});
    }
    case "mem_reminder_list": {
      ensureReminderTables(tdb);
      const lim = Math.min(a.limit || 50, 500);
      const { where, params } = reminderWhere(a || {});
      params.push(lim);
      const rows = tdb.prepare("SELECT * FROM reminder WHERE " + where.join(" AND ") + " ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT ?").all(...params);
      return { count: rows.length, reminders: rows.map(reminderRow) };
    }
    case "mem_reminder_due": {
      ensureReminderTables(tdb);
      const before = isoOrNull(a.before || a.due_before) || now();
      const lim = Math.min(a.limit || 50, 500);
      const params = [before];
      let where = "status='open' AND due_at IS NOT NULL AND due_at<=?";
      if (a.owner_name) { where += " AND owner_name=?"; params.push(String(a.owner_name)); }
      if (a.agent_name) { where += " AND (agent_name=? OR agent_name IS NULL)"; params.push(String(a.agent_name)); }
      params.push(lim);
      const rows = tdb.prepare("SELECT * FROM reminder WHERE " + where + " ORDER BY due_at ASC, id ASC LIMIT ?").all(...params);
      if (a.mark_notified && rows.length) {
        const ids = rows.map(r => r.id);
        const placeholders = ids.map(() => "?").join(",");
        tdb.prepare("UPDATE reminder SET notified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), notify_count=notify_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (" + placeholders + ")").run(...ids);
      }
      return { count: rows.length, before, reminders: rows.map(reminderRow) };
    }
    case "mem_reminder_done": {
      ensureReminderTables(tdb);
      if (!a.id) return { error: "id required" };
      const info = tdb.prepare("UPDATE reminder SET status='done', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=COALESCE(?, meta_json) WHERE id=?").run(a.meta ? JSON.stringify(a.meta) : null, a.id);
      return { ok: info.changes > 0, id: a.id, status: "done" };
    }
    case "mem_reminder_snooze": {
      ensureReminderTables(tdb);
      if (!a.id || !a.until) return { error: "id + until required" };
      const dueAt = isoOrNull(a.until);
      if (!dueAt) return { error: "until must be ISO-like date/time" };
      const info = tdb.prepare("UPDATE reminder SET due_at=?, status='open', notified_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(dueAt, a.id);
      return { ok: info.changes > 0, id: a.id, due_at: dueAt, status: "open" };
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
      try {
        mirrorTranscriptCapture(tdb, a, info.lastInsertRowid, _tcontent, _tscrub.hadPrivate);
      } catch {}
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
      if (a.ref_kind) { filters.push("ref_kind = ?"); params.push(a.ref_kind); }
      if (a.ref_id) { filters.push("ref_id = ?"); params.push(String(a.ref_id)); }
      if (a.since) { filters.push("occurred_at >= ?"); params.push(String(a.since)); }
      const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
      params.push(lim);
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript " + where + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, transcripts: rows };
    }
    case "mem_event_log": {
      if (!a.event_kind) return { error: "event_kind required" };
      const result = journalEvent(tdb, {
        source: a.source || "manual",
        channel: a.channel || null,
        direction: a.direction || "internal",
        actor: a.actor || a.agent_name || null,
        actor_id: a.actor_id || null,
        event_kind: a.event_kind,
        ref_kind: a.ref_kind || null,
        ref_id: a.ref_id || null,
        thread_id: a.thread_id || a.session_id || null,
        status: a.status || null,
        content: a.content || a.text || null,
        payload: a.payload || null,
        meta: a.meta || null,
        occurred_at: a.occurred_at || null
      });
      return result ? { ok: true, id: result.id } : { ok: false, error: "journal_insert_failed" };
    }
    case "mem_event_recent": {
      const lim = Math.min(a.limit || 50, 500);
      const where = [];
      const params = [];
      if (a.source) { where.push("source=?"); params.push(a.source); }
      if (a.channel) { where.push("channel=?"); params.push(a.channel); }
      if (a.actor) { where.push("actor=?"); params.push(a.actor); }
      if (a.event_kind) { where.push("event_kind=?"); params.push(a.event_kind); }
      if (a.ref_kind) { where.push("ref_kind=?"); params.push(a.ref_kind); }
      if (a.ref_id) { where.push("ref_id=?"); params.push(String(a.ref_id)); }
      if (a.thread_id) { where.push("thread_id=?"); params.push(String(a.thread_id)); }
      if (a.since) { where.push("occurred_at>=?"); params.push(String(a.since)); }
      params.push(lim);
      const sql = "SELECT id, source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, status, substr(content,1,500) AS content_preview, occurred_at FROM mnemo_event_journal" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC, id DESC LIMIT ?";
      const rows = tdb.prepare(sql).all(...params);
      return { count: rows.length, events: rows };
    }
    case "mem_source_coverage": {
      const since = a.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = tdb.prepare(
        "SELECT source, COALESCE(channel,'') AS channel, COUNT(*) AS events, MAX(occurred_at) AS last_event_at, " +
        "SUM(CASE WHEN status IN ('error','exception','failed') THEN 1 ELSE 0 END) AS errors " +
        "FROM mnemo_event_journal WHERE occurred_at >= ? GROUP BY source, COALESCE(channel,'') ORDER BY last_event_at DESC"
      ).all(since);
      const captures = tdb.prepare(
        "SELECT source, COALESCE(channel,'') AS channel, COUNT(*) AS receipts, MAX(occurred_at) AS last_capture_at, " +
        "SUM(CASE WHEN status='duplicate' THEN 1 ELSE 0 END) AS duplicates " +
        "FROM capture_receipt WHERE occurred_at >= ? GROUP BY source, COALESCE(channel,'') ORDER BY last_capture_at DESC"
      ).all(since);
      const writers = tdb.prepare("SELECT writer, status, last_write_at, last_check_at, rows_written FROM writer_health ORDER BY writer").all();
      return { since, sources: rows, captures, writers };
    }
    case "mem_access_upsert": {
      if (!a.system_name || !a.access_kind) return { error: "system_name + access_kind required" };
      const scope = scopeName(a.scope);
      const entrypoint = a.entrypoint || "";
      const allowed = Array.isArray(a.allowed_agents) ? JSON.stringify(a.allowed_agents) : (a.allowed_agents || null);
      const existing = tdb.prepare("SELECT id FROM access_inventory WHERE scope=? AND system_name=? AND access_kind=? AND COALESCE(entrypoint,'')=?").get(scope, a.system_name, a.access_kind, entrypoint);
      let id;
      if (existing) {
        id = existing.id;
        tdb.prepare(
          "UPDATE access_inventory SET project=?, entrypoint=?, account_hint=?, secret_ref=?, allowed_agents=?, status=?, last_verified_at=COALESCE(?, last_verified_at), verification_method=COALESCE(?, verification_method), notes=COALESCE(?, notes), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
        ).run(a.project || null, entrypoint, a.account_hint || null, a.secret_ref || null, allowed, a.status || "active", a.last_verified_at || null, a.verification_method || null, a.notes || null, a.updated_by || a.agent_name || DEFAULT_AGENT, id);
      } else {
        const info = tdb.prepare(
          "INSERT INTO access_inventory (scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(scope, a.project || null, a.system_name, a.access_kind, entrypoint, a.account_hint || null, a.secret_ref || null, allowed, a.status || "active", a.last_verified_at || null, a.verification_method || null, a.notes || null, a.updated_by || a.agent_name || DEFAULT_AGENT);
        id = info.lastInsertRowid;
      }
      tdb.prepare("INSERT INTO access_event (access_id, event_kind, actor, status, notes, meta_json) VALUES (?,?,?,?,?,?)").run(id, existing ? "updated" : "created", a.updated_by || a.agent_name || DEFAULT_AGENT, a.status || "active", a.notes || null, a.meta ? JSON.stringify(a.meta) : null);
      return { ok: true, id, status: existing ? "updated" : "created", secret_stored: false, secret_ref: a.secret_ref || null };
    }
    case "mem_access_list": {
      const where = [];
      const params = [];
      if (a.scope) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(scopeName(a.scope)); }
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name LIKE ?"); params.push("%" + a.system_name + "%"); }
      if (a.access_kind) { where.push("access_kind=?"); params.push(a.access_kind); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare(
        "SELECT id, scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at FROM access_inventory" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY COALESCE(last_verified_at, updated_at) DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, access: rows };
    }
    case "mem_access_guide": {
      const where = [];
      const params = [];
      const sc = a.scope ? scopeName(a.scope) : null;
      if (sc) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(sc); }
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name LIKE ?"); params.push("%" + a.system_name + "%"); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 300));
      const rows = tdb.prepare(
        "SELECT id, scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at " +
        "FROM access_inventory" + (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY COALESCE(project,''), system_name, access_kind, COALESCE(last_verified_at, updated_at) DESC LIMIT ?"
      ).all(...params);
      const projectNames = Array.from(new Set(rows.map((row) => row.project).filter(Boolean)));
      const registry = {};
      if (a.project) {
        const row = tdb.prepare("SELECT name, domain, repo, server, pm2_processes, nginx_files, admin_url, auth_system, live_status, live_url, staging_url, updated_at, updated_by FROM project_registry WHERE name=?").get(a.project);
        if (row) {
          for (const key of ["pm2_processes", "nginx_files"]) {
            try { row[key] = row[key] ? JSON.parse(row[key]) : []; } catch { row[key] = []; }
          }
          registry[a.project] = row;
        }
      } else if (projectNames.length) {
        const placeholders = projectNames.map(() => "?").join(",");
        const regRows = tdb.prepare(
          "SELECT name, domain, repo, server, pm2_processes, nginx_files, admin_url, auth_system, live_status, live_url, staging_url, updated_at, updated_by FROM project_registry WHERE name IN (" + placeholders + ")"
        ).all(...projectNames);
        for (const row of regRows) {
          for (const key of ["pm2_processes", "nginx_files"]) {
            try { row[key] = row[key] ? JSON.parse(row[key]) : []; } catch { row[key] = []; }
          }
          registry[row.name] = row;
        }
      }
      const grouped = new Map();
      for (const row of rows) {
        const allowedAgents = (() => {
          try { return row.allowed_agents ? JSON.parse(row.allowed_agents) : []; } catch { return row.allowed_agents ? [row.allowed_agents] : []; }
        })();
        const key = `${row.project || "_"}::${row.system_name}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            project: row.project || null,
            system_name: row.system_name,
            status: row.status,
            last_verified_at: row.last_verified_at || null,
            notes: row.notes || null,
            routes: [],
          });
        }
        grouped.get(key).routes.push({
          access_id: row.id,
          access_kind: row.access_kind,
          entrypoint: row.entrypoint,
          account_hint: row.account_hint,
          secret_ref: row.secret_ref,
          allowed_agents: allowedAgents,
          status: row.status,
          last_verified_at: row.last_verified_at || null,
          verification_method: row.verification_method || null,
          notes: row.notes || null,
          updated_by: row.updated_by,
          updated_at: row.updated_at,
        });
      }
      const systems = Array.from(grouped.values());
      const lines = [];
      lines.push("# Access Guide");
      if (a.project) lines.push(`Project: ${a.project}`);
      if (a.system_name) lines.push(`System search: ${a.system_name}`);
      if (a.status) lines.push(`Status filter: ${a.status}`);
      lines.push("");
      if (a.project && registry[a.project]) {
        const reg = registry[a.project];
        lines.push("## Project Registry");
        if (reg.domain) lines.push(`- Domain: ${reg.domain}`);
        if (reg.live_url) lines.push(`- Live URL: ${reg.live_url}`);
        if (reg.staging_url) lines.push(`- Staging URL: ${reg.staging_url}`);
        if (reg.repo) lines.push(`- Repo: ${reg.repo}`);
        if (reg.server) lines.push(`- Server: ${reg.server}`);
        if (reg.admin_url) lines.push(`- Admin URL: ${reg.admin_url}`);
        if (reg.auth_system) lines.push(`- Auth system: ${reg.auth_system}`);
        if (Array.isArray(reg.pm2_processes) && reg.pm2_processes.length) lines.push(`- PM2: ${reg.pm2_processes.join(", ")}`);
        if (Array.isArray(reg.nginx_files) && reg.nginx_files.length) lines.push(`- Nginx: ${reg.nginx_files.join(", ")}`);
        lines.push("");
      }
      for (const system of systems) {
        lines.push(`## ${system.system_name}`);
        if (system.project) lines.push(`- Project: ${system.project}`);
        if (system.status) lines.push(`- Status: ${system.status}`);
        if (system.last_verified_at) lines.push(`- Last verified: ${system.last_verified_at}`);
        if (system.notes) lines.push(`- Notes: ${system.notes}`);
        for (const route of system.routes) {
          const parts = [
            route.access_kind,
            route.entrypoint ? `entrypoint=${route.entrypoint}` : null,
            route.account_hint ? `account=${route.account_hint}` : null,
            route.secret_ref ? `secret_ref=${route.secret_ref}` : null,
            route.verification_method ? `verify=${route.verification_method}` : null,
            route.allowed_agents && route.allowed_agents.length ? `agents=${route.allowed_agents.join(",")}` : null,
          ].filter(Boolean);
          lines.push(`- ${parts.join(" | ")}`);
        }
        lines.push("");
      }
      if (systems.length === 0) lines.push("_No access routes found. Add them with mem_access_upsert._");
      return { count: rows.length, systems, registry, guide_markdown: lines.join("\n") };
    }
    case "mem_access_event_log": {
      if (!a.access_id && !(a.system_name && a.access_kind)) return { error: "access_id or system_name + access_kind required" };
      let id = a.access_id || null;
      if (!id) {
        const row = tdb.prepare("SELECT id FROM access_inventory WHERE system_name=? AND access_kind=? ORDER BY updated_at DESC LIMIT 1").get(a.system_name, a.access_kind);
        if (!row) return { error: "access_not_found" };
        id = row.id;
      }
      tdb.prepare("INSERT INTO access_event (access_id, event_kind, actor, status, notes, meta_json) VALUES (?,?,?,?,?,?)").run(id, a.event_kind || "note", a.actor || a.agent_name || DEFAULT_AGENT, a.status || null, a.notes || null, a.meta ? JSON.stringify(a.meta) : null);
      if (a.event_kind === "verified") {
        tdb.prepare("UPDATE access_inventory SET last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), verification_method=COALESCE(?, verification_method), status=COALESCE(?, status), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.verification_method || null, a.status || "active", a.actor || a.agent_name || DEFAULT_AGENT, id);
      }
      return { ok: true, access_id: id };
    }
    case "mem_entity_upsert": {
      if (!a.kind || !a.name) return { error: "kind + name required" };
      const sc = scopeName(a.scope);
      const st = a.status || "active";
      const meta_json = a.meta ? JSON.stringify(a.meta) : null;
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS entity (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'default', owner_agent TEXT, status TEXT NOT NULL DEFAULT 'active', parent_id INTEGER, url TEXT, meta_json TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(kind, name, scope)); CREATE INDEX IF NOT EXISTS idx_entity_kind_status ON entity(kind, status); CREATE INDEX IF NOT EXISTS idx_entity_owner ON entity(owner_agent);`); } catch {}
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
      else if (a.kind && a.name) row = tdb.prepare("SELECT * FROM entity WHERE kind=? AND name=? AND scope=?").get(a.kind, a.name, scopeName(a.scope));
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
      try { tdb.exec(`CREATE TABLE IF NOT EXISTS decision_log (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'default', title TEXT NOT NULL, body TEXT, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), agents_involved TEXT, files_affected TEXT, entities_affected TEXT, parent_decision_id INTEGER, status TEXT NOT NULL DEFAULT 'active', superseded_by INTEGER, meta_json TEXT); CREATE INDEX IF NOT EXISTS idx_decision_decided_at ON decision_log(decided_at);`); } catch {}
      const info = tdb.prepare("INSERT INTO decision_log (scope, title, body, decided_by, agents_involved, files_affected, entities_affected, parent_decision_id, meta_json) VALUES (?,?,?,?,?,?,?,?,?)").run(scopeName(a.scope), a.title, a.body || null, a.decided_by, a.agents_involved ? JSON.stringify(a.agents_involved) : null, a.files_affected ? JSON.stringify(a.files_affected) : null, a.entities_affected ? JSON.stringify(a.entities_affected) : null, a.parent_decision_id || null, a.meta ? JSON.stringify(a.meta) : null);
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
      const agentName = normalizeAgentName(a.agent_name);
      const now = new Date().toISOString();
      const existing = tdb.prepare("SELECT agent_name FROM agent_status_live WHERE agent_name=?").get(agentName);
      if (existing) {
        tdb.prepare("UPDATE agent_status_live SET current_task=?, current_brief_id=COALESCE(?, current_brief_id), blocked_on=?, dnd_until=COALESCE(?, dnd_until), host=COALESCE(?, host), pid=COALESCE(?, pid), meta_json=COALESCE(?, meta_json), last_heartbeat_at=? WHERE agent_name=?").run(a.current_task === undefined ? null : a.current_task, a.current_brief_id || null, a.blocked_on || null, a.dnd_until || null, a.host || null, a.pid || null, a.meta ? JSON.stringify(a.meta) : null, now, agentName);
        return { agent_name: agentName, action: "updated", last_heartbeat_at: now };
      }
      tdb.prepare("INSERT INTO agent_status_live (agent_name, current_task, current_brief_id, blocked_on, dnd_until, host, pid, meta_json, last_heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?)").run(agentName, a.current_task || null, a.current_brief_id || null, a.blocked_on || null, a.dnd_until || null, a.host || null, a.pid || null, a.meta ? JSON.stringify(a.meta) : null, now);
      return { agent_name: agentName, action: "created", last_heartbeat_at: now };
    }
    case "mem_agent_status_get": {
      if (a.agent_name) {
        const agentName = normalizeAgentName(a.agent_name);
        const row = tdb.prepare("SELECT * FROM agent_status_live WHERE agent_name=?").get(agentName);
        if (!row) return { error: "not found", agent_name: agentName };
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
      const sc = scopeName(a.scope);
      const factsPath = factsPathFor(sc);
      if (!fs.existsSync(factsPath)) return { error: "no facts file for scope: " + sc, hint: "create a private facts file at " + factsPath + " or set MNEMO_FACTS_DIR" };
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
      const sc = scopeName(a.scope);
      const factsDir = FACTS_DIR;
      try { fs.mkdirSync(factsDir, { recursive: true }); } catch {}
      const factsPath = factsPathFor(sc);
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
      const sc = scopeName(a.scope);
      const factsPath = factsPathFor(sc);
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
      ensureProjectRegistryTable(tdb);
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
      ensureProjectRegistryTable(tdb);
      const row = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(a.name);
      if (!row) return { error: "not found", name: a.name };
      for (const k of ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"]) {
        if (row[k]) try { row[k] = JSON.parse(row[k]); } catch {}
      }
      return row;
    }
    case "mem_project_registry_list": {
      ensureProjectRegistryTable(tdb);
      const where = []; const params = [];
      if (a.live_status) { where.push("live_status=?"); params.push(a.live_status); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = tdb.prepare("SELECT name, domain, server, live_status, live_url, vat_status, updated_at FROM project_registry" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY updated_at DESC LIMIT ?").all(...params);
      if (rows.length) return { count: rows.length, projects: rows };
      const candidates = [];
      try {
        for (const r of tdb.prepare("SELECT project AS name, updated_at FROM project_rules ORDER BY updated_at DESC LIMIT ?").all(Math.min(a.limit || 50, 200))) {
          if (r && r.name) candidates.push({ name: r.name, source: "project_rules", updated_at: r.updated_at || null });
        }
      } catch {}
      try {
        for (const r of tdb.prepare("SELECT name, owner_agent, status, last_active_at FROM agent_project ORDER BY last_active_at DESC LIMIT ?").all(Math.min(a.limit || 50, 200))) {
          if (r && r.name && !candidates.some((c) => c.name === r.name)) candidates.push({ name: r.name, source: "agent_project", owner_agent: r.owner_agent || null, status: r.status || null, updated_at: r.last_active_at || null });
        }
      } catch {}
      try {
        const seed = loadProjectRuleDefaults("blun");
        for (const p of seed.projects || []) {
          if (p && p.name && !candidates.some((c) => c.name === p.name)) candidates.push({ name: p.name, source: "facts/blun-project-rules.json" });
        }
      } catch {}
      return {
        count: 0,
        projects: [],
        candidates_count: candidates.length,
        candidates,
        hint: candidates.length
          ? "No structured project_registry rows matched, but project candidates exist in rules/facts. Upsert them with mem_project_registry_upsert so live URLs, repos, servers and gates are queryable."
          : "No structured project_registry rows matched."
      };
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
      // Resolve focus_modes from the private facts file so caller gets the slice config inline.
      let slice = null;
      try {
        const factsPath = factsPathFor();
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
      ensureProjectRegistryTable(tdb);
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
      ensureProjectRegistryTable(tdb);
      const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(a.name);
      const apr = (() => { try { return tdb.prepare("SELECT name, owner_agent, goal_text, status, current_milestone, blocker, last_active_at FROM agent_project WHERE name=?").get(a.name); } catch { return null; } })();
      let factsTeam = null, factsLegal = null;
      try {
        const factsPath = factsPathFor();
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
      lines.push("> Auto-rendered by mem_project_doc_render. Source-of-truth lives in mnemo (project_registry + private facts + recent decisions). Edit facts, not this file.");
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
        lines.push("## Legal (from private facts)");
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
      ensureProjectRegistryTable(tdb);
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
    case "mem_department_seed_defaults": {
      ensureAutonomyTables(tdb);
      const departments = defaultDepartments(a.agent_map || {});
      if (a.dry_run) return { ok: true, dry_run: true, departments };
      const depStmt = tdb.prepare("INSERT INTO department (name, mission, lead_agent, review_agent, skills_json, responsibilities_json, required_gates_json, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET mission=excluded.mission, lead_agent=excluded.lead_agent, review_agent=excluded.review_agent, skills_json=excluded.skills_json, responsibilities_json=excluded.responsibilities_json, required_gates_json=excluded.required_gates_json, status='active', updated_by=excluded.updated_by, updated_at=excluded.updated_at");
      const memStmt = tdb.prepare("INSERT INTO department_member (department_name, agent_name, role, skills_json, updated_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(department_name, agent_name) DO UPDATE SET role=excluded.role, skills_json=excluded.skills_json, status='active', updated_at=excluded.updated_at");
      for (const d of departments) {
        depStmt.run(d.name, d.mission, d.lead_agent || null, d.review_agent || null, JSON.stringify(d.skills || []), JSON.stringify(d.responsibilities || []), JSON.stringify(d.required_gates || []), a.updated_by || DEFAULT_AGENT);
        if (d.lead_agent) memStmt.run(d.name, d.lead_agent, "lead", JSON.stringify(d.skills || []));
        if (d.review_agent && d.review_agent !== d.lead_agent) memStmt.run(d.name, d.review_agent, "reviewer", JSON.stringify(["review"]));
      }
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'department_seed_defaults', 'departments', 'done', ?, 'autonomy')").run(a.updated_by || DEFAULT_AGENT, JSON.stringify({ count: departments.length })); } catch {}
      return { ok: true, count: departments.length, departments: departments.map(d => ({ name: d.name, lead_agent: d.lead_agent, review_agent: d.review_agent })) };
    }
    case "mem_department_list": {
      ensureAutonomyTables(tdb);
      const rows = tdb.prepare("SELECT * FROM department WHERE status='active' ORDER BY name").all();
      for (const r of rows) {
        r.skills = parseMaybeJson(r.skills_json, []);
        r.responsibilities = parseMaybeJson(r.responsibilities_json, []);
        r.required_gates = parseMaybeJson(r.required_gates_json, []);
        delete r.skills_json; delete r.responsibilities_json; delete r.required_gates_json;
        if (a.include_members) r.members = tdb.prepare("SELECT agent_name, role, skills_json, status FROM department_member WHERE department_name=? AND status='active' ORDER BY role, agent_name").all(r.name).map(m => Object.assign({}, m, { skills: parseMaybeJson(m.skills_json, []) }));
      }
      return { count: rows.length, departments: rows };
    }
    case "mem_team_operating_model": {
      return buildTeamOperatingModel(tdb, a.agent_name || null);
    }
    case "mem_connector_upsert": {
      if (!a.system_name) return { error: "system_name required" };
      ensureUniversalJournalSchema(tdb);
      const scope = scopeName(a.scope);
      const allowedAgents = normalizeStringList(a.allowed_agents);
      tdb.prepare(
        "INSERT INTO connector_registry (scope, project, system_name, owner_agent, auth_type, secret_ref, rate_limit, allowed_agents_json, read_enabled, write_enabled, live_write_enabled, lifecycle_status, approval_class, endpoint, health_status, health_summary, last_health_at, last_verified_at, runbook_json, dependency_json, rollback_json, notes, meta_json, updated_by, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
        "ON CONFLICT(scope, system_name) DO UPDATE SET project=excluded.project, owner_agent=excluded.owner_agent, auth_type=excluded.auth_type, secret_ref=excluded.secret_ref, rate_limit=excluded.rate_limit, allowed_agents_json=excluded.allowed_agents_json, read_enabled=excluded.read_enabled, write_enabled=excluded.write_enabled, live_write_enabled=excluded.live_write_enabled, lifecycle_status=excluded.lifecycle_status, approval_class=excluded.approval_class, endpoint=excluded.endpoint, health_status=excluded.health_status, health_summary=excluded.health_summary, last_health_at=COALESCE(excluded.last_health_at, connector_registry.last_health_at), last_verified_at=COALESCE(excluded.last_verified_at, connector_registry.last_verified_at), runbook_json=excluded.runbook_json, dependency_json=excluded.dependency_json, rollback_json=excluded.rollback_json, notes=excluded.notes, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
      ).run(
        scope,
        a.project || null,
        a.system_name,
        a.owner_agent || null,
        a.auth_type || null,
        a.secret_ref || null,
        a.rate_limit || null,
        JSON.stringify(allowedAgents),
        boolFlag(a.read_enabled, true) ? 1 : 0,
        boolFlag(a.write_enabled, false) ? 1 : 0,
        boolFlag(a.live_write_enabled, false) ? 1 : 0,
        a.lifecycle_status || "planned",
        a.approval_class || "normal_fix",
        a.endpoint || null,
        a.health_status || "unknown",
        a.health_summary || null,
        a.last_health_at || null,
        a.last_verified_at || null,
        JSON.stringify(a.runbook || {}),
        JSON.stringify(a.dependencies || []),
        JSON.stringify(a.rollback || {}),
        a.notes || null,
        JSON.stringify(a.meta || {}),
        a.updated_by || DEFAULT_AGENT
      );
      if (a.mirror_access || a.access_kind || a.entrypoint) {
        const entrypoint = a.entrypoint || a.endpoint || "";
        const existing = tdb.prepare("SELECT id FROM access_inventory WHERE scope=? AND system_name=? AND access_kind=? AND COALESCE(entrypoint,'')=?").get(scope, a.system_name, a.access_kind || "connector", entrypoint);
        if (existing) {
          tdb.prepare("UPDATE access_inventory SET project=?, entrypoint=?, account_hint=?, secret_ref=?, allowed_agents=?, status=?, last_verified_at=COALESCE(?, last_verified_at), verification_method='connector_registry', notes=COALESCE(?, notes), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .run(a.project || null, entrypoint || null, a.account_hint || null, a.secret_ref || null, allowedAgents.join(","), a.lifecycle_status === "deprecated" ? "deprecated" : "active", a.last_verified_at || null, a.notes || null, a.updated_by || DEFAULT_AGENT, existing.id);
        } else {
          tdb.prepare("INSERT INTO access_inventory (scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(scope, a.project || null, a.system_name, a.access_kind || "connector", entrypoint || null, a.account_hint || null, a.secret_ref || null, allowedAgents.join(","), a.lifecycle_status === "deprecated" ? "deprecated" : "active", a.last_verified_at || null, "connector_registry", a.notes || null, a.updated_by || DEFAULT_AGENT);
        }
      }
      return { ok: true, connector: connectorListData(tdb, { scope, system_name: a.system_name, include_derived: false })[0] || null };
    }
    case "mem_connector_list": {
      const connectors = connectorListData(tdb, a || {});
      return {
        ok: true,
        count: connectors.length,
        summary: {
          explicit: connectors.filter((connector) => connector.source_kind === "explicit").length,
          derived: connectors.filter((connector) => connector.source_kind !== "explicit").length,
          stale: connectors.filter((connector) => ["stale", "critical"].includes(connector.freshness_status)).length,
        },
        connectors,
      };
    }
    case "mem_agent_pass_set": {
      if (!a.agent_name) return { error: "agent_name required" };
      ensureUniversalJournalSchema(tdb);
      const agentName = normalizeAgentName(a.agent_name);
      const current = deriveAgentPassport(tdb, agentName);
      const capabilityMatrix = Object.assign({}, current.capability_matrix || {}, a.capability_matrix || {});
      tdb.prepare(
        "INSERT INTO agent_passport (agent_name, display_name, department_name, lane, allowed_projects_json, allowed_systems_json, allowed_environments_json, capability_matrix_json, live_write, review_required, needs_handoff, can_deploy, can_touch_auth, can_touch_billing, can_manage_production, approval_class, source_kind, status, meta_json, updated_by, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
        "ON CONFLICT(agent_name) DO UPDATE SET display_name=excluded.display_name, department_name=excluded.department_name, lane=excluded.lane, allowed_projects_json=excluded.allowed_projects_json, allowed_systems_json=excluded.allowed_systems_json, allowed_environments_json=excluded.allowed_environments_json, capability_matrix_json=excluded.capability_matrix_json, live_write=excluded.live_write, review_required=excluded.review_required, needs_handoff=excluded.needs_handoff, can_deploy=excluded.can_deploy, can_touch_auth=excluded.can_touch_auth, can_touch_billing=excluded.can_touch_billing, can_manage_production=excluded.can_manage_production, approval_class=excluded.approval_class, source_kind=excluded.source_kind, status=excluded.status, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
      ).run(
        agentName,
        a.display_name || current.display_name || agentName,
        a.department_name || current.department_name || null,
        a.lane || current.lane || null,
        JSON.stringify(normalizeProjectList(a.allowed_projects != null ? a.allowed_projects : current.allowed_projects)),
        JSON.stringify(normalizeStringList(a.allowed_systems != null ? a.allowed_systems : current.allowed_systems)),
        JSON.stringify(normalizeStringList(a.allowed_environments != null ? a.allowed_environments : current.allowed_environments)),
        JSON.stringify(capabilityMatrix),
        boolFlag(a.live_write, current.live_write) ? 1 : 0,
        boolFlag(a.review_required, current.review_required) ? 1 : 0,
        boolFlag(a.needs_handoff, current.needs_handoff) ? 1 : 0,
        boolFlag(a.can_deploy, current.can_deploy) ? 1 : 0,
        boolFlag(a.can_touch_auth, current.can_touch_auth) ? 1 : 0,
        boolFlag(a.can_touch_billing, current.can_touch_billing) ? 1 : 0,
        boolFlag(a.can_manage_production, current.can_manage_production) ? 1 : 0,
        a.approval_class || current.approval_class || "read_only",
        "manual",
        a.status || current.status || "active",
        JSON.stringify(a.meta || current.meta || {}),
        a.updated_by || DEFAULT_AGENT
      );
      return { ok: true, passport: agentPassportData(tdb, agentName) };
    }
    case "mem_agent_pass_get": {
      if (!a.agent_name) return { error: "agent_name required" };
      return { ok: true, passport: agentPassportData(tdb, a.agent_name) };
    }
    case "mem_agent_pass_list": {
      const passports = agentPassportListData(tdb, a || {});
      return { ok: true, count: passports.length, passports };
    }
    case "mem_drift_check_report": {
      return buildDriftCheckReport(tdb, a || {});
    }
    case "mem_drift_status": {
      ensureUniversalJournalSchema(tdb);
      const where = [];
      const params = [];
      if (a.scope) { where.push("scope=?"); params.push(String(a.scope)); }
      if (a.project) { where.push("project=?"); params.push(String(a.project)); }
      if (a.system_name) { where.push("system_name=?"); params.push(String(a.system_name)); }
      if (a.drift_kind) { where.push("drift_kind=?"); params.push(String(a.drift_kind)); }
      if (a.status) { where.push("status=?"); params.push(String(a.status)); }
      const limit = Math.max(1, Math.min(parseInt(a.limit || 50, 10) || 50, 200));
      params.push(limit);
      const rows = tdb.prepare(
        "SELECT * FROM drift_check_result" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY checked_at DESC LIMIT ?"
      ).all(...params).map((row) => ({
        id: row.id,
        scope: row.scope,
        project: row.project || null,
        system_name: row.system_name || null,
        drift_kind: row.drift_kind,
        severity: row.severity,
        status: row.status,
        freshness_status: row.freshness_status,
        expected: row.expected || null,
        actual: row.actual || null,
        source_ref: row.source_ref || null,
        checked_by: row.checked_by || null,
        checked_at: row.checked_at,
        details: parseMaybeJson(row.details_json, {}),
      }));
      return {
        ok: true,
        count: rows.length,
        summary: {
          open: rows.filter((row) => row.status === "open").length,
          critical_freshness: rows.filter((row) => row.freshness_status === "critical").length,
          high: rows.filter((row) => row.severity === "H").length,
        },
        findings: rows,
      };
    }
    case "mem_duplicate_work_check": {
      return duplicateWorkCheck(tdb, a || {});
    }
    case "mem_impact_map": {
      return buildImpactMap(tdb, a || {});
    }
    case "mem_write_gate_check": {
      if (!a.agent_name || !a.task) return { error: "agent_name + task required" };
      return writeGateCheck(tdb, a || {});
    }
    case "mem_maintenance_window_upsert": {
      if (!a.title || !a.starts_at || !a.ends_at) return { error: "title + starts_at + ends_at required" };
      ensureUniversalJournalSchema(tdb);
      const scope = scopeName(a.scope);
      if (a.id) {
        const current = tdb.prepare("SELECT id, meta_json FROM maintenance_window WHERE id=?").get(a.id);
        if (!current) return { error: "maintenance_window_not_found", id: a.id };
        tdb.prepare("UPDATE maintenance_window SET scope=?, project=?, system_name=?, title=?, window_kind=?, risk_class=?, starts_at=?, ends_at=?, status=?, notes=?, approved_by=?, updated_by=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, a.title, a.window_kind || "maintenance", a.risk_class || "normal_fix", a.starts_at, a.ends_at, a.status || "approved", a.notes || null, a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id };
      }
      const info = tdb.prepare("INSERT INTO maintenance_window (scope, project, system_name, title, window_kind, risk_class, starts_at, ends_at, status, notes, approved_by, updated_by, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, a.title, a.window_kind || "maintenance", a.risk_class || "normal_fix", a.starts_at, a.ends_at, a.status || "approved", a.notes || null, a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
    case "mem_maintenance_window_list": {
      ensureUniversalJournalSchema(tdb);
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare("SELECT * FROM maintenance_window WHERE " + where.join(" AND ") + " ORDER BY starts_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, windows: rows };
    }
    case "mem_maintenance_window_check": {
      return maintenanceWindowCheck(tdb, a || {});
    }
    case "mem_override_log": {
      if (!a.gate_kind || !a.reason) return { error: "gate_kind + reason required" };
      ensureUniversalJournalSchema(tdb);
      const scope = scopeName(a.scope);
      if (a.id) {
        const current = tdb.prepare("SELECT id, meta_json FROM override_log WHERE id=?").get(a.id);
        if (!current) return { error: "override_not_found", id: a.id };
        tdb.prepare("UPDATE override_log SET scope=?, project=?, system_name=?, agent_name=?, gate_kind=?, reason=?, approved_by=?, starts_at=?, expires_at=?, status=?, notes=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, a.agent_name || null, a.gate_kind, a.reason, a.approved_by || null, a.starts_at || isoNow(), a.expires_at || null, a.status || "active", a.notes || null, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id };
      }
      const info = tdb.prepare("INSERT INTO override_log (scope, project, system_name, agent_name, gate_kind, reason, approved_by, starts_at, expires_at, status, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, a.agent_name || null, a.gate_kind, a.reason, a.approved_by || null, a.starts_at || isoNow(), a.expires_at || null, a.status || "active", a.notes || null, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
    case "mem_override_list": {
      ensureUniversalJournalSchema(tdb);
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.gate_kind) { where.push("gate_kind=?"); params.push(a.gate_kind); }
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare("SELECT * FROM override_log WHERE " + where.join(" AND ") + " ORDER BY starts_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, overrides: rows };
    }
    case "mem_override_check": {
      const overrides = currentOverrideRows(tdb, a || {});
      return { ok: true, count: overrides.length, overrides };
    }
    case "mem_artifact_lock_set": {
      if (!a.artifact_kind || !a.artifact_value || !a.reason) return { error: "artifact_kind + artifact_value + reason required" };
      ensureUniversalJournalSchema(tdb);
      const scope = scopeName(a.scope);
      const artifactKind = normalizeArtifactKind(a.artifact_kind);
      const artifactKey = normalizeArtifactValue(artifactKind, a.artifact_value);
      if (!artifactKey) return { error: "artifact_value required" };
      if (a.id) {
        const current = tdb.prepare("SELECT id, meta_json FROM artifact_lock WHERE id=?").get(a.id);
        if (!current) return { error: "artifact_lock_not_found", id: a.id };
        tdb.prepare("UPDATE artifact_lock SET scope=?, project=?, system_name=?, artifact_kind=?, artifact_key=?, artifact_label=?, reason=?, status=?, locked_by=?, approved_by=?, started_at=?, expires_at=?, notes=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, artifactKind, artifactKey, a.artifact_label || a.artifact_value || artifactKey, a.reason, a.status || "active", a.locked_by || DEFAULT_AGENT, a.approved_by || null, a.started_at || isoNow(), a.expires_at || null, a.notes || null, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id, artifact_kind: artifactKind, artifact_key: artifactKey };
      }
      const existing = tdb.prepare("SELECT id, meta_json FROM artifact_lock WHERE scope=? AND COALESCE(project,'')=COALESCE(?, '') AND COALESCE(system_name,'')=COALESCE(?, '') AND artifact_kind=? AND artifact_key=? AND status='active' ORDER BY id DESC LIMIT 1")
        .get(scope, a.project || null, a.system_name || null, artifactKind, artifactKey);
      if (existing) {
        tdb.prepare("UPDATE artifact_lock SET artifact_label=?, reason=?, locked_by=?, approved_by=?, expires_at=?, notes=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(a.artifact_label || a.artifact_value || artifactKey, a.reason, a.locked_by || DEFAULT_AGENT, a.approved_by || null, a.expires_at || null, a.notes || null, JSON.stringify(a.meta || parseMaybeJson(existing.meta_json, {})), existing.id);
        return { ok: true, id: existing.id, artifact_kind: artifactKind, artifact_key: artifactKey, reused: true };
      }
      const info = tdb.prepare("INSERT INTO artifact_lock (scope, project, system_name, artifact_kind, artifact_key, artifact_label, reason, status, locked_by, approved_by, started_at, expires_at, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, artifactKind, artifactKey, a.artifact_label || a.artifact_value || artifactKey, a.reason, a.status || "active", a.locked_by || DEFAULT_AGENT, a.approved_by || null, a.started_at || isoNow(), a.expires_at || null, a.notes || null, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid, artifact_kind: artifactKind, artifact_key: artifactKey };
    }
    case "mem_artifact_lock_list": {
      ensureUniversalJournalSchema(tdb);
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.artifact_kind) { where.push("artifact_kind=?"); params.push(normalizeArtifactKind(a.artifact_kind)); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare("SELECT * FROM artifact_lock WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, locks: rows };
    }
    case "mem_artifact_lock_check": {
      return artifactLockCheck(tdb, a || {});
    }
    case "mem_secret_rotation_log": {
      if (!a.system_name) return { error: "system_name required" };
      ensureUniversalJournalSchema(tdb);
      const info = tdb.prepare("INSERT INTO secret_rotation_log (scope, system_name, secret_ref, project, rotated_by, verified_by, rotation_kind, status, rotated_at, verified_at, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scopeName(a.scope), a.system_name, a.secret_ref || null, a.project || null, a.rotated_by || null, a.verified_by || null, a.rotation_kind || "manual", a.status || "rotated", a.rotated_at || isoNow(), a.verified_at || null, a.notes || null, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
    case "mem_secret_rotation_list": {
      ensureUniversalJournalSchema(tdb);
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.secret_ref) { where.push("secret_ref=?"); params.push(a.secret_ref); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare("SELECT * FROM secret_rotation_log WHERE " + where.join(" AND ") + " ORDER BY rotated_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, rotations: rows };
    }
    case "mem_freeze_set": {
      if (!a.reason) return { error: "reason required" };
      ensureUniversalJournalSchema(tdb);
      const scope = scopeName(a.scope);
      if (a.id) {
        const current = tdb.prepare("SELECT id, meta_json FROM dependency_freeze WHERE id=?").get(a.id);
        if (!current) return { error: "freeze_not_found", id: a.id };
        tdb.prepare("UPDATE dependency_freeze SET scope=?, project=?, system_name=?, freeze_kind=?, reason=?, started_at=?, expires_at=?, status=?, approved_by=?, updated_by=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, a.freeze_kind || "dependency_freeze", a.reason, a.started_at || isoNow(), a.expires_at || null, a.status || "active", a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id };
      }
      const info = tdb.prepare("INSERT INTO dependency_freeze (scope, project, system_name, freeze_kind, reason, started_at, expires_at, status, approved_by, updated_by, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, a.freeze_kind || "dependency_freeze", a.reason, a.started_at || isoNow(), a.expires_at || null, a.status || "active", a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
    case "mem_freeze_list": {
      ensureUniversalJournalSchema(tdb);
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare("SELECT * FROM dependency_freeze WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, freezes: rows };
    }
    case "mem_freeze_check": {
      return freezeCheck(tdb, a || {});
    }
    case "mem_incident_report": {
      if (!a.title) return { error: "title required" };
      ensureUniversalJournalSchema(tdb);
      const info = tdb.prepare("INSERT INTO ops_incident (scope, project, system_name, title, severity, status, cause, fix_summary, prevention, source_agent, decision_id, quality_finding_id, scar_pattern_id, evidence_json, meta_json, closed_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
        .run(scopeName(a.scope), a.project || null, a.system_name || null, a.title, a.severity || "M", a.status || "open", a.cause || null, a.fix_summary || null, a.prevention || null, a.source_agent || null, a.decision_id || null, a.quality_finding_id || null, a.scar_pattern_id || null, JSON.stringify(a.evidence || {}), JSON.stringify(a.meta || {}), a.closed_at || null);
      return { ok: true, id: info.lastInsertRowid };
    }
    case "mem_incident_list": {
      ensureUniversalJournalSchema(tdb);
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.severity) { where.push("severity=?"); params.push(a.severity); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare("SELECT * FROM ops_incident WHERE " + where.join(" AND ") + " ORDER BY opened_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { evidence: parseMaybeJson(row.evidence_json, {}), meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, incidents: rows };
    }
    case "mem_status_board": {
      return buildStatusBoard(tdb, a || {});
    }
    case "mem_learning_loop_report": {
      return buildLearningLoopReport(tdb, a || {});
    }
    case "mem_search_reindex": {
      return runSearchReindex(tdb, a || {});
    }
    case "mem_department_member_set": {
      if (!a.department_name || !a.agent_name) return { error: "department_name + agent_name required" };
      ensureAutonomyTables(tdb);
      const dep = departmentInfo(tdb, a.department_name);
      if (!dep) return { error: "department not found", department_name: a.department_name, hint: "Run mem_department_seed_defaults first." };
      tdb.prepare("INSERT INTO department_member (department_name, agent_name, role, skills_json, updated_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(department_name, agent_name) DO UPDATE SET role=excluded.role, skills_json=excluded.skills_json, status='active', updated_at=excluded.updated_at")
        .run(a.department_name, a.agent_name, a.role || "member", JSON.stringify(a.skills || []));
      return { ok: true, department_name: a.department_name, agent_name: a.agent_name, role: a.role || "member" };
    }
    case "mem_project_crossover_check": {
      const result = buildProjectCrossoverCheck(tdb, a || {});
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_crossover_check', ?, ?, ?, 'autonomy')").run(a.agent_name || a.source_agent || DEFAULT_AGENT, result.project || a.project || a.name || "unknown", result.status || "error", JSON.stringify({ findings: result.findings ? result.findings.length : 0, checks: result.checks ? result.checks.length : 0 })); } catch {}
      return result;
    }
    case "mem_autonomy_sweep": {
      return runAutonomySweep(tdb, a || {});
    }
    case "mem_autonomy_next": {
      a = a || {};
      ensureAutonomyTables(tdb);
      const agentName = normalizeAgentName(a.agent_name);
      const allowTakeover = !!(a.allow_takeover && agentName);
      const staleTakeoverMinutes = Math.max(1, Math.min(parseInt(a.stale_takeover_minutes || 20, 10) || 20, 1440));
      const staleBefore = new Date(Date.now() - staleTakeoverMinutes * 60 * 1000).toISOString();
      const where = [allowTakeover ? "(status='open' OR (status='claimed' AND COALESCE(updated_at, claimed_at, created_at) < ?))" : "status='open'"];
      const params = allowTakeover ? [staleBefore] : [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.department_name) { where.push("department_name=?"); params.push(a.department_name); }
      if (agentName) {
        if (allowTakeover) {
          where.push("(lower(COALESCE(assigned_agent,''))=lower(?) OR assigned_agent IS NULL OR assigned_agent='' OR (assigned_agent IS NOT NULL AND assigned_agent<>'' AND lower(assigned_agent)<>lower(?) AND COALESCE(updated_at, claimed_at, created_at) < ?))");
          params.push(agentName, agentName, staleBefore);
        } else {
          where.push("(lower(COALESCE(assigned_agent,''))=lower(?) OR assigned_agent IS NULL OR assigned_agent='')");
          params.push(agentName);
        }
      }
      const limit = Math.min(a.limit || 10, 50);
      const ownerOrder = agentName ? "CASE WHEN lower(COALESCE(assigned_agent,''))=lower(?) THEN 0 WHEN assigned_agent IS NULL OR assigned_agent='' THEN 1 ELSE 2 END, " : "";
      if (agentName) params.push(agentName);
      params.push(limit);
      const rows = tdb.prepare("SELECT * FROM autonomy_task WHERE " + where.join(" AND ") + " ORDER BY " + ownerOrder + "CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at ASC LIMIT ?").all(...params);
      for (const r of rows) {
        const assignedAgent = normalizeAgentName(r.assigned_agent);
        const lastTouch = Date.parse(r.updated_at || r.claimed_at || r.created_at || "");
        const staleEligible = Number.isFinite(lastTouch) && lastTouch < Date.parse(staleBefore);
        r.takeover_eligible = !!(allowTakeover && assignedAgent && assignedAgent !== agentName && staleEligible);
        r.stale_claim_recovery = !!(allowTakeover && r.status === "claimed" && staleEligible);
        r.previous_assigned_agent = r.takeover_eligible ? r.assigned_agent : null;
        r.checklist = parseMaybeJson(r.checklist_json, null);
        r.meta = parseMaybeJson(r.meta_json, null);
        delete r.checklist_json; delete r.meta_json;
      }
      if (a.claim && rows[0]) {
        const id = rows[0].id;
        const claimSql = "UPDATE autonomy_task SET status='claimed', assigned_agent=COALESCE(?, assigned_agent), claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND " + (allowTakeover ? "(status='open' OR (status='claimed' AND COALESCE(updated_at, claimed_at, created_at) < ?))" : "status='open'");
        const info = allowTakeover
          ? tdb.prepare(claimSql).run(agentName || null, id, staleBefore)
          : tdb.prepare(claimSql).run(agentName || null, id);
        if (info.changes < 1) return { count: 0, tasks: [], claim_conflict: true, takeover: { allow_takeover: allowTakeover, stale_takeover_minutes: staleTakeoverMinutes, stale_before: staleBefore } };
        rows[0].status = "claimed";
        rows[0].assigned_agent = agentName || rows[0].assigned_agent;
      }
      return { count: rows.length, tasks: rows, takeover: { allow_takeover: allowTakeover, stale_takeover_minutes: staleTakeoverMinutes, stale_before: staleBefore } };
    }
    case "mem_autonomy_task_update": {
      if (!a.id) return { error: "id required" };
      ensureAutonomyTables(tdb);
      const resolved = briefCoordination.resolveAutonomyTaskUpdateId(tdb, a.id);
      if (resolved.error) {
        return {
          error: resolved.error,
          id: a.id,
          candidates: resolved.candidates || [],
          hint: "Use autonomy_task.id or the linked agent_brief.id. This tool resolves direct task IDs, brief meta/content task references, source_id links, and meta brief_id links."
        };
      }
      const taskId = resolved.id;
      const current = tdb.prepare("SELECT meta_json FROM autonomy_task WHERE id=?").get(taskId);
      if (!current) return { error: "task not found", id: a.id, resolved_id: taskId };
      if (String(a.status || "").toLowerCase() === "blocked") {
        const metaBlocker = firstReasonObject(a.meta || {}, ["blocked_reason", "blocker", "blockers", "missing", "missing_blocks", "reason", "next_action"]);
        if (!compactReason(a.notes) && !metaBlocker) {
          return {
            error: "blocked update requires blocker reason",
            id: a.id,
            resolved_id: taskId,
            hint: "Set notes='blocked because ...' or meta.blocked_reason/meta.blockers so future blocked-review briefs include the reason."
          };
        }
      }
      const meta = a.meta ? JSON.stringify(deepMergePlain(parseMaybeJson(current.meta_json, {}) || {}, a.meta)) : current.meta_json;
      const doneExpr = a.status === "done" || a.status === "reviewed" || a.status === "approved" ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "done_at";
      const sql = "UPDATE autonomy_task SET status=COALESCE(?, status), assigned_agent=COALESCE(?, assigned_agent), reviewer_agent=COALESCE(?, reviewer_agent), notes=COALESCE(?, notes), meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), done_at=" + doneExpr + " WHERE id=?";
      const info = tdb.prepare(sql).run(a.status || null, a.assigned_agent || null, a.reviewer_agent || null, a.notes || null, meta, taskId);
      return { ok: info.changes > 0, id: taskId, input_id: a.id, resolved_from: resolved.resolved_from, status: a.status || "unchanged" };
    }
    case "mem_project_rules_set": {
      if (!a.project) return { error: "project required" };
      ensureFirmOpsTables(tdb);
      const jsonKeys = ["canonical_nav","allowed_domains","auth_matrix","language_matrix","pricing_rules","checkout_rules","vat_rules","deploy_rules","design_rules","required_gates"];
      const fields = ["project"]; const placeholders = ["?"]; const values = [a.project]; const updates = [];
      for (const k of jsonKeys) if (a[k] !== undefined) { fields.push(k); placeholders.push("?"); values.push(JSON.stringify(a[k])); updates.push(k + "=excluded." + k); }
      for (const k of ["notes","updated_by"]) if (a[k] !== undefined) { fields.push(k); placeholders.push("?"); values.push(a[k]); updates.push(k + "=excluded." + k); }
      updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      const sql = "INSERT INTO project_rules (" + fields.join(",") + ") VALUES (" + placeholders.join(",") + ") ON CONFLICT(project) DO UPDATE SET " + updates.join(", ");
      tdb.prepare(sql).run(...values);
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_rules_set', ?, 'done', ?, 'project_rules')").run(a.updated_by || "unknown", a.project, JSON.stringify({ keys: Object.keys(a).filter(k => k !== "project") })); } catch {}
      return { ok: true, project: a.project };
    }
    case "mem_project_rules_get": {
      if (!a.project) return { error: "project required" };
      ensureFirmOpsTables(tdb);
      const row = tdb.prepare("SELECT * FROM project_rules WHERE project=?").get(a.project);
      if (!row) return { error: "not found", project: a.project, hint: "Create rules via mem_project_rules_set before letting agents build UI, auth, pricing, checkout, language, or deploy flows." };
      for (const k of ["canonical_nav","allowed_domains","auth_matrix","language_matrix","pricing_rules","checkout_rules","vat_rules","deploy_rules","design_rules","required_gates"]) row[k] = parseMaybeJson(row[k], null);
      row.top_directives = blunTopDirectives(a.project, row);
      return row;
    }
    case "mem_auth_contract_get": {
      if (!a.project) return { error: "project required" };
      return authContractReport(tdb, a.project, ensureFirmOpsTables);
    }
    case "mem_auth_contract_check": {
      if (!a.project) return { error: "project required" };
      return authContractReport(tdb, a.project, ensureFirmOpsTables);
    }
    case "mem_ui_contract_get": {
      if (!a.project) return { error: "project required" };
      return uiContractReport(tdb, a.project, ensureFirmOpsTables);
    }
    case "mem_ui_contract_check": {
      if (!a.project) return { error: "project required" };
      return uiContractReport(tdb, a.project, ensureFirmOpsTables);
    }
    case "mem_project_rules_list": {
      ensureFirmOpsTables(tdb);
      const rows = tdb.prepare("SELECT project, updated_at, updated_by, notes FROM project_rules ORDER BY updated_at DESC LIMIT ?").all(Math.min(a.limit || 100, 500));
      return { count: rows.length, projects: rows };
    }
    case "mem_project_rules_seed_defaults": {
      ensureFirmOpsTables(tdb);
      ensureProjectRegistryTable(tdb);
      const seed = loadProjectRuleDefaults(a.scope);
      if (seed.error) return seed;
      const wanted = Array.isArray(a.projects) && a.projects.length ? new Set(a.projects) : null;
      const updatedBy = a.updated_by || a.agent_name || "seed-defaults";
      const seeded = [];
      for (const project of seed.projects || []) {
        if (wanted && !wanted.has(project.name)) continue;
        const rules = deepMergePlain(seed.defaults || {}, project.rules || {});
        if (a.dry_run) {
          seeded.push({ project: project.name, dry_run: true, registry: Boolean(project.registry), rule_keys: Object.keys(rules) });
          continue;
        }
        let registry = null;
        if (a.include_registry !== false && project.registry) {
          registry = handleTool(tdb, "mem_project_registry_upsert", Object.assign({}, project.registry, { name: project.name, updated_by: updatedBy }));
        }
        const ruleResult = handleTool(tdb, "mem_project_rules_set", Object.assign({}, rules, { project: project.name, updated_by: updatedBy }));
        const findings = [];
        if (a.seed_findings !== false) {
          for (const f of project.findings || []) {
            const existing = tdb.prepare("SELECT id, status FROM quality_finding WHERE project=? AND title=? ORDER BY id DESC LIMIT 1").get(project.name, f.title);
            if (existing) {
              findings.push({ id: existing.id, status: existing.status, action: "kept" });
            } else {
              findings.push(handleTool(tdb, "mem_quality_finding_report", Object.assign({}, f, { project: project.name, source_agent: f.source_agent || updatedBy })));
            }
          }
        }
        seeded.push({ project: project.name, registry: registry ? registry.ok === true : false, rules: ruleResult.ok === true, findings });
      }
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_rules_seed_defaults', ?, 'done', ?, 'project_rules')").run(updatedBy, scopeName(a.scope), JSON.stringify({ count: seeded.length, projects: seeded.map(x => x.project) })); } catch {}
      return { ok: true, scope: scopeName(a.scope), count: seeded.length, seeded };
    }
    case "mem_firm_readiness_board": {
      const board = buildFirmReadinessBoard(tdb, a || {});
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'firm_readiness_board', ?, 'done', ?, 'firm_readiness')").run(a.agent_name || "unknown", scopeName(a.scope), JSON.stringify(board.summary)); } catch {}
      return board;
    }
    case "mem_quality_finding_report": {
      if (!a.project || !a.category || !a.title) return { error: "project + category + title required" };
      ensureFirmOpsTables(tdb);
      const sev = ["L","M","H","critical"].includes(a.severity) ? a.severity : "M";
      const info = tdb.prepare("INSERT INTO quality_finding (project, category, severity, title, url, expected, actual, source_agent, evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(a.project, a.category, sev, a.title, a.url || null, a.expected || null, a.actual || null, a.source_agent || null, a.evidence ? JSON.stringify(a.evidence) : null);
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'quality_finding_report', ?, 'open', ?, 'quality_finding')").run(a.source_agent || "unknown", a.project, JSON.stringify({ id: info.lastInsertRowid, category: a.category, severity: sev, title: a.title })); } catch {}
      return { id: info.lastInsertRowid, project: a.project, status: "open", severity: sev };
    }
    case "mem_quality_finding_list": {
      ensureFirmOpsTables(tdb);
      const where = []; const params = [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.category) { where.push("category=?"); params.push(a.category); }
      if (a.severity) { where.push("severity=?"); params.push(a.severity); }
      const sql = "SELECT id, project, category, severity, title, url, status, source_agent, created_at, updated_at FROM quality_finding" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at DESC LIMIT ?";
      params.push(Math.min(a.limit || 100, 500));
      const rows = tdb.prepare(sql).all(...params);
      if (rows.length) return { count: rows.length, findings: rows };
      let memoryCandidates = [];
      try {
        const q = a.project ? "%" + a.project + "%" : "%finding%";
        memoryCandidates = tdb.prepare(
          "SELECT id, kind, actor, topic, substr(text,1,360) AS snippet, occurred_at FROM memory " +
          "WHERE (lower(text) LIKE '%finding%' OR lower(topic) LIKE '%finding%' OR text LIKE '%#%') " +
          (a.project ? "AND (text LIKE ? OR topic LIKE ?) " : "") +
          "ORDER BY id DESC LIMIT ?"
        ).all(...(a.project ? [q, q, Math.min(a.limit || 25, 100)] : [Math.min(a.limit || 25, 100)]));
      } catch {}
      return {
        count: 0,
        findings: [],
        memory_candidates_count: memoryCandidates.length,
        memory_candidates: memoryCandidates,
        hint: memoryCandidates.length
          ? "No structured quality_finding rows matched, but memory rows mention findings. Backfill or report them with mem_quality_finding_report so list/update/resolve can track them structurally."
          : "No structured quality_finding rows matched."
      };
    }
    case "mem_quality_finding_resolve": {
      if (!a.id) return { error: "id required" };
      ensureFirmOpsTables(tdb);
      const info = tdb.prepare("UPDATE quality_finding SET status=?, resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by=?, fix_summary=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run(a.status || "resolved", a.resolved_by || null, a.fix_summary || null, a.id);
      return { id: a.id, updated: info.changes, status: a.status || "resolved" };
    }
    case "mem_session_start": {
      if (!a.agent_name) return { error: "agent_name required" };
      ensureFirmOpsTables(tdb);
      const agent = a.agent_name;
      const project = a.project || null;
      const focus = handleTool(tdb, "mem_focus_get", { agent_name: agent });
      const today = handleTool(tdb, "mem_today_view", { agent_name: agent });
      const work = handleTool(tdb, "mem_work_active", { project, agent_name: a.include_all_claims ? null : agent, limit: 50 });
      const status = handleTool(tdb, "mem_agent_status_set", { agent_name: agent, current_task: a.task || null, meta: { session_start: true, project } });
      const lens = project ? handleTool(tdb, "mem_lens_view", { project, limit: 10 }) : null;
      const rules = project ? handleTool(tdb, "mem_project_rules_get", { project }) : null;
      const live = project ? handleTool(tdb, "mem_project_live_check", { name: project, agent_name: agent }) : null;
      const findings = project ? handleTool(tdb, "mem_quality_finding_list", { project, status: "open", limit: 25 }) : null;
      const team = handleTool(tdb, "mem_team_operating_model", { agent_name: agent });
      const passport = handleTool(tdb, "mem_agent_pass_get", { agent_name: agent });
      const statusBoard = project ? handleTool(tdb, "mem_status_board", { projects: [project] }) : null;
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'session_start', ?, 'done', ?, 'session_lifecycle')").run(agent, project || a.task || "session", JSON.stringify({ task: a.task || null, project, passport_lane: passport && passport.passport && passport.passport.lane || null })); } catch {}
      return {
        agent_name: agent,
        project,
        task: a.task || null,
        protocol: ["view memory first", "read project rules", "check active claims", "think/preflight before edits", "claim files", "verify end-to-end", "handoff before stop"].concat((rules && rules.top_directives) || []),
        memory_paths: project ? ["/memories/top.md", "/memories/today.md", "/memories/agents/" + agent + "/status.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/registry.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/rules.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/live-check.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/findings.md"] : ["/memories/top.md", "/memories/today.md", "/memories/agents/" + agent + "/status.md"],
        focus,
        status,
        today,
        active_work: work,
        project_lens: lens,
        project_rules: rules,
        live_check: live,
        open_findings: findings,
        team_operating_model: team,
        agent_passport: passport,
        status_board: statusBoard
      };
    }
    case "mem_agent_preflight": {
      if (!a.agent_name || !a.task) return { error: "agent_name + task required" };
      ensureFirmOpsTables(tdb);
      const project = a.project || null;
      const files = Array.isArray(a.files) ? a.files : [];
      const checks = [];
      const blockers = [];
      if (project) {
        const rules = handleTool(tdb, "mem_project_rules_get", { project });
        checks.push({ name: "project_rules", result: rules.error ? "missing" : "ok" });
        if (rules.error && a.require_project_rules !== false) blockers.push("missing project rules for " + project);
        if (authSensitiveTask(a)) {
          const authCheck = handleTool(tdb, "mem_auth_contract_check", { project });
          checks.push({ name: "auth_contract", result: authCheck.status || (authCheck.ok ? "ok" : "block"), missing: authCheck.missing || [], mismatches: authCheck.mismatches || [] });
          if (authCheck.status === "block") blockers.push("canonical auth contract blocked: " + (authCheck.blockers || []).join("; "));
        }
        if (uiSensitiveTask(a)) {
          const uiCheck = handleTool(tdb, "mem_ui_contract_check", { project });
          checks.push({ name: "ui_contract", result: uiCheck.status || (uiCheck.ok ? "ok" : "block"), missing: uiCheck.missing || [], mismatches: uiCheck.mismatches || [] });
          if (uiCheck.status === "block") blockers.push("canonical ui contract blocked: " + (uiCheck.blockers || []).join("; "));
        }
        const findings = handleTool(tdb, "mem_quality_finding_list", { project, status: "open", limit: 50 });
        const high = (findings.findings || []).filter(f => f.severity === "H" || f.severity === "critical");
        checks.push({ name: "open_findings", open: findings.count, high: high.length });
        if (high.length && a.block_on_high_findings !== false) blockers.push("open high/critical findings exist");
      }
      if (a.action_type && Array.isArray(a.topics)) {
        const pre = handleTool(tdb, "mem_pre_action_check", { action_type: a.action_type, topics: a.topics, scope: a.scope, agent_name: a.agent_name, summary: a.summary || a.task });
        checks.push({ name: "canonical_facts", result: pre.status, missing: pre.missing || [] });
        if (pre.status === "block") blockers.push("canonical facts missing: " + (pre.missing || []).join(", "));
      }
      const ownership = preflightDepartmentOwnership(tdb, a.agent_name, a.task, a.topics, files);
      checks.push({
        name: "team_operating_model",
        result: ownership.blockers.length ? "block" : "ok",
        agent_status: ownership.team.agent_status,
        active_agents: ownership.team.active_agents,
        target_departments: ownership.target_departments,
        coverage: ownership.team.department_coverage
      });
      blockers.push(...ownership.blockers);
      const writeGate = writeGateCheck(tdb, {
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        topics: a.topics || [],
        files,
        urls: a.urls || [],
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        environment: a.environment || null
      });
      checks.push({ name: "write_gate", result: writeGate.status, approval_class: writeGate.passport && writeGate.passport.approval_class || null, blockers: writeGate.blockers || [] });
      blockers.push(...(writeGate.blockers || []));
      const duplicate = duplicateWorkCheck(tdb, {
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        topics: a.topics || [],
        files
      });
      checks.push({ name: "duplicate_work", result: duplicate.status, blockers: duplicate.blockers || [], warnings: duplicate.warnings || [] });
      blockers.push(...(duplicate.blockers || []));
      const impact = buildImpactMap(tdb, {
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        topics: a.topics || [],
        files,
        urls: a.urls || [],
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        environment: a.environment || null
      });
      checks.push({ name: "impact_map", result: "ok", summary: impact.summary || {} });
      const similar = [];
      const claims = [];
      for (const file of files) {
        const sim = handleTool(tdb, "mem_work_similar", { file_path: file, project, limit: 10 });
        similar.push({ file_path: file, result: sim });
        const activeOther = (sim.similar || []).find(x => x.status === "active" && x.agent_name !== a.agent_name && x.file_path === file);
        if (activeOther) blockers.push("file already claimed by " + activeOther.agent_name + ": " + file);
        if (a.auto_claim && !activeOther) claims.push(handleTool(tdb, "mem_work_claim", { project: project || "unknown", file_path: file, agent_name: a.agent_name, summary: a.task, ttl_minutes: a.ttl_minutes || 240 }));
      }
      checks.push({ name: "work_claims", files: files.length, claimed: claims.length });
      const status = blockers.length ? "block" : "ok";
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'agent_preflight', ?, ?, ?, 'agent_preflight')").run(a.agent_name, project || a.task, status, JSON.stringify({ task: a.task, files, blockers, checks })); } catch {}
      return {
        status,
        agent_name: a.agent_name,
        project,
        task: a.task,
        blockers,
        checks,
        similar,
        claims,
        agent_loop: ["think through context", "state plan/risk", "make smallest safe change", "run verification", "store outcome"],
        hint: status === "block" ? "Resolve blockers before editing/deploying." : "Proceed, but keep claims active and hand off before stopping."
      };
    }
    case "mem_session_handoff": {
      if (!a.agent_name || !a.summary) return { error: "agent_name + summary required" };
      ensureFirmOpsTables(tdb);
      const handoffMeta = (a.meta && typeof a.meta === "object") ? a.meta : {};
      const changed = Array.isArray(a.changed_files) ? a.changed_files : [];
      const evidence = Array.isArray(a.evidence) ? a.evidence.map((row) => Object.assign({}, row, { timestamp: row && row.timestamp || isoNow() })) : [];
      const evidenceRequired = handoffMeta.allow_legacy_no_evidence !== true;
      if (evidenceRequired && !evidence.length) return { error: "evidence_required", hint: "Pass evidence=[{url|file_path|server, test_step, result, timestamp}] or set meta.allow_legacy_no_evidence=true for temporary compatibility." };
      const badEvidence = evidence.find((row) => {
        const target = row && (row.url || row.file_path || row.server || row.pm2 || row.nginx || row.screenshot_path || row.json_ref || row.curl_ref || row.browser_ref);
        return !target || !row.test_step || !row.result;
      });
      if (badEvidence) return { error: "invalid_evidence", hint: "Each evidence row needs one target field plus test_step and result.", sample: badEvidence };
      const passport = handleTool(tdb, "mem_agent_pass_get", { agent_name: a.agent_name });
      const released = [];
      if (a.release_claims !== false) {
        for (const f of changed) {
          const rel = handleTool(tdb, "mem_work_release", { file_path: f, agent_name: a.agent_name, outcome: "handoff: " + String(a.summary).slice(0, 160) });
          if (!rel.error) released.push(rel);
        }
      }
      const storedMeta = Object.assign({}, handoffMeta, {
        identity_context: passport && passport.passport || null,
        evidence,
        evidence_count: evidence.length
      });
      const info = tdb.prepare("INSERT INTO session_handoff (agent_name, project, summary, changed_files, tests, deploys, blockers, next_actions, claims_released, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(a.agent_name, a.project || null, a.summary, JSON.stringify(changed), JSON.stringify(a.tests || []), JSON.stringify(a.deploys || []), JSON.stringify(a.blockers || []), JSON.stringify(a.next_actions || []), JSON.stringify(released), JSON.stringify(storedMeta));
      const transcript = handleTool(tdb, "mem_transcript_log", { source: "memory-frontdoor", channel: "handoff", direction: "outbound", speaker: a.agent_name, content: a.summary, ref_kind: "session_handoff", ref_id: String(info.lastInsertRowid), meta: { project: a.project || null, changed_files: changed, tests: a.tests || [], deploys: a.deploys || [], blockers: a.blockers || [], next_actions: a.next_actions || [], evidence_count: evidence.length } });
      const completedBriefIds = uniqueIntegers([]
        .concat(Array.isArray(a.completed_brief_ids) ? a.completed_brief_ids : [])
        .concat(Array.isArray(handoffMeta.completed_brief_ids) ? handoffMeta.completed_brief_ids : [])
        .concat(handoffMeta.source_brief_id ? [handoffMeta.source_brief_id] : [])
        .concat(handoffMeta.brief_id ? [handoffMeta.brief_id] : []));
      const completedTaskIds = uniqueIntegers([]
        .concat(Array.isArray(a.completed_task_ids) ? a.completed_task_ids : [])
        .concat(Array.isArray(handoffMeta.completed_task_ids) ? handoffMeta.completed_task_ids : [])
        .concat(handoffMeta.autonomy_task_id ? [handoffMeta.autonomy_task_id] : []));
      const completedBriefs = [];
      for (const briefId of completedBriefIds) {
        completedBriefs.push(handleTool(tdb, "mem_brief_done", {
          id: briefId,
          status: "done",
          outcome: `Completed via session_handoff #${info.lastInsertRowid} by ${a.agent_name}: ${String(a.summary).slice(0, 240)}`
        }));
      }
      const completedTasks = [];
      for (const taskId of completedTaskIds) {
        completedTasks.push(handleTool(tdb, "mem_autonomy_task_update", {
          id: taskId,
          status: "done",
          assigned_agent: a.agent_name,
          notes: `Completed via session_handoff #${info.lastInsertRowid} by ${a.agent_name}: ${String(a.summary).slice(0, 240)}`
        }));
      }
      try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, result_json, topic) VALUES (?, 'session_handoff', ?, 'done', ?, 'session_lifecycle')").run(a.agent_name, a.project || "session", JSON.stringify({ handoff_id: info.lastInsertRowid, transcript_id: transcript.id || null, completed_brief_ids: completedBriefIds, completed_task_ids: completedTaskIds, evidence_count: evidence.length, identity_lane: passport && passport.passport && passport.passport.lane || null })); } catch {}
      return { ok: true, id: info.lastInsertRowid, transcript_id: transcript.id || null, claims_released: released, completed_briefs: completedBriefs, completed_tasks: completedTasks, agent_passport: passport, evidence_count: evidence.length };
    }
    case "mem_work_report_feed": {
      return workReportFeedData(tdb, a || {});
    }
    case "mem_work_claim": {
      return handleWorkClaim(tdb, a || {});
    }
    case "mem_work_heartbeat": {
      return handleWorkHeartbeat(tdb, a || {});
    }
    case "mem_work_heartbeat_batch": {
      return handleWorkHeartbeatBatch(tdb, a || {});
    }
    case "mem_work_release": {
      return handleWorkRelease(tdb, a || {});
    }
    case "mem_work_active": {
      return handleWorkActive(tdb, a || {});
    }
    case "mem_work_similar": {
      return handleWorkSimilar(tdb, a || {});
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
      const teamTargets = resolveTeamBriefTargets(tdb);
      const expanded = [];
      for (const r of items) {
        const normalized = normalizeBriefContent(r.content, r.meta, { source_channel: r.channel || null });
        const _scrub = stripPrivate(normalized.content);
        const content = _scrub.text;
        if (isTeamBriefTarget(r.agent_name)) {
          if (!teamTargets.length) return { error: "team_brief_no_targets", agent_name: r.agent_name };
          const baseMeta = normalized.meta;
          for (const target of teamTargets) {
            expanded.push({
              ...r,
              agent_name: target,
              content,
              channel: String(r.agent_name || "team"),
              meta: { ...baseMeta, _team_fanout: true, _team_target: r.agent_name },
            });
          }
        } else {
          expanded.push({ ...r, content, channel: null, meta: normalized.meta });
        }
      }
      const ins = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?,?)");
      const txn = tdb.transaction(rows => {
        const out = [];
        for (const r of rows) {
          const info = ins.run(r.agent_name, r.source_agent || a.source_agent || null, r.content, r.channel || null, r.meta ? JSON.stringify(r.meta) : null, r.parent_id || null, r.supersedes || null);
          out.push({ id: info.lastInsertRowid, agent_name: r.agent_name });
        }
        return out;
      });
      const inserted = txn(expanded);
      // Fire hooks + FTS outside transaction (best effort)
      for (let i = 0; i < inserted.length; i++) {
        const r = inserted[i];
        const src = expanded[i] || expanded.find(x => x.agent_name === r.agent_name) || expanded[0];
        try { fireBriefHook(tdb, r.id, src && src.meta && src.meta._team_fanout ? "team_fanout" : "drop_batch", { agent_name: r.agent_name, team_target: src && src.meta && src.meta._team_target }); } catch (e) {}
        try { ftsIndex(tdb, "brief", r.id, r.agent_name, src.source_agent || "", src.content); } catch (e) {}
      }
      return { count: inserted.length, ids: inserted.map(x => x.id), inserted };
    }
    case "mem_brief_drop_multi": {
      const targets = Array.isArray(a.agent_names) ? a.agent_names : [];
      if (!targets.length || !a.content) return { error: "agent_names array + content required" };
      const teamTargets = resolveTeamBriefTargets(tdb);
      const expandedTargets = uniqueAgentNames(targets.flatMap((name) => isTeamBriefTarget(name) ? teamTargets : [name]));
      if (!expandedTargets.length) return { error: "team_brief_no_targets", agent_names: targets };
      const normalized = normalizeBriefContent(a.content, a.meta);
      const _scrub = stripPrivate(normalized.content);
      const _content = _scrub.text;
      const hasTeamTarget = targets.some((name) => isTeamBriefTarget(name));
      const baseMeta = normalized.meta;
      const meta = JSON.stringify(hasTeamTarget ? { ...baseMeta, _team_fanout: true, _team_target: targets.filter((name) => isTeamBriefTarget(name)).join(",") } : baseMeta);
      const ins = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const ids = [];
      const txn = tdb.transaction(names => {
        for (const n of names) {
          const info = ins.run(n, a.source_agent || null, _content, meta, a.parent_id || null, a.supersedes || null);
          ids.push({ id: info.lastInsertRowid, agent_name: n });
        }
      });
      txn(expandedTargets);
      for (const r of ids) {
        try { fireBriefHook(tdb, r.id, hasTeamTarget ? "team_fanout" : "drop_multi", { agent_name: r.agent_name, team_target: hasTeamTarget ? targets.join(",") : null }); } catch (e) {}
        try { ftsIndex(tdb, "brief", r.id, r.agent_name, a.source_agent || "", _content); } catch (e) {}
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
      const normalized = normalizeBriefContent(body, { ...(a.meta || {}), template: a.template, vars });
      const info = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)").run(a.agent_name, a.source_agent || null, normalized.content, normalized.meta ? JSON.stringify(normalized.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      try { fireBriefHook(tdb, newId, "drop", { agent_name: a.agent_name, template: a.template }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, a.agent_name, a.source_agent || "", normalized.content); } catch (e) {}
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
      const targetAgent = normalizeAgentName(a.agent_name);
      const includeContent = a.include_content === true;
      if (targetAgent) { where.push("lower(agent_name)=lower(?)"); params.push(targetAgent); }
      if (a.status)     { where.push("status=?");     params.push(a.status); }
      params.push(Math.min(a.limit || 20, 200));
      const rows = tdb.prepare(
        "SELECT id, agent_name, source_agent, status, created_at, dispatched_at, done_at, " +
        "substr(content,1,160) AS preview, " +
        (includeContent ? "content, " : "") +
        "channel, outcome " +
        "FROM agent_brief WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, briefs: rows };
    }
    case "mem_action_log": {
      const stmt = tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, started_at, session_id, topic, meta_json) VALUES (?,?,?,?,?,?,?,?,?)");
      const r = stmt.run(
        a.agent_name || DEFAULT_AGENT,
        a.action_kind,
        a.target || null,
        a.status || "started",
        a.payload ? JSON.stringify(a.payload) : null,
        a.started_at || new Date().toISOString(),
        a.session_id || null,
        a.topic || null,
        a.meta ? JSON.stringify(a.meta) : null
      );
      return { id: r.lastInsertRowid, agent_name: a.agent_name || DEFAULT_AGENT, action_kind: a.action_kind };
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
      const agent = a.agent_name || DEFAULT_AGENT;
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
server.on("error", (err) => {
  console.error(`[mnemo-daemon] server error: ${err.message}`);
  try { db.close(); } catch {}
  process.exit(1);
});
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

function telegramBridgeMeta(brief) {
  if (!brief) return null;
  const meta = parseMaybeJson(brief.meta_json, {}) || {};
  const source = String(meta.source || meta.type || "").toLowerCase();
  const channel = String(brief.channel || meta.channel || "").toLowerCase();
  const isBridge = channel === "telegram" ||
    source.includes("telegram-bridge") ||
    source.includes("telegram_bridge") ||
    (meta.execution_required === true && meta.chat_id && meta.message_id);
  if (!isBridge || !meta.chat_id) return null;
  return meta;
}

function compactTelegramReply(status, outcome, agentName) {
  const label = status === "done" ? "fertig" : (status === "failed" ? "blockiert" : "zwischenstand");
  let text = String(outcome || "").replace(/\r/g, "").replace(/\n+tokens used[\s\S]*$/i, "").trim();
  if (!text) text = "Auftrag verarbeitet, aber keine kurze Abschlussantwort geliefert.";
  if (text.length > 3300) text = text.slice(0, 3300).trimEnd() + "\n\n(Gekuerzt. Details bleiben im Mnemo-Brief gespeichert.)";
  const name = normalizeAgentName(agentName || "agent");
  return `${name}: ${label}\n\n${text}`;
}

function maybeSendTelegramBriefOutcome(tdb, brief, status, outcome) {
  if (!TG_TOKEN || !brief) return false;
  if (!["done", "failed"].includes(String(status || "").toLowerCase())) return false;
  const meta = telegramBridgeMeta(brief);
  if (!meta || meta.telegram_reply_sent_at) return false;
  const text = compactTelegramReply(status, outcome, brief.agent_name);
  const params = {
    chat_id: String(meta.chat_id),
    text,
    disable_notification: false
  };
  if (meta.message_id) params.reply_to_message_id = meta.message_id;
  tgRequest("sendMessage", params).then((res) => {
    if (!res || !res.ok) throw new Error(res && res.description || "telegram send failed");
    const nextMeta = Object.assign({}, meta, {
      telegram_reply_sent_at: new Date().toISOString(),
      telegram_reply_status: status,
      telegram_reply_message_id: res.result && res.result.message_id
    });
    try { tdb.prepare("UPDATE agent_brief SET meta_json=? WHERE id=?").run(JSON.stringify(nextMeta), brief.id); } catch {}
    try {
      handleTool(tdb, "mem_transcript_log", {
        source: "telegram",
        channel: "telegram-bridge",
        direction: "outbound",
        speaker: brief.agent_name || "agent",
        content: text,
        ref_kind: "agent_brief",
        ref_id: String(brief.id),
        meta: { chat_id: String(meta.chat_id), reply_to_message_id: meta.message_id || null, status }
      });
    } catch {}
    try {
      handleTool(tdb, "mem_action_log", {
        agent_name: "telegram_bridge",
        action_kind: "brief_to_telegram_reply",
        target: `${brief.agent_name || "agent"}#${brief.id}`,
        status: "sent",
        topic: "bridge_execution",
        payload: { chat_id: String(meta.chat_id), message_id: res.result && res.result.message_id, brief_status: status }
      });
    } catch {}
  }).catch((e) => {
    recordWrite("telegram_reply_bridge", 0, "error: " + String(e.message || e).slice(0, 120));
    try {
      handleTool(tdb, "mem_action_log", {
        agent_name: "telegram_bridge",
        action_kind: "brief_to_telegram_reply",
        target: `${brief.agent_name || "agent"}#${brief.id}`,
        status: "failed",
        topic: "bridge_execution",
        payload: { error: String(e.message || e).slice(0, 500) }
      });
    } catch {}
  });
  return true;
}

function parseTelegramAgentCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const aliases = String(process.env.MNEMO_TELEGRAM_AGENT_ALIASES || process.env.MNEMO_TEAM_AGENTS || process.env.MNEMO_LOCAL_AGENTS || "agent,agent")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const known = "(" + (aliases.length ? aliases : ["agent", "agent"]).join("|") + ")";
  let m = raw.match(new RegExp("^/(?:brief|agent|to)\\s+" + known + "\\s+([\\s\\S]+)$", "i"));
  if (!m) m = raw.match(new RegExp("^/" + known + "\\b\\s+([\\s\\S]+)$", "i"));
  if (!m) m = raw.match(new RegExp("^@" + known + "\\b\\s*:?\\s+([\\s\\S]+)$", "i"));
  if (!m) m = raw.match(new RegExp("^" + known + "\\s*[:,-]\\s*([\\s\\S]+)$", "i"));
  if (!m) return null;
  const agent = normalizeAgentName(m[1]);
  const content = String(m[2] || "").trim();
  if (!agent || !content) return null;
  return { agent, content };
}

function dropTelegramAgentBrief(cmd, msg, chatId, userId, occurred) {
  const content = [
    `## Telegram -> ${cmd.agent}`,
    "",
    cmd.content,
    "",
    "Bridge rule: This is an execution-bound brief for the real agent loop. Do not only reply in chat. Start real work, log evidence, and end with TELEGRAM_REPLY for the chat."
  ].join("\n");
  const result = handleTool(db, "mem_brief_drop", {
    agent_name: cmd.agent,
    source_agent: OWNER_NAME || "telegram-owner",
    channel: "telegram",
    content,
    meta: {
      source: "telegram-bridge",
      type: "execution_bound_agent_brief",
      chat_id: String(chatId || ""),
      message_id: msg && msg.message_id,
      from_user_id: String(userId || ""),
      occurred_at: occurred,
      thread_id: `telegram:${chatId || ""}:${msg && msg.message_id || ""}`,
      execution_required: true
    }
  });
  try {
    handleTool(db, "mem_action_log", {
      agent_name: "telegram_bridge",
      action_kind: "telegram_to_brief",
      target: `${cmd.agent}#${result && result.id ? result.id : "unknown"}`,
      status: result && result.id ? "queued" : "failed",
      topic: "bridge_execution",
      payload: {
        agent_name: cmd.agent,
        brief_id: result && result.id,
        chat_id: String(chatId || ""),
        message_id: msg && msg.message_id
      }
    });
  } catch {}
  return result;
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
      const chatType = String(msg.chat && msg.chat.type || "");
      const isDm = chatType === "private";
      if (OWNER_CHAT_ID && chatId !== OWNER_CHAT_ID && !(TELEGRAM_INGEST_ALL_DMS && isDm)) continue;
      const userId = String(msg.from && msg.from.id);
      const isOwner = OWNER_TELEGRAM_USER_ID
        ? userId === String(OWNER_TELEGRAM_USER_ID)
        : (OWNER_CHAT_ID ? (chatId === String(OWNER_CHAT_ID) || userId === String(OWNER_CHAT_ID)) : false);
      const occurred = new Date((msg.date || 0) * 1000).toISOString();
      const sourceRef = "tg:" + chatId + ":" + msg.message_id;
      const actorName = isOwner ? OWNER_NAME : (msg.from && (msg.from.first_name || msg.from.username) || "unknown");
      const result = captureIngest(db, {
        source: "telegram",
        channel: isDm ? "telegram-dm:" + userId : "telegram-chat:" + chatId,
        direction: "inbound",
        actor: actorName,
        actor_id: userId,
        event_kind: "message",
        ref_kind: "telegram_message",
        ref_id: sourceRef,
        source_ref: sourceRef,
        thread_id: chatId,
        occurred_at: occurred,
        content: msg.text,
        promote_transcript: true,
        promote_memory: true,
        importance: isOwner ? 7 : 5,
        meta: { chat_id: chatId, chat_type: chatType, chat_title: msg.chat && msg.chat.title || null, message_id: msg.message_id, raw_from: msg.from },
      });
      if (!result || result.ok === false) {
        recordWrite("telegram_poller", 0, "blocked_invalid_capture: " + String(result && result.error || "unknown").slice(0, 100));
        continue;
      }
      if (result && !result.duplicate) added++;
      const cmd = isOwner ? parseTelegramAgentCommand(msg.text) : null;
      if (cmd) {
        const brief = dropTelegramAgentBrief(cmd, msg, chatId, userId, occurred);
        if (brief && brief.id) {
          added++;
          const ackText = `OK. Echter ${cmd.agent}-Loop hat Auftrag #${brief.id}. Abschlussantwort kommt hier in Telegram.`;
          try {
            await tgRequest("sendMessage", {
              chat_id: chatId,
              text: ackText,
              reply_to_message_id: msg.message_id
            });
            handleTool(db, "mem_transcript_log", {
              source: "telegram",
              channel: isDm ? "telegram-dm:" + userId : "telegram-chat:" + chatId,
              direction: "outbound",
              speaker: "mnemo-telegram-bridge",
              content: ackText,
              ref_kind: "agent_brief",
              ref_id: String(brief.id),
              meta: { chat_id: chatId, message_id: msg.message_id, command_agent: cmd.agent, ack: true }
            });
          } catch {}
        }
      }
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
} else if (!TELEGRAM_POLL_ENABLED) {
  console.log("[mnemo-daemon] Telegram poller disabled by MNEMO_TELEGRAM_POLL_ENABLED=0");
  recordWrite("telegram_poller", 0, "disabled_by_env");
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

// ---------- Reminder dispatcher ----------
function reminderDispatchCycle() {
  try {
    ensureReminderTables(db);
    const due = db.prepare("SELECT * FROM reminder WHERE status='open' AND due_at IS NOT NULL AND due_at<=? AND notified_at IS NULL ORDER BY due_at ASC, id ASC LIMIT 25").all(now());
    let sent = 0;
    for (const r of due) {
      const agent = r.agent_name || DEFAULT_AGENT;
      const content = [
        "[REMINDER] " + r.title,
        "Due: " + r.due_at,
        r.details ? "\n" + String(r.details).slice(0, 1200) : "",
      ].filter(Boolean).join("\n");
      const meta = { reminder_id: r.id, due_at: r.due_at, owner_name: r.owner_name, scope: r.scope || null };
      let briefId = null;
      try {
        briefId = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?,?,?,?,?)")
          .run(agent, "mnemo-reminder", content, "reminder", JSON.stringify(meta)).lastInsertRowid;
      } catch {
        briefId = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
          .run(agent, "mnemo-reminder", content, JSON.stringify(meta)).lastInsertRowid;
      }
      try { ftsIndex(db, "brief", briefId, agent, "mnemo-reminder", content); } catch {}
      try { fireBriefHook(db, briefId, "reminder_due", { agent_name: agent, reminder_id: r.id }); } catch {}
      db.prepare("UPDATE reminder SET notified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), notify_count=notify_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(r.id);
      sent++;
    }
    if (sent) recordWrite("reminder_dispatch", sent, "alive");
  } catch (e) {
    recordWrite("reminder_dispatch", 0, "error: " + String(e.message || e).slice(0, 120));
  }
}
setInterval(reminderDispatchCycle, 60 * 1000);
setTimeout(reminderDispatchCycle, 10 * 1000);

// ---------- Agent mail inbox dispatcher ----------
// The email gateway fetches mail into agent_mail_message; this loop turns new
// inbound rows into agent_briefs so agents see their mailbox in the same work
// queue as everything else.
function agentMailDispatchCycle() {
  try {
    const result = dispatchInboundBriefs(db, { limit: parseInt(process.env.MNEMO_AGENT_MAIL_DISPATCH_LIMIT || "50", 10) });
    if (result.dispatched) recordWrite("agent_mail_dispatch", result.dispatched, "alive");
  } catch (e) {
    recordWrite("agent_mail_dispatch", 0, "error: " + String(e.message || e).slice(0, 120));
  }
}
setInterval(agentMailDispatchCycle, parseInt(process.env.MNEMO_AGENT_MAIL_DISPATCH_MS || "60000", 10));
setTimeout(agentMailDispatchCycle, 15 * 1000);

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
          "url_failed", String(u.id), 8, DEFAULT_AGENT,
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
      // Brief to agent + coordinator
      db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run(g.agent_name, "mnemo-anti-loop", "[ANTI-LOOP] " + title + " (" + g.c + " errors in last hour). Pause repeating, investigate or escalate via mem_consult_peer / mem_consult_agent / mem_meeting_open.");
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
        const lib = url.protocol === "https:" ? https : http;
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

// Phase 3+4: idle_loop driver + daily digest cron
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
const HUB_URL = process.env.MNEMO_HUB_URL || "";
const HUB_SYNC_ENABLED = (process.env.MNEMO_HUB_SYNC || "on").toLowerCase() !== "off";
const HUB_SYNC_INTERVAL_SEC = parseInt(process.env.MNEMO_HUB_SYNC_INTERVAL_SEC || "300", 10);
const LOCAL_AGENTS_DAEMON = String(process.env.MNEMO_LOCAL_AGENTS || "")
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
    const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE || "";
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
        const req = https.request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, r => r.resume());
        req.on("error", (e) => { console.error("[digest-telegram]", m.agent_name, e.message); });
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

function briefAutoRequeueCycle() {
  if (process.env.MNEMO_BRIEF_AUTO_REQUEUE === "0") return;
  try {
    const result = briefCoordination.requeueStaleDispatchedBriefs(db, {
      older_than_minutes: process.env.MNEMO_BRIEF_REQUEUE_MIN || 30,
      agent_stale_sec: process.env.MNEMO_AGENT_OFFLINE_SEC || 300,
      limit: process.env.MNEMO_BRIEF_REQUEUE_LIMIT || 100
    });
    if (result && result.requeued) {
      try { recordWrite("brief_auto_requeue", result.requeued, "alive"); } catch {}
      console.log("[brief-auto-requeue] requeued " + result.requeued + " stale dispatched brief(s)");
    }
  } catch (e) {
    try { recordWrite("brief_auto_requeue", 0, "error: " + e.message); } catch {}
    console.error("[brief-auto-requeue]", e.message);
  }
}
setInterval(briefAutoRequeueCycle, 60 * 1000);
setTimeout(briefAutoRequeueCycle, 12000);

function gracefulShutdown(signal) {
  console.log(`[mnemo-daemon] ${signal} received, shutting down…`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => { try { db.close(); } catch {} process.exit(1); }, 5000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[mnemo-daemon] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[mnemo-daemon] uncaughtException:", err);
  gracefulShutdown("uncaughtException");
});
