"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureRuntimeGovernanceSchema,
  handleRuntimeGovernanceTool,
  runtimeToolReceiptStart,
  runtimeToolReceiptFinish,
} = require("./runtime_governance");
const { runtimeTurnBegin } = require("./runtime_turn_gate");

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

{
  const angelDefault = tool("mem_runtime_policy_get", {
    runtime_name: "codexlink",
    agent_name: "angel",
    channel: "telegram",
    project: "wizard2",
  });
  assert.strictEqual(angelDefault.ok, true);
  assert.strictEqual(angelDefault.source, "default");
  assert.strictEqual(angelDefault.policy.required_brief_pull, true);
  assert.strictEqual(angelDefault.policy.required_message_capture, true);
  assert.strictEqual(angelDefault.policy.required_board, "wizard2-bridge");
  assert.strictEqual(angelDefault.policy.stale_after_minutes, 15);
  assert.strictEqual(angelDefault.policy.full_sync_every_messages, 10);
  assert.strictEqual(angelDefault.policy.response_allowed_when_context_missing, false);

  const blocked = tool("mem_runtime_policy_check", {
    runtime_name: "codexlink",
    agent_name: "angel",
    channel: "telegram",
    project: "wizard2",
    messages_since_full_sync: 10,
  });
  assert.strictEqual(blocked.status, "block");
  assert.strictEqual(blocked.allowed, false);
  assert(blocked.audit_id, "runtime policy check should persist an audit event");
  assert(blocked.required_actions.includes("mem_brief_pull"));
  assert(blocked.required_actions.includes("mem_project_board"));
  assert(blocked.required_actions.includes("memory_update"));

  const afterLoad = tool("mem_runtime_policy_check", {
    runtime_name: "codexlink",
    agent_name: "angel",
    channel: "telegram",
    project: "wizard2",
    board: "wizard2-bridge",
    has_full_sync: true,
    has_brief_pull: true,
    has_recall: true,
    has_project_board: true,
    has_chat_sync: true,
    has_memory_update: true,
    has_message_capture: true,
  });
  assert.strictEqual(afterLoad.status, "ok");
  assert.strictEqual(afterLoad.allowed, true);
}

{
  const warn = tool("mem_runtime_policy_check", {
    runtime_name: "codexlink",
    agent_name: "dieter",
    channel: "telegram",
    project: "wizard2",
    messages_since_full_sync: 10,
  });
  assert.strictEqual(warn.status, "warn");
  assert.strictEqual(warn.allowed, true);
  assert.strictEqual(warn.warning_token, "MNEMO_CONTEXT_STALE");
}

{
  const set = tool("mem_runtime_policy_set", {
    runtime_name: "codexlink",
    agent_name: "angel",
    channel: "telegram",
    project: "demo",
    required_board: "demo-board",
    stale_after_minutes: 5,
    full_sync_every_messages: 10,
    required_message_capture: true,
    response_allowed_when_context_missing: true,
    updated_by: "mayk",
  });
  assert.strictEqual(set.ok, true);
  assert.strictEqual(set.policy.required_board, "demo-board");
  assert.strictEqual(set.policy.stale_after_minutes, 5);
  assert.strictEqual(set.policy.response_allowed_when_context_missing, true);

  const custom = tool("mem_runtime_policy_get", {
    runtime_name: "codexlink",
    agent_name: "angel",
    channel: "telegram",
    project: "demo",
  });
  assert.strictEqual(custom.source, "stored");
  assert.strictEqual(custom.policy.required_board, "demo-board");
}

{
  const set = tool("mem_runtime_policy_set", {
    runtime_name: "claude-aigramm",
    agent_name: "angel",
    channel: "telegram",
    project: "apps.blun.ai:wizard2",
    required_board: "wizard2-bridge",
    stale_after_minutes: 15,
    full_sync_every_messages: 2,
    required_message_capture: true,
    response_allowed_when_context_missing: false,
    updated_by: "mayk",
  });
  assert.strictEqual(set.ok, true);

  let captureCalls = 0;
  let recallCalls = 0;
  let briefCalls = 0;
  let boardCalls = 0;
  let eventCalls = 0;
  const ops = {
    capture: (payload) => {
      captureCalls++;
      assert.strictEqual(payload.promote_memory, true);
      assert.strictEqual(payload.remember, true);
      assert.strictEqual(payload.agent_name, undefined);
      assert.strictEqual(payload.meta.agent_name, "angel");
      return { ok: true, status: "captured", event_id: 100 + captureCalls, memory_id: 200 + captureCalls };
    },
    recall: (payload) => {
      recallCalls++;
      assert(payload.query.includes("Memory"));
      return [{ surface: "memory", ref_id: "1", actor: "Filedatabase", preview: "Memory muss automatisch sein." }];
    },
    briefPull: (payload) => {
      briefCalls++;
      assert.strictEqual(payload.agent_name, "angel");
      return { count: 0, briefs: [] };
    },
    projectBoard: (payload) => {
      boardCalls++;
      assert.strictEqual(payload.name, "wizard2-bridge");
      return { ok: true, project: payload.project, next_actions: [] };
    },
    eventLog: (payload) => {
      eventCalls++;
      const info = db.prepare(
        "INSERT INTO mnemo_event_journal (source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
      ).run(
        payload.source || "test",
        payload.channel || null,
        payload.direction || "internal",
        payload.actor || null,
        payload.event_kind,
        payload.ref_kind || null,
        payload.ref_id || null,
        payload.thread_id || null,
        payload.status || "ok",
        payload.content || null,
        JSON.stringify(payload.payload || {}),
        JSON.stringify(payload.meta || {})
      );
      return { ok: true, id: info.lastInsertRowid };
    },
  };

  const first = runtimeTurnBegin(db, {
    runtime_name: "claude-aigramm",
    agent_name: "angel",
    channel: "telegram",
    project: "apps.blun.ai:wizard2",
    thread_id: "blun-group",
    actor: "Filedatabase",
    content: "Memory muss automatisch vor jeder Antwort laufen.",
  }, ops);
  assert.strictEqual(first.allowed, true);
  assert.strictEqual(first.status, "ok");
  assert.strictEqual(first.capture.ok, true);
  assert.strictEqual(first.recall.ok, true);
  assert.strictEqual(first.board, "wizard2-bridge");
  assert(first.context_block.includes("memory_checked: yes"));
  assert.strictEqual(captureCalls, 1);
  assert.strictEqual(recallCalls, 1);
  assert.strictEqual(briefCalls, 1);
  assert.strictEqual(boardCalls, 1);

  const second = runtimeTurnBegin(db, {
    runtime_name: "claude-aigramm",
    agent_name: "angel",
    channel: "telegram",
    project: "apps.blun.ai:wizard2",
    thread_id: "blun-group",
    actor: "Filedatabase",
    content: "Memory muss auch jede zehnte Nachricht voll synchronisieren.",
  }, ops);
  assert.strictEqual(second.allowed, true);
  assert.strictEqual(second.full_sync_due, true);
  assert.strictEqual(second.full_sync_ran, true);
  assert(eventCalls >= 1, "full-sync audit event should be written");
  const state = db.prepare("SELECT * FROM runtime_turn_state WHERE agent_name='angel' AND runtime_name='claude-aigramm'").get();
  assert.strictEqual(state.message_count, 2);
  assert.strictEqual(state.message_count_since_full_sync, 0);
}

console.log("test_runtime_governance ok");
