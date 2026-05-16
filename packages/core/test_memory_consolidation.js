"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureMemoryConsolidationSchema,
  handleMemoryConsolidationTool,
  memoryRemRun,
} = require("./memory_consolidation");

const db = new Database(":memory:");
db.exec(`
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT,
  actor_id TEXT,
  topic TEXT,
  importance INTEGER NOT NULL DEFAULT 5,
  text TEXT NOT NULL,
  meta_json TEXT,
  hash TEXT UNIQUE,
  embedding_id INTEGER
);
CREATE TABLE mnemo_event_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  channel TEXT,
  direction TEXT NOT NULL DEFAULT 'internal',
  actor TEXT,
  actor_id TEXT,
  event_kind TEXT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  thread_id TEXT,
  status TEXT,
  content TEXT,
  payload_json TEXT,
  meta_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE agent_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  session_id TEXT,
  action_kind TEXT,
  target TEXT,
  topic TEXT,
  status TEXT,
  payload_json TEXT,
  result_json TEXT,
  meta_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE session_handoff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  project TEXT,
  summary TEXT NOT NULL,
  changed_files TEXT,
  tests TEXT,
  deploys TEXT,
  blockers TEXT,
  next_actions TEXT,
  claims_released TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  body TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agents_involved TEXT,
  files_affected TEXT,
  entities_affected TEXT
);
CREATE TABLE quality_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  title TEXT NOT NULL,
  url TEXT,
  expected TEXT,
  actual TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_agent TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE work_claim (
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
CREATE TABLE approval_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  request_kind TEXT NOT NULL DEFAULT 'resource_access',
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'write',
  requester_agent TEXT NOT NULL,
  owner_agent TEXT,
  approver_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  expires_at TEXT,
  claim_id INTEGER,
  meta_json TEXT
);
CREATE TABLE agent_brief (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  source_agent TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json TEXT
);
`);

ensureMemoryConsolidationSchema(db);
assert(db.prepare("PRAGMA table_info(memory)").all().some((col) => col.name === "layer"), "memory.layer should be migrated");

const now = new Date().toISOString();
db.prepare("INSERT INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, hash) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("message", "telegram", "m1", now, "mayk", "account", 8, "Stop, account login is broken and must be fixed.", "h1");
db.prepare("INSERT INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, hash) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("decision", "manual", "d1", now, "alfred", "account", 9, "Account is the single source of auth truth.", "h2");
db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, topic, status, started_at) VALUES (?,?,?,?,?,?)")
  .run("alfred", "edit", "packages/core/mcp.js", "account", "done", now);
db.prepare("INSERT INTO session_handoff (agent_name, project, summary, created_at) VALUES (?,?,?,?)")
  .run("alfred", "account", "Implemented account language binding with tests.", now);
db.prepare("INSERT INTO decision_log (scope, title, body, decided_by, decided_at) VALUES (?,?,?,?,?)")
  .run("default", "Auth source", "Account owns login and portals consume it.", "mayk", now);
db.prepare("INSERT INTO quality_finding (project, category, severity, title, actual, source_agent, created_at) VALUES (?,?,?,?,?,?,?)")
  .run("account", "auth", "H", "Login loop detected", "session cookie expires immediately", "dieter", now);
db.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, claim_kind, scope_value, scope_key, expires_at, status) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("account", "account/login.js", "otto", "chat login test", "file", "account/login.js", "file:account/login.js", new Date(Date.now() + 3600000).toISOString(), "active");
db.prepare("INSERT INTO approval_request (project, request_kind, resource_kind, resource_key, permission, requester_agent, owner_agent, reason) VALUES (?,?,?,?,?,?,?,?)")
  .run("account", "resource_access", "file", "account/login.js", "write", "dieter", "otto", "need fix approval");

function tool(name, args) {
  const handled = handleMemoryConsolidationTool(db, name, args || {});
  assert(handled.handled, "tool not handled: " + name);
  return handled.result;
}

