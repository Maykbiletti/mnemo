"use strict";

const { cleanScope, parseMaybeJson, boolFlag } = require("./shared_utils");

const DEFAULT_SCOPE = cleanScope(process.env.MNEMO_DEFAULT_SCOPE || "default");
const DEFAULT_AGENT = process.env.MNEMO_DEFAULT_AGENT || process.env.MNEMO_AGENT || "agent";

const ROUTE_COLUMNS = [
  ["route_kind", "TEXT NOT NULL DEFAULT 'direct'"],
  ["direct_allowed", "INTEGER NOT NULL DEFAULT 1"],
  ["jump_host", "TEXT"],
  ["jump_user", "TEXT"],
  ["jump_secret_ref", "TEXT"],
  ["proxy_command", "TEXT"],
  ["canonical_command", "TEXT"],
  ["route_steps_json", "TEXT"],
  ["preflight_required", "INTEGER NOT NULL DEFAULT 1"],
  ["last_route_check_at", "TEXT"],
];

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeRouteKind(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return "direct";
  if (["ssh_jump", "jump_host", "jumphost", "bastion", "bastion_host"].includes(raw)) return "jump";
  if (["proxycommand", "proxy_command", "ssh_proxy"].includes(raw)) return "proxy";
  if (["direct", "jump", "proxy", "vpn", "tunnel", "manual", "unknown"].includes(raw)) return raw;
  return raw;
}

