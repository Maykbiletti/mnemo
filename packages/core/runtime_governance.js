"use strict";

const crypto = require("crypto");
const {
  boolFlag,
  cleanScope,
  compactContent,
  jsonSafe,
  parseMaybeJson,
  uniqueAgentNames,
  uniqueStrings,
  normalizeAgentName,
} = require("./shared_utils");

const DEFAULT_SCOPE = "default";

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function normalizeRuntimeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "runtime";
}

function normalizeCapabilityKind(value) {
  return String(value || "tool")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool";
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return uniqueStrings(value.map((item) => String(item || "").trim()).filter(Boolean));
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return uniqueStrings(parsed.map((item) => String(item || "").trim()).filter(Boolean));
  return uniqueStrings(String(value || "").split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean));
}

function nowIso() {
  return new Date().toISOString();
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeBindingKey(input = {}) {
  const explicit = String(input.binding_key || "").trim();
  if (explicit) return explicit.toLowerCase();
  const parts = [
    input.agent_name || "",
    input.session_key || "",
    input.channel || "",
    input.account_id || "",
    input.peer_kind || "",
    input.peer_id || "",
    input.workspace || "",
  ].map((part) => String(part || "").trim()).filter(Boolean);
  if (parts.length) return parts.join("|").toLowerCase();
  return "binding:" + sha(JSON.stringify(input || {})).slice(0, 16);
}

function normalizeCapabilityRef(input = {}) {
  const explicit = String(input.capability_ref || "").trim();
  if (explicit) return explicit.toLowerCase();
  const kind = normalizeCapabilityKind(input.capability_kind);
  const key = normalizeKey(input.capability_key || input.tool_name || input.channel || input.capability || "*") || "*";
  const agent = normalizeAgentName(input.agent_name || "");
  const channel = normalizeKey(input.channel || "");
  return [kind, key, agent || "*", channel || "*"].join("|");
}

function safeJson(value, fallback) {
  if (value == null) return JSON.stringify(fallback);
  return jsonSafe(value, 20000) || JSON.stringify(fallback);
}

function parseJsonField(value, fallback) {
  return parseMaybeJson(value, fallback);
}

function normalizePolicyPart(value, fallback = "*") {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw === "*") return fallback;
  return raw.toLowerCase();
}

function normalizePolicyRuntime(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw === "*") return "*";
  return normalizeRuntimeName(raw);
}

function normalizePolicyAgent(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw === "*") return "*";
  return normalizeAgentName(raw) || "*";
}

function normalizePolicyKey(input = {}) {
  const explicit = String(input.policy_key || "").trim();
  if (explicit) return explicit.toLowerCase();
  return [
    normalizePolicyRuntime(input.runtime_name),
    normalizePolicyAgent(input.agent_name),
    normalizePolicyPart(input.channel),
    normalizePolicyPart(input.project),
  ].join("|");
}

function intFlag(value, fallback, min = 0, max = 1000000) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function minutesSince(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Math.max(0, value);
  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber) && String(value).trim() !== "") return Math.max(0, parsedNumber);
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function defaultRuntimePolicy(input = {}) {
  const agent = normalizePolicyAgent(input.agent_name);
  const base = {
    id: null,
    scope: scopeName(input.scope),
    runtime_name: normalizePolicyRuntime(input.runtime_name || "codexlink"),
    agent_name: agent,
    channel: normalizePolicyPart(input.channel),
    project: normalizePolicyPart(input.project),
    policy_key: normalizePolicyKey(input),
    required_brief_pull: true,
    required_recall: true,
    required_project_board: true,
    required_chat_sync: true,
    required_memory_update: true,
    required_board: "",
    stale_after_minutes: 15,
    full_sync_every_messages: 10,
    response_allowed_when_context_missing: true,
    warning_token_required: true,
    status: "active",
    required_actions: ["mem_brief_pull", "mem_recall", "mem_project_board", "mem_event_log"],
    meta: { source: "default" },
    updated_by: null,
    created_at: null,
    updated_at: null,
  };
  if (agent === "angel") {
    base.required_board = "wizard2-bridge";
    base.response_allowed_when_context_missing = false;
  } else if (agent === "dieter") {
    base.required_board = "wizard2-bridge";
    base.response_allowed_when_context_missing = true;
  }
  return base;
}

function ensureRuntimeGovernanceSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS runtime_binding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  runtime_name TEXT NOT NULL,
  binding_key TEXT NOT NULL,
  agent_name TEXT,
  project TEXT,
  session_key TEXT,
  channel TEXT,
  account_id TEXT,
  peer_kind TEXT,
  peer_id TEXT,
  workspace TEXT,
  mode TEXT,
  connector_system TEXT,
  capabilities_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_ref TEXT,
  meta_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, runtime_name, binding_key)
);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_agent ON runtime_binding(agent_name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_project ON runtime_binding(project, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_binding_session ON runtime_binding(runtime_name, session_key, status);

CREATE TABLE IF NOT EXISTS runtime_capability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  runtime_name TEXT NOT NULL,
  capability_ref TEXT NOT NULL,
  capability_kind TEXT NOT NULL DEFAULT 'tool',
  capability_key TEXT NOT NULL,
  agent_name TEXT,
  channel TEXT,
  permission TEXT NOT NULL DEFAULT 'allow',
  risk_class TEXT NOT NULL DEFAULT 'normal',
  requires_preflight INTEGER NOT NULL DEFAULT 1,
  requires_receipt INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_agents_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  source_ref TEXT,
  meta_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, runtime_name, capability_ref)
);
CREATE INDEX IF NOT EXISTS idx_runtime_capability_lookup ON runtime_capability(scope, runtime_name, capability_kind, capability_key, status);
CREATE INDEX IF NOT EXISTS idx_runtime_capability_agent ON runtime_capability(agent_name, status);

