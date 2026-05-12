"use strict";

const CONTEXT_PREVIEW_TOOL_DEFS = {
  mem_context_preview: {
    description: "Build a token-budgeted preview of the Mnemo context an agent should load before work: rules, contracts, findings, claims, handoffs, memories, and exact follow-up tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        token_budget: { type: "integer", default: 1800 },
        max_items: { type: "integer", default: 8 },
      },
    },
  },
};

function handleContextPreviewTool(db, name, args) {
  if (!CONTEXT_PREVIEW_TOOL_DEFS[name]) return { handled: false };
  return { handled: true, result: contextPreview(db, args || {}) };
}

function contextPreview(db, args) {
  const agentName = clean(args.agent_name, 80).toLowerCase();
  const project = clean(args.project, 140);
  const task = clean(args.task || args.summary || args.query, 800);
  const files = cleanArray(args.files || args.file_paths, 25, 300);
  const explicitTopics = cleanArray(args.topics, 20, 120);
  const tokenBudget = clampInt(args.token_budget, 1800, 300, 20000);
  const maxItems = clampInt(args.max_items, 8, 3, 30);
  const inferredTopics = inferTopics([project, task, ...explicitTopics, ...files].join(" "));
  const isWebsiteTask = looksLikeWebsiteTask(task, files);
  const isCodeTask = looksLikeCodeTask(task, files);
  const sections = [];

  addSection(sections, {
    key: "session_brief",
    title: "Session identity and current focus",
    required: true,
    selected: true,
    priority: 10,
    estimated_tokens: 250,
    why: "Keeps identity, owner preferences, current task, and continuity loaded before action.",
    command: toolCall("mem_session_brief", compactArgs({ agent_name: agentName, project, task, token_budget: 250 })),
  });

  const registry = project ? safeGet(db, "SELECT name, domain, live_status, live_url, staging_url, updated_at FROM project_registry WHERE name=?", [project]) : null;
  addSection(sections, {
    key: "project_registry",
    title: "Project registry",
    selected: !!registry,
    priority: 20,
    estimated_tokens: registry ? estimateRowTokens(registry, 220) : 0,
    count: registry ? 1 : 0,
    why: registry ? "Canonical project coordinates, live/staging URLs, status, and deploy hints exist." : "No registry row found for this project.",
    command: project ? toolCall("mem_project_registry_get", { name: project }) : null,
    preview: registry ? [redactRow(registry)] : [],
  });

  const rules = project ? safeGet(db, "SELECT project, updated_at, required_gates, canonical_nav, design_rules, deploy_rules, notes FROM project_rules WHERE project=?", [project]) : null;
  addSection(sections, {
    key: "project_rules",
    title: "Project rules",
    required: !!rules,
    selected: !!rules,
    priority: 25,
    estimated_tokens: rules ? estimateRowTokens(rules, 420) : 0,
    count: rules ? 1 : 0,
    why: rules ? "Project-specific gates, navigation, design, deploy, and owner rules must constrain the work." : "No project rules row found.",
    command: project ? toolCall("mem_project_rules_get", { project }) : null,
    preview: rules ? [redactRow(rules)] : [],
  });

  const siteContract = project ? safeGet(db, "SELECT project, canonical_url, target_urls, paths, forbidden_hosts, required_locales, header_rules, menu_rules, footer_rules, logo_rules, auth_rules, pricing_rules, checkout_rules, required_checks, updated_at FROM site_contract WHERE project=?", [project]) : null;
  addSection(sections, {
    key: "site_contract",
    title: "Website contract",
    required: !!siteContract && isWebsiteTask,
    selected: !!siteContract && (isWebsiteTask || project),
    priority: 30,
    estimated_tokens: siteContract ? estimateRowTokens(siteContract, 520) : 0,
    count: siteContract ? 1 : 0,
    why: siteContract ? "Canonical website source, target URLs, forbidden hosts, locales, header/menu/footer/logo/auth/pricing/checkout rules." : "No website contract stored for this project.",
    command: project ? toolCall("mem_site_contract_get", { project }) : null,
    preview: siteContract ? [contractPreview(siteContract)] : [],
  });

  const training = selectTrainingRules(db, agentName, project, maxItems);
  addSection(sections, {
    key: "training_rules",
    title: "Active training rules",
    required: training.length > 0,
    selected: training.length > 0,
    priority: 35,
    estimated_tokens: estimateRowsTokens(training, 480),
    count: training.length,
    why: training.length ? "Owner/reviewer corrections that must prevent repeated mistakes." : "No active training rules found for this agent/project.",
    command: toolCall("mem_agent_training_rules", compactArgs({ agent_name: agentName, project, limit: maxItems })),
    preview: training.map(redactRow),
  });

  const openFindings = selectOpenFindings(db, project, maxItems);
  addSection(sections, {
    key: "open_findings",
    title: "Open quality findings",
    selected: openFindings.length > 0,
    priority: 45,
    estimated_tokens: estimateRowsTokens(openFindings, 420),
    count: openFindings.length,
    why: openFindings.length ? "Known defects and regressions must be considered before new work." : "No open findings found for this project.",
    command: toolCall("mem_quality_finding_list", compactArgs({ project, status: "open", limit: maxItems })),
    preview: openFindings.map(redactRow),
  });

  const claims = selectActiveClaims(db, project, maxItems);
  addSection(sections, {
    key: "active_claims",
    title: "Active work claims",
    selected: claims.length > 0,
    priority: 50,
    estimated_tokens: estimateRowsTokens(claims, 300),
    count: claims.length,
    why: claims.length ? "Avoids overlapping edits and duplicate work." : "No active claims found for this project.",
    command: toolCall("mem_work_active", compactArgs({ project, limit: maxItems })),
    preview: claims.map(redactRow),
  });

  const handoffs = selectRecentHandoffs(db, agentName, project, maxItems);
  addSection(sections, {
    key: "recent_handoffs",
    title: "Recent handoffs",
    selected: handoffs.length > 0,
    priority: 60,
    estimated_tokens: estimateRowsTokens(handoffs, 520),
    count: handoffs.length,
    why: handoffs.length ? "Shows what was changed, tested, deployed, blocked, and left open across sessions." : "No recent handoffs found.",
    command: toolCall("mem_recall_ids", { query: recallQuery(project, `session handoff ${agentName}`, inferredTopics), limit: Math.min(maxItems, 5) }),
    preview: handoffs.map(redactRow),
  });

  const decisions = selectDecisions(db, project, task, maxItems);
  addSection(sections, {
    key: "decisions",
    title: "Active decisions",
    selected: decisions.length > 0,
    priority: 65,
    estimated_tokens: estimateRowsTokens(decisions, 520),
    count: decisions.length,
    why: decisions.length ? "Existing architectural or product decisions prevent silent drift." : "No matching active decisions found.",
    command: toolCall("mem_decision_get", compactArgs({ scope: project || undefined, status: "active", limit: Math.min(maxItems, 5) })),
    preview: decisions.map(redactRow),
  });

  const briefs = selectPendingBriefs(db, agentName, maxItems);
  addSection(sections, {
    key: "pending_briefs",
    title: "Pending briefs",
    required: briefs.length > 0,
    selected: briefs.length > 0,
    priority: 70,
    estimated_tokens: estimateRowsTokens(briefs, 420),
    count: briefs.length,
    why: briefs.length ? "Direct instructions waiting in the agent inbox." : "No pending brief found for this agent.",
    command: toolCall("mem_brief_list", compactArgs({ agent_name: agentName, status: "pending", limit: maxItems })),
    preview: briefs.map(redactRow),
  });

  const actions = selectRecentActions(db, agentName, project, maxItems);
  addSection(sections, {
    key: "recent_actions",
    title: "Recent actions",
    selected: actions.length > 0,
    priority: 80,
    estimated_tokens: estimateRowsTokens(actions, 380),
    count: actions.length,
    why: actions.length ? "Prevents repeating already-finished work or missing recent failures." : "No recent actions found for this agent/project.",
    command: toolCall("mem_actions_recent", compactArgs({ agent_name: agentName, limit: maxItems })),
    preview: actions.map(redactRow),
  });

  const memories = selectMemoryCandidates(db, project, inferredTopics, task, maxItems);
  addSection(sections, {
    key: "memory_candidates",
    title: "Relevant memory candidates",
    selected: memories.length > 0,
    priority: 90,
    estimated_tokens: estimateRowsTokens(memories, 520),
    count: memories.length,
    why: memories.length ? "Small snippets point to exact memory IDs; fetch full rows only when needed." : "No matching memory snippets found.",
    command: toolCall("mem_recall_ids", compactArgs({ query: recallQuery(project, task, inferredTopics), limit: maxItems })),
    preview: memories.map(redactRow),
  });

  addSection(sections, {
    key: "smart_code_read",
    title: "Smart code read plan",
    required: files.length > 0 && isCodeTask,
    selected: files.length > 0 || isCodeTask,
    priority: 95,
    estimated_tokens: files.length ? 120 + files.length * 90 : 180,
    count: files.length,
    why: files.length ? "Outlines named files before any full read, then unfolds only needed symbols/ranges." : "Use outlines before opening large code files when code changes start.",
    command: files.length
      ? files.slice(0, maxItems).map((filePath) => toolCall("mem_code_outline", { file_path: filePath, query: task || project || "task", max_symbols: 25 }))
      : toolCall("mem_code_outline", { file_path: "<relevant-file>", query: task || project || "task", max_symbols: 25 }),
    preview: files.slice(0, maxItems).map((filePath) => ({ file_path: filePath, next: "mem_code_outline, then mem_code_unfold for the needed symbol/range" })),
  });

  const warnings = applyBudget(sections, tokenBudget);
  const selected = sections.filter((section) => section.selected);
  const estimatedSelectedTokens = selected.reduce((sum, section) => sum + section.estimated_tokens, 0);

  return {
    agent_name: agentName || null,
    project: project || null,
    task: task || null,
    token_budget: tokenBudget,
    estimated_selected_tokens: estimatedSelectedTokens,
    topics: inferredTopics,
    sections: sections.map(publicSection),
    recommended_order: selected.sort((a, b) => a.priority - b.priority).map((section) => section.key),
    fetch_plan: selected.sort((a, b) => a.priority - b.priority).map((section) => ({ key: section.key, command: section.command })).filter((item) => item.command),
    warnings,
    next_step: "Fetch only the selected sections. Use mem_get only for exact IDs, mem_code_unfold only for needed symbols/ranges, then write the pre-work guard before editing.",
  };
}

