"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureRuntimeGovernanceSchema,
  handleRuntimeGovernanceTool,
  runtimeToolReceiptStart,
  runtimeToolReceiptFinish,
} = require("./runtime_governance");

const db = new Database(":memory:");
db.exec(`
CREATE TABLE IF NOT EXISTS mnemo_event_journal (
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
ensureRuntimeGovernanceSchema(db);

function tool(name, args) {
  const result = handleRuntimeGovernanceTool(db, name, args || {});
  assert(result.handled, "tool not handled: " + name);
  return result.result;
}

{
  const upsert = tool("mem_runtime_binding_upsert", {
    runtime_name: "openclaw",
    agent_name: "alfred",
    project: "mnemo",
    session_key: "openclaw:session:1",
    channel: "telegram",
    peer_kind: "group",
    peer_id: "-1001",
    capabilities: ["browser", "toolrun"],
    updated_by: "alfred",
  });
  assert.strictEqual(upsert.ok, true);
  assert.strictEqual(upsert.binding.runtime_name, "openclaw");

  const list = tool("mem_runtime_binding_list", { runtime_name: "openclaw", agent_name: "alfred" });
  assert.strictEqual(list.count, 1);
  assert.deepStrictEqual(list.bindings[0].capabilities, ["browser", "toolrun"]);
}

{
  const cap = tool("mem_runtime_capability_upsert", {
    runtime_name: "openclaw",
    capability_kind: "tool",
    capability_key: "browser.click",
    allowed_agents: ["alfred"],
    requires_preflight: true,
    requires_receipt: true,
    updated_by: "alfred",
  });
  assert.strictEqual(cap.ok, true);

  const check = tool("mem_runtime_capability_check", {
    runtime_name: "openclaw",
    agent_name: "alfred",
    tool_name: "browser.click",
  });
  assert.strictEqual(check.status, "ok");
  assert.strictEqual(check.requires_preflight, true);
}

{
  const receipt = runtimeToolReceiptStart(db, {
    runtime_name: "openclaw",
    agent_name: "alfred",
    project: "mnemo",
    task: "click through preview",
    action_type: "code_edit",
    tool_name: "browser.click",
    files: ["packages/core/mcp.js"],
  }, {
    preflight: { status: "ok", preflight_action_id: 123, blockers: [], claims: [{ id: 77 }] },
  });
  assert.strictEqual(receipt.allowed, true);
  assert.strictEqual(receipt.preflight_action_id, 123);
  assert.strictEqual(receipt.evidence_required, true);

  const noEvidence = runtimeToolReceiptFinish(db, {
    receipt_id: receipt.receipt_id,
    status: "done",
    result_summary: "patched",
  });
  assert.strictEqual(noEvidence.error, "evidence_required");

  const done = runtimeToolReceiptFinish(db, {
    receipt_id: receipt.receipt_id,
    status: "done",
    result_summary: "patched",
    evidence: [{ file_path: "packages/core/mcp.js", test_step: "unit test", result: "pass" }],
  });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.evidence_count, 1);
}

{
  tool("mem_runtime_capability_upsert", {
    runtime_name: "openclaw",
    capability_kind: "tool",
    capability_key: "shell.rm",
    permission: "deny",
    updated_by: "alfred",
  });
  const blocked = runtimeToolReceiptStart(db, {
    runtime_name: "openclaw",
    agent_name: "otto",
    task: "delete files",
    tool_name: "shell.rm",
  }, {
    preflight: { status: "ok", blockers: [] },
  });
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.status, "blocked");
  assert(blocked.blockers.some((entry) => entry.includes("denied")));
  const blockedDone = runtimeToolReceiptFinish(db, {
    receipt_id: blocked.receipt_id,
    status: "done",
    evidence: [{ test_step: "should not run", result: "blocked" }],
  });
  assert.strictEqual(blockedDone.error, "receipt_not_allowed");
}

{
  const rows = tool("mem_runtime_tool_receipt_list", { runtime_name: "openclaw", limit: 10 });
  assert(rows.count >= 2, "receipt ledger should include started and blocked receipts");
  const events = db.prepare("SELECT COUNT(*) c FROM mnemo_event_journal WHERE source='runtime_tool_receipt'").get();
  assert(events.c >= 2, "runtime receipts should journal audit events");
}

console.log("test_runtime_governance ok");
