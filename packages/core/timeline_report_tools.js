"use strict";

const { parseMaybeJson } = require("./shared_utils");

const TIMELINE_REPORT_TOOL_DEFS = {
  mem_project_timeline_report: {
    description: "Render a token-budgeted project dossier: recent timeline, live-readiness gates, open defects, claims, briefs, handoffs, decisions, and concrete next actions.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        agent_name: { type: "string" },
        days: { type: "integer", default: 30 },
        token_budget: { type: "integer", default: 3000 },
        max_items: { type: "integer", default: 8 },
        live_focus: { type: "boolean", default: true },
        include_doc: { type: "boolean", default: true },
      },
      required: ["project"],
    },
  },
};

function handleTimelineReportTool(db, name, args) {
  if (!TIMELINE_REPORT_TOOL_DEFS[name]) return { handled: false };
  return { handled: true, result: projectTimelineReport(db, args || {}) };
}

function projectTimelineReport(db, args) {
  const project = clean(args.project || args.name, 160);
  if (!project) return { error: "project required" };
  const agentName = normalizeAgentId(args.agent_name);
  const days = clampInt(args.days, 30, 1, 3650);
  const tokenBudget = clampInt(args.token_budget, 3000, 800, 24000);
  const maxItems = clampInt(args.max_items, 8, 3, 50);
  const liveFocus = args.live_focus !== false;
  const includeDoc = args.include_doc !== false;
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

  const registry = selectProjectRegistry(db, project);
  const rules = selectProjectRules(db, project);
  const siteContract = selectSiteContract(db, project);
  const latestGolden = selectLatestGoldenCheck(db, project);
  const openFindings = selectOpenFindings(db, project, maxItems);
  const activeClaims = selectActiveClaims(db, project, maxItems);
  const autonomyTasks = selectAutonomyTasks(db, project, maxItems);
  const departmentCoverage = selectDepartmentCoverage(db, project);
  const pendingBriefs = selectPendingBriefs(db, project, agentName, maxItems);
  const handoffs = selectRecentHandoffs(db, project, agentName, sinceIso, maxItems);
  const decisions = selectRecentDecisions(db, project, sinceIso, maxItems);
  const actions = selectRecentActions(db, project, agentName, sinceIso, maxItems);
  const memories = selectMemorySnippets(db, project, sinceIso, maxItems);
  const timeline = buildTimeline({
    registry,
    rules,
    siteContract,
    latestGolden,
    openFindings,
    activeClaims,
    autonomyTasks,
    pendingBriefs,
    handoffs,
    decisions,
    actions,
    memories,
    maxItems,
  });
  const readiness = deriveLiveReadiness({
    project,
    registry,
    rules,
    siteContract,
    latestGolden,
    openFindings,
    activeClaims,
    autonomyTasks,
    liveFocus,
  });
  const nextActions = deriveNextActions(readiness, {
    openFindings,
    activeClaims,
    autonomyTasks,
    pendingBriefs,
    latestGolden,
  });

  const report = {
    ok: true,
    generated_at: new Date().toISOString(),
    project,
    agent_name: agentName || null,
    days,
    live_focus: liveFocus,
    token_budget: tokenBudget,
    summary: {
      status: readiness.status,
      readiness_percent: readiness.readiness_percent,
      blockers: readiness.blockers.length,
      warnings: readiness.warnings.length,
      open_findings: openFindings.length,
      active_claims: activeClaims.length,
      autonomy_open_or_review: autonomyTasks.filter((t) => !["done", "closed", "resolved"].includes(String(t.status || "").toLowerCase())).length,
      pending_or_dispatched_briefs: pendingBriefs.length,
      latest_golden_check_status: latestGolden ? latestGolden.status : null,
      last_activity_at: timeline.length ? timeline[0].at : null,
    },
    live_readiness: readiness,
    next_actions: nextActions,
    sections: {
      registry: registry ? redactRow(registry) : null,
      project_rules: rules ? redactRuleRow(rules) : null,
      site_contract: siteContract ? redactSiteContract(siteContract) : null,
      latest_golden_check: latestGolden ? redactRow(latestGolden) : null,
      open_findings: openFindings.map(redactRow),
      active_claims: activeClaims.map(redactRow),
      autonomy_tasks: autonomyTasks.map(redactRow),
      department_coverage: departmentCoverage.map(redactRow),
      pending_briefs: pendingBriefs.map(redactRow),
      recent_handoffs: handoffs.map(redactRow),
      recent_decisions: decisions.map(redactRow),
      recent_actions: actions.map(redactRow),
      memory_snippets: memories.map(redactRow),
      timeline,
    },
  };

  if (includeDoc) {
    const rendered = renderReport(report, tokenBudget);
    report.doc = rendered.doc;
    report.estimated_doc_tokens = rendered.estimated_tokens;
    report.truncated = rendered.truncated;
  }
  report.next_step = readiness.status === "ready"
    ? "Assign a reviewer to run the golden checks and capture the evidence before marking the project live."
    : "Work the blockers in next_actions first, then re-run mem_project_timeline_report until status is ready.";
  return report;
}

