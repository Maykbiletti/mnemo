"use strict";

const TRAINING_STATUS_ACTIVE = "active";
const SITE_JSON_FIELDS = [
  "target_urls",
  "paths",
  "forbidden_hosts",
  "required_locales",
  "header_rules",
  "menu_rules",
  "footer_rules",
  "logo_rules",
  "auth_rules",
  "pricing_rules",
  "checkout_rules",
  "mobile_viewports",
  "desktop_viewports",
  "required_checks",
];

const TEAM_QUALITY_TOOL_DEFS = {
  mem_agent_scorecard: {
    description: "Score one agent or all agents from real Mnemo work signals: actions, briefs, guard failures, quality findings, autonomy tasks, and training rules.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        days: { type: "integer", default: 14 },
        include_doc: { type: "boolean" },
      },
    },
  },
  mem_agent_scoreboard: {
    description: "Render a compact team scoreboard with blockers, score, guard issues, open findings, pending briefs, and training notes.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", default: 14 },
        limit: { type: "integer", default: 50 },
      },
    },
  },
  mem_agent_training_rule_upsert: {
    description: "Store a durable training rule for one agent, one project, or the whole team. Use when owner feedback or a repeated mistake must never be forgotten.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        agent_name: { type: "string" },
        scope: { type: "string" },
        project: { type: "string" },
        rule_kind: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        source_kind: { type: "string" },
        source_id: { type: "string" },
        severity: { type: "string" },
        status: { type: "string" },
        created_by: { type: "string" },
      },
      required: ["title", "body"],
    },
  },
  mem_agent_training_rules: {
    description: "List active training rules relevant to an agent, project, or scope.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        scope: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
  mem_correction_capture: {
    description: "Turn owner/reviewer feedback into a scar event plus a durable agent training rule so the team does not repeat the same mistake.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        text: { type: "string" },
        title: { type: "string" },
        category: { type: "string" },
        severity: { type: "string" },
        source_kind: { type: "string" },
        source_id: { type: "string" },
        created_by: { type: "string" },
        make_rule: { type: "boolean" },
        create_finding: { type: "boolean" },
        finding_url: { type: "string" },
      },
      required: ["text"],
    },
  },
  mem_site_contract_set: {
    description: "Store the canonical website contract for a project: canonical source, targets, paths, forbidden hosts, locales, header/menu/footer/logo/auth/pricing/checkout/mobile rules, and required checks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        canonical_url: { type: "string" },
        target_urls: { type: "array", items: { type: "string" } },
        paths: { type: "array", items: { type: "string" } },
        forbidden_hosts: { type: "array", items: { type: "string" } },
        required_locales: { type: "array", items: { type: "string" } },
        header_rules: { type: "object" },
        menu_rules: { type: "object" },
        footer_rules: { type: "object" },
        logo_rules: { type: "object" },
        auth_rules: { type: "object" },
        pricing_rules: { type: "object" },
        checkout_rules: { type: "object" },
        mobile_viewports: { type: "array" },
        desktop_viewports: { type: "array" },
        required_checks: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        updated_by: { type: "string" },
      },
      required: ["project"],
    },
  },
  mem_site_contract_get: {
    description: "Read the website contract for one project, merged with registry and project-rule hints when available.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
      },
      required: ["project"],
    },
  },
  mem_site_contract_list: {
    description: "List projects with stored site contracts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer" },
      },
    },
  },
  mem_site_golden_check_plan: {
    description: "Build the mandatory golden-check plan for a website change, including audit command, browser evidence, mobile/desktop, locale, logo, menu, footer, and forbidden-domain checks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        agent_name: { type: "string" },
        change_summary: { type: "string" },
        include_browser_steps: { type: "boolean" },
      },
      required: ["project"],
    },
  },
  mem_site_golden_check_report: {
    description: "Persist the actual golden-check result and optionally create quality findings for failed checks.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        agent_name: { type: "string" },
        status: { type: "string" },
        command: { type: "string" },
        summary: { type: "string" },
        evidence: { type: "object" },
        findings: { type: "array" },
        create_findings: { type: "boolean" },
      },
      required: ["project", "status"],
    },
  },
  mem_site_golden_check_history: {
    description: "List recent golden-check runs for one project or all projects.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        limit: { type: "integer" },
      },
    },
  },
};

function ensureTeamQualityTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS correction_pattern (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  classifier TEXT NOT NULL,
  actor_scope TEXT,
  trait_to_adjust TEXT,
  delta REAL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);
