"use strict";

const DEFAULT_SCOPE = "default";
const DEFAULT_TTL_MINUTES = 240;

function cleanScope(scope) {
  return String(scope || DEFAULT_SCOPE).toLowerCase().replace(/[^a-z0-9_-]/g, "") || DEFAULT_SCOPE;
}

function normalizeAgentName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeClaimKind(value) {
  const kind = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return kind || "scope";
}

function normalizeScopeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function claimScopeKey(claimKind, scopeValue) {
  return normalizeClaimKind(claimKind) + ":" + normalizeScopeKey(scopeValue);
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = String(value || "").trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function envOwner(envName, fallback) {
  return normalizeAgentName(process.env[envName] || fallback || "");
}

function defaultProtectedScopeRules() {
  return [
    {
      rule_key: "auth_login",
      label: "Account, auth, login, session",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_AUTH", "alfred"),
      risk_class: "live-risk",
      claim_scope_value: "auth login",
      patterns: [
        "account.blun.ai", "/auth", " auth", "login", "logout", "session", "cookie",
        "jwt", "oauth", "2fa", "mfa", "password reset", "whoami", "signin", "signup",
        "google/callback", "github/callback"
      ],
      required_evidence: ["login smoke test", "whoami/session check", "redirect check"]
    },
    {
      rule_key: "account_settings_popup",
      label: "Global account settings popup and user shell",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_ACCOUNT_UI", "alfred"),
      risk_class: "normal-fix",
      claim_scope_value: "account settings popup",
      patterns: [
        "settings popup", "account popup", "account settings", "global settings",
        "personalization", "theme setting", "language preference", "blun_lang_pref",
        "blun_locale", "sidebar account", "account menu", "mini popup", "user shell"
      ],
      required_evidence: ["desktop popup smoke test", "light/dark setting check", "language setting check"]
    },
    {
      rule_key: "billing_checkout",
      label: "Billing, pricing, Stripe, VAT and checkout",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_BILLING", "alfred"),
      risk_class: "billing-risk",
      claim_scope_value: "billing checkout",
      patterns: [
        "billing", "invoice", "subscription", "stripe", "vatcheck", "vatcheckapi",
        " vat", "checkout", "price", "pricing", "tier", "plan"
      ],
      required_evidence: ["test checkout or mocked billing check", "VAT validation check"]
    },
    {
      rule_key: "production_infra",
      label: "Production infra, nginx, PM2, SSH and deploy",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_INFRA", "dieter"),
      risk_class: "production",
      claim_scope_value: "production infra",
      patterns: [
        "nginx", "vhost", "pm2", "systemctl", "restart", "deploy", "ssh ",
        "server", "65er", "176er", "live system", "production"
      ],
      required_evidence: ["health check", "pm2/nginx status or curl evidence"]
    },
    {
      rule_key: "protected_final_artifacts",
      label: "Locked final pages and no-touch artifacts",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_DESIGN_LOCKS", "angel"),
      risk_class: "live-risk",
      claim_scope_value: "protected final artifacts",
      patterns: [
        "pitch/cold-email-pitch-v14.html", "artifact_lock", "locked final",
        "no-touch", "do not touch", "nicht mehr angefasst"
      ],
      required_evidence: ["explicit owner approval", "artifact lock override reference"]
    },
    {
      rule_key: "portal_design_system",
      label: "Portal dashboard skeleton and shared design system",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_DESIGN", "angel"),
      risk_class: "normal-fix",
      claim_scope_value: "portal design system",
      patterns: [
        "dashboard skeleton", "sidebar width", "sidebar color", "body color",
        "logo size", "shared design", "design system", "glassmorphism", "portal shell"
      ],
      required_evidence: ["desktop screenshot or browser check", "mobile/responsive check when relevant"]
    },
    {
      rule_key: "chat_runtime",
      label: "Chat runtime, chat UI, skills and chat memory layer",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_CHAT", "otto"),
      risk_class: "normal-fix",
      claim_scope_value: "chat runtime",
      patterns: [
        "chat.blun.ai", "/api/chat", "chat runtime", "chat login", "chat session",
        "chat sidebar", "blun-memory", "blun-skills", "skills"
      ],
      required_evidence: ["chat login smoke test", "chat API 200/401 check"]
    },
    {
      rule_key: "portal_translations",
      label: "Portal translations and language content",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_TRANSLATIONS", "frida"),
      risk_class: "normal-fix",
      claim_scope_value: "portal translations",
      patterns: [
        "translation", "translations", "locale messages", "i18n", "language switcher",
        "header footer translation", "unterseiten", "all languages", "107 languages"
      ],
      required_evidence: ["English smoke check", "Swedish smoke check", "missing-key check"]
    },
    {
      rule_key: "coordination_rules",
      label: "Agent coordination, briefs, rules and Mnemo gates",
      owner_agent: envOwner("MNEMO_SCOPE_OWNER_COORDINATION", "alfred"),
      risk_class: "coordination",
      claim_scope_value: "coordination rules",
      patterns: [
        "agent coordination", "brief", "handoff", "work claim", "protected scope",
        "mnemo gate", "mnemo plugin", "agent passport", "duplicate work", "mission control"
      ],
      required_evidence: ["local smoke test", "documented example call"]
    }
  ];
}

function ensureProtectedScopeSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS protected_scope_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  rule_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  owner_agent TEXT,
  required_approval_by TEXT,
  risk_class TEXT NOT NULL DEFAULT 'normal-fix',
  match_kind TEXT NOT NULL DEFAULT 'any',
  patterns_json TEXT NOT NULL DEFAULT '[]',
  required_claims_json TEXT NOT NULL DEFAULT '[]',
  required_evidence_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  source_kind TEXT NOT NULL DEFAULT 'manual',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, rule_key)
);
CREATE INDEX IF NOT EXISTS idx_protected_scope_status ON protected_scope_rule(scope, status, rule_key);
CREATE INDEX IF NOT EXISTS idx_protected_scope_project ON protected_scope_rule(project, status);
CREATE INDEX IF NOT EXISTS idx_protected_scope_owner ON protected_scope_rule(owner_agent, status);
`);
  const cols = db.prepare("PRAGMA table_info(protected_scope_rule)").all().map((c) => c.name);
  const missing = (name) => !cols.includes(name);
  if (missing("required_approval_by")) db.exec("ALTER TABLE protected_scope_rule ADD COLUMN required_approval_by TEXT");
  if (missing("source_kind")) db.exec("ALTER TABLE protected_scope_rule ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'");
  if (missing("meta_json")) db.exec("ALTER TABLE protected_scope_rule ADD COLUMN meta_json TEXT");
}

function ensureWorkClaimSchemaForLookup(db) {
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
CREATE INDEX IF NOT EXISTS idx_work_claim_scope_active ON work_claim(project, scope_key, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_work_claim_agent_status ON work_claim(agent_name, status, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_claim_kind_status ON work_claim(claim_kind, status, claimed_at DESC);
`);
}