{
  const status = tool("mem_memory_layer_status", { project: "account", days: 1 });
  assert.strictEqual(status.ok, true);
  assert(status.canonical_model.layers.some((layer) => layer.name === "rem"));
  assert(status.source_counts.memory >= 2);
}

{
  const plan = tool("mem_memory_rem_plan", { project: "account", agent_name: "alfred" });
  assert.strictEqual(plan.ok, true);
  assert(plan.next_due.some((phase) => phase.phase === "daily"));
}

{
  const daily = memoryRemRun(db, { phase: "daily", project: "account", agent_name: "alfred", date: now.slice(0, 10) });
  assert.strictEqual(daily.ok, true);
  assert.strictEqual(daily.daily_reflection.date, now.slice(0, 10));
  assert(daily.promoted_memory_id, "daily run should promote a semantic draft memory");
  const reflected = db.prepare("SELECT * FROM daily_reflection WHERE reflection_date=?").get(now.slice(0, 10));
  assert(reflected, "daily_reflection should be written");
}

{
  const deep = tool("mem_memory_rem_run", { phase: "deep", project: "account", agent_name: "alfred", days: 3 });
  assert.strictEqual(deep.ok, true);
  assert(deep.summary.includes("Decisions"));
  assert(deep.summary.includes("Handoffs"));
  const promoted = db.prepare("SELECT kind, layer, source FROM memory WHERE id=?").get(deep.promoted_memory_id);
  assert.strictEqual(promoted.kind, "memory_consolidation");
  assert.strictEqual(promoted.layer, "semantic");
}

{
  const rows = tool("mem_memory_consolidation_list", { project: "account", limit: 10 });
  assert(rows.count >= 2);
  assert(rows.runs[0].selected_refs.length >= 1);
  const journalEvents = db.prepare("SELECT COUNT(*) c FROM mnemo_event_journal WHERE source='memory_consolidation'").get().c;
  assert(journalEvents >= 2, "consolidation runs should be journaled");
}

{
  const journal = tool("mem_department_journal_add", {
    department_name: "backend",
    agent_name: "alfred",
    project: "account",
    progress: "Auth language binding was wired.",
    blockers: "Needs portal rollout.",
    dependencies: ["chat.blun.ai popup"],
  });
  assert.strictEqual(journal.ok, true);
  const listed = tool("mem_department_journal_list", { department_name: "backend", project: "account" });
  assert.strictEqual(listed.count, 1);

  const sleep = tool("mem_agent_sleep_note_add", {
    agent_name: "alfred",
    project: "account",
    learned: "Use Account as source of language truth.",
    recurring_errors: "Agents overwrite chat popup.",
  });
  assert.strictEqual(sleep.ok, true);
  assert.strictEqual(tool("mem_agent_sleep_note_list", { agent_name: "alfred" }).count, 1);
}

{
  const proposal = tool("mem_memory_promotion_propose", {
    proposal_kind: "decision",
    title: "Account owns language",
    body: "All portals must read logged-in language from account settings.",
    project: "account",
    agent_name: "alfred",
    evidence: [{ ref_kind: "memory", ref_id: "1" }],
  });
  assert.strictEqual(proposal.ok, true);
  const pending = tool("mem_memory_promotion_list", { status: "proposed", project: "account" });
  assert.strictEqual(pending.count, 1);
  const decided = tool("mem_memory_promotion_decide", { id: proposal.id, status: "promoted", reviewer: "dieter" });
  assert.strictEqual(decided.ok, true);
  assert(decided.promoted_ref.id, "promotion should write an official ref when promoted");
}

{
  const brief = tool("mem_company_rem_brief", { project: "account", write_brief: true, coordinator_agent: "dieter" });
  assert.strictEqual(brief.ok, true);
  assert(brief.markdown.includes("Coordinator REM Brief"));
  assert(brief.brief_id, "company REM brief should optionally write agent_brief");
}

console.log("test_memory_consolidation ok");
