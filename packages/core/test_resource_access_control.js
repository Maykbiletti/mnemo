"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureResourceAccessSchema,
  resourceAccessCheck,
  handleResourceAccessTool
} = require("./resource_access_control");

const db = new Database(":memory:");
ensureResourceAccessSchema(db);

function tool(name, args) {
  const result = handleResourceAccessTool(db, name, args || {});
  assert(result.handled, "tool not handled: " + name);
  return result.result;
}

function insertClaim() {
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
`);
  const info = db.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, claim_kind, scope_value, scope_key, expires_at, status) VALUES ('chat', 'src/chat/login.js', 'otto', 'chat login', 'file', 'src/chat/login.js', 'file:src/chat/login.js', ?, 'active')")
    .run(new Date(Date.now() + 60 * 60000).toISOString());
  return info.lastInsertRowid;
}

{
  const res = resourceAccessCheck(db, {
    agent_name: "frida",
    project: "docs",
    action_type: "code_edit",
    files: ["README.md"]
  });
  assert.strictEqual(res.status, "ok");
}

{
  const upsert = tool("mem_resource_upsert", {
    project: "account",
    resource_kind: "file",
    resource_key: "packages/account/auth.js",
    owner_agent: "alfred",
    updated_by: "alfred"
  });
  assert.strictEqual(upsert.ok, true);

  const owner = resourceAccessCheck(db, {
    agent_name: "alfred",
    project: "account",
    action_type: "code_edit",
    files: ["packages/account/auth.js"]
  });
  assert.strictEqual(owner.status, "ok");

  const blocked = resourceAccessCheck(db, {
    agent_name: "otto",
    project: "account",
    action_type: "code_edit",
    files: ["packages/account/auth.js"]
  });
  assert.strictEqual(blocked.status, "block");
  assert(blocked.blockers[0].includes("requires owner/ACL/approval"));

  const wrongGrant = tool("mem_resource_acl_grant", {
    project: "account",
    resource_kind: "file",
    resource_key: "packages/account/auth.js",
    agent_name: "otto",
    permission: "write",
    granted_by: "otto",
    reason: "test"
  });
  assert.strictEqual(wrongGrant.error, "resource_owner_approval_required");

  const grant = tool("mem_resource_acl_grant", {
    project: "account",
    resource_kind: "file",
    resource_key: "packages/account/auth.js",
    agent_name: "otto",
    permission: "write",
    granted_by: "alfred",
    reason: "owner handoff"
  });
  assert.strictEqual(grant.ok, true);

  const allowed = resourceAccessCheck(db, {
    agent_name: "otto",
    project: "account",
    action_type: "code_edit",
    files: ["packages/account/auth.js"]
  });
  assert.strictEqual(allowed.status, "ok");
}

{
  const claimId = insertClaim();
  const blocked = resourceAccessCheck(db, {
    agent_name: "alfred",
    project: "chat",
    action_type: "code_edit",
    files: ["src/chat/login.js"]
  });
  assert.strictEqual(blocked.status, "block");
  assert(blocked.blockers[0].includes("actively claimed by otto"));

  const request = tool("mem_claim_request_access", {
    claim_id: claimId,
    requester_agent: "alfred",
    reason: "need to repair auth crossover"
  });
  assert.strictEqual(request.ok, true);
  assert.strictEqual(request.owner_agent, "otto");

  const wrongGrant = tool("mem_claim_grant_access", {
    claim_id: claimId,
    requester_agent: "alfred",
    granted_by: "alfred"
  });
  assert.strictEqual(wrongGrant.error, "claim_owner_required");

  const grant = tool("mem_claim_grant_access", {
    claim_id: claimId,
    requester_agent: "alfred",
    granted_by: "otto",
    approval_id: request.id
  });
  assert.strictEqual(grant.ok, true);

  const allowed = resourceAccessCheck(db, {
    agent_name: "alfred",
    project: "chat",
    action_type: "code_edit",
    files: ["src/chat/login.js"]
  });
  assert.strictEqual(allowed.status, "ok");

  const transfer = tool("mem_claim_transfer", {
    claim_id: claimId,
    to_agent: "alfred",
    by_agent: "otto",
    reason: "handoff"
  });
  assert.strictEqual(transfer.ok, true);
}

{
  const audit = tool("mem_resource_audit_list", { limit: 20 });
  assert(audit.count >= 4, "audit log should contain resource/ACL/claim events");
}

console.log("test_resource_access_control ok");