function selectProjectRegistry(db, project) {
  if (!tableExists(db, "project_registry")) return null;
  return safeGet(db, "SELECT * FROM project_registry WHERE lower(name)=lower(?) LIMIT 1", [project]);
}

function selectProjectRules(db, project) {
  if (!tableExists(db, "project_rules")) return null;
  return safeGet(db, "SELECT * FROM project_rules WHERE lower(project)=lower(?) LIMIT 1", [project]);
}

function selectSiteContract(db, project) {
  if (!tableExists(db, "site_contract")) return null;
  return safeGet(db, "SELECT * FROM site_contract WHERE lower(project)=lower(?) LIMIT 1", [project]);
}

function selectLatestGoldenCheck(db, project) {
  if (!tableExists(db, "golden_check_run")) return null;
  return safeGet(db, "SELECT id, project, agent_name, status, command, summary, evidence_json, findings_json, created_at FROM golden_check_run WHERE lower(project)=lower(?) ORDER BY created_at DESC LIMIT 1", [project]);
}

function selectOpenFindings(db, project, limit) {
  if (!tableExists(db, "quality_finding")) return [];
  return safeAll(db, `
SELECT id, project, category, severity, title, url, expected, actual, status, source_agent, updated_at, created_at
FROM quality_finding
WHERE lower(project)=lower(?)
  AND COALESCE(status,'open') NOT IN ('resolved','closed','done')
ORDER BY CASE lower(severity)
  WHEN 'critical' THEN 0 WHEN 'crit' THEN 0 WHEN 'c' THEN 0 WHEN 'p0' THEN 0
  WHEN 'high' THEN 1 WHEN 'h' THEN 1 WHEN 'p1' THEN 1
  WHEN 'medium' THEN 2 WHEN 'm' THEN 2 WHEN 'p2' THEN 2
  ELSE 3 END, updated_at DESC
LIMIT ?`, [project, limit]);
}

function selectActiveClaims(db, project, limit) {
  if (!tableExists(db, "work_claim")) return [];
  return safeAll(db, `
SELECT id, project, file_path, agent_name, summary, claimed_at, expires_at, status
FROM work_claim
WHERE lower(project)=lower(?)
  AND COALESCE(status,'active')='active'
  AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ORDER BY expires_at ASC
LIMIT ?`, [project, limit]);
}

function selectAutonomyTasks(db, project, limit) {
  if (!tableExists(db, "autonomy_task")) return [];
  return safeAll(db, `
SELECT id, project, department_name, title, category, severity, status, assigned_agent, reviewer_agent, updated_at, created_at
FROM autonomy_task
WHERE lower(project)=lower(?)
  AND COALESCE(status,'open') NOT IN ('done','closed','resolved')
ORDER BY CASE lower(severity)
  WHEN 'critical' THEN 0 WHEN 'crit' THEN 0 WHEN 'c' THEN 0 WHEN 'p0' THEN 0
  WHEN 'high' THEN 1 WHEN 'h' THEN 1 WHEN 'p1' THEN 1
  WHEN 'medium' THEN 2 WHEN 'm' THEN 2 WHEN 'p2' THEN 2
  ELSE 3 END, updated_at DESC
LIMIT ?`, [project, limit]);
}

function selectDepartmentCoverage(db, project) {
  if (!tableExists(db, "autonomy_task")) return [];
  return safeAll(db, `
SELECT department_name, status, COUNT(*) AS count
FROM autonomy_task
WHERE lower(project)=lower(?)
GROUP BY department_name, status
ORDER BY department_name ASC, status ASC`, [project]);
}

