"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureProtectedScopeSchema,
  seedDefaultProtectedScopes,
  protectedScopeCheck,
  validateProtectedScopeOverride,
  claimScopeKey
} = require("./protected_scope_gate");

const db = new Database(":memory:");
ensureProtectedScopeSchema(db);
seedDefaultProtectedScopes(db, { scope: "default", force: true });

function insertClaim({ project = "account", agent_name = "alfred", claim_kind = "protected_scope", scope_value = "auth login" } = {}) {
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
  db.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, claim_kind, scope_value, scope_key, expires_at, status) VALUES (?,?,?,?,?,?,?,?, 'active')")
    .run(project, scope_value, agent_name, "test claim", claim_kind, scope_value, claimScopeKey(claim_kind, scope_value), new Date(Date.now() + 60 * 60000).toISOString());
}

function insertOverride({ project = "account", agent_name = "otto", gate_kind = "protected_scope:auth_login", approved_by = "alfred" } = {}) {
  db.exec(`
CREATE TABLE IF NOT EXISTS override_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT,
  agent_name TEXT,
  gate_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT,
  starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
  db.prepare("INSERT INTO override_log (scope, project, agent_name, gate_kind, reason, approved_by, expires_at, status) VALUES ('default', ?, ?, ?, 'owner approved test', ?, ?, 'active')")
    .run(project, agent_name, gate_kind, approved_by, new Date(Date.now() + 60 * 60000).toISOString());
}

{
  const res = protectedScopeCheck(db, {
    agent_name: "otto",
    project: "account",
    task: "fix login redirect on account.blun.ai",
    action_type: "code_edit"
  });
  assert.strictEqual(res.status, "block");
  assert(res.blockers.some((b) => b.includes("owned by alfred")), "non-owner must be blocked");
  assert(res.blockers.some((b) => b.includes("requires an active claim")), "claim must be required");
}

{
  const res = protectedScopeCheck(db, {
    agent_name: "alfred",
    project: "account",
    task: "fix login redirect on account.blun.ai",
    action_type: "code_edit"
  });
  assert.strictEqual(res.status, "block");
  assert(!res.blockers.some((b) => b.includes("owned by alfred")), "owner should not get owner blocker");
  assert(res.blockers.some((b) => b.includes("requires an active claim")), "owner still needs a claim");
}

{
  insertClaim();
  const res = protectedScopeCheck(db, {
    agent_name: "alfred",
    project: "account",
    task: "fix login redirect on account.blun.ai",
    action_type: "code_edit"
  });
  assert.strictEqual(res.status, "ok");
}

{
  const missingRule = validateProtectedScopeOverride(db, {
    scope: "default",
    gate_kind: "protected_scope",
    reason: "test",
    approved_by: "alfred"
  });
  assert.strictEqual(missingRule.ok, false);
  assert.strictEqual(missingRule.error, "protected_scope_rule_key_required");

  const wrongApprover = validateProtectedScopeOverride(db, {
    scope: "default",
    gate_kind: "protected_scope:auth_login",
    reason: "test",
    approved_by: "otto"
  });
  assert.strictEqual(wrongApprover.ok, false);
  assert.strictEqual(wrongApprover.error, "protected_scope_owner_approval_required");

  const ownerApprover = validateProtectedScopeOverride(db, {
    scope: "default",
    gate_kind: "protected_scope:auth_login",
    reason: "test",
    approved_by: "alfred"
  });
  assert.strictEqual(ownerApprover.ok, true);
}

{
  insertOverride();
  const res = protectedScopeCheck(db, {
    agent_name: "otto",
    project: "account",
    task: "fix login redirect on account.blun.ai",
    action_type: "code_edit"
  });
  assert.strictEqual(res.status, "ok");
  assert(res.matched_rules[0].active_overrides.length > 0, "override must be visible in check result");
}

{
  const res = protectedScopeCheck(db, {
    agent_name: "frida",
    project: "account",
    task: "review login copy on account.blun.ai",
    action_type: "code_read"
  });
  assert.strictEqual(res.status, "warn");
  assert.strictEqual(res.blockers.length, 0);
}

console.log("test_protected_scope_gate ok");
