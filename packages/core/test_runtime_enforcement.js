"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureAgentGovernanceSchema,
  workOrderCreate,
  capabilityTokenIssue,
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
`);
ensureAgentGovernanceSchema(db);

function guard(input) {
  const check = capabilityTokenCheck(db, input);
  return {
    allowed: check.granted === true,
    block_reason: check.granted ? null : check.reason,
    check,
  };
}

function auditCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM capability_token_audit").get().c;
}

{
  const readOnly = guard({
    agent_name: "alfred",
    project: "mnemo",
    action_type: "read",
    tool_name: "rg",
    task: "Inspect governance files",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(readOnly.allowed, true);
  assert.strictEqual(readOnly.check.required, false);
  assert(readOnly.check.audit_id, "read-only guard should still audit");
}

{
  const noTokenWrite = guard({
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    tool_name: "apply_patch",
    task: "Patch preflight behavior",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(requiresCapabilityToken({ action_type: "code_edit" }), true);
  assert.strictEqual(noTokenWrite.allowed, false);
  assert.strictEqual(noTokenWrite.block_reason, "capability_token_required");
  assert(noTokenWrite.check.audit_id, "blocked write should audit");
}

{
  const expired = capabilityTokenIssue(db, {
    token_id: "cap-expired-runtime-test",
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    files: ["packages/core/*"],
    allowed_tools: ["apply_patch"],
    expires_at: "2020-01-01T00:00:00.000Z",
    granted_by: "alfred",
  });
  assert.strictEqual(expired.ok, true);
  const expiredCheck = guard({
    token_id: "cap-expired-runtime-test",
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    tool_name: "apply_patch",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(expiredCheck.allowed, false);
  assert(expiredCheck.block_reason.includes("token expired"));
}

let tokenId;
let workOrderId;
{
  const order = workOrderCreate(db, {
    project: "mnemo",
    title: "Runtime guard enforcement smoke",
    objective: "Allow one scoped runtime code edit with evidence.",
    department_name: "engineering",
    assigned_agent: "alfred",
    owner_agent: "alfred",
    risk_class: "normal",
    action_type: "code_edit",
    files: ["packages/core/*"],
    allowed_tools: ["apply_patch"],
    required_evidence: ["runtime guard smoke"],
    ttl_minutes: 30,
    created_by: "alfred",
  });
  assert.strictEqual(order.ok, true);
  tokenId = order.token.token_id;
  workOrderId = order.work_order.id;
}

{
  const wrongScope = guard({
    token_id: tokenId,
    work_order_id: workOrderId,
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    tool_name: "apply_patch",
    files: ["README.md"],
  });
  assert.strictEqual(wrongScope.allowed, false);
  assert(wrongScope.block_reason.includes("requested resources not covered by token"));
}

{
  const allowed = guard({
    token_id: tokenId,
    work_order_id: workOrderId,
    agent_name: "alfred",
    project: "mnemo",
    action_type: "code_edit",
    tool_name: "apply_patch",
    files: ["packages/core/mcp.js"],
  });
  assert.strictEqual(allowed.allowed, true);
  assert.strictEqual(allowed.check.reason, "capability token grants this action");
  assert.strictEqual(allowed.check.required_evidence[0], "runtime guard smoke");
  assert(allowed.check.matched_scope.resources.length >= 1);
  assert(allowed.check.audit_id);
}

{
  const externalSend = guard({
    agent_name: "alfred",
    project: "mnemo",
    action_type: "external_comm",
    tool_name: "telegram.sendMessage",
    task: "Send a team update to Telegram",
    resources: [{ resource_kind: "system", resource_key: "telegram" }],
  });
  assert.strictEqual(externalSend.allowed, false);
  assert.strictEqual(externalSend.block_reason, "capability_token_required");
}

assert(auditCount() >= 6, "every runtime guard path should write an audit row");

console.log("test_runtime_enforcement ok");
