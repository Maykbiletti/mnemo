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

let templatedWorkOrderId;
let templatedTokenId;
{
  const templates = tool("mem_work_order_template_list", {});
  assert.strictEqual(templates.ok, true);
  assert(templates.templates.some((template) => template.template_id === "wizard_surface_work"));
  const wizardTemplate = templates.templates.find((template) => template.template_id === "wizard_surface_work");
  assert.strictEqual(wizardTemplate.runtime_contract.agent_neutral, true);

  const custom = tool("mem_work_order_template_upsert", {
    template_id: "agent-neutral-smoke",
    title: "Agent neutral smoke",
    description: "Template usable by Claude, GPT/Codex, and OpenClaw adapters.",
    department_name: "engineering",
    action_type: "code_edit",
    allowed_tools: ["apply_patch"],
    files: ["packages/core/*"],
    required_evidence: ["smoke proof"],
    updated_by: "alfred",
  });
  assert.strictEqual(custom.ok, true);
  assert.strictEqual(custom.template.runtime_contract.agent_neutral, true);

  const templated = tool("mem_work_order_create_from_template", {
    template_id: "wizard_surface_work",
    project: "apps.blun.ai",
    objective: "Merge only the Wizard2 final builder surface.",
    assigned_agent: "angel",
    owner_agent: "alfred",
    created_by: "alfred",
    routes: ["/de/dashboard/wizard2"],
    files: ["admin/app/dashboard/wizard2/*"],
    ttl_minutes: 30,
  });
  assert.strictEqual(templated.ok, true);
  assert.strictEqual(templated.work_order.meta.template_id, "wizard_surface_work");
  assert.strictEqual(templated.work_order.meta.runtime_contract.agent_neutral, true);
  assert(templated.work_order.required_evidence.includes("explicit wizard target"));
  assert(templated.work_order.required_evidence.includes("language check"));
  assert(templated.token.token_id);
  templatedWorkOrderId = templated.work_order.id;
  templatedTokenId = templated.token.token_id;

  const tokenCheck = tool("mem_capability_token_check", {
    token_id: templatedTokenId,
    work_order_id: templatedWorkOrderId,
    agent_name: "angel",
    project: "apps.blun.ai",
    action_type: "code_edit",
    tool_name: "apply_patch",
    routes: ["/de/dashboard/wizard2"],
    files: ["admin/app/dashboard/wizard2/page.tsx"],
  });
  assert.strictEqual(tokenCheck.granted, true);
}

{
  const blockedGate = tool("mem_quality_gate_run", {
    gate_id: "wizard_gate",
    work_order_id: templatedWorkOrderId,
    agent_name: "angel",
    evidence: [{ check: "explicit wizard target", result: "pass", file_path: "admin/app/dashboard/wizard2/page.tsx" }],
  });
  assert.strictEqual(blockedGate.ok, false);
  assert(blockedGate.missing.includes("builder route check"));

  const passGate = tool("mem_quality_gate_run", {
    gate_id: "wizard_gate",
    work_order_id: templatedWorkOrderId,
    agent_name: "angel",
    evidence: [
      { check: "explicit wizard target", result: "pass", file_path: "admin/app/dashboard/wizard2/page.tsx" },
      { check: "builder route check", result: "pass", url: "https://apps.blun.ai/de/dashboard/wizard2" },
      { check: "browser verification", result: "pass", url: "https://apps.blun.ai/de/dashboard/wizard2" },
      { check: "language check", result: "pass", url: "https://apps.blun.ai/sv/dashboard/wizard2" },
    ],
  });
  assert.strictEqual(passGate.ok, true);
  assert.strictEqual(passGate.status, "pass");
}