CREATE TABLE IF NOT EXISTS scar_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scar_slug TEXT NOT NULL,
  triggering_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  pattern_id INTEGER REFERENCES correction_pattern(id) ON DELETE SET NULL,
  trait_delta_applied REAL NOT NULL DEFAULT 0,
  notes TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scar_event_pattern ON scar_event(pattern_id);
CREATE INDEX IF NOT EXISTS idx_scar_event_occurred ON scar_event(occurred_at);
CREATE TABLE IF NOT EXISTS scar_high_water (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_training_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  project TEXT,
  rule_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_kind TEXT,
  source_id TEXT,
  severity TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_training_agent_status ON agent_training_rule(agent_name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_scope_status ON agent_training_rule(scope, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_project_status ON agent_training_rule(project, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS site_contract (
  project TEXT PRIMARY KEY,
  canonical_url TEXT,
  target_urls TEXT,
  paths TEXT,
  forbidden_hosts TEXT,
  required_locales TEXT,
  header_rules TEXT,
  menu_rules TEXT,
  footer_rules TEXT,
  logo_rules TEXT,
  auth_rules TEXT,
  pricing_rules TEXT,
  checkout_rules TEXT,
  mobile_viewports TEXT,
  desktop_viewports TEXT,
  required_checks TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS golden_check_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  agent_name TEXT,
  status TEXT NOT NULL,
  command TEXT,
  summary TEXT,
  evidence_json TEXT,
  findings_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_golden_project_time ON golden_check_run(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_golden_status ON golden_check_run(status, created_at DESC);
`);
}

function handleTeamQualityTool(db, name, args) {
  if (!TEAM_QUALITY_TOOL_DEFS[name]) return { handled: false };
  const a = args || {};
  ensureTeamQualityTables(db);
  switch (name) {
    case "mem_agent_scorecard":
      return { handled: true, result: agentScorecard(db, a) };
    case "mem_agent_scoreboard":
      return { handled: true, result: agentScoreboard(db, a) };
    case "mem_agent_training_rule_upsert":
      return { handled: true, result: trainingRuleUpsert(db, a) };
    case "mem_agent_training_rules":
      return { handled: true, result: trainingRules(db, a) };
    case "mem_correction_capture":
      return { handled: true, result: correctionCapture(db, a) };
    case "mem_site_contract_set":
      return { handled: true, result: siteContractSet(db, a) };
    case "mem_site_contract_get":
      return { handled: true, result: siteContractGet(db, a) };
    case "mem_site_contract_list":
      return { handled: true, result: siteContractList(db, a) };
    case "mem_site_golden_check_plan":
      return { handled: true, result: siteGoldenCheckPlan(db, a) };
    case "mem_site_golden_check_report":
      return { handled: true, result: siteGoldenCheckReport(db, a) };
    case "mem_site_golden_check_history":
      return { handled: true, result: siteGoldenCheckHistory(db, a) };
    default:
      return { handled: false };
  }
}

function agentScorecard(db, a) {
  const days = clampInt(a.days, 14, 1, 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const agents = collectAgents(db, a.agent_name, since);
  const cards = agents.map((agent) => buildAgentCard(db, agent, since, days));
  cards.sort((x, y) => x.score - y.score || y.findings.open_high - x.findings.open_high || x.agent_name.localeCompare(y.agent_name));
  const result = {
    since,
    days,
    count: cards.length,
    agents: cards,
    summary: {
      average_score: cards.length ? Math.round(cards.reduce((n, c) => n + c.score, 0) / cards.length) : null,
      needs_training: cards.filter((c) => c.needs_training).length,
      blocked: cards.filter((c) => c.status === "block").length,
      attention: cards.filter((c) => c.status === "attention").length,
    },
  };
  if (a.agent_name) result.card = cards[0] || null;
  if (a.include_doc) result.doc = formatScoreboard(result, clampInt(a.limit, 50, 1, 200));
  return result;
}

function agentScoreboard(db, a) {
  const board = agentScorecard(db, { days: a.days, include_doc: true, limit: a.limit });
  return board;
}

function buildAgentCard(db, agent, since, days) {
  const actions = safeGet(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN lower(status) IN ('done','ok','pass','ready','approved','reviewed','complete','completed','resolved') THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN lower(status) IN ('error','failed','fail') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN lower(status) IN ('block','blocked') THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN (lower(action_kind) LIKE '%guard%' OR lower(topic) LIKE '%guard%' OR lower(action_kind) IN ('pre_action_check','agent_preflight')) THEN 1 ELSE 0 END) AS guard_total,
      SUM(CASE WHEN (lower(action_kind) LIKE '%guard%' OR lower(topic) LIKE '%guard%' OR lower(action_kind) IN ('pre_action_check','agent_preflight')) AND lower(status) IN ('block','blocked','missing','error','failed','fail') THEN 1 ELSE 0 END) AS guard_blocked,
      SUM(CASE WHEN lower(status) IN ('pending','started','open') AND julianday(started_at) < julianday('now','-6 hours') THEN 1 ELSE 0 END) AS stale
    FROM agent_action
    WHERE agent_name=? AND started_at>=?
  `, [agent, since], zeroActionStats());

  const briefs = safeGet(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN lower(status)='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN lower(status)='dispatched' THEN 1 ELSE 0 END) AS dispatched,
      SUM(CASE WHEN lower(status) IN ('done','complete','completed','resolved') THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN lower(status) IN ('failed','error','blocked') THEN 1 ELSE 0 END) AS failed
    FROM agent_brief
    WHERE agent_name=? AND created_at>=?
  `, [agent, since], zeroBriefStats());

  const findings = safeGet(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status='open' AND severity IN ('H','critical') THEN 1 ELSE 0 END) AS open_high,
      SUM(CASE WHEN status<>'open' THEN 1 ELSE 0 END) AS closed
    FROM quality_finding
    WHERE source_agent=? AND created_at>=?
  `, [agent, since], zeroFindingStats());

  const tasks = safeGet(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN lower(status) IN ('done','reviewed','approved','resolved') THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN lower(status) IN ('open','claimed','review') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN lower(status) IN ('block','blocked') THEN 1 ELSE 0 END) AS blocked
    FROM autonomy_task
    WHERE (assigned_agent=? OR reviewer_agent=?) AND created_at>=?
  `, [agent, agent, since], zeroTaskStats());

  const training = safeAll(db, `
    SELECT id, agent_name, scope, project, rule_kind, title, severity, updated_at
    FROM agent_training_rule
    WHERE status='active'
      AND (agent_name IS NULL OR agent_name=? OR scope='global')
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, updated_at DESC
    LIMIT 8
  `, [agent]);

  let score = 100;
  score -= num(actions.failed) * 4;
  score -= num(actions.blocked) * 5;
  score -= num(actions.guard_blocked) * 8;
  score -= num(actions.stale) * 3;
  score -= num(briefs.failed) * 4;
  score -= Math.max(0, num(briefs.pending) + num(briefs.dispatched) - 5) * 2;
  score -= num(findings.open_high) * 12;
  score -= Math.max(0, num(findings.open) - num(findings.open_high)) * 4;
  score -= num(tasks.blocked) * 5;
  score += Math.min(num(actions.done), 20) * 0.4;
  score += Math.min(num(tasks.done), 10) * 0.5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const trainingBrief = [];
  if (!num(actions.total)) trainingBrief.push("No recent action trail: verify the loop is online and logging work.");
  if (num(actions.guard_blocked)) trainingBrief.push("Guard misses detected: reload session/project context and pass pre-work before execution.");
  if (num(findings.open_high)) trainingBrief.push("High open findings from this agent: fix or hand off before new live work.");
  if (num(briefs.pending) + num(briefs.dispatched) > 5) trainingBrief.push("Brief backlog is growing: pull, process, or explicitly reassign.");
  if (num(actions.failed) || num(briefs.failed) || num(tasks.blocked)) trainingBrief.push("Failures/blockers must become durable rules or findings, not chat-only notes.");
  if (!trainingBrief.length && training.length) trainingBrief.push("Active training rules exist: review them at session start.");

  const status = score < 70 || num(findings.open_high) || num(actions.guard_blocked) ? "block" : (score < 85 || trainingBrief.length ? "attention" : "ok");
  return {
    agent_name: agent,
    status,
    score,
    window_days: days,
    actions: normalizeStats(actions),
    briefs: normalizeStats(briefs),
    findings: normalizeStats(findings),
    autonomy_tasks: normalizeStats(tasks),
    training_rules: training,
    needs_training: status !== "ok",
    training_brief: trainingBrief,
  };
}

function trainingRuleUpsert(db, a) {
  const title = cleanText(a.title, 160);
  const body = String(a.body || "").trim();
  if (!title || !body) return { error: "title and body required" };
  const ruleKind = cleanText(a.rule_kind || "training", 60) || "training";
  const scope = cleanText(a.scope || "global", 80) || "global";
  const severity = validSeverity(a.severity || "M");
  const status = cleanText(a.status || TRAINING_STATUS_ACTIVE, 30) || TRAINING_STATUS_ACTIVE;
  if (a.id) {
    const info = db.prepare(`
      UPDATE agent_training_rule
      SET agent_name=?, scope=?, project=?, rule_kind=?, title=?, body=?, source_kind=?, source_id=?, severity=?, status=?, created_by=COALESCE(created_by, ?), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(a.agent_name || null, scope, a.project || null, ruleKind, title, body, a.source_kind || null, a.source_id || null, severity, status, a.created_by || null, a.id);
    return { ok: info.changes > 0, id: a.id, action: "updated", status };
  }
  const existing = db.prepare(`
    SELECT id FROM agent_training_rule
    WHERE title=? AND scope=? AND COALESCE(agent_name,'')=COALESCE(?, '') AND COALESCE(project,'')=COALESCE(?, '') AND status='active'
    ORDER BY id DESC LIMIT 1
  `).get(title, scope, a.agent_name || null, a.project || null);
  if (existing) {
    db.prepare(`
      UPDATE agent_training_rule
      SET body=?, rule_kind=?, source_kind=?, source_id=?, severity=?, created_by=COALESCE(created_by, ?), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(body, ruleKind, a.source_kind || null, a.source_id || null, severity, a.created_by || null, existing.id);
    return { ok: true, id: existing.id, action: "refreshed", status: "active" };
  }
  const info = db.prepare(`
    INSERT INTO agent_training_rule (agent_name, scope, project, rule_kind, title, body, source_kind, source_id, severity, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(a.agent_name || null, scope, a.project || null, ruleKind, title, body, a.source_kind || null, a.source_id || null, severity, status, a.created_by || null);
  logAction(db, a.created_by || a.agent_name || "training-rule", "agent_training_rule_upsert", a.agent_name || scope, "done", { id: info.lastInsertRowid, title, severity }, "training");
  return { ok: true, id: info.lastInsertRowid, action: "created", status };
}

function trainingRules(db, a) {
  const where = ["status=?"];
  const params = [a.status || TRAINING_STATUS_ACTIVE];
  if (a.agent_name) {
    where.push("(agent_name IS NULL OR agent_name=? OR scope='global')");
    params.push(a.agent_name);
  }
  if (a.project) {
    where.push("(project IS NULL OR project=?)");
    params.push(a.project);
  }
  if (a.scope) {
    where.push("(scope=? OR scope='global')");
    params.push(a.scope);
  }
  params.push(clampInt(a.limit, 100, 1, 500));
  const rows = db.prepare(`
    SELECT * FROM agent_training_rule
    WHERE ${where.join(" AND ")}
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, updated_at DESC
    LIMIT ?
  `).all(...params);
  return { count: rows.length, rules: rows };
}

function correctionCapture(db, a) {
  const text = String(a.text || "").trim();
  if (!text) return { error: "text required" };
  const agentName = a.agent_name || null;
  const project = a.project || null;
  const title = cleanText(a.title || firstSentence(text), 160) || "Correction captured";
  const severity = validSeverity(a.severity || "H");
  const category = cleanText(a.category || "correction", 80) || "correction";
  const slug = slugify([project, agentName, title].filter(Boolean).join("-")) || "correction";
  const created = { scar_event_id: null, training_rule: null, quality_finding: null };

  const scarInfo = db.prepare("INSERT INTO scar_event (scar_slug, trait_delta_applied, notes) VALUES (?,?,?)")
    .run(slug, 0, text);
  created.scar_event_id = scarInfo.lastInsertRowid;

  if (a.make_rule !== false) {
    created.training_rule = trainingRuleUpsert(db, {
      agent_name: agentName,
      project,
      scope: project ? "project" : "global",
      rule_kind: "correction",
      title,
      body: text,
      source_kind: a.source_kind || "correction_capture",
      source_id: a.source_id || String(scarInfo.lastInsertRowid),
      severity,
      created_by: a.created_by || "owner-feedback",
    });
  }

  if (a.create_finding && project) {
    const info = db.prepare("INSERT INTO quality_finding (project, category, severity, title, url, expected, actual, source_agent, evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(project, category, severity, title, a.finding_url || null, "The team must not repeat this correction.", text, agentName || a.created_by || null, JSON.stringify({ source: "mem_correction_capture", scar_event_id: scarInfo.lastInsertRowid }));
    created.quality_finding = { id: info.lastInsertRowid, project, status: "open", severity };
  }

  logAction(db, a.created_by || "owner-feedback", "correction_capture", project || agentName || "global", "done", { title, agent_name: agentName, project, scar_event_id: scarInfo.lastInsertRowid }, "training");
  return {
    ok: true,
    title,
    severity,
    agent_name: agentName,
    project,
    ...created,
  };
}

function siteContractSet(db, a) {
  const project = cleanText(a.project, 160);
  if (!project) return { error: "project required" };
  const fields = ["project"];
  const placeholders = ["?"];
  const values = [project];
  const updates = [];
  for (const key of ["canonical_url", "notes", "updated_by"]) {
    if (a[key] !== undefined) {
      fields.push(key);
      placeholders.push("?");
      values.push(a[key] || null);
      updates.push(key + "=excluded." + key);
    }
  }
  for (const key of SITE_JSON_FIELDS) {
    if (a[key] !== undefined) {
      fields.push(key);
      placeholders.push("?");
      values.push(JSON.stringify(a[key]));
      updates.push(key + "=excluded." + key);
    }
  }
  if (!updates.length) updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  else updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const sql = `INSERT INTO site_contract (${fields.join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT(project) DO UPDATE SET ${updates.join(", ")}`;
  db.prepare(sql).run(...values);
  logAction(db, a.updated_by || "site-contract", "site_contract_set", project, "done", { keys: Object.keys(a).filter((k) => k !== "project") }, "site_contract");
  return { ok: true, project };
}

function siteContractGet(db, a) {
  const project = cleanText(a.project, 160);
  if (!project) return { error: "project required" };
  const row = safeGet(db, "SELECT * FROM site_contract WHERE project=?", [project], null);
  const registry = safeGet(db, "SELECT name, domain, live_url, staging_url, health_checklist FROM project_registry WHERE name=?", [project], null);
  const rules = safeGet(db, "SELECT canonical_nav, allowed_domains, language_matrix, design_rules, pricing_rules, checkout_rules FROM project_rules WHERE project=?", [project], null);
  const contract = row ? parseSiteContract(row) : defaultContract(project, registry, rules);
  if (rules) {
    contract.project_rules_hint = {
      canonical_nav: json(rules.canonical_nav, null),
      allowed_domains: json(rules.allowed_domains, null),
      language_matrix: json(rules.language_matrix, null),
      design_rules: json(rules.design_rules, null),
      pricing_rules: json(rules.pricing_rules, null),
      checkout_rules: json(rules.checkout_rules, null),
    };
  }
  if (registry) contract.registry_hint = registry;
  contract.audit_command = buildAuditCommand(contract);
  contract.required_evidence = requiredSiteEvidence(contract);
  return contract;
}

function siteContractList(db, a) {
  const rows = db.prepare("SELECT project, canonical_url, updated_at, updated_by, notes FROM site_contract ORDER BY updated_at DESC LIMIT ?")
    .all(clampInt(a.limit, 100, 1, 500));
  return { count: rows.length, contracts: rows };
}

function siteGoldenCheckPlan(db, a) {
  const contract = siteContractGet(db, { project: a.project });
  if (contract.error) return contract;
  const checks = requiredSiteEvidence(contract);
  const command = buildAuditCommand(contract);
  const browserSteps = a.include_browser_steps === false ? [] : [
    "Open canonical source and each target URL at desktop viewport.",
    "Open canonical source and each target URL at mobile viewport.",
    "Compare header style, menu order, href targets, footer/legal links, and logo assets.",
    "Confirm same-label menu items point to the target domain and expected target path, not the copied canonical domain.",
    "Check each required locale route keeps the same language and does not fall back to the wrong locale.",
    "Check legal footer links preserve the active locale on localized pages.",
    "Check light and dark theme logos when the product supports themes.",
    "Confirm mobile viewport meta exists and mobile header/menu is usable.",
    "Record screenshots or explicit browser observations before reporting pass.",
  ];
  const plan = {
    project: contract.project,
    change_summary: a.change_summary || null,
    status: command ? "ready" : "blocked",
    blockers: command ? [] : ["site contract needs canonical_url and at least one target_url"],
    contract,
    command,
    checks,
    browser_steps: browserSteps,
    pass_condition: "No high findings, no forbidden domain leaks, required locales checked, mobile+desktop checked, relevant logos/themes checked, and findings reported with mem_site_golden_check_report.",
  };
  logAction(db, a.agent_name || "site-golden-plan", "site_golden_check_plan", contract.project, plan.status, { command, checks }, "site_contract");
  return plan;
}

function siteGoldenCheckReport(db, a) {
  const status = cleanText(a.status, 40) || "unknown";
  const project = cleanText(a.project, 160);
  if (!project) return { error: "project required" };
  const findings = Array.isArray(a.findings) ? a.findings : [];
  const info = db.prepare("INSERT INTO golden_check_run (project, agent_name, status, command, summary, evidence_json, findings_json) VALUES (?,?,?,?,?,?,?)")
    .run(project, a.agent_name || null, status, a.command || null, a.summary || null, a.evidence ? JSON.stringify(a.evidence) : null, JSON.stringify(findings));
  const created = [];
  if (a.create_findings !== false) {
    for (const group of groupGoldenFindings(findings, status)) {
      const existing = db.prepare("SELECT id FROM quality_finding WHERE project=? AND title=? AND status='open' ORDER BY id DESC LIMIT 1")
        .get(project, group.title);
      const evidence = { source: "golden_check_run", run_id: info.lastInsertRowid, count: group.count, examples: group.examples, urls: group.urls };
      const actual = `${group.count} ${group.type} finding(s). Examples: ${group.examples.map((x) => x.summary).join(" | ")}`;
      if (existing) {
        db.prepare("UPDATE quality_finding SET severity=?, url=?, expected=?, actual=?, source_agent=?, evidence_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(group.severity, group.urls[0] || null, group.expected, actual, a.agent_name || null, JSON.stringify(evidence), existing.id);
        created.push({ id: existing.id, title: group.title, severity: group.severity, action: "updated", count: group.count });
      } else {
        const q = db.prepare("INSERT INTO quality_finding (project, category, severity, title, url, expected, actual, source_agent, evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(project, group.category, group.severity, group.title, group.urls[0] || null, group.expected, actual, a.agent_name || null, JSON.stringify(evidence));
        created.push({ id: q.lastInsertRowid, title: group.title, severity: group.severity, action: "created", count: group.count });
      }
    }
  }
  logAction(db, a.agent_name || "golden-check", "site_golden_check_report", project, status, { run_id: info.lastInsertRowid, findings: findings.length, created_findings: created.length }, "site_contract");
  return { ok: true, id: info.lastInsertRowid, project, status, created_findings: created };
}

function siteGoldenCheckHistory(db, a) {
  const where = [];
  const params = [];
  if (a.project) {
    where.push("project=?");
    params.push(a.project);
  }
  params.push(clampInt(a.limit, 50, 1, 500));
  const rows = db.prepare(`
    SELECT id, project, agent_name, status, command, summary, created_at
    FROM golden_check_run
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);
  return { count: rows.length, runs: rows };
}

function groupGoldenFindings(findings, status) {
  const groups = new Map();
  for (const f of findings || []) {
    if (!f || (!f.type && !f.title)) continue;
    const type = cleanText(f.type || f.title || "golden_check_finding", 120);
    const key = type;
    const sev = validSeverity(f.severity || (status === "fail" ? "H" : "M"));
    const current = groups.get(key) || {
      type,
      title: "Golden audit: " + type,
      category: f.category || type || "site_contract",
      severity: sev,
      expected: f.expected || "Site contract passes for every checked path, locale, link, logo and viewport.",
      count: 0,
      urls: [],
      examples: [],
    };
    current.severity = higherSeverity(current.severity, sev);
    current.count += 1;
    const url = f.url || f.href || null;
    if (url && !current.urls.includes(url)) current.urls.push(url);
    if (current.examples.length < 8) {
      current.examples.push({
        url,
        label: f.label || f.text || null,
        href: f.href || null,
        status: f.status || null,
        summary: summarizeGoldenFinding(f),
      });
    }
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count);
}

function summarizeGoldenFinding(f) {
  const parts = [];
  if (f.type || f.title) parts.push(String(f.type || f.title));
  if (f.label || f.text) parts.push("label=" + String(f.label || f.text).slice(0, 80));
  if (f.href) parts.push("href=" + String(f.href).slice(0, 120));
  if (f.url) parts.push("url=" + String(f.url).slice(0, 120));
  if (f.status) parts.push("status=" + String(f.status));
  return parts.join(" ");
}

function higherSeverity(a, b) {
  return severityRank(b) < severityRank(a) ? b : a;
}

function severityRank(value) {
  if (value === "critical") return 0;
  if (value === "H") return 1;
  if (value === "M") return 2;
  return 3;
}

function defaultContract(project, registry, rules) {
  const liveUrl = registry && (registry.live_url || registry.staging_url) || null;
  const lang = rules ? json(rules.language_matrix, {}) || {} : {};
  const locales = Array.isArray(lang.required_locales) ? lang.required_locales : (Array.isArray(lang.locales) ? lang.locales : []);
  const paths = locales.length ? unique(["/"].concat(locales.map((l) => "/" + String(l).replace(/^\/+/, "")))) : ["/"];
  return {
    project,
    canonical_url: liveUrl,
    target_urls: liveUrl ? [liveUrl] : [],
    paths,
    forbidden_hosts: [],
    required_locales: locales,
    header_rules: {},
    menu_rules: rules ? { canonical_nav: json(rules.canonical_nav, null) } : {},
    footer_rules: {},
    logo_rules: {},
    auth_rules: {},
    pricing_rules: rules ? json(rules.pricing_rules, {}) || {} : {},
    checkout_rules: rules ? json(rules.checkout_rules, {}) || {} : {},
    mobile_viewports: ["390x844"],
    desktop_viewports: ["1440x900"],
    required_checks: defaultRequiredChecks(),
    notes: "Generated fallback. Store a real contract with mem_site_contract_set.",
    updated_at: null,
    updated_by: null,
    _generated: true,
  };
}

function parseSiteContract(row) {
  const out = Object.assign({}, row);
  for (const key of SITE_JSON_FIELDS) out[key] = json(out[key], defaultForSiteField(key));
  if (!Array.isArray(out.paths) || !out.paths.length) out.paths = ["/"];
  if (!Array.isArray(out.mobile_viewports) || !out.mobile_viewports.length) out.mobile_viewports = ["390x844"];
  if (!Array.isArray(out.desktop_viewports) || !out.desktop_viewports.length) out.desktop_viewports = ["1440x900"];
  if (!Array.isArray(out.required_checks) || !out.required_checks.length) out.required_checks = defaultRequiredChecks();
  return out;
}

function defaultForSiteField(key) {
  if (["target_urls", "paths", "forbidden_hosts", "required_locales", "mobile_viewports", "desktop_viewports", "required_checks"].includes(key)) return [];
  return {};
}

function defaultRequiredChecks() {
  return ["header_style", "menu_structure", "menu_href_targets", "footer_legal_links", "forbidden_domain_leaks", "locale_routes", "legal_locale_links", "light_dark_logos", "viewport_meta", "mobile", "desktop"];
}

function requiredSiteEvidence(contract) {
  const required = Array.isArray(contract.required_checks) && contract.required_checks.length ? contract.required_checks : defaultRequiredChecks();
  return {
    required_checks: required,
    paths: contract.paths || ["/"],
    locales: contract.required_locales || [],
    mobile_viewports: contract.mobile_viewports || ["390x844"],
    desktop_viewports: contract.desktop_viewports || ["1440x900"],
    must_record: [
      "audit command output",
      "browser/screenshot evidence when style or layout changed",
      "same-label menu hrefs checked for target-domain and expected path",
      "links checked for target-domain preservation",
      "localized legal links checked for locale preservation",
      "logo and dark-logo assets checked when applicable",
      "open findings created for every failed check",
    ],
  };
}

function buildAuditCommand(contract) {
  if (!contract || !contract.canonical_url || !Array.isArray(contract.target_urls) || !contract.target_urls.length) return "";
  const args = [
    "node packages/core/bin/site-contract-audit.js",
    "--canonical " + shellQuote(contract.canonical_url),
    "--targets " + shellQuote(contract.target_urls.join(",")),
    "--paths " + shellQuote((contract.paths && contract.paths.length ? contract.paths : ["/"]).join(",")),
  ];
  if (Array.isArray(contract.forbidden_hosts) && contract.forbidden_hosts.length) {
    args.push("--forbidden-hosts " + shellQuote(contract.forbidden_hosts.join(",")));
  }
  const allowed = allowedHostsFromContract(contract);
  if (allowed.length) args.push("--allowed-hosts " + shellQuote(allowed.join(",")));
  const logo = contract.logo_rules || {};
  if (logo.require_dark_logo || logo.dark_logo_required || logo.dark_mode === true) args.push("--require-dark-logo");
  args.push("--report");
  args.push("--project " + shellQuote(contract.project));
  return args.join(" ");
}

function allowedHostsFromContract(contract) {
  const set = new Set();
  const hint = contract && contract.project_rules_hint;
  const allowed = hint && Array.isArray(hint.allowed_domains) ? hint.allowed_domains : [];
  for (const item of allowed) {
    const raw = String(item || "").trim();
    if (!raw) continue;
    try { set.add(new URL(raw.includes("://") ? raw : "https://" + raw).host); }
    catch { set.add(raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "")); }
  }
  return Array.from(set).filter(Boolean);
}

function collectAgents(db, agentName, since) {
  if (agentName) return [agentName];
  const set = new Set();
  for (const row of safeAll(db, "SELECT agent_name FROM agent_registry WHERE agent_name IS NOT NULL", [])) set.add(row.agent_name);
  for (const row of safeAll(db, "SELECT DISTINCT agent_name FROM agent_action WHERE agent_name IS NOT NULL AND started_at>=?", [since])) set.add(row.agent_name);
  for (const row of safeAll(db, "SELECT DISTINCT agent_name FROM agent_brief WHERE agent_name IS NOT NULL AND created_at>=?", [since])) set.add(row.agent_name);
  for (const row of safeAll(db, "SELECT DISTINCT source_agent AS agent_name FROM agent_brief WHERE source_agent IS NOT NULL AND created_at>=?", [since])) set.add(row.agent_name);
  for (const row of safeAll(db, "SELECT DISTINCT assigned_agent AS agent_name FROM autonomy_task WHERE assigned_agent IS NOT NULL AND created_at>=?", [since])) set.add(row.agent_name);
  for (const row of safeAll(db, "SELECT DISTINCT source_agent AS agent_name FROM quality_finding WHERE source_agent IS NOT NULL AND created_at>=?", [since])) set.add(row.agent_name);
  return Array.from(set).filter(Boolean).sort();
}

function formatScoreboard(board, limit) {
  const lines = ["# Agent Scoreboard", "", `Window: ${board.days} days | agents: ${board.count} | needs training: ${board.summary.needs_training}`, ""];
  for (const c of board.agents.slice(0, limit)) {
    lines.push(`## ${c.agent_name}`);
    lines.push(`- Status: ${c.status} | score: ${c.score}`);
    lines.push(`- Actions: ${c.actions.done}/${c.actions.total} done, ${c.actions.failed} failed, ${c.actions.guard_blocked} guard blocks`);
    lines.push(`- Briefs: ${c.briefs.pending} pending, ${c.briefs.dispatched} dispatched, ${c.briefs.failed} failed`);
    lines.push(`- Findings: ${c.findings.open} open (${c.findings.open_high} high/critical)`);
    if (c.training_brief.length) lines.push(`- Training: ${c.training_brief.join(" ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function logAction(db, agentName, kind, target, status, payload, topic) {
  try {
    db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?,?,?,?,?,?)")
      .run(agentName || "unknown", kind, target || null, status || "done", payload ? JSON.stringify(payload) : null, topic || null);
  } catch {}
}

function safeGet(db, sql, params, fallback) {
  try { return db.prepare(sql).get(...(params || [])) || fallback; } catch { return fallback; }
}

function safeAll(db, sql, params) {
  try { return db.prepare(sql).all(...(params || [])); } catch { return []; }
}

function json(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback === undefined ? value : fallback; }
}

function cleanText(value, max) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.slice(0, max || 1000);
}

function firstSentence(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.{1,140}?)(?:[.!?]\s|$)/);
  return m ? m[1] : clean.slice(0, 140);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function validSeverity(value) {
  return ["L", "M", "H", "critical"].includes(value) ? value : "M";
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function num(value) {
  return Number(value || 0);
}

function normalizeStats(stats) {
  const out = {};
  for (const [k, v] of Object.entries(stats || {})) out[k] = num(v);
  return out;
}

function zeroActionStats() {
  return { total: 0, done: 0, failed: 0, blocked: 0, guard_total: 0, guard_blocked: 0, stale: 0 };
}

function zeroBriefStats() {
  return { total: 0, pending: 0, dispatched: 0, done: 0, failed: 0 };
}

function zeroFindingStats() {
  return { total: 0, open: 0, open_high: 0, closed: 0 };
}

function zeroTaskStats() {
  return { total: 0, done: 0, open: 0, blocked: 0 };
}

function unique(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function shellQuote(value) {
  const s = String(value || "");
  if (/^[A-Za-z0-9_./:,@%+=-]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

module.exports = {
  TEAM_QUALITY_TOOL_DEFS,
  SITE_JSON_FIELDS,
  ensureTeamQualityTables,
  handleTeamQualityTool,
  buildAuditCommand,
};