function selectPendingBriefs(db, project, agentName, limit) {
  if (!tableExists(db, "agent_brief")) return [];
  const params = [];
  const where = ["status IN ('pending','dispatched')"];
  if (agentName) {
    where.push("lower(agent_name)=lower(?)");
    params.push(agentName);
  }
  where.push("(content LIKE ? OR meta_json LIKE ?)");
  params.push(like(project), like(project));
  params.push(limit);
  return safeAll(db, `
SELECT id, agent_name, source_agent, status, created_at, dispatched_at, substr(content,1,260) AS preview
FROM agent_brief
WHERE ${where.join(" AND ")}
ORDER BY created_at DESC
LIMIT ?`, params);
}

function selectRecentHandoffs(db, project, agentName, sinceIso, limit) {
  if (!tableExists(db, "session_handoff")) return [];
  const params = [sinceIso, project, like(project), like(project)];
  const where = [
    "created_at >= ?",
    "(lower(project)=lower(?) OR summary LIKE ? OR meta_json LIKE ?)",
  ];
  if (agentName) {
    where.push("lower(agent_name)=lower(?)");
    params.push(agentName);
  }
  params.push(limit);
  return safeAll(db, `
SELECT id, agent_name, project, summary, changed_files, tests, deploys, blockers, next_actions, created_at
FROM session_handoff
WHERE ${where.join(" AND ")}
ORDER BY created_at DESC
LIMIT ?`, params);
}

function selectRecentDecisions(db, project, sinceIso, limit) {
  if (!tableExists(db, "decision_log")) return [];
  return safeAll(db, `
SELECT id, scope, title, substr(body,1,320) AS body, decided_by, decided_at, status, files_affected, entities_affected
FROM decision_log
WHERE decided_at >= ?
  AND COALESCE(status,'active')='active'
  AND (lower(scope)=lower(?) OR title LIKE ? OR body LIKE ? OR files_affected LIKE ? OR entities_affected LIKE ?)
ORDER BY decided_at DESC
LIMIT ?`, [sinceIso, project, like(project), like(project), like(project), like(project), limit]);
}

function selectRecentActions(db, project, agentName, sinceIso, limit) {
  if (!tableExists(db, "agent_action")) return [];
  const params = [sinceIso, project, like(project), like(project), like(project), like(project), like(project)];
  const where = [
    "started_at >= ?",
    "(lower(target)=lower(?) OR target LIKE ? OR topic LIKE ? OR payload_json LIKE ? OR result_json LIKE ? OR meta_json LIKE ?)",
  ];
  if (agentName) {
    where.push("lower(agent_name)=lower(?)");
    params.push(agentName);
  }
  params.push(limit);
  return safeAll(db, `
SELECT id, agent_name, action_kind, target, status, topic, started_at, finished_at
FROM agent_action
WHERE ${where.join(" AND ")}
ORDER BY started_at DESC
LIMIT ?`, params);
}

function selectMemorySnippets(db, project, sinceIso, limit) {
  if (!tableExists(db, "memory")) return [];
  return safeAll(db, `
SELECT id, kind, actor, topic, importance, occurred_at, substr(text,1,300) AS preview
FROM memory
WHERE occurred_at >= ?
  AND (topic LIKE ? OR text LIKE ?)
ORDER BY importance DESC, occurred_at DESC
LIMIT ?`, [sinceIso, like(project), like(project), limit]);
}

function buildTimeline(data) {
  const events = [];
  const max = Math.max(6, data.maxItems * 3);
  addEvent(events, "registry", data.registry && data.registry.updated_at, "project registry updated", data.registry && data.registry.live_status, data.registry && data.registry.updated_by);
  addEvent(events, "rules", data.rules && data.rules.updated_at, "project rules updated", data.rules && data.rules.notes, data.rules && data.rules.updated_by);
  addEvent(events, "site_contract", data.siteContract && data.siteContract.updated_at, "site contract updated", data.siteContract && data.siteContract.notes, data.siteContract && data.siteContract.updated_by);
  addEvent(events, "golden_check", data.latestGolden && data.latestGolden.created_at, "latest golden check", data.latestGolden && `${data.latestGolden.status}: ${data.latestGolden.summary || ""}`, data.latestGolden && data.latestGolden.agent_name);

  for (const row of data.openFindings || []) addEvent(events, "finding", row.updated_at || row.created_at, row.title, `${row.severity || ""} ${row.category || ""} ${row.status || ""}`, row.source_agent, row.id);
  for (const row of data.activeClaims || []) addEvent(events, "claim", row.claimed_at, row.file_path || row.summary, row.summary, row.agent_name, row.id);
  for (const row of data.autonomyTasks || []) addEvent(events, "autonomy_task", row.updated_at || row.created_at, row.title, `${row.department_name || ""} ${row.status || ""}`, row.assigned_agent, row.id);
  for (const row of data.pendingBriefs || []) addEvent(events, "brief", row.created_at, row.preview, row.status, row.agent_name, row.id);
  for (const row of data.handoffs || []) addEvent(events, "handoff", row.created_at, row.summary, row.next_actions || row.blockers, row.agent_name, row.id);
  for (const row of data.decisions || []) addEvent(events, "decision", row.decided_at, row.title, row.body, row.decided_by, row.id);
  for (const row of data.actions || []) addEvent(events, "action", row.started_at, row.action_kind || row.topic || row.target, row.status, row.agent_name, row.id);
  for (const row of data.memories || []) addEvent(events, "memory", row.occurred_at, row.preview, row.topic, row.actor, row.id);

  return events
    .filter((event) => event.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, max)
    .map((event) => redactRow(event));
}