function addSection(sections, section) {
  sections.push(Object.assign({
    key: "",
    title: "",
    required: false,
    selected: false,
    priority: 100,
    estimated_tokens: 0,
    count: 0,
    why: "",
    command: null,
    preview: [],
  }, section));
}

function applyBudget(sections, tokenBudget) {
  const warnings = [];
  let total = selectedTotal(sections);
  if (total <= tokenBudget) return warnings;
  const droppable = sections
    .filter((section) => section.selected && !section.required)
    .sort((a, b) => b.priority - a.priority);
  for (const section of droppable) {
    if (total <= tokenBudget) break;
    section.selected = false;
    section.deferred_reason = `Deferred to stay inside token_budget=${tokenBudget}. Fetch only if pre-work needs it.`;
    total -= section.estimated_tokens;
  }
  if (total > tokenBudget) {
    warnings.push(`Required context is estimated at ${total} tokens, above token_budget=${tokenBudget}. Keep summaries tight and fetch details only by exact ID.`);
  } else {
    warnings.push(`Some optional context was deferred to stay inside token_budget=${tokenBudget}.`);
  }
  return warnings;
}

function selectedTotal(sections) {
  return sections.filter((section) => section.selected).reduce((sum, section) => sum + section.estimated_tokens, 0);
}

