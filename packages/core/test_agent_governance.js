"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureAgentGovernanceSchema,
  handleAgentGovernanceTool,
  capabilityTokenCheck,
  requiresCapabilityToken,
} = require("./agent_governance");

const db = new Database(":memory:");
db.exec(`
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
CREATE TABLE org_resource (
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
CREATE TABLE agent_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  action_kind TEXT,
  target TEXT,
  status TEXT,
  payload_json TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE quality_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
ensureAgentGovernanceSchema(db);

function tool(name, args) {
  const handled = handleAgentGovernanceTool(db, name, args || {});
  assert(handled.handled, "tool not handled: " + name);
  return handled.result;
}

{
  const charter = tool("mem_department_charter_set", {
    department_name: "frontend",
    mission: "Own UI surfaces",
    responsibilities: ["dashboard shell", "shared popup"],
    boundaries: ["do not touch auth backend"],
    files: ["apps/frontend/*"],
    lead_agent: "angel",
    updated_by: "alfred",
  });
  assert.strictEqual(charter.ok, true);
  assert.strictEqual(charter.charter.department_name, "frontend");
  assert.strictEqual(tool("mem_department_charter_list", {}).count, 1);
}

{
  const readCheck = capabilityTokenCheck(db, {
    agent_name: "alfred",
    action_type: "read",
    task: "inspect docs",
  });
  assert.strictEqual(readCheck.granted, true);
  assert.strictEqual(readCheck.required, false);

  const blocked = capabilityTokenCheck(db, {
    agent_name: "alfred",
    action_type: "code_edit",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(blocked.granted, false);
  assert.strictEqual(blocked.reason, "capability_token_required");
  assert.strictEqual(requiresCapabilityToken({ action_type: "code_edit" }), true);
}

let tokenId;
let workOrderId;
{
  const wo = tool("mem_work_order_create", {
    project: "mnemo",
    title: "Add token gate",
    objective: "Add capability token gate to preflight.",
    department_name: "backend",
    assigned_agent: "alfred",
    owner_agent: "alfred",
    risk_class: "normal",
    action_type: "code_edit",
    files: ["packages/core/*"],
    allowed_tools: ["apply_patch", "npm test"],
    required_evidence: ["unit tests"],
    done_criteria: ["tests pass"],
    ttl_minutes: 60,
    created_by: "alfred",
  });
  assert.strictEqual(wo.ok, true);
  assert(wo.token.token_id);
  tokenId = wo.token.token_id;
  workOrderId = wo.work_order.id;

  const allowed = tool("mem_capability_token_check", {
    token_id: tokenId,
    work_order_id: workOrderId,
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    tool_name: "apply_patch",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(allowed.granted, true);
  assert.strictEqual(allowed.required_evidence[0], "unit tests");
  assert(allowed.audit_id);

  const outside = tool("mem_capability_token_check", {
    token_id: tokenId,
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    tool_name: "apply_patch",
    files: ["README.md"],
  });
  assert.strictEqual(outside.granted, false);
  assert(outside.reason.includes("requested resources"));
}

{
  const incomplete = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    completion_summary: "done",
  });
  assert.strictEqual(incomplete.error, "evidence_required");

  const weakEvidence = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    completion_summary: "done",
    evidence: [{ test_step: "node test_agent_governance.js" }],
  });
  assert.strictEqual(weakEvidence.error, "evidence_invalid");

  const missingRequired = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    completion_summary: "done",
    evidence: [{ check: "lint", command: "node -c agent_governance.js", exit_code: 0, result: "pass" }],
  });
  assert.strictEqual(missingRequired.error, "evidence_missing_required");
  assert.deepStrictEqual(missingRequired.missing_required, ["unit tests"]);

  const needsReview = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    status: "needs_review",
    completion_summary: "patched but not verified",
  });
  assert.strictEqual(needsReview.ok, true);
  assert.strictEqual(needsReview.work_order.status, "needs_review");

  const complete = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    completion_summary: "token gate implemented",
    evidence: [{ check: "unit tests", command: "node test_agent_governance.js", exit_code: 0, result: "pass", files: ["packages/core/test_agent_governance.js"] }],
  });
  assert.strictEqual(complete.ok, true);
  assert.strictEqual(complete.work_order.status, "done");
  assert.strictEqual(complete.evidence_check.ok, true);
}

{
  const noRequired = tool("mem_work_order_create", {
    project: "mnemo",
    title: "Docs note",
    objective: "Write a small documentation note.",
    department_name: "backend",
    assigned_agent: "alfred",
    owner_agent: "alfred",
    risk_class: "low",
    action_type: "write",
    files: ["docs/*"],
    ttl_minutes: 60,
    created_by: "alfred",
  });
  const noEvidenceDone = tool("mem_work_order_complete", {
    work_order_id: noRequired.work_order.id,
    completion_summary: "done",
  });
  assert.strictEqual(noEvidenceDone.error, "evidence_required");
  const okDone = tool("mem_work_order_complete", {
    work_order_id: noRequired.work_order.id,
    completion_summary: "docs note written",
    evidence: [{ check: "diff reviewed", file_path: "docs/work-orders-capability-tokens.md", result: "pass" }],
  });
  assert.strictEqual(okDone.ok, true);
}

{
  db.prepare("INSERT INTO org_resource (scope, project, resource_kind, resource_key, owner_agent, owning_department, status) VALUES ('default','chat','file','src/chat/login.js','otto','backend','active')").run();
  const route = tool("mem_intent_route", {
    intent_kind: "access_request",
    agent_name: "alfred",
    project: "chat",
    resource_kind: "file",
    resource_key: "src/chat/login.js",
    summary: "Need temporary access",
    write_brief: true,
  });
  assert.strictEqual(route.ok, true);
  assert.strictEqual(route.route_to_agent, "otto");
  assert(route.brief_id);
}

{
  db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status) VALUES ('alfred','test','x','done')").run();
  db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status) VALUES ('alfred','preflight','x','blocked')").run();
  db.prepare("INSERT INTO quality_finding (project, category, severity, title, source_agent) VALUES ('mnemo','test','M','missing test','alfred')").run();
  const score = tool("mem_autonomy_score_report", { agent_name: "alfred", window_days: 7 });
  assert.strictEqual(score.ok, true);
  assert(score.score <= 100 && score.score >= 0);
  assert(score.autonomy_level.startsWith("L"));
}

{
  const revoked = tool("mem_capability_token_revoke", { token_id: tokenId, revoked_by: "alfred", reason: "done" });
  assert.strictEqual(revoked.ok, true);
  const blocked = tool("mem_capability_token_check", {
    token_id: tokenId,
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(blocked.granted, false);
  assert(blocked.reason.includes("revoked"));
}

console.log("test_agent_governance ok");