function addEvent(events, kind, at, title, detail, actor, refId) {
  if (!at || !title) return;
  events.push({
    at,
    kind,
    title: clean(title, 180),
    detail: clean(detail, 220),
    actor: actor || null,
    ref_id: refId || null,
  });
}

function deriveLiveReadiness(data) {
  const checklist = parseMaybeJson(data.registry && data.registry.health_checklist, {});
  const missingBlocks = parseList(data.registry && data.registry.missing_blocks);
  const requiredGates = collectRequiredGates(data.rules, data.siteContract, data.liveFocus);
  const gateRows = requiredGates.map((gate) => {
    const state = gateStatus(gate, checklist);
    return {
      gate,
      status: state.status,
      source: state.source,
      value: state.value === undefined ? null : state.value,
    };
  });
  const requirements = standardRequirements(data.registry, data.rules, data.siteContract, checklist);
  const blockers = [];
  const warnings = [];

  if (!data.registry) {
    blockers.push(makeIssue("missing_project_registry", "critical", "No project_registry row exists.", "Create or seed project_registry before assigning live work."));
  }
  if (!data.rules) {
    blockers.push(makeIssue("missing_project_rules", "high", "No project_rules row exists.", "Create project rules for nav, auth, language, pricing, checkout, VAT, design, deploy and required gates."));
  }
  if (data.liveFocus && !data.siteContract) {
    warnings.push(makeIssue("missing_site_contract", "medium", "No site_contract row exists.", "Store canonical URLs, paths, forbidden hosts, locales, header/menu/footer/logo/auth/pricing/checkout checks."));
  }
  for (const item of missingBlocks) {
    blockers.push(makeIssue("registry_missing_block", "high", clean(item, 160), "Clear missing_blocks in project_registry only after evidence exists."));
  }
  for (const gate of gateRows) {
    if (gate.status === "block") blockers.push(makeIssue(`gate_blocked:${gate.gate}`, "high", `Required gate '${gate.gate}' is blocked.`, "Fix the gate and update project_registry.health_checklist."));
    if (gate.status === "unknown") warnings.push(makeIssue(`gate_unknown:${gate.gate}`, "medium", `Required gate '${gate.gate}' is unknown.`, "Run the check and record pass/fail in project_registry.health_checklist."));
  }
  for (const requirement of requirements) {
    if (requirement.status === "block") blockers.push(makeIssue(`requirement_blocked:${requirement.key}`, "high", `${requirement.label} is blocked.`, requirement.next_action));
    if (requirement.status === "unknown") warnings.push(makeIssue(`requirement_unknown:${requirement.key}`, "medium", `${requirement.label} is not documented.`, requirement.next_action));
  }
  for (const finding of data.openFindings || []) {
    if (isHighSeverity(finding.severity)) {
      blockers.push(makeIssue(`finding:${finding.id}`, severityName(finding.severity), finding.title, "Fix the finding, capture verification, then mark it resolved."));
    }
  }
  if (data.latestGolden) {
    const status = String(data.latestGolden.status || "").toLowerCase();
    if (["fail", "failed", "block", "blocked", "red"].includes(status)) {
      blockers.push(makeIssue("golden_check_failed", "high", data.latestGolden.summary || "Latest golden check failed.", "Fix failures and persist a passing mem_site_golden_check_report."));
    } else if (!["pass", "passed", "ok", "green", "approved"].includes(status)) {
      warnings.push(makeIssue("golden_check_unclear", "medium", `Latest golden check status is '${data.latestGolden.status}'.`, "Run a fresh golden check with clear pass/fail evidence."));
    }
  } else if (data.liveFocus) {
    warnings.push(makeIssue("golden_check_missing", "medium", "No golden check history found.", "Run mem_site_golden_check_plan, execute checks, then store mem_site_golden_check_report."));
  }
  if ((data.activeClaims || []).length) {
    warnings.push(makeIssue("active_claims", "medium", `${data.activeClaims.length} active work claim(s) exist.`, "Wait for release or coordinate before marking the project ready."));
  }
  if ((data.autonomyTasks || []).some((task) => ["blocked", "review"].includes(String(task.status || "").toLowerCase()))) {
    warnings.push(makeIssue("autonomy_review_or_blocked", "medium", "Autonomy tasks are still blocked or waiting for review.", "Route blocked/review tasks to their reviewer before live sign-off."));
  }

  const passedGates = gateRows.filter((gate) => gate.status === "pass").map((gate) => gate.gate);
  const blockedGates = gateRows.filter((gate) => gate.status === "block").map((gate) => gate.gate);
  const unknownGates = gateRows.filter((gate) => gate.status === "unknown").map((gate) => gate.gate);
  const status = blockers.length ? "block" : (warnings.length || unknownGates.length ? "attention" : "ready");
  const readinessPercent = Math.max(0, Math.min(100, 100 - blockers.length * 18 - warnings.length * 6 - unknownGates.length * 3));

  return {
    status,
    readiness_percent: readinessPercent,
    required_gates: requiredGates,
    gate_status: gateRows,
    requirements,
    passed_gates: passedGates,
    blocked_gates: blockedGates,
    unknown_gates: unknownGates,
    blockers: uniqueIssues(blockers),
    warnings: uniqueIssues(warnings),
  };
}