function publicSection(section) {
  return {
    key: section.key,
    title: section.title,
    selected: !!section.selected,
    required: !!section.required,
    estimated_tokens: section.estimated_tokens,
    count: section.count || 0,
    why: section.why,
    deferred_reason: section.deferred_reason || undefined,
    preview: section.preview || [],
  };
}

function selectTrainingRules(db, agentName, project, limit) {
  if (!tableExists(db, "agent_training_rule")) return [];
  return safeAll(db, `
SELECT id, agent_name, scope, project, rule_kind, title, severity, updated_at
FROM agent_training_rule
WHERE status='active'
  AND (?='' OR agent_name IS NULL OR lower(agent_name)=lower(?))
  AND (?='' OR project IS NULL OR project=?)
ORDER BY CASE severity WHEN 'H' THEN 0 WHEN 'M' THEN 1 ELSE 2 END, updated_at DESC
LIMIT ?`, [agentName, agentName, project, project, limit]);
}

function selectOpenFindings(db, project, limit) {
  if (!tableExists(db, "quality_finding")) return [];
  return safeAll(db, `
SELECT id, project, category, severity, title, url, status, updated_at
FROM quality_finding
WHERE COALESCE(status,'open')='open'
  AND (?='' OR project=?)
ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC
LIMIT ?`, [project, project, limit]);
}