CREATE TABLE IF NOT EXISTS runtime_tool_receipt (
  receipt_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'default',
  runtime_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project TEXT,
  task TEXT,
  action_type TEXT,
  tool_name TEXT NOT NULL,
  tool_kind TEXT,
  session_key TEXT,
  channel TEXT,
  request_id TEXT,
  binding_id INTEGER,
  connector_system TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  allowed INTEGER NOT NULL DEFAULT 0,
  evidence_required INTEGER NOT NULL DEFAULT 0,
  preflight_status TEXT,
  preflight_action_id INTEGER,
  preflight_json TEXT,
  capability_check_json TEXT,
  claim_ids_json TEXT,
  approval_ids_json TEXT,
  resources_json TEXT,
  tools_json TEXT,
  evidence_json TEXT,
  result_summary TEXT,
  result_json TEXT,
  error TEXT,
  meta_json TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runtime_receipt_agent ON runtime_tool_receipt(agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_receipt_project ON runtime_tool_receipt(project, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_receipt_status ON runtime_tool_receipt(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_receipt_runtime ON runtime_tool_receipt(runtime_name, session_key, started_at DESC);

CREATE TABLE IF NOT EXISTS runtime_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  runtime_name TEXT NOT NULL DEFAULT '*',
  agent_name TEXT NOT NULL DEFAULT '*',
  channel TEXT NOT NULL DEFAULT '*',
  project TEXT NOT NULL DEFAULT '*',
  policy_key TEXT NOT NULL,
  required_brief_pull INTEGER NOT NULL DEFAULT 1,
  required_recall INTEGER NOT NULL DEFAULT 1,
  required_project_board INTEGER NOT NULL DEFAULT 1,
  required_chat_sync INTEGER NOT NULL DEFAULT 1,
  required_memory_update INTEGER NOT NULL DEFAULT 1,
  required_board TEXT,
  stale_after_minutes INTEGER NOT NULL DEFAULT 15,
  full_sync_every_messages INTEGER NOT NULL DEFAULT 10,
  response_allowed_when_context_missing INTEGER NOT NULL DEFAULT 1,
  warning_token_required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  required_actions_json TEXT,
  meta_json TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, runtime_name, policy_key)
);
CREATE INDEX IF NOT EXISTS idx_runtime_policy_lookup ON runtime_policy(scope, runtime_name, agent_name, channel, project, status);
CREATE INDEX IF NOT EXISTS idx_runtime_policy_agent ON runtime_policy(agent_name, status, updated_at DESC);
`);

  try {
    db.exec(`
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_binding_ai AFTER INSERT ON runtime_binding BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_binding', NEW.channel, 'internal', NEW.updated_by, 'runtime_binding_insert', 'runtime_binding', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.runtime_name, '') || ' ' || COALESCE(NEW.agent_name, '') || ' ' || COALESCE(NEW.session_key, ''), NULL, NEW.meta_json, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_binding_au AFTER UPDATE ON runtime_binding BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_binding', NEW.channel, 'internal', NEW.updated_by, 'runtime_binding_update', 'runtime_binding', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.runtime_name, '') || ' ' || COALESCE(NEW.agent_name, '') || ' ' || COALESCE(NEW.session_key, ''), NULL, NEW.meta_json, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_capability_ai AFTER INSERT ON runtime_capability BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_capability', NEW.channel, 'internal', NEW.updated_by, 'runtime_capability_insert', 'runtime_capability', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.runtime_name, '') || ' ' || COALESCE(NEW.capability_kind, '') || ':' || COALESCE(NEW.capability_key, ''), NULL, NEW.meta_json, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_receipt_ai AFTER INSERT ON runtime_tool_receipt BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_tool_receipt', NEW.channel, 'internal', NEW.agent_name, 'runtime_tool_receipt_start', 'runtime_tool_receipt', NEW.receipt_id, NEW.status, COALESCE(NEW.tool_name, '') || ' ' || COALESCE(NEW.task, ''), NEW.resources_json, NEW.meta_json, NEW.started_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_receipt_au AFTER UPDATE ON runtime_tool_receipt BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_tool_receipt', NEW.channel, 'internal', NEW.agent_name, 'runtime_tool_receipt_update', 'runtime_tool_receipt', NEW.receipt_id, NEW.status, COALESCE(NEW.result_summary, NEW.error, NEW.tool_name), NEW.result_json, NEW.meta_json, COALESCE(NEW.finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_policy_ai AFTER INSERT ON runtime_policy BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_policy', NEW.channel, 'internal', NEW.updated_by, 'runtime_policy_insert', 'runtime_policy', CAST(NEW.id AS TEXT), NEW.status, NEW.policy_key, NEW.required_actions_json, NEW.meta_json, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_runtime_policy_au AFTER UPDATE ON runtime_policy BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('runtime_policy', NEW.channel, 'internal', NEW.updated_by, 'runtime_policy_update', 'runtime_policy', CAST(NEW.id AS TEXT), NEW.status, NEW.policy_key, NEW.required_actions_json, NEW.meta_json, NEW.updated_at);
END;
`);
  } catch {}
}

function bindingUpsert(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const runtime = normalizeRuntimeName(input.runtime_name);
  const bindingKey = normalizeBindingKey(input);
  const agent = normalizeAgentName(input.agent_name || "");
  const capabilities = normalizeStringList(input.capabilities);
  db.prepare(
    "INSERT INTO runtime_binding (scope, runtime_name, binding_key, agent_name, project, session_key, channel, account_id, peer_kind, peer_id, workspace, mode, connector_system, capabilities_json, status, source_ref, meta_json, updated_by, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ON CONFLICT(scope, runtime_name, binding_key) DO UPDATE SET agent_name=excluded.agent_name, project=excluded.project, session_key=excluded.session_key, channel=excluded.channel, account_id=excluded.account_id, peer_kind=excluded.peer_kind, peer_id=excluded.peer_id, workspace=excluded.workspace, mode=excluded.mode, connector_system=excluded.connector_system, capabilities_json=excluded.capabilities_json, status=excluded.status, source_ref=excluded.source_ref, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
  ).run(
    scope,
    runtime,
    bindingKey,
    agent || null,
    input.project || null,
    input.session_key || null,
    input.channel || null,
    input.account_id || null,
    input.peer_kind || null,
    input.peer_id || null,
    input.workspace || null,
    input.mode || null,
    input.connector_system || null,
    JSON.stringify(capabilities),
    input.status || "active",
    input.source_ref || null,
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  const row = db.prepare("SELECT * FROM runtime_binding WHERE scope=? AND runtime_name=? AND binding_key=?").get(scope, runtime, bindingKey);
  return { ok: true, binding: rowToBinding(row) };
}

function rowToBinding(row) {
  return row ? Object.assign({}, row, {
    capabilities: parseJsonField(row.capabilities_json, []),
    meta: parseJsonField(row.meta_json, {}),
  }) : null;
}

function bindingList(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.runtime_name) { where.push("runtime_name=?"); params.push(normalizeRuntimeName(input.runtime_name)); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.session_key) { where.push("session_key=?"); params.push(input.session_key); }
  if (input.channel) { where.push("channel=?"); params.push(input.channel); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  else where.push("status!='deleted'");
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM runtime_binding WHERE " + where.join(" AND ") + " ORDER BY updated_at DESC LIMIT ?").all(...params).map(rowToBinding);
  return { ok: true, count: rows.length, bindings: rows };
}

function capabilityUpsert(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const runtime = normalizeRuntimeName(input.runtime_name);
  const kind = normalizeCapabilityKind(input.capability_kind || (input.tool_name ? "tool" : "capability"));
  const key = normalizeKey(input.capability_key || input.tool_name || input.capability || "*") || "*";
  const ref = normalizeCapabilityRef(Object.assign({}, input, { capability_kind: kind, capability_key: key }));
  const allowedAgents = uniqueAgentNames(normalizeStringList(input.allowed_agents));
  db.prepare(
    "INSERT INTO runtime_capability (scope, runtime_name, capability_ref, capability_kind, capability_key, agent_name, channel, permission, risk_class, requires_preflight, requires_receipt, enabled, allowed_agents_json, status, notes, source_ref, meta_json, updated_by, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ON CONFLICT(scope, runtime_name, capability_ref) DO UPDATE SET capability_kind=excluded.capability_kind, capability_key=excluded.capability_key, agent_name=excluded.agent_name, channel=excluded.channel, permission=excluded.permission, risk_class=excluded.risk_class, requires_preflight=excluded.requires_preflight, requires_receipt=excluded.requires_receipt, enabled=excluded.enabled, allowed_agents_json=excluded.allowed_agents_json, status=excluded.status, notes=excluded.notes, source_ref=excluded.source_ref, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
  ).run(
    scope,
    runtime,
    ref,
    kind,
    key,
    normalizeAgentName(input.agent_name || "") || null,
    input.channel || null,
    String(input.permission || "allow").toLowerCase(),
    input.risk_class || "normal",
    boolFlag(input.requires_preflight, true) ? 1 : 0,
    boolFlag(input.requires_receipt, true) ? 1 : 0,
    boolFlag(input.enabled, true) ? 1 : 0,
    JSON.stringify(allowedAgents),
    input.status || "active",
    input.notes || null,
    input.source_ref || null,
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  const row = db.prepare("SELECT * FROM runtime_capability WHERE scope=? AND runtime_name=? AND capability_ref=?").get(scope, runtime, ref);
  return { ok: true, capability: rowToCapability(row) };
}

function rowToCapability(row) {
  return row ? Object.assign({}, row, {
    requires_preflight: !!row.requires_preflight,
    requires_receipt: !!row.requires_receipt,
    enabled: !!row.enabled,
    allowed_agents: parseJsonField(row.allowed_agents_json, []),
    meta: parseJsonField(row.meta_json, {}),
  }) : null;
}

function capabilityList(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.runtime_name) { where.push("runtime_name=?"); params.push(normalizeRuntimeName(input.runtime_name)); }
  if (input.capability_kind) { where.push("capability_kind=?"); params.push(normalizeCapabilityKind(input.capability_kind)); }
  if (input.capability_key) { where.push("capability_key=?"); params.push(normalizeKey(input.capability_key)); }
  if (input.agent_name) { where.push("(agent_name=? OR agent_name IS NULL)"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.channel) { where.push("(channel=? OR channel IS NULL)"); params.push(input.channel); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  else where.push("status='active'");
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM runtime_capability WHERE " + where.join(" AND ") + " ORDER BY updated_at DESC LIMIT ?").all(...params).map(rowToCapability);
  return { ok: true, count: rows.length, capabilities: rows };
}

function runtimeCapabilityCheck(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const runtime = normalizeRuntimeName(input.runtime_name);
  const agent = normalizeAgentName(input.agent_name || "");
  const channel = input.channel || null;
  const requested = uniqueStrings([])
    .concat(normalizeStringList(input.capabilities))
    .concat(input.tool_name ? [String(input.tool_name)] : [])
    .concat(input.tool_kind ? [String(input.tool_kind)] : [])
    .map((item) => normalizeKey(item))
    .filter(Boolean);
  const allRows = db.prepare(
    "SELECT * FROM runtime_capability WHERE scope IN (?, 'default') AND runtime_name IN (?, '*') AND status='active' ORDER BY updated_at DESC"
  ).all(scope, runtime).map(rowToCapability);
  const matched = [];
  const blockers = [];
  const warnings = [];
  for (const row of allRows) {
    const key = normalizeKey(row.capability_key);
    const agentMatch = !row.agent_name || row.agent_name === agent;
    const channelMatch = !row.channel || row.channel === channel;
    const keyMatch = key === "*" || requested.includes(key);
    if (!agentMatch || !channelMatch || !keyMatch) continue;
    matched.push(row);
    const allowedAgents = uniqueAgentNames(row.allowed_agents || []);
    if (!row.enabled || ["deny", "block", "disabled"].includes(String(row.permission || "").toLowerCase())) {
      blockers.push(`runtime capability denied: ${row.runtime_name} ${row.capability_kind}:${row.capability_key}`);
    }
    if (allowedAgents.length && !allowedAgents.includes(agent)) {
      blockers.push(`runtime capability ${row.capability_key} does not allow agent ${agent}`);
    }
  }
  if (!matched.length) {
    const msg = `runtime capability not registered for ${runtime}: ${requested.join(", ") || input.tool_name || "tool"}`;
    if (input.require_registered_capability) blockers.push(msg);
    else warnings.push(msg);
  }
  return {
    ok: blockers.length === 0,
    status: blockers.length ? "block" : (warnings.length ? "warn" : "ok"),
    runtime_name: runtime,
    agent_name: agent,
    requested,
    blockers,
    warnings,
    matched_count: matched.length,
    matched_capabilities: matched,
    requires_preflight: matched.length ? matched.some((row) => row.requires_preflight) : true,
    requires_receipt: matched.length ? matched.some((row) => row.requires_receipt) : true,
  };
}

function rowToRuntimePolicy(row) {
  return row ? Object.assign({}, row, {
    required_brief_pull: !!row.required_brief_pull,
    required_recall: !!row.required_recall,
    required_project_board: !!row.required_project_board,
    required_chat_sync: !!row.required_chat_sync,
    required_memory_update: !!row.required_memory_update,
    response_allowed_when_context_missing: !!row.response_allowed_when_context_missing,
    warning_token_required: !!row.warning_token_required,
    required_actions: parseJsonField(row.required_actions_json, []),
    meta: parseJsonField(row.meta_json, {}),
  }) : null;
}

function runtimePolicySet(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const runtime = normalizePolicyRuntime(input.runtime_name || "*");
  const agent = normalizePolicyAgent(input.agent_name || "*");
  const channel = normalizePolicyPart(input.channel || "*");
  const project = normalizePolicyPart(input.project || "*");
  const policyKey = normalizePolicyKey({ runtime_name: runtime, agent_name: agent, channel, project, policy_key: input.policy_key });
  const base = defaultRuntimePolicy({ scope, runtime_name: runtime, agent_name: agent, channel, project, policy_key: policyKey });
  const requiredActions = normalizeStringList(input.required_actions || input.required_actions_json || base.required_actions);
  db.prepare(
    "INSERT INTO runtime_policy (scope, runtime_name, agent_name, channel, project, policy_key, required_brief_pull, required_recall, required_project_board, required_chat_sync, required_memory_update, required_board, stale_after_minutes, full_sync_every_messages, response_allowed_when_context_missing, warning_token_required, status, required_actions_json, meta_json, updated_by, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ON CONFLICT(scope, runtime_name, policy_key) DO UPDATE SET agent_name=excluded.agent_name, channel=excluded.channel, project=excluded.project, required_brief_pull=excluded.required_brief_pull, required_recall=excluded.required_recall, required_project_board=excluded.required_project_board, required_chat_sync=excluded.required_chat_sync, required_memory_update=excluded.required_memory_update, required_board=excluded.required_board, stale_after_minutes=excluded.stale_after_minutes, full_sync_every_messages=excluded.full_sync_every_messages, response_allowed_when_context_missing=excluded.response_allowed_when_context_missing, warning_token_required=excluded.warning_token_required, status=excluded.status, required_actions_json=excluded.required_actions_json, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
  ).run(
    scope,
    runtime,
    agent,
    channel,
    project,
    policyKey,
    boolFlag(input.required_brief_pull, base.required_brief_pull) ? 1 : 0,
    boolFlag(input.required_recall, base.required_recall) ? 1 : 0,
    boolFlag(input.required_project_board, base.required_project_board) ? 1 : 0,
    boolFlag(input.required_chat_sync, base.required_chat_sync) ? 1 : 0,
    boolFlag(input.required_memory_update, base.required_memory_update) ? 1 : 0,
    input.required_board != null ? String(input.required_board) : base.required_board,
    intFlag(input.stale_after_minutes, base.stale_after_minutes, 1, 10080),
    intFlag(input.full_sync_every_messages, base.full_sync_every_messages, 1, 100000),
    boolFlag(input.response_allowed_when_context_missing, base.response_allowed_when_context_missing) ? 1 : 0,
    boolFlag(input.warning_token_required, base.warning_token_required) ? 1 : 0,
    input.status || "active",
    safeJson(requiredActions, []),
    safeJson(input.meta || {}, {}),
    normalizeAgentName(input.updated_by || input.agent_name || "") || null
  );
  const row = db.prepare("SELECT * FROM runtime_policy WHERE scope=? AND runtime_name=? AND policy_key=?").get(scope, runtime, policyKey);
  return { ok: true, policy: rowToRuntimePolicy(row) };
}

function runtimePolicySpecificity(row, input = {}) {
  const runtime = normalizePolicyRuntime(input.runtime_name || "codexlink");
  const agent = normalizePolicyAgent(input.agent_name || "*");
  const channel = normalizePolicyPart(input.channel || "*");
  const project = normalizePolicyPart(input.project || "*");
  let score = 0;
  if (row.scope === scopeName(input.scope)) score += 32;
  if (row.runtime_name === runtime) score += 16;
  if (row.agent_name === agent) score += 8;
  if (row.project === project) score += 4;
  if (row.channel === channel) score += 2;
  if (row.policy_key && row.policy_key !== "*") score += 1;
  return score;
}

function runtimePolicyGet(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const scope = scopeName(input.scope);
  const runtime = normalizePolicyRuntime(input.runtime_name || "codexlink");
  const agent = normalizePolicyAgent(input.agent_name || "*");
  const channel = normalizePolicyPart(input.channel || "*");
  const project = normalizePolicyPart(input.project || "*");
  const rows = db.prepare(
    "SELECT * FROM runtime_policy WHERE scope IN (?, 'default') AND runtime_name IN (?, '*') AND agent_name IN (?, '*') AND channel IN (?, '*') AND project IN (?, '*') AND status='active'"
  ).all(scope, runtime, agent, channel, project).map(rowToRuntimePolicy);
  rows.sort((a, b) => runtimePolicySpecificity(b, input) - runtimePolicySpecificity(a, input));
  if (rows.length) return { ok: true, source: "stored", policy: rows[0], matched_policy_id: rows[0].id };
  return { ok: true, source: "default", policy: defaultRuntimePolicy({ scope, runtime_name: runtime, agent_name: agent, channel, project }) };
}

function requirementStale(input, key, staleAfter) {
  const has = boolFlag(input[`has_${key}`], false);
  const minutes = minutesSince(input[`${key}_at`] || input[`last_${key}_at`] || input[`minutes_since_${key}`]);
  if (!has) return { missing: true, reason: `${key} missing`, age_minutes: minutes };
  if (minutes != null && minutes > staleAfter) return { missing: true, reason: `${key} stale (${minutes}m > ${staleAfter}m)`, age_minutes: minutes };
  return { missing: false, reason: "ok", age_minutes: minutes };
}

function journalRuntimePolicyCheck(db, input, result) {
  try {
    const info = db.prepare(
      "INSERT INTO mnemo_event_journal (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    ).run(
      "runtime_policy",
      input.channel || null,
      "internal",
      normalizeAgentName(input.agent_name || "") || null,
      "runtime_policy_check",
      "runtime_policy",
      result.policy && result.policy.id ? String(result.policy.id) : result.policy_key,
      result.status,
      `runtime policy ${result.status}: ${result.agent_name || ""} ${result.project || ""}`.trim(),
      safeJson({ missing_context: result.missing_context, required_actions: result.required_actions, full_sync_due: result.full_sync_due }, {}),
      safeJson({ input, policy: result.policy, warning_token: result.warning_token || null }, {})
    );
    return Number(info.lastInsertRowid || 0) || null;
  } catch {
    return null;
  }
}

function runtimePolicyCheck(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const policyResult = runtimePolicyGet(db, input);
  const policy = policyResult.policy || defaultRuntimePolicy(input);
  const staleAfter = intFlag(policy.stale_after_minutes, 15, 1, 10080);
  const every = intFlag(policy.full_sync_every_messages, 10, 1, 100000);
  const messageCount = intFlag(input.message_count_since_full_sync ?? input.messages_since_full_sync ?? input.message_count, 0, 0, 100000000);
  const turnNumber = intFlag(input.turn_number ?? input.message_number, 0, 0, 100000000);
  const fullSyncDue = !boolFlag(input.has_full_sync, false) && !boolFlag(input.full_sync_completed, false) && (messageCount >= every || (turnNumber > 0 && turnNumber % every === 0));
  const missing = [];
  const addMissing = (name, check) => {
    if (check.missing) missing.push({ requirement: name, reason: check.reason, age_minutes: check.age_minutes });
  };
  if (policy.required_brief_pull) addMissing("mem_brief_pull", requirementStale(input, "brief_pull", staleAfter));
  if (policy.required_recall) addMissing("mem_recall", requirementStale(input, "recall", staleAfter));
  if (policy.required_project_board) addMissing("mem_project_board", requirementStale(input, "project_board", staleAfter));
  if (policy.required_chat_sync) addMissing("chat_sync", requirementStale(input, "chat_sync", staleAfter));
  if (policy.required_memory_update) addMissing("memory_update", requirementStale(input, "memory_update", staleAfter));
  if (policy.required_board) {
    const board = String(input.board || input.project_board || "").trim().toLowerCase();
    const requiredBoard = String(policy.required_board || "").trim().toLowerCase();
    if (requiredBoard && board && board !== requiredBoard) {
      missing.push({ requirement: "required_board", reason: `board mismatch: ${board} != ${requiredBoard}`, expected: policy.required_board, actual: input.board || input.project_board });
    } else if (requiredBoard && !board) {
      missing.push({ requirement: "required_board", reason: `board ${policy.required_board} not loaded`, expected: policy.required_board });
    }
  }
  if (fullSyncDue) {
    missing.push({ requirement: "full_sync_every_messages", reason: `full sync due after ${messageCount || turnNumber} messages`, every });
  }
  const responseAllowed = missing.length === 0 || !!policy.response_allowed_when_context_missing;
  const status = missing.length === 0 ? "ok" : (responseAllowed ? "warn" : "block");
  const requiredActions = uniqueStrings([])
    .concat(policy.required_actions || [])
    .concat(missing.map((entry) => entry.requirement))
    .concat(fullSyncDue ? ["mem_event_log", "chat_sync", "memory_update"] : []);
  const result = {
    ok: responseAllowed,
    allowed: responseAllowed,
    response_allowed: responseAllowed,
    status,
    source: policyResult.source,
    runtime_name: normalizePolicyRuntime(input.runtime_name || policy.runtime_name || "codexlink"),
    agent_name: normalizePolicyAgent(input.agent_name || policy.agent_name),
    channel: normalizePolicyPart(input.channel || policy.channel),
    project: normalizePolicyPart(input.project || policy.project),
    policy_key: policy.policy_key || normalizePolicyKey(input),
    policy,
    missing_context: missing,
    required_actions: requiredActions,
    full_sync_due: fullSyncDue,
    full_sync_every_messages: every,
    message_count_since_full_sync: messageCount,
    warning_token: missing.length && policy.warning_token_required ? "MNEMO_CONTEXT_STALE" : null,
    hint: missing.length ? "Run the required Mnemo sync actions before responding, then check this policy again." : "Context is fresh enough to respond."
  };
  result.audit_id = journalRuntimePolicyCheck(db, input, result);
  return result;
}

function inferActionType(input = {}) {
  if (input.action_type) return String(input.action_type);
  const text = [input.tool_name, input.tool_kind, input.task, input.summary].filter(Boolean).join(" ").toLowerCase();
  if (/\b(deploy|pm2|nginx|dns|restart|ssh|scp|rsync)\b/.test(text)) return "deploy";
  if (/\b(write|edit|patch|apply|delete|remove|move|rename|create|generate|save)\b/.test(text)) return "code_edit";
  if (/\b(send|post|message|email|reply|webhook|api)\b/.test(text)) return "external_comm";
  return "read";
}

function isEvidenceRequired(input = {}) {
  if (input.evidence_required != null) return boolFlag(input.evidence_required, false);
  const action = inferActionType(input).toLowerCase();
  return ["deploy", "code_edit", "write", "delete", "move", "external_comm"].includes(action);
}

function resourcesFromInput(input = {}) {
  return {
    files: Array.isArray(input.files) ? input.files : [],
    urls: Array.isArray(input.urls) ? input.urls : [],
    routes: Array.isArray(input.routes) ? input.routes : [],
    domains: Array.isArray(input.domains) ? input.domains : [],
    system_names: Array.isArray(input.system_names) ? input.system_names : [],
    resources: Array.isArray(input.resources) ? input.resources : [],
  };
}

function runtimeToolReceiptStart(db, input = {}, options = {}) {
  ensureRuntimeGovernanceSchema(db);
  const runtime = normalizeRuntimeName(input.runtime_name);
  const agent = normalizeAgentName(input.agent_name);
  const toolName = String(input.tool_name || "").trim();
  if (!agent || !toolName) return { error: "agent_name + tool_name required" };
  const actionType = inferActionType(input);
  const capCheck = runtimeCapabilityCheck(db, Object.assign({}, input, { action_type: actionType }));
  const preflight = options.preflight || input.preflight || null;
  const preflightStatus = preflight && (preflight.status || (preflight.ok ? "ok" : "block")) || (input.preflight_required === false ? "skipped" : "missing");
  const blockers = []
    .concat(capCheck.blockers || [])
    .concat(preflight && Array.isArray(preflight.blockers) ? preflight.blockers : []);
  if (input.preflight_required !== false && !preflight) blockers.push("missing Mnemo preflight result");
  const allowed = blockers.length === 0;
  const status = allowed ? "started" : "blocked";
  const receiptId = input.receipt_id || "rt-" + sha([runtime, agent, toolName, input.request_id || "", nowIso(), Math.random()].join("|")).slice(0, 24);
  const evidenceRequired = isEvidenceRequired(Object.assign({}, input, { action_type: actionType }));
  const claims = uniqueStrings([])
    .concat(Array.isArray(input.claim_ids) ? input.claim_ids.map(String) : [])
    .concat(Array.isArray(preflight && preflight.claims) ? preflight.claims.map((claim) => String(claim && (claim.id || claim.claim_id) || "")).filter(Boolean) : []);
  const approvals = uniqueStrings(Array.isArray(input.approval_ids) ? input.approval_ids.map(String) : []);
  const toolsUsed = uniqueStrings([])
    .concat(input.tool_name ? [input.tool_name] : [])
    .concat(Array.isArray(input.tools_used) ? input.tools_used : []);
  const meta = Object.assign({}, input.meta || {}, {
    blockers,
    capability_status: capCheck.status,
    preflight_status: preflightStatus,
    request_payload: input.payload || null,
  });
  db.prepare(
    "INSERT INTO runtime_tool_receipt (receipt_id, scope, runtime_name, agent_name, project, task, action_type, tool_name, tool_kind, session_key, channel, request_id, binding_id, connector_system, status, allowed, evidence_required, preflight_status, preflight_action_id, preflight_json, capability_check_json, claim_ids_json, approval_ids_json, resources_json, tools_json, evidence_json, meta_json, started_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ON CONFLICT(receipt_id) DO UPDATE SET status=excluded.status, allowed=excluded.allowed, preflight_status=excluded.preflight_status, preflight_action_id=excluded.preflight_action_id, preflight_json=excluded.preflight_json, capability_check_json=excluded.capability_check_json, claim_ids_json=excluded.claim_ids_json, approval_ids_json=excluded.approval_ids_json, resources_json=excluded.resources_json, tools_json=excluded.tools_json, meta_json=excluded.meta_json"
  ).run(
    receiptId,
    scopeName(input.scope),
    runtime,
    agent,
    input.project || null,
    input.task || input.summary || `runtime toolrun ${toolName}`,
    actionType,
    toolName,
    input.tool_kind || null,
    input.session_key || null,
    input.channel || null,
    input.request_id || null,
    input.binding_id || null,
    input.connector_system || null,
    status,
    allowed ? 1 : 0,
    evidenceRequired ? 1 : 0,
    preflightStatus,
    preflight && preflight.preflight_action_id || null,
    safeJson(preflight || {}, {}),
    safeJson(capCheck, {}),
    JSON.stringify(claims),
    JSON.stringify(approvals),
    safeJson(resourcesFromInput(input), {}),
    JSON.stringify(toolsUsed),
    JSON.stringify([]),
    safeJson(meta, {})
  );
  return {
    ok: true,
    receipt_id: receiptId,
    allowed,
    status,
    runtime_name: runtime,
    agent_name: agent,
    preflight_status: preflightStatus,
    preflight_action_id: preflight && preflight.preflight_action_id || null,
    evidence_required: evidenceRequired,
    blockers,
    warnings: capCheck.warnings || [],
    capability_check: capCheck,
    hint: allowed ? "Toolrun may proceed. Finish this receipt with mem_runtime_tool_receipt_finish." : "Do not execute the toolrun. Resolve blockers or request approval/claim access."
  };
}

function runtimeToolReceiptFinish(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const receiptId = String(input.receipt_id || "").trim();
  if (!receiptId) return { error: "receipt_id required" };
  const row = db.prepare("SELECT * FROM runtime_tool_receipt WHERE receipt_id=?").get(receiptId);
  if (!row) return { error: "receipt_not_found", receipt_id: receiptId };
  const status = String(input.status || "done").toLowerCase();
  if (!["done", "failed", "blocked", "cancelled", "skipped"].includes(status)) return { error: "invalid_status", allowed: ["done", "failed", "blocked", "cancelled", "skipped"] };
  if (status === "done" && !row.allowed) {
    return {
      error: "receipt_not_allowed",
      receipt_id: receiptId,
      hint: "A blocked receipt cannot be completed as done. Resolve the gate and open a new allowed receipt."
    };
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (status === "done" && !!row.evidence_required && !evidence.length && !input.handoff_id) {
    return {
      error: "evidence_required",
      receipt_id: receiptId,
      hint: "Pass evidence=[{target|url|file_path|server|screenshot_path, test_step, result, timestamp}] or link a handoff_id that contains evidence."
    };
  }
  const shapedEvidence = evidence.map((item) => Object.assign({}, item, { timestamp: item && item.timestamp || nowIso() }));
  const resultSummary = compactContent(input.result_summary || input.summary || input.result || input.error || status, 1200);
  const meta = Object.assign(parseJsonField(row.meta_json, {}), input.meta || {}, {
    handoff_id: input.handoff_id || null,
    output_ref: input.output_ref || null,
  });
  db.prepare(
    "UPDATE runtime_tool_receipt SET status=?, evidence_json=?, result_summary=?, result_json=?, error=?, meta_json=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE receipt_id=?"
  ).run(
    status,
    safeJson(shapedEvidence, []),
    resultSummary || null,
    safeJson(input.result_json != null ? input.result_json : input.result, {}),
    input.error || null,
    safeJson(meta, {}),
    receiptId
  );
  return { ok: true, receipt_id: receiptId, status, evidence_count: shapedEvidence.length, handoff_id: input.handoff_id || null };
}

function rowToReceipt(row) {
  return row ? Object.assign({}, row, {
    allowed: !!row.allowed,
    evidence_required: !!row.evidence_required,
    preflight: parseJsonField(row.preflight_json, {}),
    capability_check: parseJsonField(row.capability_check_json, {}),
    claim_ids: parseJsonField(row.claim_ids_json, []),
    approval_ids: parseJsonField(row.approval_ids_json, []),
    resources: parseJsonField(row.resources_json, {}),
    tools_used: parseJsonField(row.tools_json, []),
    evidence: parseJsonField(row.evidence_json, []),
    result: parseJsonField(row.result_json, {}),
    meta: parseJsonField(row.meta_json, {}),
  }) : null;
}

function runtimeToolReceiptList(db, input = {}) {
  ensureRuntimeGovernanceSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.runtime_name) { where.push("runtime_name=?"); params.push(normalizeRuntimeName(input.runtime_name)); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  if (input.session_key) { where.push("session_key=?"); params.push(input.session_key); }
  if (input.tool_name) { where.push("tool_name=?"); params.push(input.tool_name); }
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM runtime_tool_receipt WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?").all(...params).map(rowToReceipt);
  return { ok: true, count: rows.length, receipts: rows };
}

const RUNTIME_GOVERNANCE_TOOL_DEFS = {
  mem_runtime_binding_upsert: {
    description: "Register or update an external runtime/session/channel binding so OpenClaw-like gateways map to one Mnemo agent, project, connector, and capability set.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, binding_key: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, session_key: { type: "string" }, channel: { type: "string" }, account_id: { type: "string" }, peer_kind: { type: "string" }, peer_id: { type: "string" }, workspace: { type: "string" }, mode: { type: "string" }, connector_system: { type: "string" }, capabilities: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, status: { type: "string" }, source_ref: { type: "string" }, meta: { type: "object" }, updated_by: { type: "string" } }, required: ["runtime_name"] }
  },
  mem_runtime_binding_list: {
    description: "List external runtime/session/channel bindings.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, session_key: { type: "string" }, channel: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_runtime_capability_upsert: {
    description: "Register a runtime, channel, or tool capability with allow/deny, agent allowlist, risk class, and receipt/preflight requirements.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, capability_ref: { type: "string" }, capability_kind: { type: "string" }, capability_key: { type: "string" }, tool_name: { type: "string" }, agent_name: { type: "string" }, channel: { type: "string" }, permission: { type: "string" }, risk_class: { type: "string" }, requires_preflight: { type: "boolean" }, requires_receipt: { type: "boolean" }, enabled: { type: "boolean" }, allowed_agents: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, status: { type: "string" }, notes: { type: "string" }, source_ref: { type: "string" }, meta: { type: "object" }, updated_by: { type: "string" } }, required: ["runtime_name"] }
  },
  mem_runtime_capability_list: {
    description: "List runtime/channel/tool capabilities and their preflight/receipt requirements.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, capability_kind: { type: "string" }, capability_key: { type: "string" }, agent_name: { type: "string" }, channel: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_runtime_capability_check: {
    description: "Check whether an external runtime tool/capability is allowed for an agent before execution.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, channel: { type: "string" }, tool_name: { type: "string" }, tool_kind: { type: "string" }, capabilities: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, require_registered_capability: { type: "boolean" } }, required: ["runtime_name", "agent_name"] }
  },
  mem_runtime_policy_set: {
    description: "Set an adapter/runtime response policy for an agent/channel/project, including mandatory Mnemo context sync, stale limits, and every-N-message full sync cadence.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, channel: { type: "string" }, project: { type: "string" }, policy_key: { type: "string" }, required_brief_pull: { type: "boolean" }, required_recall: { type: "boolean" }, required_project_board: { type: "boolean" }, required_chat_sync: { type: "boolean" }, required_memory_update: { type: "boolean" }, required_board: { type: "string" }, stale_after_minutes: { type: "integer" }, full_sync_every_messages: { type: "integer" }, response_allowed_when_context_missing: { type: "boolean" }, warning_token_required: { type: "boolean" }, required_actions: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, status: { type: "string" }, meta: { type: "object" }, updated_by: { type: "string" } } }
  },
  mem_runtime_policy_get: {
    description: "Return the effective runtime response policy for an agent/channel/project, falling back to built-in defaults when no stored policy exists.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, channel: { type: "string" }, project: { type: "string" } } }
  },
  mem_runtime_policy_check: {
    description: "Check whether a runtime/agent is allowed to answer now, enforcing stale Mnemo context, project-board load, chat/memory sync, and every-N-message full sync. Writes an audit event and returns audit_id.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, channel: { type: "string" }, project: { type: "string" }, board: { type: "string" }, project_board: { type: "string" }, message_count_since_full_sync: { type: "integer" }, messages_since_full_sync: { type: "integer" }, turn_number: { type: "integer" }, has_full_sync: { type: "boolean" }, full_sync_completed: { type: "boolean" }, has_brief_pull: { type: "boolean" }, has_recall: { type: "boolean" }, has_project_board: { type: "boolean" }, has_chat_sync: { type: "boolean" }, has_memory_update: { type: "boolean" }, brief_pull_at: { type: "string" }, recall_at: { type: "string" }, project_board_at: { type: "string" }, chat_sync_at: { type: "string" }, memory_update_at: { type: "string" }, minutes_since_brief_pull: { type: "number" }, minutes_since_recall: { type: "number" }, minutes_since_project_board: { type: "number" }, minutes_since_chat_sync: { type: "number" }, minutes_since_memory_update: { type: "number" }, message_ref: { type: "string" }, session_key: { type: "string" }, meta: { type: "object" } } }
  },
  mem_runtime_tool_receipt_start: {
    description: "Open a Mnemo receipt for an external runtime toolrun. This must run before OpenClaw-like tool execution and stores the preflight result, capability gate, claims, approvals, resources, and receipt id.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, task: { type: "string" }, summary: { type: "string" }, action_type: { type: "string" }, tool_name: { type: "string" }, tool_kind: { type: "string" }, session_key: { type: "string" }, channel: { type: "string" }, request_id: { type: "string" }, binding_id: { type: "integer" }, connector_system: { type: "string" }, token_id: { type: "string" }, capability_token_id: { type: "string" }, work_order_id: { type: "integer" }, files: { type: "array", items: { type: "string" } }, urls: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } }, capabilities: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] }, claim_ids: { type: "array", items: { type: "string" } }, approval_ids: { type: "array", items: { type: "string" } }, evidence_required: { type: "boolean" }, preflight_required: { type: "boolean" }, require_project_rules: { type: "boolean" }, require_registered_capability: { type: "boolean" }, payload: { type: "object" }, meta: { type: "object" } }, required: ["runtime_name", "agent_name", "tool_name"] }
  },
  mem_runtime_tool_receipt_finish: {
    description: "Finish an external runtime toolrun receipt with result, error, evidence, output reference, and optional handoff link.",
    inputSchema: { type: "object", properties: { receipt_id: { type: "string" }, status: { type: "string" }, result_summary: { type: "string" }, summary: { type: "string" }, result: {}, result_json: { type: "object" }, error: { type: "string" }, evidence: { type: "array", items: { type: "object" } }, output_ref: { type: "string" }, handoff_id: { type: "integer" }, meta: { type: "object" } }, required: ["receipt_id"] }
  },
  mem_runtime_tool_receipt_list: {
    description: "List external runtime tool receipts with preflight, capability, evidence, and result state.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, runtime_name: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, status: { type: "string" }, session_key: { type: "string" }, tool_name: { type: "string" }, limit: { type: "integer" } } }
  }
};

function handleRuntimeGovernanceTool(db, name, input = {}) {
  if (name === "mem_runtime_binding_upsert") return { handled: true, result: bindingUpsert(db, input || {}) };
  if (name === "mem_runtime_binding_list") return { handled: true, result: bindingList(db, input || {}) };
  if (name === "mem_runtime_capability_upsert") return { handled: true, result: capabilityUpsert(db, input || {}) };
  if (name === "mem_runtime_capability_list") return { handled: true, result: capabilityList(db, input || {}) };
  if (name === "mem_runtime_capability_check") return { handled: true, result: runtimeCapabilityCheck(db, input || {}) };
  if (name === "mem_runtime_policy_set") return { handled: true, result: runtimePolicySet(db, input || {}) };
  if (name === "mem_runtime_policy_get") return { handled: true, result: runtimePolicyGet(db, input || {}) };
  if (name === "mem_runtime_policy_check") return { handled: true, result: runtimePolicyCheck(db, input || {}) };
  if (name === "mem_runtime_tool_receipt_start") return { handled: true, result: runtimeToolReceiptStart(db, input || {}) };
  if (name === "mem_runtime_tool_receipt_finish") return { handled: true, result: runtimeToolReceiptFinish(db, input || {}) };
  if (name === "mem_runtime_tool_receipt_list") return { handled: true, result: runtimeToolReceiptList(db, input || {}) };
  return { handled: false };
}

module.exports = {
  RUNTIME_GOVERNANCE_TOOL_DEFS,
  ensureRuntimeGovernanceSchema,
  handleRuntimeGovernanceTool,
  runtimeToolReceiptStart,
  runtimeToolReceiptFinish,
  runtimeCapabilityCheck,
  runtimePolicySet,
  runtimePolicyGet,
  runtimePolicyCheck,
};
