"use strict";

const crypto = require("crypto");
const {
  boolFlag,
  cleanScope,
  compactContent,
  jsonSafe,
  normalizeAgentName,
  parseMaybeJson,
  uniqueStrings,
} = require("./shared_utils");
const { normalizeResourceKind, normalizeResourceKey } = require("./resource_access_control");

const DEFAULT_SCOPE = "default";
const RISKY_ACTIONS = new Set(["code_edit", "write", "delete", "move", "deploy", "external_comm", "migration", "billing", "auth", "production"]);

function nowIso() {
  return new Date().toISOString();
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function tableExists(db, tableName) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(tableName);
  } catch {
    return false;
  }
}

function safeJson(value, fallback) {
  if (value === undefined) return JSON.stringify(fallback);
  return jsonSafe(value, 30000) || JSON.stringify(fallback);
}

function parseJson(value, fallback) {
  return parseMaybeJson(value, fallback);
}

function normalizeDepartment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function normalizeRisk(value) {
  return String(value || "normal")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "normal";
}

function listInput(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return uniqueStrings(parsed);
  return uniqueStrings(String(value || "").split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean));
}

function textOrNull(value, max = 8000) {
  const text = compactContent(value, max);
  return text && text.trim() ? text : null;
}

function ensureAgentGovernanceSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS department_charter (
  scope TEXT NOT NULL DEFAULT 'default',
  department_name TEXT NOT NULL,
  mission TEXT,
  responsibilities_json TEXT,
  boundaries_json TEXT,
  standard_permissions_json TEXT,
  allowed_resources_json TEXT,
  escalation_rules_json TEXT,
  standing_permissions_json TEXT,
  autonomy_floor INTEGER NOT NULL DEFAULT 0,
  autonomy_ceiling INTEGER NOT NULL DEFAULT 3,
  default_risk_class TEXT NOT NULL DEFAULT 'normal',
  lead_agent TEXT,
  review_agent TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  meta_json TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope, department_name)
);
CREATE INDEX IF NOT EXISTS idx_department_charter_status ON department_charter(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS work_order_template (
  template_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  description TEXT,
  department_name TEXT,
  risk_class TEXT NOT NULL DEFAULT 'normal',
  action_type TEXT,
  allowed_tools_json TEXT,
  allowed_resources_json TEXT,
  done_criteria_json TEXT,
  required_evidence_json TEXT,
  quality_gates_json TEXT,
  runtime_contract_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'custom',
  meta_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_work_order_template_scope ON work_order_template(scope, status, template_id);

CREATE TABLE IF NOT EXISTS work_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  department_name TEXT,
  owner_agent TEXT,
  assigned_agent TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  risk_class TEXT NOT NULL DEFAULT 'normal',
  action_type TEXT,
  allowed_tools_json TEXT,
  allowed_resources_json TEXT,
  done_criteria_json TEXT,
  required_evidence_json TEXT,
  approval_ids_json TEXT,
  deadline_at TEXT,
  token_id TEXT,
  source_ref TEXT,
  created_by TEXT,
  completion_summary TEXT,
  handoff_id INTEGER,
  evidence_json TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_order_assigned ON work_order(assigned_agent, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_order_project ON work_order(project, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_order_department ON work_order(department_name, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS capability_token (
  token_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'default',
  work_order_id INTEGER,
  agent_name TEXT NOT NULL,
  department_name TEXT,
  project TEXT,
  risk_class TEXT NOT NULL DEFAULT 'normal',
  action_type TEXT,
  allowed_tools_json TEXT,
  allowed_resources_json TEXT,
  required_evidence_json TEXT,
  approval_ids_json TEXT,
  budgets_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  granted_by TEXT,
  reason TEXT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_capability_token_agent ON capability_token(agent_name, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_capability_token_work_order ON capability_token(work_order_id, status);

CREATE TABLE IF NOT EXISTS capability_token_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT,
  work_order_id INTEGER,
  agent_name TEXT,
  project TEXT,
  event_kind TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  matched_scope_json TEXT,
  missing_approval INTEGER NOT NULL DEFAULT 0,
  required_evidence_json TEXT,
  action_payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_capability_audit_token ON capability_token_audit(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capability_audit_agent ON capability_token_audit(agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS intent_route (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  intent_kind TEXT NOT NULL,
  agent_name TEXT,
  project TEXT,
  department_name TEXT,
  resource_kind TEXT,
  resource_key TEXT,
  summary TEXT,
  route_to_agent TEXT,
  route_to_department TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'routed',
  brief_id INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_intent_route_agent ON intent_route(route_to_agent, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intent_route_project ON intent_route(project, status, created_at DESC);

CREATE TABLE IF NOT EXISTS context_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  agent_name TEXT,
  runtime_name TEXT,
  work_order_id INTEGER,
  title TEXT,
  summary TEXT,
  decisions_json TEXT,
  remaining_work_json TEXT,
  files_json TEXT,
  routes_json TEXT,
  urls_json TEXT,
  branch TEXT,
  commit_sha TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_context_snapshot_project ON context_snapshot(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_snapshot_agent ON context_snapshot(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_snapshot_work_order ON context_snapshot(work_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quality_gate_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  gate_id TEXT NOT NULL,
  project TEXT,
  work_order_id INTEGER,
  agent_name TEXT,
  status TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  missing_json TEXT,
  invalid_json TEXT,
  evidence_json TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_quality_gate_run_project ON quality_gate_run(project, gate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quality_gate_run_work_order ON quality_gate_run(work_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS autonomy_score_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  agent_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  autonomy_level TEXT NOT NULL,
  status TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  factors_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_autonomy_score_agent ON autonomy_score_snapshot(agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS project_focus (
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT NOT NULL,
  surface TEXT,
  active_target TEXT,
  focus_summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  owner_agent TEXT,
  coordinator_agent TEXT,
  current_work_order_id INTEGER,
  must_do_json TEXT,
  must_not_do_json TEXT,
  source_ref TEXT,
  meta_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope, project)
);
CREATE INDEX IF NOT EXISTS idx_project_focus_status ON project_focus(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT NOT NULL,
  surface TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  category TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  owner_agent TEXT,
  assigned_agent TEXT,
  source_kind TEXT,
  source_id TEXT,
  source_ref TEXT,
  acceptance_json TEXT,
  blockers_json TEXT,
  evidence_json TEXT,
  linked_work_order_id INTEGER,
  meta_json TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_task_project ON project_task(project, status, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_task_assigned ON project_task(assigned_agent, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_task_source ON project_task(source_kind, source_id);

CREATE TABLE IF NOT EXISTS project_task_ingest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  project TEXT,
  brief_id INTEGER,
  status TEXT NOT NULL DEFAULT 'linked',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_ingest_source ON project_task_ingest(scope, source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_project_task_ingest_dedupe ON project_task_ingest(scope, dedupe_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_task_ingest_task ON project_task_ingest(task_id);
CREATE INDEX IF NOT EXISTS idx_project_task_ingest_brief ON project_task_ingest(brief_id);

CREATE TABLE IF NOT EXISTS user_intent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  user_name TEXT,
  source_channel TEXT,
  message_ref TEXT,
  intent_kind TEXT NOT NULL DEFAULT 'request',
  summary TEXT NOT NULL,
  exact_words TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'captured',
  linked_task_id INTEGER,
  linked_work_order_id INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_intent_project ON user_intent(project, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_intent_status ON user_intent(status, priority, created_at DESC);

CREATE TABLE IF NOT EXISTS project_channel_policy (
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT NOT NULL,
  telegram_role TEXT,
  brief_role TEXT,
  work_order_role TEXT,
  rules_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  meta_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope, project)
);
CREATE INDEX IF NOT EXISTS idx_project_channel_policy_status ON project_channel_policy(status, updated_at DESC);
`);
  try {
    db.exec(`
CREATE TRIGGER IF NOT EXISTS mnemo_journal_work_order_ai AFTER INSERT ON work_order BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('work_order', NEW.project, 'internal', NEW.created_by, 'work_order_insert', 'work_order', CAST(NEW.id AS TEXT), NEW.status, NEW.title || ': ' || NEW.objective, NEW.allowed_resources_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_capability_token_ai AFTER INSERT ON capability_token BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('capability_token', NEW.project, 'internal', NEW.granted_by, 'capability_token_insert', 'capability_token', NEW.token_id, NEW.status, COALESCE(NEW.reason, ''), NEW.allowed_resources_json, NEW.meta_json, NEW.issued_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_capability_audit_ai AFTER INSERT ON capability_token_audit BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('capability_token_audit', NEW.project, 'internal', NEW.agent_name, 'capability_token_check', 'capability_token_audit', CAST(NEW.id AS TEXT), CASE WHEN NEW.granted=1 THEN 'granted' ELSE 'blocked' END, NEW.reason, NEW.action_payload_json, NEW.matched_scope_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_context_snapshot_ai AFTER INSERT ON context_snapshot BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('context_snapshot', NEW.project, 'internal', NEW.agent_name, 'context_snapshot_create', 'context_snapshot', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.title, NEW.summary, ''), NEW.remaining_work_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_quality_gate_run_ai AFTER INSERT ON quality_gate_run BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('quality_gate', NEW.project, 'internal', NEW.agent_name, 'quality_gate_run', 'quality_gate_run', CAST(NEW.id AS TEXT), NEW.status, NEW.gate_id, NEW.evidence_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_project_focus_au AFTER UPDATE ON project_focus BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('project_focus', NEW.project, 'internal', NEW.updated_by, 'project_focus_update', 'project_focus', NEW.project, NEW.status, COALESCE(NEW.focus_summary, NEW.active_target, ''), NEW.must_do_json, NEW.meta_json, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_project_task_ai AFTER INSERT ON project_task BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('project_task', NEW.project, 'internal', NEW.created_by, 'project_task_insert', 'project_task', CAST(NEW.id AS TEXT), NEW.status, NEW.title, NEW.acceptance_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_user_intent_ai AFTER INSERT ON user_intent BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('user_intent', NEW.project, 'inbound', NEW.user_name, 'user_intent_capture', 'user_intent', CAST(NEW.id AS TEXT), NEW.status, NEW.summary, NEW.exact_words, NEW.meta_json, NEW.created_at);
END;
`);
  } catch {}
}

function normalizeAllowedResources(input = {}) {
  const direct = input.allowed_resources || input.resources_scope || input.resource_scope;
  const parsed = parseMaybeJson(direct, direct);
  const src = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : input;
  const out = [];
  const add = (kind, key, label) => {
    const k = normalizeResourceKind(kind);
    const normalized = normalizeResourceKey(k, key);
    if (!normalized) return;
    out.push({ resource_kind: k, resource_key: normalized, label: label || key });
  };
  for (const file of listInput(src.files)) add("file", file, file);
  for (const route of listInput(src.routes)) add("route", route, route);
  for (const domain of listInput(src.domains)) add("domain", domain, domain);
  for (const system of listInput(src.system_names || src.systems)) add("system", system, system);
  for (const item of Array.isArray(src.resources) ? src.resources : []) {
    if (!item || typeof item !== "object") continue;
    add(item.resource_kind || item.kind, item.resource_key || item.key || item.file_path || item.route || item.domain || item.system_name, item.label);
  }
  if (src.allow_all === true || src.all === true || listInput(src.resources).includes("*")) {
    out.push({ resource_kind: "*", resource_key: "*", label: "all" });
  }
  const seen = new Set();
  return out.filter((item) => {
    const key = item.resource_kind + ":" + item.resource_key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requestedResources(input = {}) {
  return normalizeAllowedResources(input);
}

function normalizeTools(value) {
  const tools = listInput(value);
  return tools.length ? tools : [];
}

function rowToCharter(row) {
  return row ? Object.assign({}, row, {
    responsibilities: parseJson(row.responsibilities_json, []),
    boundaries: parseJson(row.boundaries_json, []),
    standard_permissions: parseJson(row.standard_permissions_json, []),
    allowed_resources: parseJson(row.allowed_resources_json, []),
    escalation_rules: parseJson(row.escalation_rules_json, []),
    standing_permissions: parseJson(row.standing_permissions_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function departmentCharterSet(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const department = normalizeDepartment(input.department_name || input.department);
  const allowed = normalizeAllowedResources(input);
  db.prepare(`
    INSERT INTO department_charter
      (scope, department_name, mission, responsibilities_json, boundaries_json, standard_permissions_json, allowed_resources_json, escalation_rules_json, standing_permissions_json, autonomy_floor, autonomy_ceiling, default_risk_class, lead_agent, review_agent, status, meta_json, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(scope, department_name) DO UPDATE SET
      mission=excluded.mission,
      responsibilities_json=excluded.responsibilities_json,
      boundaries_json=excluded.boundaries_json,
      standard_permissions_json=excluded.standard_permissions_json,
      allowed_resources_json=excluded.allowed_resources_json,
      escalation_rules_json=excluded.escalation_rules_json,
      standing_permissions_json=excluded.standing_permissions_json,
      autonomy_floor=excluded.autonomy_floor,
      autonomy_ceiling=excluded.autonomy_ceiling,
      default_risk_class=excluded.default_risk_class,
      lead_agent=excluded.lead_agent,
      review_agent=excluded.review_agent,
      status=excluded.status,
      meta_json=excluded.meta_json,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(
    scope,
    department,
    textOrNull(input.mission),
    safeJson(listInput(input.responsibilities), []),
    safeJson(listInput(input.boundaries), []),
    safeJson(listInput(input.standard_permissions), []),
    safeJson(allowed, []),
    safeJson(listInput(input.escalation_rules), []),
    safeJson(listInput(input.standing_permissions), []),
    clampInt(input.autonomy_floor, 0, 0, 5),
    clampInt(input.autonomy_ceiling, 3, 0, 5),
    normalizeRisk(input.default_risk_class),
    normalizeAgentName(input.lead_agent || "") || null,
    normalizeAgentName(input.review_agent || "") || null,
    input.status || "active",
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  return { ok: true, charter: departmentCharterGet(db, { scope, department_name: department }).charter };
}

function departmentCharterGet(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const row = db.prepare("SELECT * FROM department_charter WHERE scope=? AND department_name=?").get(scopeName(input.scope), normalizeDepartment(input.department_name || input.department));
  return { ok: !!row, charter: rowToCharter(row) };
}

function departmentCharterList(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.status) { where.push("status=?"); params.push(input.status); }
  params.push(clampInt(input.limit, 100, 1, 500));
  const rows = db.prepare(`SELECT * FROM department_charter WHERE ${where.join(" AND ")} ORDER BY department_name ASC LIMIT ?`).all(...params).map(rowToCharter);
  return { ok: true, count: rows.length, charters: rows };
}

function expiresAt(input = {}) {
  if (input.expires_at) return new Date(input.expires_at).toISOString();
  const ttl = clampInt(input.ttl_minutes, 240, 1, 43200);
  return new Date(Date.now() + ttl * 60000).toISOString();
}

function rowToWorkOrder(row) {
  return row ? Object.assign({}, row, {
    allowed_tools: parseJson(row.allowed_tools_json, []),
    allowed_resources: parseJson(row.allowed_resources_json, []),
    done_criteria: parseJson(row.done_criteria_json, []),
    required_evidence: parseJson(row.required_evidence_json, []),
    approval_ids: parseJson(row.approval_ids_json, []),
    evidence: parseJson(row.evidence_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function rowToToken(row) {
  return row ? Object.assign({}, row, {
    allowed_tools: parseJson(row.allowed_tools_json, []),
    allowed_resources: parseJson(row.allowed_resources_json, []),
    required_evidence: parseJson(row.required_evidence_json, []),
    approval_ids: parseJson(row.approval_ids_json, []),
    budgets: parseJson(row.budgets_json, {}),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

const AGENT_NEUTRAL_RUNTIME_CONTRACT = Object.freeze({
  contract_version: "mnemo-agent-neutral-v1",
  agent_neutral: true,
  rule: "All runtimes use the same Mnemo tools. Claude, GPT/Codex, OpenClaw, and other adapters translate their local tool names into this contract; Mnemo remains the authority.",
  required_flow: [
    "mem_session_start + mem_context_preview at session start",
    "mem_work_order_create_from_template or mem_work_order_create before scoped work",
    "mem_capability_token_check or mem_runtime_tool_receipt_start before risky non-read actions",
    "mem_runtime_tool_receipt_finish after tool execution with concrete evidence",
    "mem_context_snapshot_create before handoff, compaction, or long pause",
    "mem_quality_gate_run and mem_work_order_complete before claiming done"
  ],
  low_risk_without_token: ["read", "inspect", "list"],
  risky_requires_token: ["code_edit", "write", "delete", "deploy", "external_comm", "auth", "billing", "production"]
});

const BUILTIN_WORK_ORDER_TEMPLATES = [
  {
    template_id: "general_task",
    title: "General scoped task",
    description: "Run a normal scoped task with explicit objective, owner, resources, and evidence.",
    department_name: "general",
    risk_class: "normal",
    action_type: "write",
    allowed_tools: ["read", "search", "apply_patch", "test"],
    done_criteria: ["Scope stayed within the Work Order", "Changes or findings are summarized", "Evidence covers the requested outcome"],
    required_evidence: ["diff reviewed or finding report", "verification result"],
    quality_gates: ["code_change_gate"],
  },
  {
    template_id: "debug_investigation",
    title: "Debug investigation",
    description: "Investigate root cause before fixing. No symptom patch without confirmed evidence.",
    department_name: "engineering",
    risk_class: "normal",
    action_type: "code_edit",
    allowed_tools: ["read", "search", "test", "apply_patch"],
    done_criteria: ["Root cause is stated", "Reproduction or trace is documented", "Fix addresses the root cause", "Regression or verification check passes"],
    required_evidence: ["root cause", "reproduction or trace", "regression test or verification command", "fresh verification"],
    quality_gates: ["debug_gate", "code_change_gate"],
  },
  {
    template_id: "browser_qa",
    title: "Browser QA",
    description: "Test a user-facing surface in a real browser with screenshots, console checks, and route coverage.",
    department_name: "qa",
    risk_class: "normal",
    action_type: "browser_qa",
    allowed_tools: ["browser", "playwright", "read", "screenshot"],
    done_criteria: ["Core route loads", "Console errors checked", "Interactive flow tested when relevant", "Screenshots or report attached"],
    required_evidence: ["browser screenshot", "console check", "route or page list", "issue report or pass summary"],
    quality_gates: ["browser_qa_gate"],
  },
  {
    template_id: "ship_release",
    title: "Ship or deploy release",
    description: "Run release work with tests, review, deploy proof, health check, and rollback path.",
    department_name: "deploy-ops",
    risk_class: "production",
    action_type: "deploy",
    allowed_tools: ["git", "test", "deploy", "curl", "browser"],
    done_criteria: ["Tests pass", "Diff/release reviewed", "Deployment health verified", "Rollback plan recorded"],
    required_evidence: ["tests", "diff reviewed", "deploy or push result", "production health check", "rollback plan"],
    quality_gates: ["release_gate"],
  },
  {
    template_id: "design_review",
    title: "Design review",
    description: "Review a UI surface for hierarchy, layout, responsive behavior, theme consistency, and content fit.",
    department_name: "frontend",
    risk_class: "normal",
    action_type: "review",
    allowed_tools: ["browser", "screenshot", "read", "search"],
    done_criteria: ["Desktop and mobile considered", "Theme and typography checked", "Findings are concrete and scoped"],
    required_evidence: ["screenshot", "viewport check", "design findings or pass summary"],
    quality_gates: ["design_review_gate"],
  },
  {
    template_id: "i18n_qa",
    title: "Language and i18n QA",
    description: "Verify language separation and translations without mixing locales or bypassing account/browser language rules.",
    department_name: "translations",
    risk_class: "normal",
    action_type: "browser_qa",
    allowed_tools: ["browser", "search", "read", "test"],
    done_criteria: ["Each requested locale is checked", "No mixed-language blocks remain", "Language source of truth is respected"],
    required_evidence: ["locale matrix", "mixed-language scan", "browser or route check"],
    quality_gates: ["i18n_gate"],
  },
  {
    template_id: "wizard_surface_work",
    title: "Wizard surface work",
    description: "Work on a wizard surface only after the target is explicit. Wizard1 and Wizard2 must not be mixed in one task.",
    department_name: "apps",
    risk_class: "normal",
    action_type: "code_edit",
    allowed_tools: ["read", "search", "apply_patch", "test", "browser"],
    done_criteria: ["Target explicitly names Wizard1 or Wizard2", "Builder/list/edit routes checked as applicable", "No fallback to the wrong builder", "Language separation checked"],
    required_evidence: ["explicit wizard target", "builder route check", "browser verification", "language check"],
    quality_gates: ["wizard_gate", "browser_qa_gate", "i18n_gate"],
  },
  {
    template_id: "context_checkpoint",
    title: "Context checkpoint",
    description: "Save decisions, remaining work, affected files, and branch state so another agent can resume safely.",
    department_name: "general",
    risk_class: "low",
    action_type: "read",
    allowed_tools: ["read", "git", "mem_context_snapshot_create"],
    done_criteria: ["Snapshot records current state", "Remaining work is concrete", "Uncertainty is named"],
    required_evidence: ["context snapshot"],
    quality_gates: ["context_handoff_gate"],
  },
];

const QUALITY_GATE_TEMPLATES = [
  { gate_id: "code_change_gate", title: "Code change gate", required_evidence: ["diff reviewed or finding report", "verification result"], minimum_score: 100 },
  { gate_id: "debug_gate", title: "Debug root-cause gate", required_evidence: ["root cause", "reproduction or trace", "fresh verification"], minimum_score: 100 },
  { gate_id: "browser_qa_gate", title: "Browser QA gate", required_evidence: ["browser screenshot", "console check", "route or page list"], minimum_score: 100 },
  { gate_id: "release_gate", title: "Release gate", required_evidence: ["tests", "deploy or push result", "production health check", "rollback plan"], minimum_score: 100 },
  { gate_id: "design_review_gate", title: "Design review gate", required_evidence: ["screenshot", "viewport check", "design findings or pass summary"], minimum_score: 100 },
  { gate_id: "i18n_gate", title: "i18n gate", required_evidence: ["locale matrix", "mixed-language scan", "browser or route check"], minimum_score: 100 },
  { gate_id: "wizard_gate", title: "Wizard target gate", required_evidence: ["explicit wizard target", "builder route check"], minimum_score: 100 },
  { gate_id: "context_handoff_gate", title: "Context handoff gate", required_evidence: ["context snapshot"], minimum_score: 100 },
];

function normalizeTemplateId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function rowToTemplate(row) {
  return row ? Object.assign({}, row, {
    allowed_tools: parseJson(row.allowed_tools_json, []),
    allowed_resources: parseJson(row.allowed_resources_json, []),
    done_criteria: parseJson(row.done_criteria_json, []),
    required_evidence: parseJson(row.required_evidence_json, []),
    quality_gates: parseJson(row.quality_gates_json, []),
    runtime_contract: parseJson(row.runtime_contract_json, AGENT_NEUTRAL_RUNTIME_CONTRACT),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function builtinTemplateRows(scope = DEFAULT_SCOPE) {
  return BUILTIN_WORK_ORDER_TEMPLATES.map((template) => rowToTemplate({
    template_id: template.template_id,
    scope,
    title: template.title,
    description: template.description,
    department_name: template.department_name,
    risk_class: template.risk_class,
    action_type: template.action_type,
    allowed_tools_json: JSON.stringify(template.allowed_tools || []),
    allowed_resources_json: JSON.stringify(template.allowed_resources || []),
    done_criteria_json: JSON.stringify(template.done_criteria || []),
    required_evidence_json: JSON.stringify(template.required_evidence || []),
    quality_gates_json: JSON.stringify(template.quality_gates || []),
    runtime_contract_json: JSON.stringify(AGENT_NEUTRAL_RUNTIME_CONTRACT),
    status: "active",
    source: "builtin",
    meta_json: JSON.stringify({ agent_neutral: true }),
    updated_by: "mnemo",
    created_at: null,
    updated_at: null,
  }));
}

function qualityGateTemplateList(_db, input = {}) {
  const filter = normalizeTemplateId(input.gate_id || input.id || "");
  const gates = QUALITY_GATE_TEMPLATES
    .filter((gate) => !filter || gate.gate_id === filter)
    .map((gate) => Object.assign({
      agent_neutral: true,
      runtime_contract: AGENT_NEUTRAL_RUNTIME_CONTRACT,
    }, gate));
  return { ok: true, count: gates.length, gates };
}

function workOrderTemplateList(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const idFilter = normalizeTemplateId(input.template_id || input.id || "");
  const includeInactive = input.include_inactive === true;
  const byId = new Map();
  for (const template of builtinTemplateRows(scope)) {
    if (idFilter && template.template_id !== idFilter) continue;
    byId.set(template.template_id, template);
  }
  const rows = db.prepare("SELECT * FROM work_order_template WHERE scope IN (?, 'default') ORDER BY updated_at DESC").all(scope).map(rowToTemplate);
  for (const row of rows) {
    if (!includeInactive && row.status !== "active") continue;
    if (idFilter && row.template_id !== idFilter) continue;
    byId.set(row.template_id, row);
  }
  const templates = Array.from(byId.values()).sort((a, b) => String(a.template_id).localeCompare(String(b.template_id)));
  return { ok: true, count: templates.length, templates };
}

function workOrderTemplateUpsert(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const templateId = normalizeTemplateId(input.template_id || input.id);
  if (!templateId) return { error: "template_id required" };
  const title = textOrNull(input.title, 240) || templateId;
  const scope = scopeName(input.scope);
  db.prepare(`
    INSERT INTO work_order_template
      (template_id, scope, title, description, department_name, risk_class, action_type, allowed_tools_json, allowed_resources_json, done_criteria_json, required_evidence_json, quality_gates_json, runtime_contract_json, status, source, meta_json, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(template_id) DO UPDATE SET
      scope=excluded.scope,
      title=excluded.title,
      description=excluded.description,
      department_name=excluded.department_name,
      risk_class=excluded.risk_class,
      action_type=excluded.action_type,
      allowed_tools_json=excluded.allowed_tools_json,
      allowed_resources_json=excluded.allowed_resources_json,
      done_criteria_json=excluded.done_criteria_json,
      required_evidence_json=excluded.required_evidence_json,
      quality_gates_json=excluded.quality_gates_json,
      runtime_contract_json=excluded.runtime_contract_json,
      status=excluded.status,
      source=excluded.source,
      meta_json=excluded.meta_json,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(
    templateId,
    scope,
    title,
    textOrNull(input.description || input.objective || input.summary, 4000),
    input.department_name || input.department ? normalizeDepartment(input.department_name || input.department) : null,
    normalizeRisk(input.risk_class),
    input.action_type || null,
    safeJson(normalizeTools(input.allowed_tools || input.tools), []),
    safeJson(normalizeAllowedResources(input), []),
    safeJson(listInput(input.done_criteria), []),
    safeJson(listInput(input.required_evidence || input.evidence_required), []),
    safeJson(listInput(input.quality_gates), []),
    safeJson(Object.assign({}, AGENT_NEUTRAL_RUNTIME_CONTRACT, input.runtime_contract || {}), AGENT_NEUTRAL_RUNTIME_CONTRACT),
    input.status || "active",
    input.source || "custom",
    safeJson(Object.assign({ agent_neutral: true }, input.meta || {}), {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  return { ok: true, template: workOrderTemplateList(db, { scope, template_id: templateId, include_inactive: true }).templates[0] || null };
}

function getWorkOrderTemplate(db, input = {}) {
  const templateId = normalizeTemplateId(input.template_id || input.id || input.kind || "general_task");
  return workOrderTemplateList(db, Object.assign({}, input, { template_id: templateId, include_inactive: false })).templates[0] || null;
}

function workOrderCreateFromTemplate(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const template = getWorkOrderTemplate(db, input);
  if (!template) return { error: "work_order_template_not_found", template_id: normalizeTemplateId(input.template_id || input.id || input.kind) };
  const requiredEvidence = uniqueStrings([].concat(template.required_evidence || [], listInput(input.required_evidence || input.evidence_required)));
  const doneCriteria = uniqueStrings([].concat(template.done_criteria || [], listInput(input.done_criteria)));
  const allowedTools = uniqueStrings([].concat(template.allowed_tools || [], normalizeTools(input.allowed_tools || input.tools)));
  const templateResources = Array.isArray(template.allowed_resources) ? template.allowed_resources : [];
  const inputResources = normalizeAllowedResources(input);
  const meta = Object.assign({}, template.meta || {}, input.meta || {}, {
    template_id: template.template_id,
    quality_gates: uniqueStrings([].concat(template.quality_gates || [], listInput(input.quality_gates))),
    runtime_contract: Object.assign({}, AGENT_NEUTRAL_RUNTIME_CONTRACT, template.runtime_contract || {}, input.runtime_contract || {}),
    agent_neutral: true,
  });
  return workOrderCreate(db, Object.assign({}, input, {
    title: input.title || template.title,
    objective: input.objective || input.summary || input.task || template.description,
    department_name: input.department_name || input.department || template.department_name,
    risk_class: input.risk_class || template.risk_class,
    action_type: input.action_type || template.action_type,
    allowed_tools: allowedTools,
    resources: templateResources.concat(inputResources),
    done_criteria: doneCriteria,
    required_evidence: requiredEvidence,
    meta,
  }));
}

function rowToSnapshot(row) {
  return row ? Object.assign({}, row, {
    dirty: !!row.dirty,
    decisions: parseJson(row.decisions_json, []),
    remaining_work: parseJson(row.remaining_work_json, []),
    files: parseJson(row.files_json, []),
    routes: parseJson(row.routes_json, []),
    urls: parseJson(row.urls_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function contextSnapshotCreate(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const agent = normalizeAgentName(input.agent_name || input.agent);
  const summary = textOrNull(input.summary || input.context || input.notes, 8000);
  if (!summary) return { error: "summary required" };
  const info = db.prepare(`
    INSERT INTO context_snapshot
      (scope, project, agent_name, runtime_name, work_order_id, title, summary, decisions_json, remaining_work_json, files_json, routes_json, urls_json, branch, commit_sha, dirty, source_ref, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scopeName(input.scope),
    input.project || null,
    agent || null,
    input.runtime_name || input.runtime || null,
    input.work_order_id || null,
    textOrNull(input.title, 240) || "Context snapshot",
    summary,
    safeJson(listInput(input.decisions), []),
    safeJson(listInput(input.remaining_work || input.remaining || input.next_steps), []),
    safeJson(listInput(input.files), []),
    safeJson(listInput(input.routes), []),
    safeJson(listInput(input.urls), []),
    input.branch || null,
    input.commit_sha || input.commit || null,
    input.dirty ? 1 : 0,
    input.source_ref || null,
    input.status || "active",
    safeJson(Object.assign({ agent_neutral: true }, input.meta || {}), {})
  );
  return { ok: true, snapshot: rowToSnapshot(db.prepare("SELECT * FROM context_snapshot WHERE id=?").get(info.lastInsertRowid)) };
}

function formatList(title, values) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return [`## ${title}`, "- (none recorded)"].join("\n");
  return [`## ${title}`].concat(list.map((item) => "- " + String(item))).join("\n");
}

function contextRestoreBrief(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.id || input.snapshot_id) {
    where.push("id=?");
    params.push(parseInt(input.id || input.snapshot_id, 10));
  } else {
    if (input.project) { where.push("project=?"); params.push(input.project); }
    if (input.agent_name || input.agent) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name || input.agent)); }
    if (input.work_order_id) { where.push("work_order_id=?"); params.push(parseInt(input.work_order_id, 10)); }
    if (input.status) { where.push("status=?"); params.push(input.status); }
  }
  const row = db.prepare(`SELECT * FROM context_snapshot WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 1`).get(...params);
  const snapshot = rowToSnapshot(row);
  if (!snapshot) return { error: "context_snapshot_not_found" };
  const brief = [
    "# Mnemo Context Restore Brief",
    "",
    "Snapshot: #" + snapshot.id,
    "Project: " + (snapshot.project || "unspecified"),
    "Agent: " + (snapshot.agent_name || "unspecified"),
    "Runtime: " + (snapshot.runtime_name || "unspecified"),
    "Work Order: " + (snapshot.work_order_id || "none"),
    "Branch: " + (snapshot.branch || "unknown") + (snapshot.commit_sha ? " @ " + snapshot.commit_sha : "") + (snapshot.dirty ? " (dirty)" : ""),
    "Saved: " + snapshot.created_at,
    "",
    "## Summary",
    snapshot.summary || "(none)",
    "",
    formatList("Decisions", snapshot.decisions),
    "",
    formatList("Remaining Work", snapshot.remaining_work),
    "",
    formatList("Files", snapshot.files),
    "",
    formatList("Routes", snapshot.routes),
    "",
    "## Resume Rule",
    "- Treat this brief as context, not company truth.",
    "- Check current repo state and Mnemo gates before editing.",
    "- If target/scope changed, create or update a Work Order before work."
  ].join("\n");
  return { ok: true, snapshot, brief };
}

function rowToGateRun(row) {
  return row ? Object.assign({}, row, {
    missing: parseJson(row.missing_json, []),
    invalid: parseJson(row.invalid_json, []),
    evidence: parseJson(row.evidence_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function qualityGateRun(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const gateId = normalizeTemplateId(input.gate_id || input.template_id || input.gate || "code_change_gate");
  const gate = QUALITY_GATE_TEMPLATES.find((item) => item.gate_id === gateId);
  if (!gate) return { error: "quality_gate_template_not_found", gate_id: gateId };
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  let workOrder = null;
  if (input.work_order_id) {
    workOrder = rowToWorkOrder(db.prepare("SELECT * FROM work_order WHERE id=?").get(parseInt(input.work_order_id, 10)));
    if (!workOrder) return { error: "work_order_not_found", work_order_id: input.work_order_id };
  }
  const requirements = uniqueStrings([]
    .concat(gate.required_evidence || [])
    .concat(input.include_work_order_evidence === false ? [] : (workOrder && workOrder.required_evidence || []))
    .concat(listInput(input.required_evidence)));
  const invalid = evidence.map(validateEvidenceItem).filter(Boolean).concat(evidence.map(nonPassEvidenceReason).filter(Boolean));
  const missing = requirements.filter((requirement) => !evidence.some((item) => evidenceMatchesRequirement(item, requirement)));
  const score = Math.max(0, 100 - invalid.length * 25 - missing.length * 20);
  const status = invalid.length || missing.length || score < (gate.minimum_score || 100) ? "block" : "pass";
  let run = null;
  if (input.persist !== false) {
    const info = db.prepare(`
      INSERT INTO quality_gate_run
        (scope, gate_id, project, work_order_id, agent_name, status, score, missing_json, invalid_json, evidence_json, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      scopeName(input.scope),
      gateId,
      input.project || (workOrder && workOrder.project) || null,
      input.work_order_id || null,
      normalizeAgentName(input.agent_name || input.agent || "") || null,
      status,
      score,
      safeJson(missing, []),
      safeJson(invalid, []),
      safeJson(evidence, []),
      safeJson(Object.assign({ agent_neutral: true }, input.meta || {}), {})
    );
    run = rowToGateRun(db.prepare("SELECT * FROM quality_gate_run WHERE id=?").get(info.lastInsertRowid));
  }
  return {
    ok: status === "pass",
    status,
    score,
    gate,
    required_evidence: requirements,
    missing,
    invalid,
    run,
    hint: status === "pass" ? "Quality gate passed." : "Do not mark done. Add passing evidence or use needs_review/blocked.",
  };
}

function workOrderCreate(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const title = textOrNull(input.title, 240) || textOrNull(input.objective, 120) || "Work order";
  const objective = textOrNull(input.objective || input.summary || input.task, 8000);
  if (!objective) return { error: "objective required" };
  const scope = scopeName(input.scope);
  const department = input.department_name || input.department ? normalizeDepartment(input.department_name || input.department) : null;
  const agent = input.assigned_agent || input.agent_name ? normalizeAgentName(input.assigned_agent || input.agent_name) : null;
  const allowedResources = normalizeAllowedResources(input);
  const requiredEvidence = listInput(input.required_evidence || input.evidence_required);
  const approvalIds = listInput(input.approval_ids).map(String);
  const info = db.prepare(`
    INSERT INTO work_order
      (scope, project, title, objective, department_name, owner_agent, assigned_agent, status, risk_class, action_type, allowed_tools_json, allowed_resources_json, done_criteria_json, required_evidence_json, approval_ids_json, deadline_at, source_ref, created_by, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scope,
    input.project || null,
    title,
    objective,
    department,
    normalizeAgentName(input.owner_agent || "") || null,
    agent,
    input.status || "open",
    normalizeRisk(input.risk_class),
    input.action_type || null,
    safeJson(normalizeTools(input.allowed_tools || input.tools), []),
    safeJson(allowedResources, []),
    safeJson(listInput(input.done_criteria), []),
    safeJson(requiredEvidence, []),
    safeJson(approvalIds, []),
    input.deadline_at || null,
    input.source_ref || null,
    normalizeAgentName(input.created_by || input.owner_agent || input.agent_name || "") || null,
    safeJson(input.meta || {}, {})
  );
  const workOrderId = info.lastInsertRowid;
  let token = null;
  if (input.issue_token !== false && agent) {
    token = capabilityTokenIssue(db, Object.assign({}, input, {
      scope,
      work_order_id: workOrderId,
      agent_name: agent,
      department_name: department,
      allowed_resources: { resources: allowedResources },
      required_evidence: requiredEvidence,
      approval_ids: approvalIds,
      reason: input.reason || "issued from work order #" + workOrderId,
      granted_by: input.created_by || input.owner_agent || input.agent_name,
    }));
    if (token && token.token_id) {
      db.prepare("UPDATE work_order SET token_id=?, status=CASE WHEN status='open' THEN 'issued' ELSE status END, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(token.token_id, workOrderId);
    }
  }
  return { ok: true, work_order: rowToWorkOrder(db.prepare("SELECT * FROM work_order WHERE id=?").get(workOrderId)), token };
}

function workOrderList(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.assigned_agent || input.agent_name) { where.push("assigned_agent=?"); params.push(normalizeAgentName(input.assigned_agent || input.agent_name)); }
  if (input.owner_agent) { where.push("owner_agent=?"); params.push(normalizeAgentName(input.owner_agent)); }
  if (input.department_name || input.department) { where.push("department_name=?"); params.push(normalizeDepartment(input.department_name || input.department)); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  else if (!input.include_done) where.push("status NOT IN ('done','cancelled')");
  params.push(clampInt(input.limit, 100, 1, 500));
  const rows = db.prepare(`SELECT * FROM work_order WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(...params).map(rowToWorkOrder);
  return { ok: true, count: rows.length, work_orders: rows };
}

function normalizeEvidenceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceText(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [
    item.check,
    item.name,
    item.label,
    item.test_step,
    item.command,
    item.result,
    item.status,
    item.summary,
    item.file_path,
    item.url,
    item.output_ref,
    item.receipt_id,
  ];
  for (const field of ["files", "urls", "artifacts", "screenshots", "required_evidence"]) {
    if (Array.isArray(item[field])) parts.push(...item[field]);
  }
  return normalizeEvidenceText(parts.filter(Boolean).join(" "));
}

function evidenceMatchesRequirement(item, requirement) {
  const req = normalizeEvidenceText(requirement);
  if (!req) return true;
  const text = evidenceText(item);
  if (!text) return false;
  if (text.includes(req)) return true;
  const tokens = req.split(" ").filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

function validateEvidenceItem(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return "evidence[" + index + "] must be an object";
  }
  const hasOutcome = item.result != null || item.status != null || item.exit_code != null || item.exitCode != null;
  const hasCheck = !!textOrNull(item.check || item.name || item.label || item.test_step || item.command, 2000);
  const hasTarget = !!textOrNull(item.file_path || item.url || item.output_ref || item.receipt_id || item.screenshot_path || item.media_id, 2000)
    || ["files", "urls", "artifacts", "screenshots"].some((field) => Array.isArray(item[field]) && item[field].length > 0);
  if (!hasOutcome) {
    return "evidence[" + index + "] needs result/status/exit_code";
  }
  if (!hasCheck && !hasTarget) {
    return "evidence[" + index + "] needs command/test_step/check or file/url/artifact reference";
  }
  if (item.command && item.exit_code == null && item.exitCode == null) {
    return "evidence[" + index + "] command evidence needs exit_code";
  }
  return null;
}

function nonPassEvidenceReason(item, index) {
  const exitCode = item && (item.exit_code != null ? item.exit_code : item.exitCode);
  if (exitCode != null) {
    const n = Number(exitCode);
    if (!Number.isFinite(n) || n !== 0) {
      return "evidence[" + index + "] exit_code must be 0 for done";
    }
  }
  const outcome = normalizeEvidenceText([item && item.result, item && item.status].filter(Boolean).join(" "));
  if (outcome && /\b(fail|failed|failure|error|errored|exception|blocked|block|needs review|needs_review|incomplete|missing|skipped|cancelled|canceled|timeout|timed out|red|not ok|nok)\b/.test(outcome)) {
    return "evidence[" + index + "] outcome is not passing for done";
  }
  return null;
}

function validateWorkOrderCompletionEvidence(order, input = {}, evidence = []) {
  const status = String(input.status || "done").toLowerCase();
  if (status !== "done") {
    return { ok: true, status, missing_required: [], invalid: [], required_evidence: order.required_evidence || [] };
  }
  if (!evidence.length) {
    return {
      ok: false,
      error: "evidence_required",
      status,
      missing_required: order.required_evidence || [],
      invalid: [],
      required_evidence: order.required_evidence || [],
      hint: "done requires concrete evidence. Use status needs_review or blocked when verification is not available.",
    };
  }
  const invalid = evidence.map(validateEvidenceItem).filter(Boolean);
  if (invalid.length) {
    return {
      ok: false,
      error: "evidence_invalid",
      status,
      missing_required: [],
      invalid,
      required_evidence: order.required_evidence || [],
      hint: "Evidence must include concrete checks with result/status/exit_code and relevant command/file/url/artifact references.",
    };
  }
  const failing = evidence.map(nonPassEvidenceReason).filter(Boolean);
  if (failing.length) {
    return {
      ok: false,
      error: "evidence_not_passing",
      status,
      missing_required: [],
      invalid: failing,
      required_evidence: order.required_evidence || [],
      hint: "done requires passing evidence. Use status needs_review or blocked for failed checks, non-zero exit codes, or incomplete verification.",
    };
  }
  const missing = (order.required_evidence || []).filter((requirement) => !evidence.some((item) => evidenceMatchesRequirement(item, requirement)));
  if (missing.length) {
    return {
      ok: false,
      error: "evidence_missing_required",
      status,
      missing_required: missing,
      invalid: [],
      required_evidence: order.required_evidence || [],
      hint: "Each required_evidence item must be explicitly covered by at least one evidence object, preferably with check/name/label.",
    };
  }
  return { ok: true, status, missing_required: [], invalid: [], required_evidence: order.required_evidence || [] };
}

function workOrderComplete(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const id = parseInt(input.id || input.work_order_id, 10);
  if (!id) return { error: "work_order_id required" };
  const row = db.prepare("SELECT * FROM work_order WHERE id=?").get(id);
  if (!row) return { error: "work_order_not_found", work_order_id: id };
  const order = rowToWorkOrder(row);
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const evidenceCheck = validateWorkOrderCompletionEvidence(order, input, evidence);
  if (!evidenceCheck.ok) {
    return Object.assign({ work_order_id: id }, evidenceCheck);
  }
  const status = evidenceCheck.status || "done";
  const completedAtSql = status === "done" || status === "cancelled"
    ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    : "completed_at";
  db.prepare(`
    UPDATE work_order
    SET status=?, completion_summary=?, handoff_id=?, evidence_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_at=${completedAtSql}
    WHERE id=?
  `).run(
    status,
    textOrNull(input.completion_summary || input.summary || input.result, 8000),
    input.handoff_id || null,
    safeJson(evidence, []),
    id
  );
  return { ok: true, status, evidence_check: evidenceCheck, work_order: rowToWorkOrder(db.prepare("SELECT * FROM work_order WHERE id=?").get(id)) };
}

function capabilityTokenIssue(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const agent = normalizeAgentName(input.agent_name || input.assigned_agent);
  if (!agent) return { error: "agent_name required" };
  const scope = scopeName(input.scope);
  const workOrder = input.work_order_id ? db.prepare("SELECT * FROM work_order WHERE id=?").get(parseInt(input.work_order_id, 10)) : null;
  if (input.work_order_id && !workOrder) return { error: "work_order_not_found", work_order_id: input.work_order_id };
  const wo = rowToWorkOrder(workOrder);
  const allowedResources = normalizeAllowedResources(input.allowed_resources ? input : (wo ? { allowed_resources: { resources: wo.allowed_resources } } : input));
  const allowedTools = normalizeTools(input.allowed_tools || input.tools || (wo && wo.allowed_tools));
  const requiredEvidence = listInput(input.required_evidence || (wo && wo.required_evidence) || input.evidence_required);
  const approvalIds = listInput(input.approval_ids || (wo && wo.approval_ids)).map(String);
  const tokenId = input.token_id || "cap-" + sha([scope, agent, input.work_order_id || "", nowIso(), Math.random()].join("|")).slice(0, 24);
  db.prepare(`
    INSERT INTO capability_token
      (token_id, scope, work_order_id, agent_name, department_name, project, risk_class, action_type, allowed_tools_json, allowed_resources_json, required_evidence_json, approval_ids_json, budgets_json, status, granted_by, reason, expires_at, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    tokenId,
    scope,
    input.work_order_id || null,
    agent,
    input.department_name ? normalizeDepartment(input.department_name) : (wo && wo.department_name) || null,
    input.project || (wo && wo.project) || null,
    normalizeRisk(input.risk_class || (wo && wo.risk_class)),
    input.action_type || (wo && wo.action_type) || null,
    safeJson(allowedTools, []),
    safeJson(allowedResources, []),
    safeJson(requiredEvidence, []),
    safeJson(approvalIds, []),
    safeJson(input.budgets || {}, {}),
    input.status || "active",
    normalizeAgentName(input.granted_by || input.created_by || "") || null,
    textOrNull(input.reason || "capability token issued", 1200),
    expiresAt(input),
    safeJson(input.meta || {}, {})
  );
  return { ok: true, token_id: tokenId, token: rowToToken(db.prepare("SELECT * FROM capability_token WHERE token_id=?").get(tokenId)) };
}

function toolMatches(allowedTools, requestedTool) {
  if (!requestedTool || !allowedTools.length || allowedTools.includes("*")) return true;
  const req = String(requestedTool).toLowerCase();
  return allowedTools.some((tool) => {
    const allowed = String(tool || "").toLowerCase();
    if (allowed === req) return true;
    if (allowed.endsWith("*")) return req.startsWith(allowed.slice(0, -1));
    return false;
  });
}

function resourceMatchesOne(allowed, requested) {
  if (!allowed || !requested) return false;
  if (allowed.resource_kind === "*" && allowed.resource_key === "*") return true;
  if (allowed.resource_kind !== requested.resource_kind) return false;
  const a = String(allowed.resource_key || "");
  const r = String(requested.resource_key || "");
  if (a === r) return true;
  if (a.endsWith("*")) return r.startsWith(a.slice(0, -1));
  if (allowed.resource_kind === "file" && (a.endsWith("/") || a.endsWith("/*"))) {
    const prefix = a.replace(/\*$/, "");
    return r.startsWith(prefix);
  }
  return false;
}

function matchRequestedResources(allowedResources, requested) {
  if (!requested.length) return { ok: true, matched: [], missing: [] };
  if (!allowedResources.length) return { ok: false, matched: [], missing: requested };
  const matched = [];
  const missing = [];
  for (const req of requested) {
    const hit = allowedResources.find((allowed) => resourceMatchesOne(allowed, req));
    if (hit) matched.push({ requested: req, allowed: hit });
    else missing.push(req);
  }
  return { ok: missing.length === 0, matched, missing };
}

function isCriticalRisk(risk) {
  return /^(critical|live-risk|production|billing-risk|auth-risk|deploy|billing|auth)$/.test(normalizeRisk(risk));
}

function requiresCapabilityToken(input = {}) {
  const action = String(input.action_type || "").toLowerCase();
  const text = [
    input.task,
    input.summary,
    input.tool_name,
    action,
    Array.isArray(input.files) ? input.files.join(" ") : "",
    Array.isArray(input.routes) ? input.routes.join(" ") : "",
    Array.isArray(input.domains) ? input.domains.join(" ") : "",
    Array.isArray(input.system_names) ? input.system_names.join(" ") : "",
  ].filter(Boolean).join(" ").toLowerCase();
  if (RISKY_ACTIONS.has(action)) return true;
  if (/\b(edit|write|patch|delete|remove|move|rename|deploy|restart|pm2|nginx|dns|migrate|migration|stripe|billing|vat|auth|login|oauth|session|production|live)\b/.test(text)) return true;
  if ((Array.isArray(input.files) && input.files.length) && action !== "read") return true;
  if ((Array.isArray(input.routes) && input.routes.length) && action !== "read") return true;
  if ((Array.isArray(input.domains) && input.domains.length) && action !== "read") return true;
  if ((Array.isArray(input.system_names) && input.system_names.length) && action !== "read") return true;
  if (Array.isArray(input.resources) && input.resources.length && action !== "read") return true;
  return false;
}

function auditTokenCheck(db, token, input, result) {
  ensureAgentGovernanceSchema(db);
  const info = db.prepare(`
    INSERT INTO capability_token_audit
      (token_id, work_order_id, agent_name, project, event_kind, granted, reason, matched_scope_json, missing_approval, required_evidence_json, action_payload_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    token && token.token_id || input.token_id || input.capability_token_id || null,
    token && token.work_order_id || input.work_order_id || null,
    normalizeAgentName(input.agent_name || token && token.agent_name || ""),
    input.project || token && token.project || null,
    input.event_kind || "check",
    result.granted ? 1 : 0,
    result.reason || null,
    safeJson(result.matched_scope || {}, {}),
    result.missing_approval ? 1 : 0,
    safeJson(result.required_evidence || [], []),
    safeJson(input, {})
  );
  return info.lastInsertRowid;
}

function capabilityTokenCheck(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const tokenId = String(input.token_id || input.capability_token_id || input.capability_token || "").trim();
  const required = requiresCapabilityToken(input);
  if (!required && !tokenId) {
    const result = { ok: true, granted: true, reason: "capability token not required for low-risk/read action", required: false, matched_scope: {}, missing_approval: false, required_evidence: [], expires_at: null };
    result.audit_id = auditTokenCheck(db, null, input, result);
    return result;
  }
  if (!tokenId) {
    const result = { ok: false, granted: false, reason: "capability_token_required", required: true, matched_scope: {}, missing_approval: false, required_evidence: [], expires_at: null };
    result.audit_id = auditTokenCheck(db, null, input, result);
    return result;
  }
  const token = rowToToken(db.prepare("SELECT * FROM capability_token WHERE token_id=?").get(tokenId));
  if (!token) {
    const result = { ok: false, granted: false, reason: "capability_token_not_found", required: true, matched_scope: {}, missing_approval: false, required_evidence: [], expires_at: null };
    result.audit_id = auditTokenCheck(db, null, input, result);
    return result;
  }
  const blockers = [];
  const agent = normalizeAgentName(input.agent_name);
  if (token.status !== "active") blockers.push("token status is " + token.status);
  if (Date.parse(token.expires_at) < Date.now()) blockers.push("token expired");
  if (agent && token.agent_name !== agent) blockers.push("token belongs to " + token.agent_name);
  if (input.work_order_id && token.work_order_id && Number(input.work_order_id) !== Number(token.work_order_id)) blockers.push("token belongs to work_order #" + token.work_order_id);
  if (input.project && token.project && input.project !== token.project) blockers.push("token project mismatch");
  if (token.action_type && input.action_type && String(token.action_type).toLowerCase() !== String(input.action_type).toLowerCase()) blockers.push("token action_type mismatch");
  if (!toolMatches(token.allowed_tools || [], input.tool_name)) blockers.push("tool not covered by token");
  const requested = requestedResources(input);
  const resourceMatch = matchRequestedResources(token.allowed_resources || [], requested);
  if (!resourceMatch.ok) blockers.push("requested resources not covered by token");
  const approvals = uniqueStrings([])
    .concat(Array.isArray(input.approval_ids) ? input.approval_ids.map(String) : [])
    .concat(token.approval_ids || []);
  const missingApproval = (input.require_approval === true || boolFlag(token.meta && token.meta.requires_approval, false) || isCriticalRisk(token.risk_class)) &&
    approvals.length === 0 &&
    !boolFlag(token.meta && token.meta.approval_not_required, false);
  if (missingApproval) blockers.push("approval required for token risk class");
  const result = {
    ok: blockers.length === 0,
    granted: blockers.length === 0,
    reason: blockers.length ? blockers.join("; ") : "capability token grants this action",
    required,
    token_id: token.token_id,
    work_order_id: token.work_order_id,
    agent_name: token.agent_name,
    project: token.project,
    matched_scope: { resources: resourceMatch.matched, missing_resources: resourceMatch.missing, tool_name: input.tool_name || null },
    missing_approval: missingApproval,
    required_evidence: token.required_evidence || [],
    expires_at: token.expires_at,
  };
  result.audit_id = auditTokenCheck(db, token, input, result);
  return result;
}

function capabilityTokenRevoke(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const tokenId = String(input.token_id || input.capability_token_id || "").trim();
  const by = normalizeAgentName(input.revoked_by || input.agent_name || "");
  if (!tokenId || !by) return { error: "token_id + revoked_by required" };
  const info = db.prepare("UPDATE capability_token SET status='revoked', revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=COALESCE(?, meta_json) WHERE token_id=? AND status='active'")
    .run(input.meta ? safeJson(input.meta, {}) : null, tokenId);
  const result = { granted: false, reason: input.reason || "token revoked", matched_scope: {}, missing_approval: false, required_evidence: [] };
  const auditId = auditTokenCheck(db, { token_id: tokenId }, { token_id: tokenId, agent_name: by, event_kind: "revoke" }, result);
  return { ok: info.changes > 0, token_id: tokenId, revoked_by: by, audit_id: auditId };
}

function resourceOwner(db, input = {}) {
  if (!tableExists(db, "org_resource")) return null;
  const kind = normalizeResourceKind(input.resource_kind);
  const key = normalizeResourceKey(kind, input.resource_key || input.file_path || input.route || input.domain || input.system_name);
  if (!kind || !key) return null;
  try {
    return db.prepare("SELECT * FROM org_resource WHERE scope=? AND resource_kind=? AND resource_key=? AND status='active' ORDER BY updated_at DESC LIMIT 1")
      .get(scopeName(input.scope), kind, key) || null;
  } catch {
    return null;
  }
}

function departmentLead(db, scope, department) {
  const charter = departmentCharterGet(db, { scope, department_name: department }).charter;
  if (charter && (charter.lead_agent || charter.review_agent)) return charter.lead_agent || charter.review_agent;
  if (tableExists(db, "department")) {
    try {
      const row = db.prepare("SELECT lead_agent, review_agent FROM department WHERE name=?").get(department);
      if (row) return row.lead_agent || row.review_agent || null;
    } catch {}
  }
  return null;
}

function intentRoute(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const intentKind = String(input.intent_kind || input.intent || "request").toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  const department = input.department_name || input.department ? normalizeDepartment(input.department_name || input.department) : null;
  const owner = resourceOwner(db, input);
  const targetDepartment = department || (owner && owner.owning_department) || null;
  const routeToAgent = normalizeAgentName(input.route_to_agent || (owner && owner.owner_agent) || (targetDepartment && departmentLead(db, scope, targetDepartment)) || process.env.MNEMO_DEFAULT_COORDINATOR || "dieter");
  const routeToDepartment = input.route_to_department || targetDepartment || null;
  const reason = input.reason || (owner ? `resource owner ${owner.owner_agent || "unknown"}` : (targetDepartment ? `department lead for ${targetDepartment}` : "default coordinator"));
  let briefId = null;
  if (input.write_brief === true && tableExists(db, "agent_brief")) {
    const content = [
      "# Intent Route",
      "",
      "## Intent",
      intentKind,
      "",
      "## Request",
      input.summary || input.request || input.reason || "",
      "",
      "## Project",
      input.project || "unspecified",
      "",
      "## Resource",
      [input.resource_kind, input.resource_key || input.file_path || input.route || input.domain || input.system_name].filter(Boolean).join(":") || "unspecified",
      "",
      "## Report Back",
      "- decision or route result",
      "- approval/denial if access-related",
    ].join("\n");
    const info = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
      .run(routeToAgent, normalizeAgentName(input.agent_name || "intent-router"), content, safeJson({ intent_kind: intentKind, project: input.project || null }, {}));
    briefId = info.lastInsertRowid;
  }
  const info = db.prepare(`
    INSERT INTO intent_route
      (scope, intent_kind, agent_name, project, department_name, resource_kind, resource_key, summary, route_to_agent, route_to_department, reason, status, brief_id, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scope,
    intentKind,
    normalizeAgentName(input.agent_name || "") || null,
    input.project || null,
    targetDepartment,
    input.resource_kind ? normalizeResourceKind(input.resource_kind) : null,
    input.resource_key ? normalizeResourceKey(input.resource_kind, input.resource_key) : null,
    textOrNull(input.summary || input.request || input.reason, 1200),
    routeToAgent,
    routeToDepartment,
    reason,
    input.status || "routed",
    briefId,
    safeJson(input.meta || {}, {})
  );
  return { ok: true, id: info.lastInsertRowid, intent_kind: intentKind, route_to_agent: routeToAgent, route_to_department: routeToDepartment, reason, brief_id: briefId };
}

function countRows(db, sql, params = []) {
  try { return db.prepare(sql).get(...params).c || 0; } catch { return 0; }
}

function autonomyLevel(score) {
  if (score < 50) return "L0";
  if (score < 65) return "L1";
  if (score < 80) return "L2";
  if (score < 90) return "L3";
  return "L4";
}

function autonomyMeaning(level) {
  return {
    L0: "read-only",
    L1: "proposals and reports",
    L2: "own low-risk files with token",
    L3: "tests/builds and normal work orders with token",
    L4: "limited low-risk deployments with token and evidence",
    L5: "critical decisions only with explicit approval; never automatic",
  }[level] || "unknown";
}

function autonomyScoreReport(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const agent = normalizeAgentName(input.agent_name);
  if (!agent) return { error: "agent_name required" };
  const days = clampInt(input.window_days || input.days, 7, 1, 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const actions = tableExists(db, "agent_action") ? {
    done: countRows(db, "SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND status IN ('done','ok','completed') AND started_at>=?", [agent, since]),
    failed: countRows(db, "SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND status IN ('failed','error','auth_failed') AND started_at>=?", [agent, since]),
    blocked: countRows(db, "SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND status IN ('blocked','block') AND started_at>=?", [agent, since]),
    guard_blocked: countRows(db, "SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND status LIKE '%guard%' AND started_at>=?", [agent, since]),
  } : { done: 0, failed: 0, blocked: 0, guard_blocked: 0 };
  const briefs = tableExists(db, "agent_brief") ? {
    pending: countRows(db, "SELECT COUNT(*) c FROM agent_brief WHERE agent_name=? AND status IN ('pending','dispatched')", [agent]),
    done: countRows(db, "SELECT COUNT(*) c FROM agent_brief WHERE agent_name=? AND status='done' AND COALESCE(done_at, created_at)>=?", [agent, since]),
  } : { pending: 0, done: 0 };
  const findings = tableExists(db, "quality_finding") ? {
    open_high: countRows(db, "SELECT COUNT(*) c FROM quality_finding WHERE source_agent=? AND status='open' AND severity IN ('H','critical')", [agent]),
    open: countRows(db, "SELECT COUNT(*) c FROM quality_finding WHERE source_agent=? AND status='open'", [agent]),
  } : { open_high: 0, open: 0 };
  const tokenAudits = tableExists(db, "capability_token_audit") ? {
    granted: countRows(db, "SELECT COUNT(*) c FROM capability_token_audit WHERE agent_name=? AND granted=1 AND created_at>=?", [agent, since]),
    denied: countRows(db, "SELECT COUNT(*) c FROM capability_token_audit WHERE agent_name=? AND granted=0 AND created_at>=?", [agent, since]),
  } : { granted: 0, denied: 0 };
  let score = 100;
  score -= actions.failed * 5;
  score -= actions.blocked * 4;
  score -= actions.guard_blocked * 8;
  score -= Math.max(0, briefs.pending - 3) * 2;
  score -= findings.open_high * 15;
  score -= Math.max(0, findings.open - findings.open_high) * 4;
  score -= tokenAudits.denied * 2;
  score += Math.min(actions.done, 20) * 0.4;
  score += Math.min(briefs.done, 10) * 0.5;
  score += Math.min(tokenAudits.granted, 20) * 0.2;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = autonomyLevel(score);
  const status = score < 70 || findings.open_high || actions.guard_blocked ? "block" : (score < 85 || tokenAudits.denied ? "attention" : "ok");
  const factors = { actions, briefs, findings, token_audits: tokenAudits, note: "L5 is never automatic; critical work still requires explicit approval and a capability token." };
  let snapshotId = null;
  if (input.persist !== false) {
    const info = db.prepare("INSERT INTO autonomy_score_snapshot (scope, agent_name, score, autonomy_level, status, window_days, factors_json) VALUES (?,?,?,?,?,?,?)")
      .run(scopeName(input.scope), agent, score, level, status, days, safeJson(factors, {}));
    snapshotId = info.lastInsertRowid;
  }
  return { ok: true, agent_name: agent, score, autonomy_level: level, autonomy_meaning: autonomyMeaning(level), status, window_days: days, since, factors, snapshot_id: snapshotId };
}

function normalizeProject(value) {
  return String(compactContent(value, 160) || "").trim();
}

function normalizeSurface(value) {
  const text = String(compactContent(value, 160) || "").trim();
  return text || null;
}

function normalizePriority(value) {
  const clean = String(value || "normal").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (["critical", "high", "normal", "medium", "low", "backlog"].includes(clean)) return clean === "medium" ? "normal" : clean;
  return "normal";
}

function normalizeTaskStatus(value) {
  const clean = String(value || "open").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (["open", "active", "in_progress", "in-progress", "blocked", "needs_review", "needs-review", "done", "closed", "cancelled"].includes(clean)) {
    return clean.replace(/-/g, "_");
  }
  return "open";
}

function normalizeIntentKind(value) {
  return String(value || "request").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "_").replace(/^_+|_+$/g, "") || "request";
}

function inferUserIntentPriority(text, fallback) {
  const src = String(text || "").toLowerCase();
  if (/demo[- ]?blocker|production down|502|kaputt|sofort|heute|blocker|dringend|urgent|kritisch/.test(src)) return "critical";
  if (/wichtig|high|bald|morgen/.test(src)) return "high";
  return normalizePriority(fallback);
}

function rowToProjectFocus(row) {
  return row ? Object.assign({}, row, {
    must_do: parseJson(row.must_do_json, []),
    must_not_do: parseJson(row.must_not_do_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function rowToProjectTask(row) {
  return row ? Object.assign({}, row, {
    acceptance: parseJson(row.acceptance_json, []),
    blockers: parseJson(row.blockers_json, []),
    evidence: parseJson(row.evidence_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function rowToUserIntent(row) {
  return row ? Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }) : null;
}

function rowToProjectChannelPolicy(row) {
  return row ? Object.assign({}, row, {
    rules: parseJson(row.rules_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function projectFocusSet(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const project = normalizeProject(input.project || input.name);
  if (!project) return { error: "project required" };
  const summary = textOrNull(input.focus_summary || input.summary || input.objective, 4000);
  const activeTarget = textOrNull(input.active_target || input.target || input.current_target, 1000);
  db.prepare(`
    INSERT INTO project_focus
      (scope, project, surface, active_target, focus_summary, status, owner_agent, coordinator_agent, current_work_order_id, must_do_json, must_not_do_json, source_ref, meta_json, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(scope, project) DO UPDATE SET
      surface=excluded.surface,
      active_target=excluded.active_target,
      focus_summary=excluded.focus_summary,
      status=excluded.status,
      owner_agent=excluded.owner_agent,
      coordinator_agent=excluded.coordinator_agent,
      current_work_order_id=excluded.current_work_order_id,
      must_do_json=excluded.must_do_json,
      must_not_do_json=excluded.must_not_do_json,
      source_ref=excluded.source_ref,
      meta_json=excluded.meta_json,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(
    scope,
    project,
    normalizeSurface(input.surface || input.portal || input.area),
    activeTarget,
    summary,
    input.status || "active",
    normalizeAgentName(input.owner_agent || input.owner || "") || null,
    normalizeAgentName(input.coordinator_agent || input.coordinator || "") || null,
    input.current_work_order_id || input.work_order_id || null,
    safeJson(listInput(input.must_do || input.must || input.acceptance), []),
    safeJson(listInput(input.must_not_do || input.out_of_scope || input.exclusions), []),
    textOrNull(input.source_ref || input.source || input.message_ref, 1000),
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  return projectFocusGet(db, { scope, project });
}

function projectFocusGet(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const project = normalizeProject(input.project || input.name);
  if (!project) return { error: "project required" };
  const row = db.prepare("SELECT * FROM project_focus WHERE scope=? AND project=?").get(scope, project);
  return { ok: !!row, focus: rowToProjectFocus(row), hint: row ? undefined : "Set focus with mem_project_focus_set before assigning project work." };
}

function projectFocusList(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.status) { where.push("status=?"); params.push(input.status); }
  params.push(clampInt(input.limit, 50, 1, 200));
  const rows = db.prepare(`SELECT * FROM project_focus WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).all(...params).map(rowToProjectFocus);
  return { ok: true, count: rows.length, focuses: rows };
}

function projectTaskCreate(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const project = normalizeProject(input.project || input.name);
  const title = textOrNull(input.title || input.summary || input.objective, 300);
  if (!project) return { error: "project required" };
  if (!title) return { error: "title required" };
  const summary = textOrNull(input.summary || input.objective || input.description || input.task, 4000);
  const info = db.prepare(`
    INSERT INTO project_task
      (scope, project, surface, title, summary, category, priority, status, owner_agent, assigned_agent, source_kind, source_id, source_ref, acceptance_json, blockers_json, evidence_json, linked_work_order_id, meta_json, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scope,
    project,
    normalizeSurface(input.surface || input.portal || input.area),
    title,
    summary,
    normalizeIntentKind(input.category || input.kind || "task"),
    normalizePriority(input.priority),
    normalizeTaskStatus(input.status || "open"),
    normalizeAgentName(input.owner_agent || input.owner || "") || null,
    normalizeAgentName(input.assigned_agent || input.agent_name || input.assignee || "") || null,
    textOrNull(input.source_kind || input.source, 120),
    textOrNull(input.source_id || input.brief_id || input.finding_id, 120),
    textOrNull(input.source_ref || input.message_ref || input.url, 1000),
    safeJson(listInput(input.acceptance || input.acceptance_criteria || input.done_criteria), []),
    safeJson(listInput(input.blockers || input.blocked_by), []),
    safeJson(Array.isArray(input.evidence) ? input.evidence : [], []),
    input.linked_work_order_id || input.work_order_id || null,
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.created_by || input.agent_name || "") || null,
    normalizeAgentName(input.updated_by || input.agent_name || input.created_by || "") || null
  );
  return { ok: true, task: rowToProjectTask(db.prepare("SELECT * FROM project_task WHERE id=?").get(info.lastInsertRowid)) };
}

function projectTaskUpdate(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const id = parseInt(input.id || input.task_id, 10);
  if (!id) return { error: "task_id required" };
  const existing = db.prepare("SELECT * FROM project_task WHERE id=?").get(id);
  if (!existing) return { error: "project_task_not_found", task_id: id };
  const updates = [];
  const params = [];
  function set(key, value) { updates.push(key + "=?"); params.push(value); }
  if (input.project !== undefined) set("project", normalizeProject(input.project));
  if (input.surface !== undefined || input.portal !== undefined || input.area !== undefined) set("surface", normalizeSurface(input.surface || input.portal || input.area));
  if (input.title !== undefined) set("title", textOrNull(input.title, 300));
  if (input.summary !== undefined || input.objective !== undefined || input.description !== undefined) set("summary", textOrNull(input.summary || input.objective || input.description, 4000));
  if (input.category !== undefined || input.kind !== undefined) set("category", normalizeIntentKind(input.category || input.kind));
  if (input.priority !== undefined) set("priority", normalizePriority(input.priority));
  if (input.status !== undefined) {
    const status = normalizeTaskStatus(input.status);
    set("status", status);
    if (["done", "closed", "cancelled"].includes(status)) set("completed_at", nowIso());
  }
  if (input.owner_agent !== undefined || input.owner !== undefined) set("owner_agent", normalizeAgentName(input.owner_agent || input.owner || "") || null);
  if (input.assigned_agent !== undefined || input.agent_name !== undefined || input.assignee !== undefined) set("assigned_agent", normalizeAgentName(input.assigned_agent || input.agent_name || input.assignee || "") || null);
  if (input.acceptance !== undefined || input.acceptance_criteria !== undefined || input.done_criteria !== undefined) set("acceptance_json", safeJson(listInput(input.acceptance || input.acceptance_criteria || input.done_criteria), []));
  if (input.blockers !== undefined || input.blocked_by !== undefined) set("blockers_json", safeJson(listInput(input.blockers || input.blocked_by), []));
  if (input.evidence !== undefined) set("evidence_json", safeJson(Array.isArray(input.evidence) ? input.evidence : [], []));
  if (input.linked_work_order_id !== undefined || input.work_order_id !== undefined) set("linked_work_order_id", input.linked_work_order_id || input.work_order_id || null);
  if (input.meta !== undefined) set("meta_json", safeJson(input.meta || {}, {}));
  set("updated_by", normalizeAgentName(input.updated_by || input.agent_name || "") || null);
  set("updated_at", nowIso());
  params.push(id);
  db.prepare(`UPDATE project_task SET ${updates.join(", ")} WHERE id=?`).run(...params);
  return { ok: true, task: rowToProjectTask(db.prepare("SELECT * FROM project_task WHERE id=?").get(id)) };
}

function projectTaskList(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  const project = normalizeProject(input.project || input.name);
  if (project) { where.push("project=?"); params.push(project); }
  if (input.assigned_agent || input.agent_name) { where.push("assigned_agent=?"); params.push(normalizeAgentName(input.assigned_agent || input.agent_name)); }
  if (input.owner_agent || input.owner) { where.push("owner_agent=?"); params.push(normalizeAgentName(input.owner_agent || input.owner)); }
  if (input.status) { where.push("status=?"); params.push(normalizeTaskStatus(input.status)); }
  else if (input.include_done !== true) where.push("status NOT IN ('done','closed','cancelled')");
  params.push(clampInt(input.limit, 50, 1, 500));
  const rows = db.prepare(`SELECT * FROM project_task WHERE ${where.join(" AND ")} ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, updated_at DESC LIMIT ?`).all(...params).map(rowToProjectTask);
  return { ok: true, count: rows.length, tasks: rows };
}

function normalizeBriefHeading(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_()[\]{}:.,!?]+/g, "")
    .replace(/\s+/g, " ");
}

function markdownSection(content, names) {
  const wanted = new Set((Array.isArray(names) ? names : [names]).map(normalizeBriefHeading));
  const lines = String(content || "").split(/\r?\n/);
  let start = -1;
  let level = 99;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) continue;
    const heading = normalizeBriefHeading(match[2]);
    if (wanted.has(heading)) {
      start = i + 1;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) break;
    out.push(lines[i]);
  }
  return textOrNull(out.join("\n").trim(), 4000);
}

function firstMarkdownTitle(content) {
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      const title = textOrNull(match[1].replace(/^brief\s*[:#-]?\s*/i, ""), 260);
      if (title) return title;
    }
  }
  return null;
}

function briefPreview(content, max = 700) {
  return textOrNull(String(content || "")
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/^\s*[-*+]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim(), max);
}

function sectionList(content, names) {
  const section = markdownSection(content, names);
  if (!section) return [];
  const items = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*(?:[-*+]|\d+[.)]|[•])\s+(.+?)\s*$/.exec(line);
    if (match && match[1]) items.push(match[1].trim());
  }
  return items.length ? uniqueStrings(items) : listInput(section);
}

function briefMeta(row) {
  return parseJson(row && row.meta_json, {});
}

function extractBriefFiles(content, meta = {}) {
  const files = [];
  const add = (value) => {
    for (const item of listInput(value)) {
      if (/[\\/]/.test(item) || /\.[A-Za-z0-9]{1,8}$/.test(item)) files.push(item);
    }
  };
  add(meta.files);
  add(meta.file_paths);
  add(meta.paths);
  const text = String(content || "");
  for (const match of text.matchAll(/`([^`\n]*(?:[\\/][^`\n]+|\.[A-Za-z0-9]{1,8})[^`\n]*)`/g)) add(match[1]);
  for (const match of text.matchAll(/(?:[A-Za-z]:\\)?[A-Za-z0-9_. -]+[\\/][A-Za-z0-9_.() \\/-]+\.[A-Za-z0-9]{1,8}/g)) add(match[0]);
  return uniqueStrings(files).sort();
}

function briefTaskDedupeKey(scope, draft) {
  const basis = {
    scope,
    project: draft.project || "",
    category: draft.category || "",
    title: String(draft.title || "").trim().toLowerCase(),
    files: Array.isArray(draft.files) ? draft.files.slice().sort() : [],
  };
  return { key: sha(JSON.stringify(basis)), basis };
}

function briefToTaskDraft(row, input = {}) {
  const meta = briefMeta(row);
  const content = String(row && row.content || "");
  const explicitProject = input.project || input.default_project || meta.project || meta.project_name || markdownSection(content, ["project", "projekt", "scope"]);
  const project = normalizeProject(explicitProject);
  const title = textOrNull(
    input.title ||
    meta.title ||
    markdownSection(content, ["title", "titel", "task", "aufgabe", "finding", "befund"]) ||
    firstMarkdownTitle(content) ||
    briefPreview(content, 220),
    260
  );
  const summary = textOrNull(
    input.summary ||
    meta.summary ||
    markdownSection(content, ["request", "anforderung", "summary", "zusammenfassung", "description", "beschreibung", "details", "befund"]) ||
    briefPreview(content, 1200),
    4000
  );
  const files = extractBriefFiles(content, meta);
  const acceptance = listInput(input.acceptance || input.acceptance_criteria || meta.acceptance || meta.acceptance_criteria)
    .concat(sectionList(content, ["acceptance", "akzeptanz", "done", "definition of done", "annahme", "verify", "verification", "test"]));
  const priorityText = input.priority || meta.priority || markdownSection(content, ["priority", "priorität", "prio"]) || content;
  const category = normalizeIntentKind(input.category || input.kind || meta.category || meta.kind || "brief");
  const draft = {
    project,
    title,
    summary,
    category,
    priority: inferUserIntentPriority(priorityText + " " + title + " " + summary, input.priority || meta.priority),
    status: normalizeTaskStatus(input.task_status || input.status_for_task || "open"),
    owner_agent: normalizeAgentName(input.owner_agent || input.owner || meta.owner_agent || row.agent_name || "") || null,
    assigned_agent: normalizeAgentName(input.assigned_agent || input.agent_name || input.assignee || meta.assigned_agent || row.agent_name || "") || null,
    acceptance: uniqueStrings(acceptance),
    blockers: listInput(input.blockers || meta.blockers),
    files,
    source_kind: "agent_brief",
    source_id: String(row.id),
    source_ref: input.source_ref || meta.source_ref || ("agent_brief:" + row.id),
    created_by: normalizeAgentName(input.created_by || input.agent_name || row.source_agent || "mnemo") || "mnemo",
    meta: Object.assign({}, meta, {
      brief_id: row.id,
      brief_agent_name: row.agent_name || null,
      brief_source_agent: row.source_agent || null,
      files,
    }),
  };
  return draft;
}

function insertProjectTaskIngest(db, values) {
  db.prepare(`
    INSERT OR IGNORE INTO project_task_ingest
      (scope, source_kind, source_id, dedupe_key, task_id, project, brief_id, status, meta_json, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    values.scope,
    values.source_kind,
    String(values.source_id),
    values.dedupe_key,
    values.task_id,
    values.project || null,
    values.brief_id || null,
    values.status || "linked",
    safeJson(values.meta || {}, {})
  );
}

function markAgentBriefStatus(db, briefId, status, outcome) {
  const clean = textOrNull(status, 80);
  if (!clean || !briefId) return;
  try {
    const cols = db.prepare("PRAGMA table_info(agent_brief)").all().map((col) => col.name);
    if (cols.includes("done_at") && ["done", "failed"].includes(clean)) {
      if (cols.includes("outcome")) {
        db.prepare("UPDATE agent_brief SET status=?, done_at=?, outcome=COALESCE(outcome, ?) WHERE id=?")
          .run(clean, nowIso(), outcome || "Converted to project task.", briefId);
      } else {
        db.prepare("UPDATE agent_brief SET status=?, done_at=? WHERE id=?").run(clean, nowIso(), briefId);
      }
    } else {
      db.prepare("UPDATE agent_brief SET status=? WHERE id=?").run(clean, briefId);
    }
  } catch {}
}

function ingestOneBriefAsTask(db, row, input = {}) {
  const scope = scopeName(input.scope);
  const sourceId = String(row.id);
  const existingSource = db.prepare("SELECT * FROM project_task_ingest WHERE scope=? AND source_kind='agent_brief' AND source_id=?").get(scope, sourceId);
  if (existingSource) {
    const task = db.prepare("SELECT * FROM project_task WHERE id=?").get(existingSource.task_id);
    if (input.mark_brief_status) markAgentBriefStatus(db, row.id, input.mark_brief_status, "Already converted to project task #" + existingSource.task_id + ".");
    return { action: "source_existing", brief_id: row.id, task: rowToProjectTask(task), task_id: existingSource.task_id };
  }

  const draft = briefToTaskDraft(row, input);
  if (!draft.project || !draft.title) {
    return { action: "skipped", reason: !draft.project ? "project_missing" : "title_missing", brief_id: row.id };
  }
  const dedupe = briefTaskDedupeKey(scope, draft);
  draft.meta.dedupe_key = dedupe.key;
  draft.meta.dedupe_basis = dedupe.basis;

  if (input.dry_run === true) {
    return { action: "dry_run", brief_id: row.id, dedupe_key: dedupe.key, draft };
  }

  let task = null;
  let action = "created";
  const mapped = db.prepare("SELECT * FROM project_task_ingest WHERE scope=? AND dedupe_key=? ORDER BY updated_at DESC LIMIT 1").get(scope, dedupe.key);
  if (mapped) {
    task = db.prepare("SELECT * FROM project_task WHERE id=?").get(mapped.task_id);
    action = "linked_duplicate";
  }
  if (!task) {
    const where = ["scope=?", "project=?", "title=?"];
    const params = [scope, draft.project, draft.title];
    if (input.include_done !== true) where.push("status NOT IN ('done','closed','cancelled')");
    task = db.prepare(`SELECT * FROM project_task WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`).get(...params);
    if (task) action = "linked_existing";
  }
  if (!task) {
    const created = projectTaskCreate(db, Object.assign({}, draft, {
      scope,
      meta: draft.meta,
    }));
    task = created.task;
    action = "created";
  } else {
    task = rowToProjectTask(task);
  }

  insertProjectTaskIngest(db, {
    scope,
    source_kind: "agent_brief",
    source_id: sourceId,
    dedupe_key: dedupe.key,
    task_id: task.id,
    project: draft.project,
    brief_id: row.id,
    status: action,
    meta: { dedupe_basis: dedupe.basis, linked_from_agent_brief: row.id },
  });
  if (input.mark_brief_status) {
    markAgentBriefStatus(db, row.id, input.mark_brief_status, "Converted to project task #" + task.id + ".");
  }
  return { action, brief_id: row.id, dedupe_key: dedupe.key, task };
}

function briefTaskIngest(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  if (!tableExists(db, "agent_brief")) return { ok: true, count: 0, created: 0, linked: 0, skipped: 0, results: [], note: "agent_brief table missing" };
  const scope = scopeName(input.scope);
  const where = [];
  const params = [];
  const briefIds = uniqueStrings([].concat(input.brief_ids || [], input.brief_id || []).filter((id) => id !== undefined && id !== null)).map((id) => parseInt(id, 10)).filter(Boolean);
  if (briefIds.length) {
    where.push(`id IN (${briefIds.map(() => "?").join(",")})`);
    params.push(...briefIds);
  } else {
    const statuses = listInput(input.statuses || input.status || ["pending", "dispatched"]);
    if (statuses.length && input.include_all_statuses !== true) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
    if (input.source_agent) { where.push("source_agent=?"); params.push(normalizeAgentName(input.source_agent)); }
    const project = normalizeProject(input.project || input.default_project);
    if (project) {
      where.push("(content LIKE ? OR (json_valid(meta_json) AND json_extract(meta_json,'$.project')=?))");
      params.push("%" + project + "%", project);
    }
  }
  const limit = clampInt(input.limit, 20, 1, 200);
  params.push(limit);
  const rows = db.prepare(`SELECT id, agent_name, source_agent, content, status, created_at, meta_json FROM agent_brief ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at ASC, id ASC LIMIT ?`).all(...params);
  const results = rows.map((row) => ingestOneBriefAsTask(db, row, Object.assign({}, input, { scope })));
  return {
    ok: true,
    count: results.length,
    created: results.filter((result) => result.action === "created").length,
    linked: results.filter((result) => result.action === "linked_duplicate" || result.action === "linked_existing" || result.action === "source_existing").length,
    skipped: results.filter((result) => result.action === "skipped").length,
    dry_run: input.dry_run === true,
    results,
  };
}

function userIntentCapture(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const exactWords = textOrNull(input.exact_words || input.text || input.message || input.content, 8000);
  const summary = textOrNull(input.summary || input.intent || exactWords, 600);
  if (!summary) return { error: "summary_or_text required" };
  const project = normalizeProject(input.project || input.name) || null;
  const priority = inferUserIntentPriority((exactWords || "") + " " + summary, input.priority);
  let linkedTaskId = input.linked_task_id || input.task_id || null;
  const info = db.prepare(`
    INSERT INTO user_intent
      (scope, project, user_name, source_channel, message_ref, intent_kind, summary, exact_words, priority, status, linked_task_id, linked_work_order_id, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scope,
    project,
    textOrNull(input.user_name || input.user || input.actor, 160),
    textOrNull(input.source_channel || input.channel || "telegram", 160),
    textOrNull(input.message_ref || input.source_ref, 1000),
    normalizeIntentKind(input.intent_kind || input.kind || "request"),
    summary,
    exactWords,
    priority,
    input.status || "captured",
    linkedTaskId || null,
    input.linked_work_order_id || input.work_order_id || null,
    safeJson(input.meta || {}, {})
  );
  const intentId = info.lastInsertRowid;
  let task = null;
  if (input.create_task === true && project) {
    const created = projectTaskCreate(db, {
      scope,
      project,
      surface: input.surface,
      title: input.task_title || summary,
      summary,
      category: input.intent_kind || input.kind || "user_request",
      priority,
      status: input.task_status || "open",
      owner_agent: input.owner_agent,
      assigned_agent: input.assigned_agent || input.agent_name,
      source_kind: "user_intent",
      source_id: String(intentId),
      source_ref: input.message_ref || input.source_ref,
      acceptance: input.acceptance || input.acceptance_criteria,
      created_by: input.agent_name || "mnemo",
      meta: { user_intent_id: intentId },
    });
    task = created.task || null;
    linkedTaskId = task && task.id || null;
    if (linkedTaskId) db.prepare("UPDATE user_intent SET linked_task_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(linkedTaskId, intentId);
  }
  if (input.set_focus === true && project) {
    projectFocusSet(db, {
      scope,
      project,
      surface: input.surface,
      active_target: input.active_target || summary,
      focus_summary: summary,
      must_do: input.must_do || input.acceptance,
      must_not_do: input.must_not_do || input.out_of_scope,
      owner_agent: input.owner_agent,
      coordinator_agent: input.coordinator_agent,
      source_ref: input.message_ref || input.source_ref,
      updated_by: input.agent_name || "mnemo",
      meta: { user_intent_id: intentId },
    });
  }
  return { ok: true, intent: rowToUserIntent(db.prepare("SELECT * FROM user_intent WHERE id=?").get(intentId)), task };
}

function projectChannelPolicySet(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const project = normalizeProject(input.project || input.name);
  if (!project) return { error: "project required" };
  const defaultRules = [
    "Telegram is for coordination, short status, explicit questions, and human-facing updates.",
    "Mnemo Briefs are for durable assignments, findings, acceptance criteria, and cross-agent handoffs.",
    "Work Orders are the execution contract for scoped work; done is only accepted with evidence.",
    "Agents should propose useful next actions when a risk or project gap is visible, not wait for human phrasing."
  ];
  db.prepare(`
    INSERT INTO project_channel_policy
      (scope, project, telegram_role, brief_role, work_order_role, rules_json, status, meta_json, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(scope, project) DO UPDATE SET
      telegram_role=excluded.telegram_role,
      brief_role=excluded.brief_role,
      work_order_role=excluded.work_order_role,
      rules_json=excluded.rules_json,
      status=excluded.status,
      meta_json=excluded.meta_json,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
  `).run(
    scope,
    project,
    textOrNull(input.telegram_role, 2000) || "Fast team coordination and human-visible updates; not durable truth.",
    textOrNull(input.brief_role, 2000) || "Durable cross-agent findings, assignments, acceptance criteria, and handoffs.",
    textOrNull(input.work_order_role, 2000) || "Scoped execution contract with owner, target, resources, evidence, and done gate.",
    safeJson(listInput(input.rules).length ? listInput(input.rules) : defaultRules, []),
    input.status || "active",
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  return projectChannelPolicyGet(db, { scope, project });
}

function projectChannelPolicyGet(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const project = normalizeProject(input.project || input.name);
  if (!project) return { error: "project required" };
  const row = db.prepare("SELECT * FROM project_channel_policy WHERE scope=? AND project=?").get(scopeName(input.scope), project);
  return { ok: !!row, policy: rowToProjectChannelPolicy(row), hint: row ? undefined : "Set policy with mem_project_channel_policy_set so Telegram, briefs, and Work Orders have clear roles." };
}

function latestRows(db, sql, params, mapper) {
  try { return db.prepare(sql).all(...params).map(mapper || ((x) => x)); } catch { return []; }
}

function projectBoard(db, input = {}) {
  ensureAgentGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const project = normalizeProject(input.project || input.name);
  if (!project) return { error: "project required" };
  const limit = clampInt(input.limit, 25, 5, 100);
  const focus = projectFocusGet(db, { scope, project }).focus || null;
  const tasks = projectTaskList(db, { scope, project, include_done: input.include_done === true, limit }).tasks || [];
  const policy = projectChannelPolicyGet(db, { scope, project }).policy || null;
  const activeWorkOrders = latestRows(db, "SELECT * FROM work_order WHERE scope=? AND project=? AND status NOT IN ('done','closed','cancelled') ORDER BY updated_at DESC LIMIT ?", [scope, project, limit], rowToWorkOrder);
  const pendingBriefs = tableExists(db, "agent_brief")
    ? latestRows(
      db,
      `SELECT b.id, b.agent_name, b.source_agent, b.status, substr(b.content,1,240) AS preview, b.created_at
       FROM agent_brief b
       WHERE b.status IN ('pending','dispatched')
         AND (b.content LIKE ? OR (json_valid(b.meta_json) AND json_extract(b.meta_json,'$.project')=?))
         AND (?=1 OR NOT EXISTS (
           SELECT 1 FROM project_task_ingest ti
           WHERE ti.scope=? AND ti.source_kind='agent_brief' AND ti.source_id=CAST(b.id AS TEXT)
         ))
       ORDER BY b.created_at DESC LIMIT ?`,
      ["%" + project + "%", project, input.include_ingested_briefs === true ? 1 : 0, scope, limit]
    )
    : [];
  const intents = latestRows(db, "SELECT * FROM user_intent WHERE scope=? AND (project=? OR project IS NULL) AND status NOT IN ('done','closed','cancelled') ORDER BY created_at DESC LIMIT ?", [scope, project, limit], rowToUserIntent);
  const byStatus = {};
  tasks.forEach((task) => {
    const key = task.status || "open";
    if (!byStatus[key]) byStatus[key] = [];
    byStatus[key].push(task);
  });
  const nextActions = [];
  if (!focus) nextActions.push("Set active project focus with mem_project_focus_set.");
  if (!policy) nextActions.push("Set channel policy so Telegram, briefs, and Work Orders are not mixed.");
  const critical = tasks.filter((task) => task.priority === "critical" && !["done", "closed", "cancelled"].includes(task.status));
  if (critical.length) nextActions.push("Resolve critical task #" + critical[0].id + ": " + critical[0].title);
  if (!activeWorkOrders.length && tasks.length) nextActions.push("Create a Work Order for the top open task before risky execution.");
  return {
    ok: true,
    project,
    focus,
    policy,
    summary: {
      open_tasks: tasks.filter((task) => !["done", "closed", "cancelled"].includes(task.status)).length,
      critical_tasks: critical.length,
      active_work_orders: activeWorkOrders.length,
      pending_briefs: pendingBriefs.length,
      open_intents: intents.length,
    },
    tasks_by_status: byStatus,
    active_work_orders: activeWorkOrders,
    pending_briefs: pendingBriefs,
    user_intents: intents,
    next_actions: nextActions,
    channel_rule: "Telegram coordinates; Mnemo briefs assign durable work; Work Orders authorize execution; Company Ledger remains truth.",
  };
}

const AGENT_GOVERNANCE_TOOL_DEFS = {
  mem_work_order_template_list: {
    description: "List agent-neutral Work Order templates. These are runtime-agnostic contracts for Claude, GPT/Codex, OpenClaw, and other adapters.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, template_id: { type: "string" }, id: { type: "string" }, include_inactive: { type: "boolean" } } }
  },
  mem_work_order_template_upsert: {
    description: "Create/update a custom agent-neutral Work Order template. Templates are contracts; runtime adapters still execute through Mnemo gates.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, template_id: { type: "string" }, id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, objective: { type: "string" }, summary: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, risk_class: { type: "string" }, action_type: { type: "string" }, allowed_tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, done_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, required_evidence: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, evidence_required: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, quality_gates: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, runtime_contract: { type: "object" }, status: { type: "string" }, source: { type: "string" }, updated_by: { type: "string" }, agent_name: { type: "string" }, meta: { type: "object" } }, required: ["template_id"] }
  },
  mem_work_order_create_from_template: {
    description: "Create a Work Order from a built-in or custom template and optionally issue a capability token. Same contract for all agent runtimes.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, template_id: { type: "string" }, id: { type: "string" }, kind: { type: "string" }, project: { type: "string" }, title: { type: "string" }, objective: { type: "string" }, summary: { type: "string" }, task: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, owner_agent: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, risk_class: { type: "string" }, action_type: { type: "string" }, allowed_tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, done_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, required_evidence: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, evidence_required: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, quality_gates: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, issue_token: { type: "boolean" }, ttl_minutes: { type: "integer" }, expires_at: { type: "string" }, source_ref: { type: "string" }, created_by: { type: "string" }, runtime_contract: { type: "object" }, meta: { type: "object" } }, required: ["template_id"] }
  },
  mem_quality_gate_template_list: {
    description: "List built-in agent-neutral quality gates used before Work Orders can be marked done.",
    inputSchema: { type: "object", properties: { gate_id: { type: "string" }, id: { type: "string" } } }
  },
  mem_quality_gate_run: {
    description: "Run an agent-neutral quality gate against concrete evidence. Failing gates should block done and force needs_review/blocked.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, gate_id: { type: "string" }, template_id: { type: "string" }, gate: { type: "string" }, project: { type: "string" }, work_order_id: { type: "integer" }, agent_name: { type: "string" }, agent: { type: "string" }, evidence: { type: "array", items: { type: "object" } }, required_evidence: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, include_work_order_evidence: { type: "boolean" }, persist: { type: "boolean" }, meta: { type: "object" } } }
  },
  mem_context_snapshot_create: {
    description: "Save an agent-neutral context snapshot: decisions, remaining work, affected files/routes, branch, and Work Order link.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, agent_name: { type: "string" }, agent: { type: "string" }, runtime_name: { type: "string" }, runtime: { type: "string" }, work_order_id: { type: "integer" }, title: { type: "string" }, summary: { type: "string" }, context: { type: "string" }, notes: { type: "string" }, decisions: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, remaining_work: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, remaining: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, next_steps: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, files: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, routes: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, urls: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, branch: { type: "string" }, commit_sha: { type: "string" }, commit: { type: "string" }, dirty: { type: "boolean" }, source_ref: { type: "string" }, status: { type: "string" }, meta: { type: "object" } }, required: ["summary"] }
  },
  mem_context_restore_brief: {
    description: "Return the latest saved context snapshot as a concise resume brief. Context is not company truth; agents must still check gates.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, id: { type: "integer" }, snapshot_id: { type: "integer" }, project: { type: "string" }, agent_name: { type: "string" }, agent: { type: "string" }, work_order_id: { type: "integer" }, status: { type: "string" } } }
  },
  mem_work_order_create: {
    description: "Create a structured work order: objective, owner, department, assigned agent, scope, done criteria, risk, evidence, and optional capability token.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, title: { type: "string" }, objective: { type: "string" }, summary: { type: "string" }, task: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, owner_agent: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, risk_class: { type: "string" }, action_type: { type: "string" }, allowed_tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, done_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, required_evidence: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, evidence_required: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, approval_ids: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, deadline_at: { type: "string" }, issue_token: { type: "boolean" }, ttl_minutes: { type: "integer" }, expires_at: { type: "string" }, source_ref: { type: "string" }, created_by: { type: "string" }, meta: { type: "object" } }, required: ["objective"] }
  },
  mem_work_order_list: {
    description: "List structured work orders by agent, owner, project, department, or status.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, owner_agent: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, status: { type: "string" }, include_done: { type: "boolean" }, limit: { type: "integer" } } }
  },
  mem_work_order_complete: {
    description: "Complete a work order with evidence, optional handoff id, and completion summary. Token permission is not truth; completion needs evidence.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, work_order_id: { type: "integer" }, status: { type: "string" }, completion_summary: { type: "string" }, summary: { type: "string" }, result: { type: "string" }, handoff_id: { type: "integer" }, evidence: { type: "array", items: { type: "object" } } }, required: ["work_order_id"] }
  },
  mem_capability_token_issue: {
    description: "Issue a time-limited capability token for exactly one agent/work order/scope. Token is permission only, not truth.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, work_order_id: { type: "integer" }, agent_name: { type: "string" }, department_name: { type: "string" }, project: { type: "string" }, risk_class: { type: "string" }, action_type: { type: "string" }, allowed_tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, tools: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, allowed_resources: { type: "object" }, required_evidence: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, approval_ids: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, budgets: { type: "object" }, granted_by: { type: "string" }, reason: { type: "string" }, ttl_minutes: { type: "integer" }, expires_at: { type: "string" }, meta: { type: "object" } }, required: ["agent_name"] }
  },
  mem_capability_token_check: {
    description: "Deterministically check whether a work step is covered by a valid token. Returns granted, reason, matched_scope, missing_approval, required_evidence, expires_at, and audit_id.",
    inputSchema: { type: "object", properties: { token_id: { type: "string" }, capability_token_id: { type: "string" }, work_order_id: { type: "integer" }, agent_name: { type: "string" }, project: { type: "string" }, task: { type: "string" }, summary: { type: "string" }, action_type: { type: "string" }, tool_name: { type: "string" }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, approval_ids: { type: "array", items: { type: "string" } }, require_approval: { type: "boolean" } } }
  },
  mem_capability_token_revoke: {
    description: "Revoke a capability token and audit the revocation.",
    inputSchema: { type: "object", properties: { token_id: { type: "string" }, capability_token_id: { type: "string" }, revoked_by: { type: "string" }, agent_name: { type: "string" }, reason: { type: "string" }, meta: { type: "object" } }, required: ["token_id", "revoked_by"] }
  },
  mem_department_charter_set: {
    description: "Create/update a department charter: mission, responsibilities, boundaries, standard permissions, escalation rules, and autonomy bounds.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, mission: { type: "string" }, responsibilities: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, boundaries: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, standard_permissions: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, escalation_rules: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, standing_permissions: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, autonomy_floor: { type: "integer" }, autonomy_ceiling: { type: "integer" }, default_risk_class: { type: "string" }, lead_agent: { type: "string" }, review_agent: { type: "string" }, status: { type: "string" }, updated_by: { type: "string" }, meta: { type: "object" } }, required: ["department_name"] }
  },
  mem_department_charter_get: {
    description: "Get one department charter.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, department_name: { type: "string" }, department: { type: "string" } }, required: ["department_name"] }
  },
  mem_department_charter_list: {
    description: "List department charters.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_intent_route: {
    description: "Route an intent such as access request, decision, review, handoff, or incident to the right owner/department/coordinator.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, intent_kind: { type: "string" }, intent: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, resource_kind: { type: "string" }, resource_key: { type: "string" }, file_path: { type: "string" }, route: { type: "string" }, domain: { type: "string" }, system_name: { type: "string" }, summary: { type: "string" }, request: { type: "string" }, reason: { type: "string" }, route_to_agent: { type: "string" }, route_to_department: { type: "string" }, write_brief: { type: "boolean" }, meta: { type: "object" } } }
  },
  mem_autonomy_score_report: {
    description: "Compute a fact-based autonomy/trust score and suggested autonomy level from actions, briefs, findings, and token audit history.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, agent_name: { type: "string" }, window_days: { type: "integer" }, days: { type: "integer" }, persist: { type: "boolean" } }, required: ["agent_name"] }
  },
  mem_project_focus_set: {
    description: "Set the active project focus so agents do not drift between portals, surfaces, or old tasks.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" }, surface: { type: "string" }, portal: { type: "string" }, active_target: { type: "string" }, target: { type: "string" }, focus_summary: { type: "string" }, summary: { type: "string" }, objective: { type: "string" }, status: { type: "string" }, owner_agent: { type: "string" }, coordinator_agent: { type: "string" }, current_work_order_id: { type: "integer" }, work_order_id: { type: "integer" }, must_do: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, acceptance: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, must_not_do: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, out_of_scope: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, exclusions: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, source_ref: { type: "string" }, updated_by: { type: "string" }, agent_name: { type: "string" }, meta: { type: "object" } }, required: ["project"] }
  },
  mem_project_focus_get: {
    description: "Get the current active project focus.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" } }, required: ["project"] }
  },
  mem_project_focus_list: {
    description: "List active project focuses across the company.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_project_task_create: {
    description: "Create a durable project task from a finding, user request, brief, or agent idea. This is not execution permission; create a Work Order before risky work.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" }, surface: { type: "string" }, portal: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, objective: { type: "string" }, description: { type: "string" }, task: { type: "string" }, category: { type: "string" }, kind: { type: "string" }, priority: { type: "string" }, status: { type: "string" }, owner_agent: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, assignee: { type: "string" }, source_kind: { type: "string" }, source_id: { type: "string" }, brief_id: { type: "integer" }, finding_id: { type: "integer" }, source_ref: { type: "string" }, message_ref: { type: "string" }, url: { type: "string" }, acceptance: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, acceptance_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, done_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, blockers: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, evidence: { type: "array", items: { type: "object" } }, linked_work_order_id: { type: "integer" }, work_order_id: { type: "integer" }, created_by: { type: "string" }, updated_by: { type: "string" }, meta: { type: "object" } }, required: ["project"] }
  },
  mem_project_task_update: {
    description: "Update a project task status, owner, evidence, blockers, or acceptance criteria.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, task_id: { type: "integer" }, project: { type: "string" }, surface: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, objective: { type: "string" }, description: { type: "string" }, category: { type: "string" }, kind: { type: "string" }, priority: { type: "string" }, status: { type: "string" }, owner_agent: { type: "string" }, owner: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, assignee: { type: "string" }, acceptance: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, acceptance_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, done_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, blockers: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, evidence: { type: "array", items: { type: "object" } }, linked_work_order_id: { type: "integer" }, work_order_id: { type: "integer" }, updated_by: { type: "string" }, meta: { type: "object" } } }
  },
  mem_project_task_list: {
    description: "List durable project tasks by project, owner, assigned agent, status, or priority.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, owner_agent: { type: "string" }, owner: { type: "string" }, status: { type: "string" }, include_done: { type: "boolean" }, limit: { type: "integer" } } }
  },
  mem_brief_task_ingest: {
    description: "Convert pending Mnemo agent briefs into durable project tasks with deterministic dedupe. Use this before project boards so old briefs stop reappearing as loose work.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, brief_id: { type: "integer" }, brief_ids: { type: "array", items: { type: "integer" } }, agent_name: { type: "string" }, source_agent: { type: "string" }, project: { type: "string" }, default_project: { type: "string" }, status: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, statuses: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, limit: { type: "integer" }, title: { type: "string" }, summary: { type: "string" }, category: { type: "string" }, kind: { type: "string" }, priority: { type: "string" }, assigned_agent: { type: "string" }, assignee: { type: "string" }, owner_agent: { type: "string" }, owner: { type: "string" }, created_by: { type: "string" }, acceptance: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, acceptance_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, blockers: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, mark_brief_status: { type: "string" }, include_done: { type: "boolean" }, include_all_statuses: { type: "boolean" }, dry_run: { type: "boolean" } } }
  },
  mem_user_intent_capture: {
    description: "Capture what the human actually wants in durable form, optionally creating a project task and/or active focus. Use this when user wording is business intent, not agent-internal thinking.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" }, user_name: { type: "string" }, user: { type: "string" }, actor: { type: "string" }, source_channel: { type: "string" }, channel: { type: "string" }, message_ref: { type: "string" }, source_ref: { type: "string" }, intent_kind: { type: "string" }, kind: { type: "string" }, summary: { type: "string" }, intent: { type: "string" }, exact_words: { type: "string" }, text: { type: "string" }, message: { type: "string" }, content: { type: "string" }, priority: { type: "string" }, status: { type: "string" }, linked_task_id: { type: "integer" }, task_id: { type: "integer" }, linked_work_order_id: { type: "integer" }, work_order_id: { type: "integer" }, create_task: { type: "boolean" }, set_focus: { type: "boolean" }, task_title: { type: "string" }, task_status: { type: "string" }, surface: { type: "string" }, active_target: { type: "string" }, owner_agent: { type: "string" }, coordinator_agent: { type: "string" }, assigned_agent: { type: "string" }, agent_name: { type: "string" }, acceptance: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, acceptance_criteria: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, must_do: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, must_not_do: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, out_of_scope: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, meta: { type: "object" } } }
  },
  mem_project_channel_policy_set: {
    description: "Define what belongs in Telegram, Mnemo briefs, and Work Orders for one project so agent chatter does not become company truth.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" }, telegram_role: { type: "string" }, brief_role: { type: "string" }, work_order_role: { type: "string" }, rules: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, status: { type: "string" }, updated_by: { type: "string" }, agent_name: { type: "string" }, meta: { type: "object" } }, required: ["project"] }
  },
  mem_project_channel_policy_get: {
    description: "Get the Telegram/Brief/Work-Order channel policy for one project.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" } }, required: ["project"] }
  },
  mem_project_board: {
    description: "Render a project operating board: active focus, channel policy, tasks, active Work Orders, pending briefs, user intents, and next actions.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, name: { type: "string" }, include_done: { type: "boolean" }, include_ingested_briefs: { type: "boolean" }, limit: { type: "integer" } }, required: ["project"] }
  },
};

function handleAgentGovernanceTool(db, name, input = {}) {
  if (name === "mem_work_order_template_list") return { handled: true, result: workOrderTemplateList(db, input || {}) };
  if (name === "mem_work_order_template_upsert") return { handled: true, result: workOrderTemplateUpsert(db, input || {}) };
  if (name === "mem_work_order_create_from_template") return { handled: true, result: workOrderCreateFromTemplate(db, input || {}) };
  if (name === "mem_quality_gate_template_list") return { handled: true, result: qualityGateTemplateList(db, input || {}) };
  if (name === "mem_quality_gate_run") return { handled: true, result: qualityGateRun(db, input || {}) };
  if (name === "mem_context_snapshot_create") return { handled: true, result: contextSnapshotCreate(db, input || {}) };
  if (name === "mem_context_restore_brief") return { handled: true, result: contextRestoreBrief(db, input || {}) };
  if (name === "mem_work_order_create") return { handled: true, result: workOrderCreate(db, input || {}) };
  if (name === "mem_work_order_list") return { handled: true, result: workOrderList(db, input || {}) };
  if (name === "mem_work_order_complete") return { handled: true, result: workOrderComplete(db, input || {}) };
  if (name === "mem_capability_token_issue") return { handled: true, result: capabilityTokenIssue(db, input || {}) };
  if (name === "mem_capability_token_check") return { handled: true, result: capabilityTokenCheck(db, input || {}) };
  if (name === "mem_capability_token_revoke") return { handled: true, result: capabilityTokenRevoke(db, input || {}) };
  if (name === "mem_department_charter_set") return { handled: true, result: departmentCharterSet(db, input || {}) };
  if (name === "mem_department_charter_get") return { handled: true, result: departmentCharterGet(db, input || {}) };
  if (name === "mem_department_charter_list") return { handled: true, result: departmentCharterList(db, input || {}) };
  if (name === "mem_intent_route") return { handled: true, result: intentRoute(db, input || {}) };
  if (name === "mem_autonomy_score_report") return { handled: true, result: autonomyScoreReport(db, input || {}) };
  if (name === "mem_project_focus_set") return { handled: true, result: projectFocusSet(db, input || {}) };
  if (name === "mem_project_focus_get") return { handled: true, result: projectFocusGet(db, input || {}) };
  if (name === "mem_project_focus_list") return { handled: true, result: projectFocusList(db, input || {}) };
  if (name === "mem_project_task_create") return { handled: true, result: projectTaskCreate(db, input || {}) };
  if (name === "mem_project_task_update") return { handled: true, result: projectTaskUpdate(db, input || {}) };
  if (name === "mem_project_task_list") return { handled: true, result: projectTaskList(db, input || {}) };
  if (name === "mem_brief_task_ingest") return { handled: true, result: briefTaskIngest(db, input || {}) };
  if (name === "mem_user_intent_capture") return { handled: true, result: userIntentCapture(db, input || {}) };
  if (name === "mem_project_channel_policy_set") return { handled: true, result: projectChannelPolicySet(db, input || {}) };
  if (name === "mem_project_channel_policy_get") return { handled: true, result: projectChannelPolicyGet(db, input || {}) };
  if (name === "mem_project_board") return { handled: true, result: projectBoard(db, input || {}) };
  return { handled: false };
}

module.exports = {
  AGENT_GOVERNANCE_TOOL_DEFS,
  ensureAgentGovernanceSchema,
  handleAgentGovernanceTool,
  workOrderTemplateList,
  workOrderTemplateUpsert,
  workOrderCreateFromTemplate,
  qualityGateTemplateList,
  qualityGateRun,
  contextSnapshotCreate,
  contextRestoreBrief,
  workOrderCreate,
  workOrderList,
  workOrderComplete,
  capabilityTokenIssue,
  capabilityTokenCheck,
  capabilityTokenRevoke,
  requiresCapabilityToken,
  departmentCharterSet,
  departmentCharterGet,
  departmentCharterList,
  intentRoute,
  autonomyScoreReport,
  projectFocusSet,
  projectFocusGet,
  projectFocusList,
  projectTaskCreate,
  projectTaskUpdate,
  projectTaskList,
  briefTaskIngest,
  userIntentCapture,
  projectChannelPolicySet,
  projectChannelPolicyGet,
  projectBoard,
};