function selectActiveClaims(db, project, limit) {
  if (!tableExists(db, "work_claim")) return [];
  return safeAll(db, `
SELECT id, project, file_path, agent_name, summary, expires_at
FROM work_claim
WHERE status='active'
  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (?='' OR project=?)
ORDER BY expires_at ASC
LIMIT ?`, [project, project, limit]);
}

function selectRecentHandoffs(db, agentName, project, limit) {
  if (!tableExists(db, "session_handoff")) return [];
  return safeAll(db, `
SELECT id, agent_name, project, summary, changed_files, tests, deploys, blockers, next_actions, created_at
FROM session_handoff
WHERE (?='' OR lower(agent_name)=lower(?))
  AND (?='' OR project=?)
ORDER BY created_at DESC
LIMIT ?`, [agentName, agentName, project, project, Math.min(limit, 5)]);
}

function selectDecisions(db, project, task, limit) {
  if (!tableExists(db, "decision_log")) return [];
  const terms = [project, ...inferTopics(task)].filter(Boolean).slice(0, 4);
  if (!terms.length) {
    return safeAll(db, `
SELECT id, scope, title, substr(body,1,220) AS body, decided_by, decided_at, status
FROM decision_log
WHERE status='active'
ORDER BY decided_at DESC
LIMIT ?`, [Math.min(limit, 5)]);
  }
  const where = terms.map(() => "(scope LIKE ? OR title LIKE ? OR body LIKE ?)").join(" OR ");
  const params = [];
  for (const term of terms) params.push(like(term), like(term), like(term));
  params.push(Math.min(limit, 5));
  return safeAll(db, `
SELECT id, scope, title, substr(body,1,220) AS body, decided_by, decided_at, status
FROM decision_log
WHERE status='active' AND (${where})
ORDER BY decided_at DESC
LIMIT ?`, params);
}

function selectPendingBriefs(db, agentName, limit) {
  if (!agentName || !tableExists(db, "agent_brief")) return [];
  return safeAll(db, `
SELECT id, agent_name, source_agent, substr(content,1,260) AS preview, created_at
FROM agent_brief
WHERE status='pending'
  AND lower(agent_name)=lower(?)
ORDER BY created_at DESC
LIMIT ?`, [agentName, limit]);
}

function selectRecentActions(db, agentName, project, limit) {
  if (!tableExists(db, "agent_action")) return [];
  return safeAll(db, `
SELECT id, agent_name, action_kind, target, status, topic, started_at
FROM agent_action
WHERE (?='' OR lower(agent_name)=lower(?))
  AND (?='' OR lower(target)=lower(?) OR lower(topic)=lower(?))
ORDER BY started_at DESC
LIMIT ?`, [agentName, agentName, project, project, project, limit]);
}

function selectMemoryCandidates(db, project, topics, task, limit) {
  if (!tableExists(db, "memory")) return [];
  const terms = [project, ...topics, ...inferTopics(task)].filter(Boolean).slice(0, 5);
  if (!terms.length) return [];
  const where = terms.map(() => "(topic LIKE ? OR text LIKE ?)").join(" OR ");
  const params = [];
  for (const term of terms) params.push(like(term), like(term));
  params.push(limit);
  return safeAll(db, `
SELECT id, kind, actor, topic, importance, occurred_at, substr(text,1,260) AS preview
FROM memory
WHERE ${where}
ORDER BY importance DESC, occurred_at DESC
LIMIT ?`, params);
}