function normalizeAccessKind(value) {
  return String(value || "other").trim().toLowerCase() || "other";
}

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function parseAllowedAgents(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return parsed.map((v) => String(v || "").trim()).filter(Boolean);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

function parseRouteSteps(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return parsed.map((v) => String(v || "").trim()).filter(Boolean);
  return String(value).split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
}

function stringifyAllowedAgents(value) {
  const agents = parseAllowedAgents(value);
  return agents.length ? JSON.stringify(agents) : null;
}

function stringifyRouteSteps(value) {
  const steps = parseRouteSteps(value);
  return steps.length ? JSON.stringify(steps) : null;
}

function sshTarget(route) {
  const entrypoint = cleanText(route.entrypoint);
  if (!entrypoint) return "";
  if (/^ssh\s+/i.test(entrypoint) || /^https?:\/\//i.test(entrypoint) || entrypoint.includes("@")) return entrypoint;
  const account = cleanText(route.account_hint);
  return account ? `${account}@${entrypoint}` : entrypoint;
}

function jumpTarget(route) {
  const host = cleanText(route.jump_host);
  if (!host) return "";
  if (host.includes("@")) return host;
  const user = cleanText(route.jump_user);
  return user ? `${user}@${host}` : host;
}

function buildCanonicalCommand(route) {
  if (cleanText(route.canonical_command)) return cleanText(route.canonical_command);
  const kind = normalizeAccessKind(route.access_kind);
  const routeKind = normalizeRouteKind(route.route_kind);
  const entrypoint = cleanText(route.entrypoint);
  const target = sshTarget(route);

  if (["ssh", "server", "shell"].includes(kind)) {
    if (/^ssh\s+/i.test(target)) return target;
    if (routeKind === "jump" && target && jumpTarget(route)) return `ssh -J ${jumpTarget(route)} ${target}`;
    if (routeKind === "proxy" && target && cleanText(route.proxy_command)) return `ssh -o ProxyCommand='${cleanText(route.proxy_command)}' ${target}`;
    if (routeKind === "tunnel" && target && cleanText(route.proxy_command)) return cleanText(route.proxy_command);
    if (routeKind === "direct" && target) return `ssh ${target}`;
  }

  if (routeKind === "proxy" && cleanText(route.proxy_command)) return cleanText(route.proxy_command);
  if (entrypoint) return entrypoint;
  return "";
}

function buildRouteSteps(route) {
  const explicit = parseRouteSteps(route.route_steps || route.route_steps_json);
  if (explicit.length) return explicit;

  const steps = ["Resolve this Mnemo access route before attempting the connection."];
  const routeKind = normalizeRouteKind(route.route_kind);
  if (!route.direct_allowed && routeKind !== "direct") {
    steps.push("Direct access is not allowed for this route.");
  }
  if (routeKind === "jump") {
    steps.push(`Use jump host: ${jumpTarget(route) || route.jump_host || "configured jump host"}.`);
  } else if (routeKind === "proxy") {
    steps.push("Use the configured proxy command.");
  } else if (routeKind === "vpn" || routeKind === "tunnel") {
    steps.push(`Use the configured ${routeKind} path before touching the entrypoint.`);
  }
  const command = buildCanonicalCommand(route);
  if (command) steps.push(`Canonical command: ${command}`);
  if (route.secret_ref) steps.push(`Secret reference only: ${route.secret_ref}`);
  if (route.jump_secret_ref) steps.push(`Jump secret reference only: ${route.jump_secret_ref}`);
  return steps;
}

function routeFromRow(row) {
  if (!row) return null;
  const routeKind = normalizeRouteKind(row.route_kind || "direct");
  const directAllowed = boolFlag(row.direct_allowed, routeKind === "direct");
  const route = {
    id: row.id,
    access_id: row.id,
    scope: row.scope || DEFAULT_SCOPE,
    project: row.project || null,
    system_name: row.system_name,
    access_kind: row.access_kind,
    entrypoint: row.entrypoint || "",
    account_hint: row.account_hint || null,
    secret_ref: row.secret_ref || null,
    allowed_agents: parseAllowedAgents(row.allowed_agents),
    status: row.status || "active",
    route_kind: routeKind,
    direct_allowed: directAllowed,
    jump_host: row.jump_host || null,
    jump_user: row.jump_user || null,
    jump_secret_ref: row.jump_secret_ref || null,
    proxy_command: row.proxy_command || null,
    canonical_command: row.canonical_command || null,
    route_steps: parseRouteSteps(row.route_steps_json),
    preflight_required: boolFlag(row.preflight_required, true),
    last_route_check_at: row.last_route_check_at || null,
    last_verified_at: row.last_verified_at || null,
    verification_method: row.verification_method || null,
    notes: row.notes || null,
    updated_by: row.updated_by || null,
    updated_at: row.updated_at || null,
    created_at: row.created_at || null,
  };
  route.canonical_command = buildCanonicalCommand(route);
  route.route_steps = buildRouteSteps(route);
  return route;
}

function ensureAccessRouteSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS access_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT NOT NULL,
  access_kind TEXT NOT NULL,
  entrypoint TEXT,
  account_hint TEXT,
  secret_ref TEXT,
  allowed_agents TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  route_kind TEXT NOT NULL DEFAULT 'direct',
  direct_allowed INTEGER NOT NULL DEFAULT 1,
  jump_host TEXT,
  jump_user TEXT,
  jump_secret_ref TEXT,
  proxy_command TEXT,
  canonical_command TEXT,
  route_steps_json TEXT,
  preflight_required INTEGER NOT NULL DEFAULT 1,
  last_route_check_at TEXT,
  last_verified_at TEXT,
  verification_method TEXT,
  notes TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, system_name, access_kind, entrypoint)
);
CREATE INDEX IF NOT EXISTS idx_access_project ON access_inventory(project, status);
CREATE INDEX IF NOT EXISTS idx_access_system ON access_inventory(system_name, access_kind);
CREATE INDEX IF NOT EXISTS idx_access_status ON access_inventory(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS access_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_id INTEGER REFERENCES access_inventory(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL,
  actor TEXT,
  status TEXT,
  notes TEXT,
  meta_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_access_event_access ON access_event(access_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_event_actor ON access_event(actor, occurred_at DESC);
`);

  const cols = new Set(db.prepare("PRAGMA table_info(access_inventory)").all().map((c) => c.name));
  for (const [name, ddl] of ROUTE_COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE access_inventory ADD COLUMN ${name} ${ddl}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_access_route_kind ON access_inventory(route_kind, direct_allowed, status)");
}

function allowedForAgent(route, agentName) {
  if (!route.allowed_agents || route.allowed_agents.length === 0) return true;
  const agent = String(agentName || DEFAULT_AGENT).trim().toLowerCase();
  return route.allowed_agents.some((name) => String(name || "").trim().toLowerCase() === agent);
}

function logAccessEvent(db, routeId, eventKind, actor, status, notes, meta) {
  try {
    db.prepare("INSERT INTO access_event (access_id, event_kind, actor, status, notes, meta_json) VALUES (?,?,?,?,?,?)")
      .run(routeId || null, eventKind, actor || DEFAULT_AGENT, status || null, notes || null, meta ? JSON.stringify(meta) : null);
  } catch {}
}

function upsertAccessRoute(db, input = {}) {
  ensureAccessRouteSchema(db);
  if (!input.system_name || !input.access_kind) return { ok: false, error: "system_name + access_kind required" };

  const scope = scopeName(input.scope);
  const entrypoint = cleanText(input.entrypoint) || "";
  const actor = input.updated_by || input.agent_name || DEFAULT_AGENT;
  const routeKindProvided = input.route_kind !== undefined || !!(input.meta && input.meta.route_kind !== undefined);
  const directAllowedProvided = input.direct_allowed !== undefined || !!(input.meta && input.meta.direct_allowed !== undefined);
  const routeKind = normalizeRouteKind(input.route_kind || (input.meta && input.meta.route_kind) || "direct");
  const directAllowed = input.direct_allowed === undefined && input.meta && input.meta.direct_allowed !== undefined
    ? boolFlag(input.meta.direct_allowed, routeKind === "direct")
    : boolFlag(input.direct_allowed, routeKind === "direct");
  const allowed = stringifyAllowedAgents(input.allowed_agents);
  const routeStepsProvided = input.route_steps !== undefined || input.route_steps_json !== undefined;
  const routeSteps = stringifyRouteSteps(input.route_steps || input.route_steps_json);

  const existing = db.prepare(
    "SELECT id FROM access_inventory WHERE scope=? AND system_name=? AND access_kind=? AND COALESCE(entrypoint,'')=?"
  ).get(scope, input.system_name, input.access_kind, entrypoint);

  let id;
  if (existing) {
    id = existing.id;
    db.prepare(
      "UPDATE access_inventory SET project=?, entrypoint=?, account_hint=?, secret_ref=?, allowed_agents=?, status=?, " +
      "route_kind=COALESCE(?, route_kind), direct_allowed=COALESCE(?, direct_allowed), jump_host=COALESCE(?, jump_host), jump_user=COALESCE(?, jump_user), jump_secret_ref=COALESCE(?, jump_secret_ref), proxy_command=COALESCE(?, proxy_command), canonical_command=COALESCE(?, canonical_command), route_steps_json=COALESCE(?, route_steps_json), preflight_required=COALESCE(?, preflight_required), " +
      "last_verified_at=COALESCE(?, last_verified_at), last_route_check_at=COALESCE(?, last_route_check_at), verification_method=COALESCE(?, verification_method), notes=COALESCE(?, notes), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    ).run(
      input.project || null,
      entrypoint,
      input.account_hint || null,
      input.secret_ref || null,
      allowed,
      input.status || "active",
      routeKindProvided ? routeKind : null,
      directAllowedProvided ? (directAllowed ? 1 : 0) : null,
      input.jump_host || null,
      input.jump_user || null,
      input.jump_secret_ref || null,
      input.proxy_command || null,
      input.canonical_command || null,
      routeStepsProvided ? routeSteps : null,
      input.preflight_required !== undefined ? (boolFlag(input.preflight_required, true) ? 1 : 0) : null,
      input.last_verified_at || null,
      input.last_route_check_at || null,
      input.verification_method || null,
      input.notes || null,
      actor,
      id
    );
  } else {
    const info = db.prepare(
      "INSERT INTO access_inventory (scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, route_kind, direct_allowed, jump_host, jump_user, jump_secret_ref, proxy_command, canonical_command, route_steps_json, preflight_required, last_verified_at, last_route_check_at, verification_method, notes, updated_by) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      scope,
      input.project || null,
      input.system_name,
      input.access_kind,
      entrypoint,
      input.account_hint || null,
      input.secret_ref || null,
      allowed,
      input.status || "active",
      routeKind,
      directAllowed ? 1 : 0,
      input.jump_host || null,
      input.jump_user || null,
      input.jump_secret_ref || null,
      input.proxy_command || null,
      input.canonical_command || null,
      routeSteps,
      boolFlag(input.preflight_required, true) ? 1 : 0,
      input.last_verified_at || null,
      input.last_route_check_at || null,
      input.verification_method || null,
      input.notes || null,
      actor
    );
    id = info.lastInsertRowid;
  }

  logAccessEvent(db, id, existing ? "updated" : "created", actor, input.status || "active", input.notes || null, {
    route_kind: routeKind,
    direct_allowed: directAllowed,
    secret_ref: input.secret_ref || null,
    jump_secret_ref: input.jump_secret_ref || null,
    meta: input.meta || null,
  });

  const row = db.prepare("SELECT * FROM access_inventory WHERE id=?").get(id);
  return {
    ok: true,
    id,
    status: existing ? "updated" : "created",
    secret_stored: false,
    secret_ref: input.secret_ref || null,
    route: routeFromRow(row),
  };
}

function buildWhere(input = {}) {
  const where = [];
  const params = [];
  if (input.scope) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(scopeName(input.scope)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.system_name) {
    where.push("(system_name LIKE ? OR entrypoint LIKE ?)");
    params.push(`%${input.system_name}%`, `%${input.system_name}%`);
  }
  if (input.access_kind) { where.push("access_kind=?"); params.push(input.access_kind); }
  if (input.entrypoint) { where.push("entrypoint LIKE ?"); params.push(`%${input.entrypoint}%`); }
  if (input.route_kind) { where.push("route_kind=?"); params.push(normalizeRouteKind(input.route_kind)); }
  if (input.direct_allowed !== undefined) { where.push("direct_allowed=?"); params.push(boolFlag(input.direct_allowed, false) ? 1 : 0); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  else if (!input.include_inactive) { where.push("status IN ('active','verified','ok','fresh','observed')"); }
  return { where, params };
}

function listAccessRoutes(db, input = {}) {
  ensureAccessRouteSchema(db);
  let rows = queryAccessRows(db, input);
  let usedScopeFallback = false;
  const hasSpecificFilter = !!(input.project || input.system_name || input.access_kind || input.entrypoint || input.route_kind);
  if (!rows.length && input.scope && hasSpecificFilter) {
    rows = queryAccessRows(db, Object.assign({}, input, { scope: null }));
    usedScopeFallback = rows.length > 0;
  }
  return {
    count: rows.length,
    access: rows.map(routeFromRow),
    scope_fallback: usedScopeFallback,
  };
}

function queryAccessRows(db, input = {}) {
  const { where, params } = buildWhere(input);
  params.push(Math.min(input.limit || 50, 300));
  return db.prepare(
    "SELECT * FROM access_inventory" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY COALESCE(last_verified_at, updated_at) DESC LIMIT ?"
  ).all(...params);
}

function routeScore(route, input = {}) {
  let score = 0;
  if (input.system_name && String(route.system_name).toLowerCase() === String(input.system_name).toLowerCase()) score += 40;
  if (input.access_kind && String(route.access_kind).toLowerCase() === String(input.access_kind).toLowerCase()) score += 20;
  if (input.entrypoint && String(route.entrypoint || "").toLowerCase() === String(input.entrypoint).toLowerCase()) score += 20;
  if (route.status === "active") score += 15;
  if (route.last_verified_at) score += 10;
  if (route.scope === scopeName(input.scope)) score += 5;
  return score;
}

function selectCandidateRoutes(db, input = {}) {
  const where = [];
  const params = [];
  if (input.scope) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(scopeName(input.scope)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.system_name) {
    where.push("(LOWER(system_name)=LOWER(?) OR system_name LIKE ? OR entrypoint LIKE ?)");
    params.push(input.system_name, `%${input.system_name}%`, `%${input.system_name}%`);
  }
  if (input.access_kind) { where.push("access_kind=?"); params.push(input.access_kind); }
  if (input.entrypoint) { where.push("(entrypoint=? OR entrypoint LIKE ?)"); params.push(input.entrypoint, `%${input.entrypoint}%`); }
  if (!input.include_inactive) { where.push("status IN ('active','verified','ok')"); }
  params.push(Math.min(input.limit || 20, 100));
  const rows = db.prepare(
    "SELECT * FROM access_inventory" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY COALESCE(last_verified_at, updated_at) DESC LIMIT ?"
  ).all(...params).map(routeFromRow);
  return rows.sort((a, b) => routeScore(b, input) - routeScore(a, input));
}

function intendedLooksDirect(input = {}, route) {
  const rawKind = input.intended_route_kind || input.route_kind || "";
  if (rawKind && normalizeRouteKind(rawKind) === "direct") return true;
  const command = String(input.intended_command || "").trim();
  if (!command) return false;
  if (/(^|\s)-J(\s|=|$)/.test(command) || /\bProxyCommand\b/i.test(command) || /\bproxy\b/i.test(command)) return false;
  if (route.route_kind !== "direct" && /\bssh\b/i.test(command)) return true;
  const intendedEntry = String(input.intended_entrypoint || input.entrypoint || "").trim();
  if (intendedEntry && route.entrypoint && intendedEntry === route.entrypoint && route.route_kind !== "direct") return true;
  return false;
}

function resolveAccessRoute(db, input = {}) {
  ensureAccessRouteSchema(db);
  if (!input.system_name && !input.project && !input.entrypoint) {
    return {
      ok: false,
      status: "block",
      error: "system_name_or_project_or_entrypoint_required",
      message: "Call mem_access_route_resolve with at least system_name, project, or entrypoint before attempting access.",
    };
  }

  let candidates = selectCandidateRoutes(db, input);
  let usedScopeFallback = false;
  if (!candidates.length && input.scope) {
    candidates = selectCandidateRoutes(db, Object.assign({}, input, { scope: null }));
    usedScopeFallback = candidates.length > 0;
  }
  if (!candidates.length) {
    return {
      ok: false,
      status: "block",
      error: "access_route_missing",
      message: "No canonical access route is stored for this target. Do not improvise direct access; add or verify the route first with mem_access_upsert.",
      query: {
        scope: input.scope || null,
        project: input.project || null,
        system_name: input.system_name || null,
        access_kind: input.access_kind || null,
        entrypoint: input.entrypoint || input.intended_entrypoint || null,
      },
      next_step: "Use mem_access_upsert with route_kind, direct_allowed, jump/proxy fields, secret_ref labels, and verification evidence.",
    };
  }

  const route = candidates[0];
  const agent = input.agent_name || input.actor || DEFAULT_AGENT;
  if (!allowedForAgent(route, agent)) {
    return {
      ok: false,
      status: "block",
      error: "agent_not_allowed_for_access_route",
      message: `${agent} is not listed in allowed_agents for this access route.`,
      route,
      scope_fallback: usedScopeFallback,
      allowed_agents: route.allowed_agents,
    };
  }

  if (!route.direct_allowed && intendedLooksDirect(input, route)) {
    return {
      ok: false,
      status: "block",
      error: "direct_access_blocked_use_canonical_route",
      message: "This target is reachable only through the canonical stored route. Do not try direct access first.",
      route,
      scope_fallback: usedScopeFallback,
      must_use: {
        route_kind: route.route_kind,
        direct_allowed: route.direct_allowed,
        canonical_command: route.canonical_command,
        route_steps: route.route_steps,
      },
    };
  }

  return {
    ok: true,
    status: "ok",
    route,
    candidates: candidates.slice(0, 5),
    scope_fallback: usedScopeFallback,
    must_use: {
      route_kind: route.route_kind,
      direct_allowed: route.direct_allowed,
      canonical_command: route.canonical_command,
      route_steps: route.route_steps,
    },
  };
}

function preflightAccessRoute(db, input = {}) {
  const result = resolveAccessRoute(db, input);
  const routeId = result.route && result.route.id ? result.route.id : null;
  const actor = input.agent_name || input.actor || DEFAULT_AGENT;
  const status = result.ok ? "allowed" : "blocked";
  const notes = result.ok
    ? `preflight allowed for ${result.route.system_name} (${result.route.route_kind})`
    : `preflight blocked: ${result.error || "unknown"}`;
  logAccessEvent(db, routeId, result.ok ? "preflight_allowed" : "preflight_blocked", actor, status, notes, {
    system_name: input.system_name || null,
    access_kind: input.access_kind || null,
    intended_route_kind: input.intended_route_kind || null,
    intended_entrypoint: input.intended_entrypoint || input.entrypoint || null,
    intended_command: input.intended_command || null,
    result_error: result.error || null,
  });
  if (routeId) {
    try {
      db.prepare("UPDATE access_inventory SET last_route_check_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(routeId);
    } catch {}
  }
  return Object.assign({}, result, { preflight_logged: true, preflight_at: isoNow() });
}

function accessGuide(db, input = {}) {
  const listed = listAccessRoutes(db, Object.assign({}, input, { limit: input.limit || 100 }));
  const grouped = new Map();
  for (const route of listed.access) {
    const key = `${route.project || "_"}::${route.system_name}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        project: route.project || null,
        system_name: route.system_name,
        status: route.status,
        last_verified_at: route.last_verified_at || null,
        notes: route.notes || null,
        routes: [],
      });
    }
    grouped.get(key).routes.push(route);
  }
  const systems = Array.from(grouped.values());
  const projectNames = Array.from(new Set(systems.map((row) => row.project).filter(Boolean)));
  const registry = {};
  try {
    if (input.project) {
      const row = db.prepare("SELECT name, domain, repo, server, pm2_processes, nginx_files, admin_url, auth_system, live_status, live_url, staging_url, updated_at, updated_by FROM project_registry WHERE name=?").get(input.project);
      if (row) registry[input.project] = normalizeRegistryRow(row);
    } else if (projectNames.length) {
      const placeholders = projectNames.map(() => "?").join(",");
      const rows = db.prepare("SELECT name, domain, repo, server, pm2_processes, nginx_files, admin_url, auth_system, live_status, live_url, staging_url, updated_at, updated_by FROM project_registry WHERE name IN (" + placeholders + ")").all(...projectNames);
      for (const row of rows) registry[row.name] = normalizeRegistryRow(row);
    }
  } catch {}
  const lines = ["# Access Guide"];
  if (input.project) lines.push(`Project: ${input.project}`);
  if (input.system_name) lines.push(`System search: ${input.system_name}`);
  lines.push("");
  if (input.project && registry[input.project]) {
    const reg = registry[input.project];
    lines.push("## Project Registry");
    if (reg.domain) lines.push(`- Domain: ${reg.domain}`);
    if (reg.live_url) lines.push(`- Live URL: ${reg.live_url}`);
    if (reg.staging_url) lines.push(`- Staging URL: ${reg.staging_url}`);
    if (reg.repo) lines.push(`- Repo: ${reg.repo}`);
    if (reg.server) lines.push(`- Server: ${reg.server}`);
    if (reg.admin_url) lines.push(`- Admin URL: ${reg.admin_url}`);
    if (reg.auth_system) lines.push(`- Auth system: ${reg.auth_system}`);
    if (Array.isArray(reg.pm2_processes) && reg.pm2_processes.length) lines.push(`- PM2: ${reg.pm2_processes.join(", ")}`);
    if (Array.isArray(reg.nginx_files) && reg.nginx_files.length) lines.push(`- Nginx: ${reg.nginx_files.join(", ")}`);
    lines.push("");
  }
  for (const system of systems) {
    lines.push(`## ${system.system_name}`);
    if (system.project) lines.push(`- Project: ${system.project}`);
    if (system.status) lines.push(`- Status: ${system.status}`);
    if (system.last_verified_at) lines.push(`- Last verified: ${system.last_verified_at}`);
    if (system.notes) lines.push(`- Notes: ${system.notes}`);
    for (const route of system.routes) {
      const parts = [
        route.access_kind,
        `route=${route.route_kind}`,
        route.direct_allowed ? "direct_allowed=yes" : "direct_allowed=no",
        route.entrypoint ? `entrypoint=${route.entrypoint}` : null,
        route.jump_host ? `jump=${jumpTarget(route)}` : null,
        route.secret_ref ? `secret_ref=${route.secret_ref}` : null,
        route.canonical_command ? `canonical=${route.canonical_command}` : null,
        route.allowed_agents && route.allowed_agents.length ? `agents=${route.allowed_agents.join(",")}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    }
    lines.push("");
  }
  if (!systems.length) lines.push("_No access routes found. Add them with mem_access_upsert before attempting access._");
  return { count: listed.count, systems, registry, guide_markdown: lines.join("\n") };
}

function normalizeRegistryRow(row) {
  const out = Object.assign({}, row);
  for (const key of ["pm2_processes", "nginx_files"]) {
    try { out[key] = out[key] ? JSON.parse(out[key]) : []; } catch { out[key] = []; }
  }
  return out;
}

const routeInputProperties = {
  scope: { type: "string" },
  project: { type: "string" },
  system_name: { type: "string" },
  access_kind: { type: "string" },
  entrypoint: { type: "string" },
  intended_entrypoint: { type: "string" },
  intended_command: { type: "string" },
  intended_route_kind: { type: "string" },
  route_kind: { type: "string", description: "direct | jump | proxy | vpn | tunnel | manual" },
  direct_allowed: { type: "boolean" },
  account_hint: { type: "string" },
  secret_ref: { type: "string" },
  allowed_agents: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
  jump_host: { type: "string" },
  jump_user: { type: "string" },
  jump_secret_ref: { type: "string" },
  proxy_command: { type: "string" },
  canonical_command: { type: "string" },
  route_steps: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
  preflight_required: { type: "boolean" },
  status: { type: "string" },
  last_verified_at: { type: "string" },
  last_route_check_at: { type: "string" },
  verification_method: { type: "string" },
  notes: { type: "string" },
  updated_by: { type: "string" },
  agent_name: { type: "string" },
  actor: { type: "string" },
  limit: { type: "integer" },
  include_inactive: { type: "boolean" },
  meta: { type: "object" },
};

const ACCESS_ROUTE_TOOL_DEFS = {
  mem_access_upsert: {
    description: "Create/update the canonical access route for a server/admin/repo/API/DB. Store route_kind, jump/proxy details, direct_allowed, canonical_command, and secret_ref labels only; never raw secrets.",
    inputSchema: { type: "object", properties: routeInputProperties, required: ["system_name", "access_kind"] },
  },
  mem_access_list: {
    description: "List canonical access routes including jump/proxy/direct policy. Returns secret references, never raw secrets.",
    inputSchema: { type: "object", properties: routeInputProperties },
  },
  mem_access_guide: {
    description: "Render the fixed access guide. Agents must read this or preflight before touching servers, repos, APIs, dashboards, databases, or providers.",
    inputSchema: { type: "object", properties: routeInputProperties },
  },
  mem_access_route_resolve: {
    description: "Resolve the canonical route before access. Blocks missing routes, unauthorized agents, and direct attempts when direct_allowed=false.",
    inputSchema: { type: "object", properties: routeInputProperties },
  },
  mem_access_preflight: {
    description: "Mandatory preflight before SSH/API/DB/admin/provider access. Logs allowed/blocked evidence and returns the canonical command/steps.",
    inputSchema: { type: "object", properties: routeInputProperties },
  },
};

function handleAccessRouteTool(db, name, args = {}) {
  if (name === "mem_access_upsert") return { handled: true, result: upsertAccessRoute(db, args) };
  if (name === "mem_access_list") return { handled: true, result: listAccessRoutes(db, args) };
  if (name === "mem_access_guide") return { handled: true, result: accessGuide(db, args) };
  if (name === "mem_access_route_resolve") return { handled: true, result: resolveAccessRoute(db, args) };
  if (name === "mem_access_preflight") return { handled: true, result: preflightAccessRoute(db, args) };
  return { handled: false };
}

module.exports = {
  ACCESS_ROUTE_TOOL_DEFS,
  ensureAccessRouteSchema,
  handleAccessRouteTool,
  upsertAccessRoute,
  listAccessRoutes,
  resolveAccessRoute,
  preflightAccessRoute,
  routeFromRow,
  buildCanonicalCommand,
  normalizeRouteKind,
};