{
  const snapshot = tool("mem_context_snapshot_create", {
    project: "apps.blun.ai",
    agent_name: "alfred",
    runtime_name: "codex",
    work_order_id: templatedWorkOrderId,
    title: "Wizard2 builder merge checkpoint",
    summary: "Wizard2 final builder merge is scoped to the new-create flow, not Wizard1.",
    decisions: ["Wizard2 is the target", "Wizard1 must not be edited in this task"],
    remaining_work: ["Run browser QA", "Check all eight languages"],
    files: ["admin/app/dashboard/wizard2/page.tsx"],
    routes: ["/de/dashboard/wizard2"],
    branch: "main",
    commit_sha: "abc123",
    dirty: true,
  });
  assert.strictEqual(snapshot.ok, true);
  assert.strictEqual(snapshot.snapshot.meta.agent_neutral, true);

  const restore = tool("mem_context_restore_brief", {
    project: "apps.blun.ai",
    work_order_id: templatedWorkOrderId,
  });
  assert.strictEqual(restore.ok, true);
  assert(restore.brief.includes("Wizard2 is the target"));
  assert(restore.brief.includes("Treat this brief as context, not company truth"));
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

  const failingExit = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    completion_summary: "done",
    evidence: [{ check: "unit tests", command: "node test_agent_governance.js", exit_code: 1, result: "pass" }],
  });
  assert.strictEqual(failingExit.error, "evidence_not_passing");

  const failingResult = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    completion_summary: "done",
    evidence: [{ check: "unit tests", command: "node test_agent_governance.js", exit_code: 0, result: "failed" }],
  });
  assert.strictEqual(failingResult.error, "evidence_not_passing");

  const needsReview = tool("mem_work_order_complete", {
    work_order_id: workOrderId,
    status: "needs_review",
    completion_summary: "patched but not verified",
    evidence: [{ check: "unit tests", command: "node test_agent_governance.js", exit_code: 1, result: "failed" }],
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
  const policy = tool("mem_project_channel_policy_set", {
    project: "apps.blun.ai",
    updated_by: "alfred",
  });
  assert.strictEqual(policy.ok, true);
  assert(policy.policy.rules.some((rule) => rule.includes("Telegram")));

  const focus = tool("mem_project_focus_set", {
    project: "apps.blun.ai",
    surface: "wizard2",
    active_target: "Wizard2 output only",
    focus_summary: "Keep Wizard2 focused; do not mix Wizard1 or unrelated app work.",
    must_do: ["Fix Wizard2 findings from verified QA"],
    must_not_do: ["Do not mix Wizard1", "Do not change unrelated chat/mobile scope"],
    owner_agent: "alfred",
    coordinator_agent: "dieter",
    updated_by: "alfred",
  });
  assert.strictEqual(focus.ok, true);
  assert.strictEqual(focus.focus.surface, "wizard2");
  assert(focus.focus.must_not_do.includes("Do not mix Wizard1"));

  const intent = tool("mem_user_intent_capture", {
    project: "apps.blun.ai",
    source_channel: "telegram",
    message_ref: "blungroup/7782",
    exact_words: "Wizard2 nichts anderes. Demo blocker gefunden.",
    summary: "Keep current execution on Wizard2 and capture demo blockers as tasks.",
    create_task: true,
    set_focus: true,
    surface: "wizard2",
    assigned_agent: "alfred",
    agent_name: "alfred",
    acceptance: ["Wizard2 task is visible on the project board", "Work Orders remain required before risky execution"],
    must_not_do: ["Do not mix Wizard1"],
  });
  assert.strictEqual(intent.ok, true);
  assert.strictEqual(intent.intent.priority, "critical");
  assert(intent.task.id);

  const updated = tool("mem_project_task_update", {
    task_id: intent.task.id,
    status: "active",
    blockers: ["needs verified build"],
    evidence: [{ check: "captured user words", result: "pass", message_ref: "blungroup/7782" }],
    updated_by: "alfred",
  });
  assert.strictEqual(updated.ok, true);
  assert.strictEqual(updated.task.status, "active");
  assert(updated.task.blockers.includes("needs verified build"));

  const tasks = tool("mem_project_task_list", { project: "apps.blun.ai", assigned_agent: "alfred" });
  assert.strictEqual(tasks.ok, true);
  assert(tasks.count >= 1);

  const briefContent = `# Wizard2 QA Brief
## Title
Wizard2 header nav overflow
## Project
apps.blun.ai
## Request
Generated Wizard2 output has too many header nav items and overflows the viewport.
## Acceptance
- Top navigation fits without horizontal scroll
- Legal links move to footer
## Files
- /root/blun-website/src/routes/wizard-build.js`;
  const firstBrief = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
    .run("alfred", "dieter", briefContent, JSON.stringify({ project: "apps.blun.ai", priority: "high" })).lastInsertRowid;
  const ingest = tool("mem_brief_task_ingest", {
    brief_id: firstBrief,
    default_project: "apps.blun.ai",
    assigned_agent: "alfred",
    created_by: "mnemo",
  });
  assert.strictEqual(ingest.ok, true);
  assert.strictEqual(ingest.created, 1);
  assert.strictEqual(ingest.results[0].task.source_kind, "agent_brief");
  assert.strictEqual(ingest.results[0].task.source_id, String(firstBrief));
  assert(ingest.results[0].task.acceptance.includes("Top navigation fits without horizontal scroll"));

  const duplicateBrief = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
    .run("alfred", "angel", briefContent, JSON.stringify({ project: "apps.blun.ai", priority: "high" })).lastInsertRowid;
  const duplicateIngest = tool("mem_brief_task_ingest", {
    brief_id: duplicateBrief,
    default_project: "apps.blun.ai",
    assigned_agent: "alfred",
  });
  assert.strictEqual(duplicateIngest.ok, true);
  assert.strictEqual(duplicateIngest.created, 0);
  assert.strictEqual(duplicateIngest.linked, 1);
  assert.strictEqual(duplicateIngest.results[0].task.id, ingest.results[0].task.id);

  const repeatedIngest = tool("mem_brief_task_ingest", { brief_id: firstBrief, default_project: "apps.blun.ai", mark_brief_status: "done" });
  assert.strictEqual(repeatedIngest.results[0].action, "source_existing");
  assert.strictEqual(db.prepare("SELECT status FROM agent_brief WHERE id=?").get(firstBrief).status, "done");

  const board = tool("mem_project_board", { project: "apps.blun.ai" });
  assert.strictEqual(board.ok, true);
  assert.strictEqual(board.focus.surface, "wizard2");
  assert.strictEqual(board.policy.project, "apps.blun.ai");
  assert(board.summary.open_tasks >= 1);
  assert(board.summary.active_work_orders >= 1);
  assert(board.tasks_by_status.active.some((task) => task.id === intent.task.id));
  assert(board.tasks_by_status.open.some((task) => task.id === ingest.results[0].task.id));
  assert(!board.pending_briefs.some((brief) => brief.id === firstBrief || brief.id === duplicateBrief));
  const boardWithBriefs = tool("mem_project_board", { project: "apps.blun.ai", include_ingested_briefs: true });
  assert(boardWithBriefs.pending_briefs.some((brief) => brief.id === duplicateBrief));
  assert.strictEqual(board.channel_rule, "Telegram coordinates; Mnemo briefs assign durable work; Work Orders authorize execution; Company Ledger remains truth.");
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