function contractPreview(row) {
  const out = redactRow(row);
  for (const key of ["target_urls", "paths", "forbidden_hosts", "required_locales", "required_checks"]) {
    out[key] = safeJsonSummary(row[key], 6);
  }
  for (const key of ["header_rules", "menu_rules", "footer_rules", "logo_rules", "auth_rules", "pricing_rules", "checkout_rules"]) {
    out[key] = safeJsonSummary(row[key], 4);
  }
  return out;
}

function safeJsonSummary(value, maxItems) {
  if (!value) return null;
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.slice(0, maxItems);
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed).slice(0, maxItems);
      const out = {};
      for (const key of keys) out[key] = parsed[key];
      return out;
    }
    return parsed;
  } catch {
    return redact(text, 260);
  }
}

function toolCall(tool, args) {
  return { tool, args: compactArgs(args || {}) };
}

function compactArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function safeGet(db, sql, params) {
  try { return db.prepare(sql).get(...(params || [])) || null; } catch { return null; }
}

function safeAll(db, sql, params) {
  try { return db.prepare(sql).all(...(params || [])); } catch { return []; }
}

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name);
  } catch {
    return false;
  }
}

function clean(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "...";
}

function cleanArray(value, maxItems, maxLen) {
  const items = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,\n]/) : []);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const cleanItem = clean(item, maxLen);
    const key = cleanItem.toLowerCase();
    if (!cleanItem || seen.has(key)) continue;
    seen.add(key);
    out.push(cleanItem);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function inferTopics(text) {
  const normalized = String(text || "").toLowerCase();
  const stop = new Set(["the","and","for","with","that","this","from","eine","einen","einer","oder","aber","auch","alle","alles","muss","soll","sind","ist","nicht","noch","jetzt","dann","bitte","wenn","werden","wurde","wird","das","der","die","den","dem","auf","aus","bei","was","wie","wir","ihr"]);
  const words = normalized.match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const word of words) {
    const compact = word.replace(/^[._-]+|[._-]+$/g, "");
    if (!compact || stop.has(compact) || seen.has(compact)) continue;
    seen.add(compact);
    out.push(compact);
    if (out.length >= 8) break;
  }
  return out;
}

function recallQuery(project, task, topics) {
  const parts = [project, ...topics.slice(0, 5), clean(task, 120)].filter(Boolean);
  return parts.join(" ").slice(0, 500);
}

function looksLikeWebsiteTask(task, files) {
  const haystack = [task, ...(files || [])].join(" ").toLowerCase();
  return /(website|landing|seite|seiten|header|footer|menu|menue|menü|logo|link|impressum|sprache|language|locale|darkmode|pricing|price|checkout|vat|oss|login|auth|mobile|responsive|domain)/i.test(haystack);
}

function looksLikeCodeTask(task, files) {
  const haystack = [task, ...(files || [])].join(" ").toLowerCase();
  return files.length > 0 || /(code|coding|programm|fix|bug|api|endpoint|schema|test|repo|file|datei|function|class|component|css|js|ts|tsx|py|php|html)/i.test(haystack);
}

function like(term) {
  return `%${String(term || "").replace(/[%_]/g, "")}%`;
}

function estimateRowTokens(row, cap) {
  return Math.min(cap, Math.max(80, estimateTokens(JSON.stringify(redactRow(row)))));
}

function estimateRowsTokens(rows, cap) {
  if (!rows || !rows.length) return 0;
  return Math.min(cap, 80 + rows.reduce((sum, row) => sum + estimateTokens(JSON.stringify(redactRow(row))), 0));
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function redactRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    out[key] = typeof value === "string" ? redact(value, 260) : value;
  }
  return out;
}

function redact(value, max) {
  let text = String(value || "");
  text = text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]");
  text = text.replace(/\b(sk|pk|rk|ghp|gho|github_pat)_[A-Za-z0-9_=-]{12,}\b/g, "[secret]");
  text = text.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;}]+/gi, "$1=[secret]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "...";
}

module.exports = {
  CONTEXT_PREVIEW_TOOL_DEFS,
  handleContextPreviewTool,
  contextPreview,
};
