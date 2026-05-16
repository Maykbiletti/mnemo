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

const AGENT_GOVERNANCE_TOOL_DEFS = {
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
};

function handleAgentGovernanceTool(db, name, input = {}) {
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
  return { handled: false };
}

module.exports = {
  AGENT_GOVERNANCE_TOOL_DEFS,
  ensureAgentGovernanceSchema,
  handleAgentGovernanceTool,
  workOrderCreate,
  workOrderList,
  workOrderComplete,
  capabilityTokenIssue,
  capabilityTokenCheck,
  capabilityTokenRevoke,
  requiresCapabilityToken,
  departmentCharterSet,
  departmentCharterGet,
  intentRoute,
  autonomyScoreReport,
};
