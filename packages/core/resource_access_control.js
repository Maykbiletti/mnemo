"use strict";

const DEFAULT_SCOPE = "default";
const WRITE_PERMISSIONS = new Set(["write", "execute", "deploy", "approve", "own"]);

function cleanScope(scope) {
  return String(scope || DEFAULT_SCOPE).toLowerCase().replace(/[^a-z0-9_-]/g, "") || DEFAULT_SCOPE;
}

function normalizeAgentName(name) {
  return String(name || "").trim().toLowerCase();
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeResourceKind(kind) {
  const value = String(kind || "scope")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return value || "scope";
}

function normalizeResourceKey(kind, key) {
  const k = normalizeResourceKind(kind);
  const raw = String(key || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (k === "file") return raw.toLowerCase();
  if (k === "domain") return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (k === "route") return raw.startsWith("/") ? raw.toLowerCase() : "/" + raw.toLowerCase();
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function permissionRank(permission) {
  const p = String(permission || "read").toLowerCase();
  if (p === "own") return 50;
  if (p === "approve") return 40;
  if (p === "deploy" || p === "execute") return 30;
  if (p === "write") return 20;
  return 10;
}

function requiredPermission(input = {}) {
  const action = String(input.action_type || "").toLowerCase();
  if (action === "deploy") return "deploy";
  if (["code_edit", "write", "delete", "move"].includes(action)) return "write";
  if (action === "external_comm") return "execute";
  return "read";
}

function isWriteLike(input = {}) {
  return WRITE_PERMISSIONS.has(requiredPermission(input));
}

function ensureResourceAccessSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS org_resource (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  label TEXT,
  owner_agent TEXT,
  owning_department TEXT,
  risk_class TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, resource_kind, resource_key)
);
CREATE INDEX IF NOT EXISTS idx_org_resource_owner ON org_resource(owner_agent, status);
CREATE INDEX IF NOT EXISTS idx_org_resource_project ON org_resource(project, status);

CREATE TABLE IF NOT EXISTS resource_acl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  agent_name TEXT,
  department_name TEXT,
  permission TEXT NOT NULL DEFAULT 'read',
  status TEXT NOT NULL DEFAULT 'active',
  granted_by TEXT,
  reason TEXT,
  claim_id INTEGER,
  approval_id INTEGER,
  expires_at TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resource_acl_lookup ON resource_acl(scope, resource_kind, resource_key, status);
CREATE INDEX IF NOT EXISTS idx_resource_acl_agent ON resource_acl(agent_name, status, expires_at);

CREATE TABLE IF NOT EXISTS approval_request (
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
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_request(scope, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_owner ON approval_request(owner_agent, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_resource ON approval_request(scope, resource_kind, resource_key, status);

CREATE TABLE IF NOT EXISTS resource_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  event_kind TEXT NOT NULL,
  actor_agent TEXT,
  resource_kind TEXT,
  resource_key TEXT,
  permission TEXT,
  claim_id INTEGER,
  approval_id INTEGER,
  tool_name TEXT,
  reason TEXT,
  result TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resource_audit_resource ON resource_audit_log(scope, resource_kind, resource_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resource_audit_actor ON resource_audit_log(actor_agent, created_at DESC);
`);
}

function ensureWorkClaimSchemaForLookup(db) {
  db.exec(`
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
CREATE INDEX IF NOT EXISTS idx_work_claim_scope_active ON work_claim(project, scope_key, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_work_claim_agent_status ON work_claim(agent_name, status, claimed_at DESC);
`);
}

function audit(db, input = {}) {
  ensureResourceAccessSchema(db);
  try {
    db.prepare("INSERT INTO resource_audit_log (scope, project, event_kind, actor_agent, resource_kind, resource_key, permission, claim_id, approval_id, tool_name, reason, result, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(cleanScope(input.scope), input.project || null, input.event_kind || "event", normalizeAgentName(input.actor_agent), input.resource_kind || null, input.resource_key || null, input.permission || null, input.claim_id || null, input.approval_id || null, input.tool_name || null, input.reason || null, input.result || null, JSON.stringify(input.payload || {}));
  } catch {}
}

function rowToResource(row) {
  return row ? Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }) : null;
}

function rowToAcl(row) {
  return row ? Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }) : null;
}

function rowToApproval(row) {
  return row ? Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }) : null;
}

function resourceUpsert(db, input = {}) {
  ensureResourceAccessSchema(db);
  const scope = cleanScope(input.scope);
  const kind = normalizeResourceKind(input.resource_kind);
  const key = normalizeResourceKey(kind, input.resource_key || input.file_path || input.route || input.domain || input.system_name);
  if (!key) return { error: "resource_kind + resource_key required" };
  const owner = normalizeAgentName(input.owner_agent);
  db.prepare(
    "INSERT INTO org_resource (scope, project, resource_kind, resource_key, label, owner_agent, owning_department, risk_class, status, notes, meta_json) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(scope, resource_kind, resource_key) DO UPDATE SET project=excluded.project, label=excluded.label, owner_agent=excluded.owner_agent, owning_department=excluded.owning_department, risk_class=excluded.risk_class, status=excluded.status, notes=excluded.notes, meta_json=excluded.meta_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
  ).run(scope, input.project || null, kind, key, input.label || key, owner || null, input.owning_department || null, input.risk_class || "normal", input.status || "active", input.notes || null, JSON.stringify(input.meta || {}));
  audit(db, { scope, project: input.project, event_kind: "resource_upsert", actor_agent: input.updated_by || owner, resource_kind: kind, resource_key: key, result: "ok", payload: input });
  return { ok: true, scope, resource_kind: kind, resource_key: key, owner_agent: owner || null };
}

function resourceList(db, input = {}) {
  ensureResourceAccessSchema(db);
  const where = ["scope=?"];
  const params = [cleanScope(input.scope)];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.resource_kind) { where.push("resource_kind=?"); params.push(normalizeResourceKind(input.resource_kind)); }
  if (input.owner_agent) { where.push("owner_agent=?"); params.push(normalizeAgentName(input.owner_agent)); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  else where.push("status!='deleted'");
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM org_resource WHERE " + where.join(" AND ") + " ORDER BY updated_at DESC LIMIT ?").all(...params).map(rowToResource);
  return { ok: true, count: rows.length, resources: rows };
}

function getResource(db, scope, kind, key, project) {
  ensureResourceAccessSchema(db);
  return rowToResource(db.prepare(
    "SELECT * FROM org_resource WHERE scope=? AND resource_kind=? AND resource_key=? AND status='active' AND (project IS NULL OR project=? OR ? IS NULL) ORDER BY project DESC, id DESC LIMIT 1"
  ).get(cleanScope(scope), normalizeResourceKind(kind), normalizeResourceKey(kind, key), project || null, project || null));
}

function executiveAgents() {
  return new Set(String(process.env.MNEMO_EXECUTIVE_AGENTS || "")
    .split(",")
    .map(normalizeAgentName)
    .filter(Boolean));
}

function canGrantResource(resource, grantedBy) {
  const grantor = normalizeAgentName(grantedBy);
  if (!resource || !resource.owner_agent) return !!grantor;
  if (normalizeAgentName(resource.owner_agent) === grantor) return true;
  return process.env.MNEMO_ALLOW_EXECUTIVE_RESOURCE_OVERRIDE === "1" && executiveAgents().has(grantor);
}

function aclGrant(db, input = {}) {
  ensureResourceAccessSchema(db);
  const scope = cleanScope(input.scope);
  const kind = normalizeResourceKind(input.resource_kind);
  const key = normalizeResourceKey(kind, input.resource_key || input.file_path || input.route || input.domain || input.system_name);
  const agent = normalizeAgentName(input.agent_name);
  const permission = String(input.permission || "write").toLowerCase();
  if (!key || (!agent && !input.department_name)) return { error: "resource + agent_name/department_name required" };
  if (input.claim_id) {
    const claim = claimRow(db, input.claim_id);
    if (!claim) return { error: "claim_not_found", claim_id: input.claim_id };
    const claimOwner = normalizeAgentName(claim.agent_name);
    const grantor = normalizeAgentName(input.granted_by);
    if (claimOwner !== grantor) {
      return { error: "claim_owner_required", required_granted_by: claimOwner, provided_granted_by: grantor || null };
    }
  }
  const resource = getResource(db, scope, kind, key, input.project);
  if (resource && !canGrantResource(resource, input.granted_by)) {
    return {
      error: "resource_owner_approval_required",
      required_granted_by: resource.owner_agent,
      provided_granted_by: normalizeAgentName(input.granted_by) || null,
      resource
    };
  }
  db.prepare(
    "INSERT INTO resource_acl (scope, project, resource_kind, resource_key, agent_name, department_name, permission, status, granted_by, reason, claim_id, approval_id, expires_at, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(scope, input.project || null, kind, key, agent || null, input.department_name || null, permission, input.status || "active", normalizeAgentName(input.granted_by) || null, input.reason || null, input.claim_id || null, input.approval_id || null, input.expires_at || null, JSON.stringify(input.meta || {}));
  audit(db, { scope, project: input.project, event_kind: "acl_grant", actor_agent: input.granted_by, resource_kind: kind, resource_key: key, permission, claim_id: input.claim_id || null, approval_id: input.approval_id || null, reason: input.reason || null, result: "ok", payload: input });
  return { ok: true, scope, resource_kind: kind, resource_key: key, agent_name: agent || null, permission };
}

function aclList(db, input = {}) {
  ensureResourceAccessSchema(db);
  const where = ["scope=?"];
  const params = [cleanScope(input.scope)];
  if (input.project) { where.push("(project=? OR project IS NULL)"); params.push(input.project); }
  if (input.resource_kind) { where.push("resource_kind=?"); params.push(normalizeResourceKind(input.resource_kind)); }
  if (input.resource_key) { where.push("resource_key=?"); params.push(normalizeResourceKey(input.resource_kind, input.resource_key)); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  else where.push("status='active'");
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM resource_acl WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT ?").all(...params).map(rowToAcl);
  return { ok: true, count: rows.length, acl: rows };
}

function activeAclRows(db, input = {}) {
  ensureResourceAccessSchema(db);
  const scope = cleanScope(input.scope);
  const agent = normalizeAgentName(input.agent_name);
  const kind = normalizeResourceKind(input.resource_kind);
  const key = normalizeResourceKey(kind, input.resource_key);
  const permissionNeeded = input.permission || "read";
  if (!agent || !key) return [];
  return db.prepare(
    "SELECT * FROM resource_acl WHERE scope=? AND resource_kind=? AND resource_key=? AND agent_name=? AND status='active' " +
    "AND (project IS NULL OR project=? OR ? IS NULL) " +
    "AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ORDER BY created_at DESC"
  ).all(scope, kind, key, agent, input.project || null, input.project || null)
    .filter((row) => permissionRank(row.permission) >= permissionRank(permissionNeeded))
    .map(rowToAcl);
}

function activeApprovalRows(db, input = {}) {
  ensureResourceAccessSchema(db);
  const scope = cleanScope(input.scope);
  const agent = normalizeAgentName(input.agent_name);
  const kind = normalizeResourceKind(input.resource_kind);
  const key = normalizeResourceKey(kind, input.resource_key);
  const permissionNeeded = input.permission || "read";
  if (!agent || !key) return [];
  return db.prepare(
    "SELECT * FROM approval_request WHERE scope=? AND resource_kind=? AND resource_key=? AND requester_agent=? AND status='approved' " +
    "AND (project IS NULL OR project=? OR ? IS NULL) " +
    "AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "ORDER BY decided_at DESC"
  ).all(scope, kind, key, agent, input.project || null, input.project || null)
    .filter((row) => permissionRank(row.permission) >= permissionRank(permissionNeeded))
    .map(rowToApproval);
}

function resourcesFromInput(input = {}) {
  const out = [];
  for (const file of Array.isArray(input.files) ? input.files : []) {
    const key = normalizeResourceKey("file", file);
    if (key) out.push({ resource_kind: "file", resource_key: key, label: file });
  }
  for (const route of Array.isArray(input.routes) ? input.routes : []) {
    const key = normalizeResourceKey("route", route);
    if (key) out.push({ resource_kind: "route", resource_key: key, label: route });
  }
  for (const domain of Array.isArray(input.domains) ? input.domains : []) {
    const key = normalizeResourceKey("domain", domain);
    if (key) out.push({ resource_kind: "domain", resource_key: key, label: domain });
  }
  for (const system of Array.isArray(input.system_names) ? input.system_names : []) {
    const key = normalizeResourceKey("system", system);
    if (key) out.push({ resource_kind: "system", resource_key: key, label: system });
  }
  for (const res of Array.isArray(input.resources) ? input.resources : []) {
    const kind = normalizeResourceKind(res && res.resource_kind);
    const key = normalizeResourceKey(kind, res && res.resource_key);
    if (key) out.push({ resource_kind: kind, resource_key: key, label: res.label || key });
  }
  const seen = new Set();
  return out.filter((resource) => {
    const k = resource.resource_kind + ":" + resource.resource_key;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function workClaimScopeKey(kind, key) {
  if (kind === "file") return "file:" + normalizeResourceKey("file", key);
  return kind + ":" + normalizeResourceKey(kind, key).replace(/[^a-z0-9]+/g, " ").trim();
}

function activeWorkClaimForResource(db, input = {}) {
  ensureWorkClaimSchemaForLookup(db);
  const key = workClaimScopeKey(normalizeResourceKind(input.resource_kind), input.resource_key);
  return db.prepare(
    "SELECT * FROM work_claim WHERE scope_key=? AND status='active' AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
    "AND (project=? OR project='unknown' OR project='*' OR ? IS NULL) ORDER BY expires_at DESC LIMIT 1"
  ).get(key, input.project || "unknown", input.project || null) || null;
}

function resourceAccessCheck(db, input = {}) {
  ensureResourceAccessSchema(db);
  const scope = cleanScope(input.scope);
  const agent = normalizeAgentName(input.agent_name);
  const project = input.project || null;
  const permission = input.permission || requiredPermission(input);
  const writeLike = isWriteLike(Object.assign({}, input, { permission }));
  const blockers = [];
  const warnings = [];
  const checks = [];
  const resources = resourcesFromInput(input);

  for (const resourceRef of resources) {
    const resource = getResource(db, scope, resourceRef.resource_kind, resourceRef.resource_key, project);
    const activeClaim = activeWorkClaimForResource(db, Object.assign({}, resourceRef, { project }));
    const claimOwner = activeClaim ? normalizeAgentName(activeClaim.agent_name) : null;
    const acl = activeAclRows(db, Object.assign({}, resourceRef, { scope, project, agent_name: agent, permission }));
    const approvals = activeApprovalRows(db, Object.assign({}, resourceRef, { scope, project, agent_name: agent, permission }));
    const owner = normalizeAgentName(resource && resource.owner_agent);
    const ownerOk = owner && owner === agent;
    const claimOk = !activeClaim || claimOwner === agent || acl.some((row) => Number(row.claim_id || 0) === Number(activeClaim.id || 0)) || approvals.some((row) => Number(row.claim_id || 0) === Number(activeClaim.id || 0));
    const resourceManaged = !!resource || !!activeClaim || acl.length > 0;
    const ok = !resourceManaged || ownerOk || acl.length > 0 || approvals.length > 0;
    checks.push({
      resource: resourceRef,
      managed: resourceManaged,
      owner_agent: owner || null,
      active_claim: activeClaim ? { id: activeClaim.id, agent_name: activeClaim.agent_name, expires_at: activeClaim.expires_at } : null,
      acl_count: acl.length,
      approval_count: approvals.length,
      owner_ok: !!ownerOk,
      access_ok: !!ok,
      claim_ok: !!claimOk
    });
    if (!writeLike) {
      if (resourceManaged && !ok) warnings.push("resource managed by " + (owner || claimOwner || "another agent") + ": " + resourceRef.resource_kind + ":" + resourceRef.resource_key);
      continue;
    }
    if (activeClaim && claimOwner !== agent && !claimOk) {
      blockers.push("resource is actively claimed by " + claimOwner + ": " + resourceRef.resource_kind + ":" + resourceRef.resource_key + "; request claim access or transfer before writing.");
      continue;
    }
    if (resourceManaged && !ok) {
      blockers.push("resource access denied for " + agent + ": " + resourceRef.resource_kind + ":" + resourceRef.resource_key + " requires owner/ACL/approval from " + (owner || claimOwner || "resource owner") + ".");
    }
  }

  const status = blockers.length ? "block" : (warnings.length ? "warn" : "ok");
  return {
    ok: !blockers.length,
    status,
    scope,
    project,
    agent_name: agent,
    permission,
    write_like: writeLike,
    resources_checked: resources.length,
    blockers,
    warnings,
    checks,
    hint: blockers.length ? "Request access, get owner approval, or transfer the claim before editing." : "Resource access gate passed."
  };
}

function approvalRequest(db, input = {}) {
  ensureResourceAccessSchema(db);
  const scope = cleanScope(input.scope);
  const kind = normalizeResourceKind(input.resource_kind);
  const key = normalizeResourceKey(kind, input.resource_key || input.file_path || input.route || input.domain || input.system_name);
  const requester = normalizeAgentName(input.requester_agent || input.agent_name);
  if (!key || !requester || !input.reason) return { error: "resource + requester_agent + reason required" };
  const resource = getResource(db, scope, kind, key, input.project);
  const owner = normalizeAgentName(input.owner_agent || (resource && resource.owner_agent));
  const info = db.prepare(
    "INSERT INTO approval_request (scope, project, request_kind, resource_kind, resource_key, permission, requester_agent, owner_agent, approver_agent, status, reason, expires_at, claim_id, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(scope, input.project || null, input.request_kind || "resource_access", kind, key, input.permission || "write", requester, owner || null, owner || null, "pending", input.reason, input.expires_at || null, input.claim_id || null, JSON.stringify(input.meta || {}));
  audit(db, { scope, project: input.project, event_kind: "approval_request", actor_agent: requester, resource_kind: kind, resource_key: key, permission: input.permission || "write", claim_id: input.claim_id || null, approval_id: info.lastInsertRowid, reason: input.reason, result: "pending", payload: input });
  return { ok: true, id: info.lastInsertRowid, status: "pending", owner_agent: owner || null };
}

function approvalDecide(db, input = {}) {
  ensureResourceAccessSchema(db);
  const id = parseInt(input.id, 10);
  const decidedBy = normalizeAgentName(input.decided_by || input.approved_by);
  const status = String(input.status || input.decision || "").toLowerCase();
  if (!id || !decidedBy || !["approved", "denied", "cancelled"].includes(status)) return { error: "id + decided_by + status(approved|denied|cancelled) required" };
  const row = db.prepare("SELECT * FROM approval_request WHERE id=?").get(id);
  if (!row) return { error: "approval_not_found", id };
  const owner = normalizeAgentName(row.owner_agent);
  if (owner && owner !== decidedBy) {
    return { error: "approval_owner_required", required_decided_by: owner, provided_decided_by: decidedBy, approval: rowToApproval(row) };
  }
  db.prepare("UPDATE approval_request SET status=?, decision=?, decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at=COALESCE(?, expires_at), meta_json=COALESCE(?, meta_json) WHERE id=?")
    .run(status, input.decision || status, decidedBy, input.expires_at || null, input.meta ? JSON.stringify(input.meta) : null, id);
  if (status === "approved" && input.grant_acl !== false) {
    aclGrant(db, {
      scope: row.scope,
      project: row.project,
      resource_kind: row.resource_kind,
      resource_key: row.resource_key,
      agent_name: row.requester_agent,
      permission: row.permission,
      granted_by: decidedBy,
      reason: "approval_request #" + id,
      claim_id: row.claim_id || null,
      approval_id: id,
      expires_at: input.expires_at || row.expires_at || null,
      meta: { approval_id: id }
    });
  }
  audit(db, { scope: row.scope, project: row.project, event_kind: "approval_" + status, actor_agent: decidedBy, resource_kind: row.resource_kind, resource_key: row.resource_key, permission: row.permission, claim_id: row.claim_id || null, approval_id: id, reason: input.reason || null, result: status, payload: input });
  return { ok: true, id, status };
}

function approvalList(db, input = {}) {
  ensureResourceAccessSchema(db);
  const where = ["scope=?"];
  const params = [cleanScope(input.scope)];
  if (input.project) { where.push("(project=? OR project IS NULL)"); params.push(input.project); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  if (input.owner_agent) { where.push("owner_agent=?"); params.push(normalizeAgentName(input.owner_agent)); }
  if (input.requester_agent) { where.push("requester_agent=?"); params.push(normalizeAgentName(input.requester_agent)); }
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM approval_request WHERE " + where.join(" AND ") + " ORDER BY requested_at DESC LIMIT ?").all(...params).map(rowToApproval);
  return { ok: true, count: rows.length, approvals: rows };
}

function claimRow(db, id) {
  ensureWorkClaimSchemaForLookup(db);
  return db.prepare("SELECT * FROM work_claim WHERE id=?").get(id) || null;
}

function claimResourceFromRow(row) {
  if (!row) return null;
  const kind = normalizeResourceKind(row.claim_kind || "file");
  const key = kind === "file" ? normalizeResourceKey("file", row.file_path || row.scope_value) : normalizeResourceKey(kind, row.scope_value || row.file_path);
  return { resource_kind: kind, resource_key: key };
}

function claimRequestAccess(db, input = {}) {
  const id = parseInt(input.claim_id || input.id, 10);
  const row = claimRow(db, id);
  if (!row) return { error: "claim_not_found", claim_id: id || null };
  const res = claimResourceFromRow(row);
  return approvalRequest(db, {
    scope: input.scope,
    project: input.project || row.project,
    request_kind: "claim_access",
    resource_kind: res.resource_kind,
    resource_key: res.resource_key,
    requester_agent: input.requester_agent || input.agent_name,
    owner_agent: row.agent_name,
    permission: input.permission || "write",
    reason: input.reason || "request access to active claim #" + row.id,
    expires_at: input.expires_at || row.expires_at || null,
    claim_id: row.id,
    meta: Object.assign({}, input.meta || {}, { claim_owner: row.agent_name })
  });
}

function claimGrantAccess(db, input = {}) {
  const id = parseInt(input.claim_id || input.id, 10);
  const row = claimRow(db, id);
  if (!row) return { error: "claim_not_found", claim_id: id || null };
  const decidedBy = normalizeAgentName(input.decided_by || input.granted_by || input.approved_by);
  const owner = normalizeAgentName(row.agent_name);
  if (decidedBy !== owner) {
    return { error: "claim_owner_required", required_decided_by: owner, provided_decided_by: decidedBy || null };
  }
  let approvalId = input.approval_id || null;
  if (approvalId) {
    const decision = approvalDecide(db, { id: approvalId, status: "approved", decided_by: decidedBy, expires_at: input.expires_at || row.expires_at || null });
    if (decision.error) return decision;
  }
  const res = claimResourceFromRow(row);
  const grant = aclGrant(db, {
    scope: input.scope,
    project: input.project || row.project,
    resource_kind: res.resource_kind,
    resource_key: res.resource_key,
    agent_name: input.requester_agent || input.agent_name,
    permission: input.permission || "write",
    granted_by: decidedBy,
    reason: input.reason || "claim access granted for claim #" + row.id,
    claim_id: row.id,
    approval_id: approvalId,
    expires_at: input.expires_at || row.expires_at || null,
    meta: input.meta || {}
  });
  return Object.assign({ claim_id: row.id }, grant);
}

function claimDenyAccess(db, input = {}) {
  const id = parseInt(input.approval_id || input.id, 10);
  if (!id) return { error: "approval_id required" };
  return approvalDecide(db, { id, status: "denied", decided_by: input.decided_by || input.denied_by, reason: input.reason || "claim access denied" });
}

function claimTransfer(db, input = {}) {
  ensureWorkClaimSchemaForLookup(db);
  const id = parseInt(input.claim_id || input.id, 10);
  const row = claimRow(db, id);
  const toAgent = normalizeAgentName(input.to_agent || input.agent_name);
  const byAgent = normalizeAgentName(input.by_agent || input.transferred_by);
  if (!row || !toAgent || !byAgent) return { error: "claim_id + to_agent + by_agent required" };
  const owner = normalizeAgentName(row.agent_name);
  if (owner !== byAgent) return { error: "claim_owner_required", required_by_agent: owner, provided_by_agent: byAgent };
  db.prepare("UPDATE work_claim SET agent_name=?, summary=COALESCE(?, summary), heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=COALESCE(?, meta_json) WHERE id=?")
    .run(toAgent, input.summary || null, input.meta ? JSON.stringify(input.meta) : null, id);
  const res = claimResourceFromRow(row);
  audit(db, { scope: input.scope, project: row.project, event_kind: "claim_transfer", actor_agent: byAgent, resource_kind: res.resource_kind, resource_key: res.resource_key, permission: "write", claim_id: id, reason: input.reason || null, result: "ok", payload: input });
  return { ok: true, claim_id: id, from_agent: owner, to_agent: toAgent };
}

function auditList(db, input = {}) {
  ensureResourceAccessSchema(db);
  const where = ["scope=?"];
  const params = [cleanScope(input.scope)];
  if (input.project) { where.push("(project=? OR project IS NULL)"); params.push(input.project); }
  if (input.actor_agent) { where.push("actor_agent=?"); params.push(normalizeAgentName(input.actor_agent)); }
  if (input.resource_kind) { where.push("resource_kind=?"); params.push(normalizeResourceKind(input.resource_kind)); }
  if (input.resource_key) { where.push("resource_key=?"); params.push(normalizeResourceKey(input.resource_kind, input.resource_key)); }
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM resource_audit_log WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT ?").all(...params)
    .map((row) => Object.assign({}, row, { payload: parseJson(row.payload_json, {}) }));
  return { ok: true, count: rows.length, events: rows };
}

const RESOURCE_ACCESS_TOOL_DEFS = {
  mem_resource_upsert: {
    description: "Create/update a canonical company resource with owner, department, risk class, and status.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, resource_kind: { type: "string" }, resource_key: { type: "string" }, label: { type: "string" }, owner_agent: { type: "string" }, owning_department: { type: "string" }, risk_class: { type: "string" }, status: { type: "string" }, notes: { type: "string" }, meta: { type: "object" }, updated_by: { type: "string" } }, required: ["resource_kind", "resource_key"] }
  },
  mem_resource_list: {
    description: "List canonical resources and owners.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, resource_kind: { type: "string" }, owner_agent: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_resource_acl_grant: {
    description: "Grant an agent or department permission on a resource. If the resource has an owner, only that owner may grant unless executive override is explicitly enabled.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, resource_kind: { type: "string" }, resource_key: { type: "string" }, agent_name: { type: "string" }, department_name: { type: "string" }, permission: { type: "string" }, granted_by: { type: "string" }, reason: { type: "string" }, claim_id: { type: "integer" }, approval_id: { type: "integer" }, expires_at: { type: "string" }, meta: { type: "object" } }, required: ["resource_kind", "resource_key", "permission", "granted_by"] }
  },
  mem_resource_acl_list: {
    description: "List active ACL entries.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, resource_kind: { type: "string" }, resource_key: { type: "string" }, agent_name: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_resource_access_check: {
    description: "Check agent access for resources derived from files/routes/domains/systems before a write/deploy action.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, agent_name: { type: "string" }, action_type: { type: "string" }, permission: { type: "string" }, files: { type: "array", items: { type: "string" } }, routes: { type: "array", items: { type: "string" } }, domains: { type: "array", items: { type: "string" } }, system_names: { type: "array", items: { type: "string" } }, resources: { type: "array", items: { type: "object" } } }, required: ["agent_name"] }
  },
  mem_approval_request: {
    description: "Request owner approval for resource access.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, request_kind: { type: "string" }, resource_kind: { type: "string" }, resource_key: { type: "string" }, requester_agent: { type: "string" }, owner_agent: { type: "string" }, permission: { type: "string" }, reason: { type: "string" }, expires_at: { type: "string" }, claim_id: { type: "integer" }, meta: { type: "object" } }, required: ["resource_kind", "resource_key", "requester_agent", "reason"] }
  },
  mem_approval_decide: {
    description: "Approve/deny/cancel an approval request. Owner approval is enforced.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, status: { type: "string" }, decided_by: { type: "string" }, reason: { type: "string" }, expires_at: { type: "string" }, grant_acl: { type: "boolean" }, meta: { type: "object" } }, required: ["id", "status", "decided_by"] }
  },
  mem_approval_list: {
    description: "List approval requests.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, status: { type: "string" }, owner_agent: { type: "string" }, requester_agent: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_claim_request_access: {
    description: "Request access to another agent's active work claim.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, claim_id: { type: "integer" }, requester_agent: { type: "string" }, permission: { type: "string" }, reason: { type: "string" }, expires_at: { type: "string" }, meta: { type: "object" } }, required: ["claim_id", "requester_agent"] }
  },
  mem_claim_grant_access: {
    description: "Grant access to an active claim. Only the claim owner may grant.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, claim_id: { type: "integer" }, requester_agent: { type: "string" }, permission: { type: "string" }, granted_by: { type: "string" }, approval_id: { type: "integer" }, expires_at: { type: "string" }, reason: { type: "string" }, meta: { type: "object" } }, required: ["claim_id", "requester_agent", "granted_by"] }
  },
  mem_claim_deny_access: {
    description: "Deny a pending claim-access approval request.",
    inputSchema: { type: "object", properties: { approval_id: { type: "integer" }, denied_by: { type: "string" }, reason: { type: "string" } }, required: ["approval_id", "denied_by"] }
  },
  mem_claim_transfer: {
    description: "Transfer an active claim to another agent. Only the current claim owner may transfer.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, claim_id: { type: "integer" }, to_agent: { type: "string" }, by_agent: { type: "string" }, reason: { type: "string" }, summary: { type: "string" }, meta: { type: "object" } }, required: ["claim_id", "to_agent", "by_agent"] }
  },
  mem_resource_audit_list: {
    description: "List resource permission, approval, and claim-access audit events.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, actor_agent: { type: "string" }, resource_kind: { type: "string" }, resource_key: { type: "string" }, limit: { type: "integer" } } }
  }
};

function handleResourceAccessTool(db, name, input = {}) {
  if (name === "mem_resource_upsert") return { handled: true, result: resourceUpsert(db, input || {}) };
  if (name === "mem_resource_list") return { handled: true, result: resourceList(db, input || {}) };
  if (name === "mem_resource_acl_grant") return { handled: true, result: aclGrant(db, input || {}) };
  if (name === "mem_resource_acl_list") return { handled: true, result: aclList(db, input || {}) };
  if (name === "mem_resource_access_check") return { handled: true, result: resourceAccessCheck(db, input || {}) };
  if (name === "mem_approval_request") return { handled: true, result: approvalRequest(db, input || {}) };
  if (name === "mem_approval_decide") return { handled: true, result: approvalDecide(db, input || {}) };
  if (name === "mem_approval_list") return { handled: true, result: approvalList(db, input || {}) };
  if (name === "mem_claim_request_access") return { handled: true, result: claimRequestAccess(db, input || {}) };
  if (name === "mem_claim_grant_access") return { handled: true, result: claimGrantAccess(db, input || {}) };
  if (name === "mem_claim_deny_access") return { handled: true, result: claimDenyAccess(db, input || {}) };
  if (name === "mem_claim_transfer") return { handled: true, result: claimTransfer(db, input || {}) };
  if (name === "mem_resource_audit_list") return { handled: true, result: auditList(db, input || {}) };
  return { handled: false };
}

module.exports = {
  RESOURCE_ACCESS_TOOL_DEFS,
  ensureResourceAccessSchema,
  resourceAccessCheck,
  handleResourceAccessTool,
  normalizeResourceKind,
  normalizeResourceKey
};
