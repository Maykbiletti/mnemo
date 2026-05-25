"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureAgentGovernanceSchema,
  handleAgentGovernanceTool,
} = require("./agent_governance");

const db = new Database(":memory:");
db.exec(`
CREATE TABLE agent_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  action_kind TEXT,
  target TEXT,
  status TEXT,
  payload_json TEXT,
  topic TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE mnemo_event_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  channel TEXT,
  direction TEXT NOT NULL DEFAULT 'internal',
  actor TEXT,
  event_kind TEXT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  status TEXT,
  content TEXT,
  payload_json TEXT,
  meta_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE work_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  file_path TEXT,
  agent_name TEXT NOT NULL,
  summary TEXT,
  claim_kind TEXT,
  scope_value TEXT,
  scope_key TEXT,
  heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stale_after_sec INTEGER NOT NULL DEFAULT 300,
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  released_at TEXT,
  takeover_count INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT
);
CREATE TABLE project_rules (
  project TEXT PRIMARY KEY,
  canonical_nav TEXT,
  allowed_domains TEXT,
  auth_matrix TEXT,
  language_matrix TEXT,
  pricing_rules TEXT,
  checkout_rules TEXT,
  vat_rules TEXT,
  deploy_rules TEXT,
  design_rules TEXT,
  required_gates TEXT,
  notes TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE session_handoff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  project TEXT,
  summary TEXT,
  changed_files TEXT,
  tests TEXT,
  deploys TEXT,
  blockers TEXT,
  next_actions TEXT,
  claims_released TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
ensureAgentGovernanceSchema(db);
db.prepare("INSERT INTO project_rules (project, deploy_rules, design_rules, required_gates, notes, updated_by) VALUES (?,?,?,?,?,?)")
  .run("mnemo", JSON.stringify({ completion_guard: true }), JSON.stringify({ owner_rules_are_blockers: true }), JSON.stringify(["evidence_required"]), "initial", "test");

function tool(name, args) {
  const handled = handleAgentGovernanceTool(db, name, args || {});
  assert(handled.handled, "tool not handled: " + name);
  return handled.result;
}

{
  const catalog = tool("mem_gstack_catalog", {});
  assert.strictEqual(catalog.ok, true);
  assert.strictEqual(catalog.role_count, 10);
  assert.strictEqual(catalog.core_skill_count, 23);
  assert(catalog.workflow.includes("reflect"));
  assert(catalog.workflow.includes("memorize"));
  assert(catalog.kernel.contract.includes("never_start_without_boot"));
  assert(catalog.commands.some((row) => row.command === "mnemo boot"));
  assert(catalog.hundred_agent_model.requires.includes("work claim"));
}

{
  const role = tool("mem_agent_role_select", {
    agent_name: "otto",
    role: "Backend Engineer",
    project: "mnemo",
    task: "Build gstack adoption layer",
    plan: "Add catalog, role, portal context, preflight, receipts and board.",
  });
  assert.strictEqual(role.ok, true);
  assert.strictEqual(role.assignment.role_name, "Backend Engineer");

  const got = tool("mem_agent_role_get", { agent_name: "otto", project: "mnemo" });
  assert.strictEqual(got.assignment.role_name, "Backend Engineer");
}

{
  const role = tool("mem_agent_role_select", {
    agent_name: "angel",
    role: "Chief Security Officer",
    project: "mnemo",
    task: "Review protected scope",
    plan: "Check owner rules and protected scope before approval.",
  });
  assert.strictEqual(role.ok, true);
  assert.strictEqual(role.assignment.role_name, "Security Reviewer");
}

{
  const blocked = tool("mem_agent_company_preflight", {
    agent_name: "otto",
    project: "mnemo",
    task: "Change code without portal context",
    files: ["packages/core/agent_governance.js"],
  });
  assert.strictEqual(blocked.status, "block");
  assert(blocked.blockers.some((item) => item.includes("portal context")));
}

{
  const context = tool("mem_portal_context_set", {
    project: "mnemo",
    portal: "default",
    portal_id: "mnemo-core",
    portal_name: "Mnemo Core",
    brand_name: "Mnemo",
    domain: "local",
    environment: "local",
    country_or_market: ["DE"],
    user_role: "agent",
    language_default: "de",
    supported_languages: ["de", "en"],
    design: { system: "ops" },
    credit_system: { type: "none" },
    pricing: { plan: "internal" },
    rights: { write: ["alfred", "otto"] },
    billing_owner: "internal",
    auth_owner: "backend",
    deployment_owner: "release",
    legal_owner: "owner",
    forbidden_cross_portal_leaks: ["wrong-domain-links", "wrong-brand"],
    shared_modules: ["runtime", "mcp", "daemon"],
    protected_surfaces: ["memory", "claims", "audit"],
    global_rules: ["Owner rules are blockers"],
    rules: ["Mnemo is source of truth"],
    customer_partner_rules: ["No customer-specific override loaded"],
    updated_by: "alfred",
  });
  assert.strictEqual(context.ok, true);
  assert.strictEqual(context.context.brand_name, "Mnemo");
  assert.strictEqual(context.context.portal_id, "mnemo-core");
  assert(context.context.supported_languages.includes("en"));
}

{
  const missingClaim = tool("mem_agent_company_preflight", {
    agent_name: "otto",
    project: "mnemo",
    task: "Change claimed code",
    files: ["packages/core/agent_governance.js"],
  });
  assert.strictEqual(missingClaim.status, "block");
  assert(missingClaim.blockers.some((item) => item.includes("missing active work claims")));

  db.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, claim_kind, scope_value, scope_key, expires_at, status) VALUES (?,?,?,?,?,?,?,?, 'active')")
    .run("mnemo", "packages/core/agent_governance.js", "otto", "test claim", "file", "packages/core/agent_governance.js", "file:packages/core/agent_governance.js", "2099-01-01T00:00:00.000Z");

  const ok = tool("mem_agent_company_preflight", {
    agent_name: "otto",
    project: "mnemo",
    task: "Change claimed code",
    files: ["packages/core/agent_governance.js"],
  });
  assert.strictEqual(ok.status, "ok");
}

{
  const receipt = tool("mem_workflow_receipt_create", {
    agent_name: "otto",
    project: "mnemo",
    phase: "plan",
    summary: "Plan saved for gstack adoption.",
    evidence: [{ test_step: "unit", result: "planned" }],
  });
  assert.strictEqual(receipt.ok, true);
  assert.strictEqual(receipt.phase, "plan");

  const memorize = tool("mem_workflow_receipt_create", {
    agent_name: "otto",
    project: "mnemo",
    phase: "memorize",
    summary: "Done-state was captured for session handoff.",
    evidence: [{ handoff: "captured" }],
  });
  assert.strictEqual(memorize.ok, true);
  assert.strictEqual(memorize.phase, "memorize");

  const board = tool("mem_agent_company_board", { project: "mnemo", scale_target_agents: 100 });
  assert.strictEqual(board.ok, true);
  assert.strictEqual(board.capacity.scale_target_agents, 100);
  assert.strictEqual(board.role_counts["Backend Engineer"], 1);
  assert(board.recommendations.some((item) => item.includes("100 agents")));
}

{
  const boot = tool("mem_agent_os_boot", {
    agent_name: "otto",
    role: "Backend",
    project: "mnemo",
    portal: "default",
    task: "Continue gstack adoption layer",
    plan: "Use existing claim and portal context, then write receipts and handoff.",
    files: ["packages/core/agent_governance.js"],
  });
  assert.strictEqual(boot.status, "ok");
  assert(boot.boot_sequence.includes("load_latest_receipts_and_handoffs"));
  assert.strictEqual(boot.role_assignment.role_name, "Backend Engineer");
  assert(boot.recent_receipts.length >= 1);
}

{
  const first = tool("mem_owner_rule_diff", { project: "mnemo", agent_name: "otto" });
  assert.strictEqual(first.ok, true);
  assert(first.snapshot_id);
  db.prepare("UPDATE project_rules SET required_gates=?, updated_by='test2' WHERE project='mnemo'")
    .run(JSON.stringify(["evidence_required", "agent_os_boot"]));
  const diff = tool("mem_owner_rule_diff", { project: "mnemo", before_snapshot_id: first.snapshot_id, agent_name: "otto" });
  assert.strictEqual(diff.ok, true);
  assert(diff.diff.changed_count > 0);

  const fp1 = tool("mem_task_fingerprint", {
    project: "mnemo",
    portal: "default",
    agent_name: "otto",
    task: "Build Agent OS rule violation and never again checks",
    files: ["packages/core/agent_governance.js"],
  });
  assert.strictEqual(fp1.ok, true);
  const fp2 = tool("mem_task_fingerprint", {
    project: "mnemo",
    portal: "default",
    agent_name: "angel",
    task: "Build Agent OS rule violation and never again checks",
    files: ["packages/core/agent_governance.js"],
    persist: false,
  });
  assert.strictEqual(fp2.duplicate, true);

  const violation = tool("mem_rule_violation_log", {
    project: "mnemo",
    agent_name: "otto",
    rule_key: "test-no-repeat",
    rule_text: "Do not repeat this test violation.",
    severity: "H",
    evidence: [{ test_step: "unit", result: "captured", file_path: "packages/core/test_gstack_governance.js" }],
  });
  assert.strictEqual(violation.ok, true);

  const never = tool("mem_never_again_check", {
    project: "mnemo",
    agent_name: "otto",
    task: "Build Agent OS rule violation and never again checks",
  });
  assert.strictEqual(never.status, "block");
  assert(never.blockers.some((item) => item.includes("rule violation")));

  const guardBlocked = tool("mem_completion_guard_check", {
    project: "mnemo",
    agent_name: "otto",
    summary: "Finish without evidence",
    skip_never_again: true,
  });
  assert.strictEqual(guardBlocked.status, "block");

  const guardPass = tool("mem_completion_guard_check", {
    project: "mnemo",
    agent_name: "otto",
    summary: "Finish with evidence",
    required_evidence: ["unit"],
    evidence: [{ test_step: "unit", result: "passed", file_path: "packages/core/test_gstack_governance.js" }],
    tests: ["node test_gstack_governance.js"],
    handoff_id: 1,
    skip_never_again: true,
  });
  assert.strictEqual(guardPass.status, "pass");

  const blame = tool("mem_agent_blame_report", { agent_name: "otto", project: "mnemo", days: 30 });
  assert.strictEqual(blame.ok, true);
  assert(blame.reliability.score >= 0);
}

console.log("test_gstack_governance ok");