function collectRequiredGates(rules, siteContract, liveFocus) {
  const fromRules = parseList(rules && rules.required_gates);
  if (fromRules.length) return unique(fromRules.map((item) => clean(item, 80)).filter(Boolean));
  const fromSite = parseList(siteContract && siteContract.required_checks);
  if (fromSite.length) return unique(fromSite.map((item) => clean(item, 80)).filter(Boolean));
  if (!liveFocus) return ["planning", "implementation", "review"];
  return [
    "nav",
    "links",
    "header_footer",
    "logo",
    "mobile",
    "i18n",
    "auth",
    "pricing",
    "checkout",
    "vat",
    "legal",
    "deploy",
    "monitoring",
  ];
}

function standardRequirements(registry, rules, siteContract, checklist) {
  const defs = [
    { key: "nav", label: "Navigation/menu contract", fields: [rules && rules.canonical_nav, siteContract && siteContract.menu_rules], gates: ["nav", "menu", "navigation"], next: "Document canonical menu links and verify every locale/domain." },
    { key: "header_footer", label: "Header/footer consistency", fields: [siteContract && siteContract.header_rules, siteContract && siteContract.footer_rules], gates: ["header_footer", "header", "footer"], next: "Store header/footer rules and prove pages match the canonical shell." },
    { key: "logo", label: "Logo and dark-mode assets", fields: [siteContract && siteContract.logo_rules], gates: ["logo", "dark_logo", "darkmode_logo"], next: "Document logo rules including light/dark variants and verify them visually." },
    { key: "links", label: "Internal/legal links", fields: [siteContract && siteContract.paths, siteContract && siteContract.forbidden_hosts], gates: ["links", "legal_links", "forbidden_hosts"], next: "Run link checks for all stored paths/locales and remove forbidden cross-domain links." },
    { key: "mobile", label: "Mobile responsiveness", fields: [siteContract && siteContract.mobile_viewports], gates: ["mobile", "responsive"], next: "Run mobile viewport checks and store evidence." },
    { key: "i18n", label: "Language parity", fields: [registry && registry.langs, rules && rules.language_matrix, siteContract && siteContract.required_locales], gates: ["i18n", "language", "languages", "locales"], next: "Store required locales and verify every menu/legal/pricing path in each language." },
    { key: "auth", label: "Auth crossover", fields: [registry && registry.auth_system, rules && rules.auth_matrix, siteContract && siteContract.auth_rules], gates: ["auth", "login", "sso"], next: "Document shared auth rules and test one login across all related surfaces." },
    { key: "pricing", label: "Pricing source of truth", fields: [rules && rules.pricing_rules, siteContract && siteContract.pricing_rules], gates: ["pricing", "prices"], next: "Store pricing rules and verify every page displaying prices uses the same source." },
    { key: "checkout", label: "Checkout and billing", fields: [registry && registry.stripe_product_ids, rules && rules.checkout_rules, siteContract && siteContract.checkout_rules], gates: ["checkout", "billing", "stripe"], next: "Document checkout flow, product IDs, webhooks, and customer self-service checks." },
    { key: "vat", label: "VAT/OSS handling", fields: [registry && registry.vat_status, rules && rules.vat_rules], gates: ["vat", "oss", "tax"], next: "Record VAT/OSS decision and where VAT checks are already implemented." },
    { key: "deploy", label: "Deploy and rollback", fields: [registry && registry.server, registry && registry.pm2_processes, registry && registry.nginx_files, rules && rules.deploy_rules], gates: ["deploy", "server", "rollback"], next: "Record server/process/proxy coordinates and deploy/rollback rule." },
    { key: "legal", label: "Legal pages and public claims", fields: [siteContract && siteContract.paths, rules && rules.notes], gates: ["legal", "privacy", "terms", "impressum"], next: "Verify legal pages, locale routing, and public claims before launch." },
  ];
  return defs.map((def) => evaluateRequirement(def, checklist));
}