function ensureOverrideSchemaForLookup(db) {
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
CREATE INDEX IF NOT EXISTS idx_override_scope_status ON override_log(scope, status, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_override_project_gate ON override_log(project, gate_kind, status);
`);
}

function seedDefaultProtectedScopes(db, options = {}) {
  ensureProtectedScopeSchema(db);
  if (process.env.MNEMO_PROTECTED_SCOPE_SEED_DEFAULTS === "0" && !options.force) {
    return { ok: true, skipped: "disabled", count: 0, scope: cleanScope(options.scope) };
  }
  const scope = cleanScope(options.scope || process.env.MNEMO_DEFAULT_SCOPE || DEFAULT_SCOPE);
  const rules = Array.isArray(options.rules) && options.rules.length ? options.rules : defaultProtectedScopeRules();
  const insert = db.prepare(`
INSERT OR IGNORE INTO protected_scope_rule
  (scope, project, rule_key, label, status, owner_agent, required_approval_by, risk_class, match_kind, patterns_json, required_claims_json, required_evidence_json, notes, source_kind, meta_json)
VALUES
  (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 'default', ?)
`);
  const update = db.prepare(`
UPDATE protected_scope_rule
SET label=?,
    risk_class=?,
    match_kind=?,
    patterns_json=?,
    required_claims_json=?,
    required_evidence_json=?,
    notes=?,
    meta_json=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE scope=? AND rule_key=? AND source_kind='default'
`);
  const txn = db.transaction(() => {
    for (const rule of rules) {
      const requiredClaims = rule.required_claims || [{
        claim_kind: "protected_scope",
        scope_value: rule.claim_scope_value || rule.rule_key
      }];
      const meta = Object.assign({}, rule.meta || {}, { seeded_by: "protected_scope_gate" });
      insert.run(
        scope,
        rule.project || null,
        rule.rule_key,
        rule.label,
        rule.owner_agent || null,
        rule.required_approval_by || null,
        rule.risk_class || "normal-fix",
        rule.match_kind || "any",
        JSON.stringify(uniqueStrings(rule.patterns || [])),
        JSON.stringify(requiredClaims),
        JSON.stringify(uniqueStrings(rule.required_evidence || [])),
        rule.notes || null,
        JSON.stringify(meta)
      );
      update.run(
        rule.label,
        rule.risk_class || "normal-fix",
        rule.match_kind || "any",
        JSON.stringify(uniqueStrings(rule.patterns || [])),
        JSON.stringify(requiredClaims),
        JSON.stringify(uniqueStrings(rule.required_evidence || [])),
        rule.notes || null,
        JSON.stringify(meta),
        scope,
        rule.rule_key
      );
    }
  });
  txn();
  return { ok: true, scope, count: rules.length };
}

function protectedScopeRuleRow(row) {
  return Object.assign({}, row, {
    patterns: parseJson(row.patterns_json, []),
    required_claims: parseJson(row.required_claims_json, []),
    required_evidence: parseJson(row.required_evidence_json, []),
    meta: parseJson(row.meta_json, {})
  });
}

function listProtectedScopeRules(db, input = {}) {
  ensureProtectedScopeSchema(db);
  seedDefaultProtectedScopes(db, { scope: input.scope });
  const where = ["scope=?"];
  const params = [cleanScope(input.scope || process.env.MNEMO_DEFAULT_SCOPE || DEFAULT_SCOPE)];
  if (input.project) {
    where.push("(project=? OR project IS NULL)");
    params.push(input.project);
  }
  if (input.rule_key) {
    where.push("rule_key=?");
    params.push(input.rule_key);
  }
  if (input.owner_agent) {
    where.push("owner_agent=?");
    params.push(normalizeAgentName(input.owner_agent));
  }
  if (input.status) {
    where.push("status=?");
    params.push(input.status);
  } else {
    where.push("status!='deleted'");
  }
  params.push(Math.min(Math.max(parseInt(input.limit || 100, 10) || 100, 1), 500));
  const rows = db.prepare("SELECT * FROM protected_scope_rule WHERE " + where.join(" AND ") + " ORDER BY rule_key LIMIT ?").all(...params).map(protectedScopeRuleRow);
  return { ok: true, count: rows.length, rules: rows };
}

function buildHaystack(input = {}) {
  const parts = [];
  for (const key of ["task", "summary", "action_type", "environment", "tool_name"]) {
    if (input[key]) parts.push(String(input[key]));
  }
  for (const key of ["files", "urls", "routes", "domains", "system_names", "topics", "commands"]) {
    const values = Array.isArray(input[key]) ? input[key] : [];
    for (const value of values) parts.push(String(value || ""));
  }
  return parts.join("\n").replace(/\\/g, "/").toLowerCase();
}

function patternMatches(pattern, haystack) {
  const raw = String(pattern || "").trim();
  if (!raw) return false;
  if (raw.startsWith("re:")) {
    try { return new RegExp(raw.slice(3), "i").test(haystack); } catch { return false; }
  }
  return haystack.includes(raw.toLowerCase());
}

function ruleMatches(rule, haystack) {
  const patterns = parseJson(rule.patterns_json, []);
  if (!patterns.length) return false;
  const matches = patterns.filter((pattern) => patternMatches(pattern, haystack));
  if (String(rule.match_kind || "any").toLowerCase() === "all") {
    return matches.length === patterns.length ? matches : [];
  }
  return matches;
}

function isReadLikeText(text) {
  const trimmed = String(text || "").trim().toLowerCase();
  return /^(get-content|select-string|rg\b|grep\b|cat\b|type\b|dir\b|ls\b|git status\b|git diff\b|git show\b|npm test\b|node --check\b)/.test(trimmed);
}

function isWriteLike(input = {}, haystack = "") {
  if (process.env.MNEMO_PROTECTED_SCOPE_STRICT_READ === "1") return true;
  const action = String(input.action_type || "").toLowerCase();
  if (["code_edit", "deploy", "external_comm", "write", "delete", "move"].includes(action)) return true;
  if (action === "code_read" || action === "read") return false;
  if (isReadLikeText(input.task) || isReadLikeText(input.summary)) return false;
  return /\b(apply_patch|set-content|new-item|remove-item|move-item|copy-item|git push|pm2 restart|pm2 reload|systemctl|nginx -s|rsync|scp|deploy)\b/i.test(haystack);
}

function activeClaimRows(db, input = {}) {
  ensureWorkClaimSchemaForLookup(db);
  const project = input.project || "unknown";
  const key = claimScopeKey(input.claim_kind, input.scope_value);
  const agent = normalizeAgentName(input.agent_name);
  if (!agent || !key.includes(":")) return [];
  const rows = db.prepare(
    "SELECT * FROM work_claim " +
    "WHERE scope_key=? AND agent_name=? AND status='active' AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
    "AND (project=? OR project='*' OR project='unknown' OR ?='unknown') " +
    "ORDER BY expires_at DESC LIMIT 10"
  ).all(key, agent, project, project);
  return rows.map((row) => Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }));
}

function activeOverrideRows(db, input = {}) {
  ensureOverrideSchemaForLookup(db);
  const scope = cleanScope(input.scope || process.env.MNEMO_DEFAULT_SCOPE || DEFAULT_SCOPE);
  const project = input.project || null;
  const agent = normalizeAgentName(input.agent_name);
  const ruleKey = String(input.rule_key || "").trim();
  const gateKinds = uniqueStrings(["protected_scope", ruleKey ? "protected_scope:" + ruleKey : "", ruleKey]).filter(Boolean);
  const placeholders = gateKinds.map(() => "?").join(",");
  const rows = db.prepare(
    "SELECT * FROM override_log WHERE scope=? AND status='active' " +
    "AND gate_kind IN (" + placeholders + ") " +
    "AND starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
    "AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
    "AND (project IS NULL OR project=? OR ? IS NULL) " +
    "AND (agent_name IS NULL OR agent_name=? OR ?='') " +
    "ORDER BY starts_at DESC LIMIT 20"
  ).all(scope, ...gateKinds, project, project, agent, agent);
  return rows.map((row) => Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }));
}

function validateProtectedScopeOverride(db, input = {}) {
  const gateKind = String(input.gate_kind || "").trim().toLowerCase();
  if (!gateKind.startsWith("protected_scope")) {
    return { ok: true, protected_scope: false };
  }
  ensureProtectedScopeSchema(db);
  seedDefaultProtectedScopes(db, { scope: input.scope });
  const scope = cleanScope(input.scope || process.env.MNEMO_DEFAULT_SCOPE || DEFAULT_SCOPE);
  const meta = input.meta && typeof input.meta === "object" ? input.meta : parseJson(input.meta_json, {});
  const suffix = gateKind.includes(":") ? gateKind.split(":").slice(1).join(":") : "";
  const ruleKey = String(input.rule_key || meta.rule_key || suffix || "").trim();
  if (!ruleKey) {
    return {
      ok: false,
      protected_scope: true,
      error: "protected_scope_rule_key_required",
      hint: "Protected-scope overrides must name the exact rule: gate_kind='protected_scope:<rule_key>' and approved_by=<assigned owner>."
    };
  }
  const row = db.prepare("SELECT * FROM protected_scope_rule WHERE scope=? AND rule_key=? AND status='active'").get(scope, ruleKey);
  if (!row) {
    return {
      ok: false,
      protected_scope: true,
      error: "protected_scope_rule_not_found",
      rule_key: ruleKey,
      hint: "Run mem_protected_scope_list and use an existing active rule_key."
    };
  }
  const owner = normalizeAgentName(row.required_approval_by || row.owner_agent);
  const approvedBy = normalizeAgentName(input.approved_by);
  if (!owner) {
    return {
      ok: false,
      protected_scope: true,
      error: "protected_scope_owner_missing",
      rule_key: ruleKey,
      hint: "Set owner_agent or required_approval_by on the protected scope before overrides are allowed."
    };
  }
  if (!approvedBy || approvedBy !== owner) {
    return {
      ok: false,
      protected_scope: true,
      error: "protected_scope_owner_approval_required",
      rule_key: ruleKey,
      label: row.label,
      required_approved_by: owner,
      provided_approved_by: approvedBy || null,
      hint: "Only the assigned protected-scope owner can approve this exception."
    };
  }
  return {
    ok: true,
    protected_scope: true,
    rule_key: ruleKey,
    label: row.label,
    approved_by: approvedBy,
    owner_agent: owner
  };
}

function protectedScopeCheck(db, input = {}) {
  ensureProtectedScopeSchema(db);
  seedDefaultProtectedScopes(db, { scope: input.scope });
  const scope = cleanScope(input.scope || process.env.MNEMO_DEFAULT_SCOPE || DEFAULT_SCOPE);
  const project = input.project || null;
  const agent = normalizeAgentName(input.agent_name);
  const haystack = buildHaystack(input);
  const writeLike = isWriteLike(input, haystack);
  const rows = db.prepare("SELECT * FROM protected_scope_rule WHERE scope=? AND status='active' AND (project IS NULL OR project=?) ORDER BY rule_key").all(scope, project);
  const matched = [];
  const blockers = [];
  const warnings = [];
  const instructions = [];
  for (const row of rows) {
    const patternHits = ruleMatches(row, haystack);
    if (!patternHits.length) continue;
    const rule = protectedScopeRuleRow(row);
    const requiredClaims = Array.isArray(rule.required_claims) && rule.required_claims.length
      ? rule.required_claims
      : [{ claim_kind: "protected_scope", scope_value: rule.rule_key }];
    const claims = requiredClaims.flatMap((claim) => activeClaimRows(db, {
      project: project || "unknown",
      agent_name: agent,
      claim_kind: claim.claim_kind || "protected_scope",
      scope_value: claim.scope_value || rule.rule_key
    }));
    const overrides = activeOverrideRows(db, {
      scope,
      project,
      agent_name: agent,
      rule_key: rule.rule_key
    });
    const owner = normalizeAgentName(rule.owner_agent);
    const ownerOk = !owner || owner === agent;
    const hasClaim = claims.length > 0;
    const hasOverride = overrides.length > 0;
    matched.push(Object.assign({}, rule, {
      matched_patterns: patternHits,
      active_claims: claims,
      active_overrides: overrides,
      owner_ok: ownerOk,
      claim_ok: hasClaim,
      override_ok: hasOverride
    }));
    if (!writeLike) {
      warnings.push("protected scope matched read/prep context: " + rule.label + "; write/deploy will require owner/claim gate.");
      continue;
    }
    if (!hasOverride && !ownerOk) {
      blockers.push("protected scope \"" + rule.label + "\" is owned by " + owner + "; " + (agent || "this agent") + " needs explicit handoff or mem_override_log before write/deploy.");
    }
    if (!hasOverride && !hasClaim) {
      const claim = requiredClaims[0] || { claim_kind: "protected_scope", scope_value: rule.rule_key };
      const claimKind = claim.claim_kind || "protected_scope";
      const scopeValue = claim.scope_value || rule.rule_key;
      blockers.push("protected scope \"" + rule.label + "\" requires an active claim before write/deploy.");
      instructions.push("Claim first: mem_work_claim({ project: \"" + (project || "unknown") + "\", agent_name: \"" + (agent || "<agent>") + "\", claim_kind: \"" + claimKind + "\", scope_value: \"" + scopeValue + "\", summary: \"<task>\", ttl_minutes: " + DEFAULT_TTL_MINUTES + " })");
    }
  }
  const status = blockers.length ? "block" : (warnings.length ? "warn" : "ok");
  return {
    ok: !blockers.length,
    status,
    scope,
    project,
    agent_name: agent,
    write_like: writeLike,
    matched_count: matched.length,
    matched_rules: matched,
    blockers,
    warnings,
    instructions,
    hint: blockers.length ? "Resolve protected-scope blockers before editing, deploying, or changing shared behavior." : "Protected-scope gate passed."
  };
}

const PROTECTED_SCOPE_TOOL_DEFS = {
  mem_protected_scope_seed: {
    description: "Seed the default protected-scope rules into the current Mnemo scope.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, force: { type: "boolean" } } }
  },
  mem_protected_scope_list: {
    description: "List active protected-scope rules. These are hard gates checked by mem_agent_preflight.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, rule_key: { type: "string" }, owner_agent: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } }
  },
  mem_protected_scope_check: {
    description: "Check whether a task/files/routes touch protected scopes and whether owner, claim, or override gates are satisfied.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        summary: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        routes: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } },
        system_names: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        commands: { type: "array", items: { type: "string" } },
        action_type: { type: "string" },
        scope: { type: "string" }
      },
      required: ["agent_name"]
    }
  }
};

function handleProtectedScopeTool(db, name, input = {}) {
  if (name === "mem_protected_scope_seed") return { handled: true, result: seedDefaultProtectedScopes(db, input || {}) };
  if (name === "mem_protected_scope_list") return { handled: true, result: listProtectedScopeRules(db, input || {}) };
  if (name === "mem_protected_scope_check") return { handled: true, result: protectedScopeCheck(db, input || {}) };
  return { handled: false };
}

module.exports = {
  PROTECTED_SCOPE_TOOL_DEFS,
  ensureProtectedScopeSchema,
  seedDefaultProtectedScopes,
  listProtectedScopeRules,
  protectedScopeCheck,
  validateProtectedScopeOverride,
  handleProtectedScopeTool,
  claimScopeKey
};