function evaluateRequirement(def, checklist) {
  const gate = firstGateStatus(def.gates, checklist);
  if (gate.status === "block") {
    return { key: def.key, label: def.label, status: "block", source: gate.source, next_action: def.next };
  }
  if (gate.status === "pass") {
    return { key: def.key, label: def.label, status: "pass", source: gate.source, next_action: null };
  }
  const hasField = (def.fields || []).some((value) => hasMeaningfulValue(value));
  return {
    key: def.key,
    label: def.label,
    status: hasField ? "documented" : "unknown",
    source: hasField ? "registry/rules/site_contract" : "missing",
    next_action: hasField ? null : def.next,
  };
}

function firstGateStatus(keys, checklist) {
  for (const key of keys || []) {
    const status = gateStatus(key, checklist);
    if (status.status !== "unknown") return status;
  }
  return { status: "unknown", source: "health_checklist", value: null };
}

function gateStatus(gate, checklist) {
  const normalized = normalizeKey(gate);
  if (!checklist || typeof checklist !== "object" || Array.isArray(checklist)) {
    return { status: "unknown", source: "health_checklist", value: null };
  }
  for (const [key, value] of Object.entries(checklist)) {
    if (normalizeKey(key) !== normalized) continue;
    return { status: normalizeStatus(value), source: `health_checklist.${key}`, value: redactValue(value) };
  }
  return { status: "unknown", source: "health_checklist", value: null };
}

function normalizeStatus(value) {
  if (value === true) return "pass";
  if (value === false) return "block";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("status" in value) return normalizeStatus(value.status);
    if ("passed" in value) return normalizeStatus(value.passed);
    if ("ok" in value) return normalizeStatus(value.ok);
    if ("done" in value) return normalizeStatus(value.done);
  }
  const text = String(value == null ? "" : value).toLowerCase().trim();
  if (["pass", "passed", "ok", "done", "green", "approved", "true", "yes", "ready"].includes(text)) return "pass";
  if (["block", "blocked", "fail", "failed", "red", "missing", "false", "no", "broken"].includes(text)) return "block";
  return "unknown";
}

function deriveNextActions(readiness, data) {
  const actions = [];
  for (const issue of readiness.blockers.slice(0, 8)) {
    actions.push({ priority: "P0", source: issue.id, action: issue.next_action || issue.title });
  }
  for (const issue of readiness.warnings.slice(0, 8)) {
    actions.push({ priority: "P1", source: issue.id, action: issue.next_action || issue.title });
  }
  for (const finding of (data.openFindings || []).filter((row) => !isHighSeverity(row.severity)).slice(0, 5)) {
    actions.push({ priority: "P2", source: `finding:${finding.id}`, action: `Resolve ${finding.category || "finding"}: ${clean(finding.title, 140)}` });
  }
  for (const task of (data.autonomyTasks || []).slice(0, 5)) {
    actions.push({ priority: task.status === "blocked" ? "P1" : "P2", source: `autonomy_task:${task.id}`, action: `${task.department_name || "department"}: ${clean(task.title, 140)}` });
  }
  if (!actions.length && readiness.status === "ready") {
    actions.push({ priority: "P1", source: "review", action: "Run final reviewer pass with site golden checks, deploy evidence, and handoff capture." });
  }
  return uniqueActions(actions).slice(0, 12);
}

function renderReport(report, tokenBudget) {
  const lines = [];
  lines.push(`# Project timeline report: ${report.project}`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Window: ${report.days} days`);
  lines.push(`Status: ${report.summary.status} (${report.summary.readiness_percent}%)`);
  lines.push(`Open: ${report.summary.open_findings} finding(s), ${report.summary.active_claims} active claim(s), ${report.summary.autonomy_open_or_review} autonomy task(s), ${report.summary.pending_or_dispatched_briefs} brief(s)`);
  lines.push("");

  lines.push("## Live readiness");
  addIssueLines(lines, "Blockers", report.live_readiness.blockers);
  addIssueLines(lines, "Warnings", report.live_readiness.warnings);
  lines.push(`Passed gates: ${report.live_readiness.passed_gates.join(", ") || "none"}`);
  lines.push(`Unknown gates: ${report.live_readiness.unknown_gates.join(", ") || "none"}`);
  lines.push("");

  lines.push("## Next actions");
  if (report.next_actions.length) {
    for (const action of report.next_actions) lines.push(`- ${action.priority} ${action.source}: ${action.action}`);
  } else {
    lines.push("- No next action detected.");
  }
  lines.push("");

  lines.push("## Project coordinates");
  const registry = report.sections.registry;
  if (registry) {
    pushKV(lines, "Domain", registry.domain);
    pushKV(lines, "Live URL", registry.live_url);
    pushKV(lines, "Staging URL", registry.staging_url);
    pushKV(lines, "Repo", registry.repo);
    pushKV(lines, "Server", registry.server);
    pushKV(lines, "Auth", registry.auth_system);
    pushKV(lines, "VAT", registry.vat_status);
    pushKV(lines, "Languages", registry.langs);
    pushKV(lines, "Live status", registry.live_status);
  } else {
    lines.push("- No registry row.");
  }
  lines.push("");

  lines.push("## Requirement map");
  for (const requirement of report.live_readiness.requirements) {
    lines.push(`- ${requirement.key}: ${requirement.status}${requirement.source ? ` (${requirement.source})` : ""}`);
  }
  lines.push("");

  renderTable(lines, "Open findings", report.sections.open_findings, (row) => `${row.severity || ""} ${row.category || ""} #${row.id}: ${row.title}${row.url ? ` (${row.url})` : ""}`);
  renderTable(lines, "Active claims", report.sections.active_claims, (row) => `${row.agent_name || "agent"} ${row.file_path || ""}: ${row.summary || ""}`);
  renderTable(lines, "Autonomy tasks", report.sections.autonomy_tasks, (row) => `${row.severity || ""} ${row.status || ""} ${row.department_name || ""} #${row.id}: ${row.title}`);
  renderTable(lines, "Pending/dispatched briefs", report.sections.pending_briefs, (row) => `${row.status || ""} ${row.agent_name || ""} #${row.id}: ${row.preview || ""}`);
  renderTable(lines, "Recent handoffs", report.sections.recent_handoffs, (row) => `${row.created_at || ""} ${row.agent_name || ""}: ${row.summary || ""}`);
  renderTable(lines, "Recent decisions", report.sections.recent_decisions, (row) => `${row.decided_at || ""} #${row.id}: ${row.title}`);
  renderTable(lines, "Timeline", report.sections.timeline, (row) => `${row.at || ""} ${row.kind || ""}: ${row.title || ""}${row.actor ? ` (${row.actor})` : ""}`);

  let doc = lines.join("\n");
  const maxChars = Math.max(1200, tokenBudget * 4);
  let truncated = false;
  if (doc.length > maxChars) {
    doc = doc.slice(0, maxChars - 120).trimEnd() + "\n\n[truncated: raise token_budget or lower max_items for a smaller report]";
    truncated = true;
  }
  return { doc, estimated_tokens: estimateTokens(doc), truncated };
}

function addIssueLines(lines, title, issues) {
  lines.push(`${title}:`);
  if (!issues || !issues.length) {
    lines.push("- none");
    return;
  }
  for (const issue of issues) {
    lines.push(`- ${issue.severity || "medium"} ${issue.id}: ${issue.title}${issue.next_action ? ` -> ${issue.next_action}` : ""}`);
  }
}

function renderTable(lines, title, rows, formatter) {
  lines.push(`## ${title}`);
  if (!rows || !rows.length) {
    lines.push("- none");
    lines.push("");
    return;
  }
  for (const row of rows) lines.push(`- ${clean(formatter(row), 320)}`);
  lines.push("");
}

function pushKV(lines, key, value) {
  if (hasMeaningfulValue(value)) lines.push(`- ${key}: ${clean(renderValue(value), 260)}`);
}

function makeIssue(id, severity, title, nextAction) {
  return {
    id,
    severity: severity || "medium",
    title: clean(title, 220),
    next_action: clean(nextAction, 240),
  };
}

function uniqueIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues || []) {
    const key = issue.id || issue.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function uniqueActions(actions) {
  const seen = new Set();
  const out = [];
  for (const action of actions || []) {
    const key = `${action.priority}:${action.source}:${action.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

function redactRuleRow(row) {
  const out = redactRow(row);
  for (const key of ["canonical_nav", "allowed_domains", "auth_matrix", "language_matrix", "pricing_rules", "checkout_rules", "vat_rules", "deploy_rules", "design_rules", "required_gates"]) {
    if (out[key]) out[key] = summarizeJsonish(out[key], 420);
  }
  return out;
}

function redactSiteContract(row) {
  const out = redactRow(row);
  for (const key of ["target_urls", "paths", "forbidden_hosts", "required_locales", "mobile_viewports", "desktop_viewports", "required_checks"]) {
    if (out[key]) out[key] = summarizeJsonish(out[key], 300);
  }
  for (const key of ["header_rules", "menu_rules", "footer_rules", "logo_rules", "auth_rules", "pricing_rules", "checkout_rules"]) {
    if (out[key]) out[key] = summarizeJsonish(out[key], 420);
  }
  return out;
}

function summarizeJsonish(value, max) {
  const parsed = parseMaybeJson(value, null);
  if (parsed == null || parsed === value) return redact(value, max);
  if (Array.isArray(parsed)) return parsed.slice(0, 12).map((item) => redactValue(item));
  if (parsed && typeof parsed === "object") {
    const out = {};
    for (const key of Object.keys(parsed).slice(0, 12)) out[key] = redactValue(parsed[key]);
    return out;
  }
  return parsed;
}

function redactRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) out[key] = redactValue(value);
  return out;
}

function redactValue(value) {
  if (typeof value === "string") return redact(value, 420);
  if (Array.isArray(value)) return value.slice(0, 20).map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) out[key] = redactValue(item);
    return out;
  }
  return value;
}

function parseList(value) {
  const parsed = parseMaybeJson(value, value);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.map((item) => renderValue(item)).filter(Boolean);
  if (parsed && typeof parsed === "object") return Object.keys(parsed).filter(Boolean);
  return String(parsed)
    .split(/[\n,;|]/)
    .map((item) => clean(item, 120))
    .filter(Boolean)
    .filter((item) => item !== "[]" && item !== "{}");
}

function renderValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function hasMeaningfulValue(value) {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return true;
  const text = String(value).trim();
  if (!text || text === "[]" || text === "{}" || text.toLowerCase() === "null") return false;
  return true;
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function severityName(value) {
  const text = String(value || "").toLowerCase();
  if (["critical", "crit", "c", "p0"].includes(text)) return "critical";
  if (["high", "h", "p1"].includes(text)) return "high";
  if (["medium", "m", "p2"].includes(text)) return "medium";
  return text || "low";
}

function isHighSeverity(value) {
  return ["critical", "crit", "c", "p0", "high", "h", "p1"].includes(String(value || "").toLowerCase());
}

function severityRank(value) {
  const text = String(value || "").toLowerCase();
  if (["critical", "crit", "c", "p0"].includes(text)) return 0;
  if (["high", "h", "p1"].includes(text)) return 1;
  if (["medium", "m", "p2"].includes(text)) return 2;
  return 3;
}

function safeGet(db, sql, params) {
  try {
    return db.prepare(sql).get(...(params || [])) || null;
  } catch {
    return null;
  }
}

function safeAll(db, sql, params) {
  try {
    return db.prepare(sql).all(...(params || []));
  } catch {
    return [];
  }
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name); } catch { return false; }
}

function clean(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (!max || text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "...";
}

function normalizeAgentId(value) {
  return String(value || "").trim().toLowerCase();
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function like(term) {
  return `%${String(term || "").replace(/[%_]/g, "")}%`;
}

function unique(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function redact(value, max) {
  let text = String(value || "");
  text = text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]");
  text = text.replace(/\b(sk|pk|rk|ghp|gho|github_pat)_[A-Za-z0-9_=-]{12,}\b/g, "[secret]");
  text = text.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;}]+/gi, "$1=[secret]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text || !max || text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "...";
}

module.exports = {
  TIMELINE_REPORT_TOOL_DEFS,
  handleTimelineReportTool,
  projectTimelineReport,
};
