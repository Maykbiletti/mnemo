#!/usr/bin/env node
/**
 * Mnemo MCP Server — persistent memory exposed as MCP tools.
 *
 * Speaks the Model Context Protocol over stdio.
 * Tools exposed:
 *   - mem_recall(query, limit?, since?, kind?, actor?)  FTS5 search ranked by BM25 + recency
 *   - mem_who_am_i()                                    Current self: values + top traits + recent reflection
 *   - mem_timeline(date_or_range, actor?)               Chronological memory window
 *   - mem_health()                                      Writer health snapshot
 *   - mem_add(kind, text, source?, actor?, topic?, importance?)  Explicit insert
 *   - mem_link(from_id, to_id, kind, weight?)           Add typed edge
 *   - mem_recall_ids(query, ...)                        Token-frugal recall (id+kind+score+snippet only)
 *   - mem_get(ids[]|id)                                 Fetch full memory rows by id
 *   - mem_neighbors(id, depth?, kinds?, direction?)     BFS over memory_link graph
 *   - mem_value_get(name?)                              List/fetch core values
 *   - mem_belief_get(topic?)                            List beliefs
 *   - mem_trait_get(dimension?)                         List traits
 *   - mem_reflect(date?)                                Run reflection-cycle for a date (writes daily_reflection)
 *
 * Storage backend: SQLite at MNEMO_DB (default ./mnemo.db)
 */
"use strict";

const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TEAM_QUALITY_TOOL_DEFS, ensureTeamQualityTables, handleTeamQualityTool } = require("./team_quality_ops");
const { CODE_READ_TOOL_DEFS, handleCodeReadTool } = require("./code_read_tools");
const { CONTEXT_PREVIEW_TOOL_DEFS, handleContextPreviewTool } = require("./context_preview_tools");
const { LOOP_DOCTOR_TOOL_DEFS, handleLoopDoctorTool } = require("./loop_doctor_tools");
const { TIMELINE_REPORT_TOOL_DEFS, handleTimelineReportTool } = require("./timeline_report_tools");
const { memoryHealth } = require("./memory_health_tools");
const { parseMaybeJson, deepMergePlain, uniqueIntegers, stripPrivate, parseAgentCsv, normalizeAgentName, jsonSafe, compactContent, parseMetaJson, isoOrNull, parseBriefTitle, TEAM_BRIEF_ALIASES, BRIEF_CONTRACT_VERSION, BRIEF_REQUIRED_HEADINGS, cleanScope, uniqueAgentNames, isTeamBriefTarget, hasCanonicalBriefShape, normalizeBriefMeta, normalizeBriefContent, baseName, extensionName, inferMediaKind, inferMediaType, uniqueStrings, boolFlag, isoAgeDays, freshnessFromAgeDays, capabilityMatrixForDepartments, AUTH_CONTRACT_REQUIRED_FIELDS, UI_CONTRACT_REQUIRED_FIELDS, authSensitiveTask, uiSensitiveTask, wizardTargetGate, authContractReport, uiContractReport, normalizeReminderText, parseReminderTime, applyReminderTime, parseReminderDue, reminderTitleFromText, reminderRow, buildMediaTitle, buildCanonicalMediaFileName, slugFilePart } = require("./shared_utils");
const briefCoordination = require("./brief_coordination");
const { AGENT_MAIL_TOOL_DEFS, ensureAgentMailTables, handleAgentMailTool } = require("./agent_mail");
const { ACCESS_ROUTE_TOOL_DEFS, ensureAccessRouteSchema, handleAccessRouteTool } = require("./access_routes");
const { PROTECTED_SCOPE_TOOL_DEFS, ensureProtectedScopeSchema, seedDefaultProtectedScopes, protectedScopeCheck, validateProtectedScopeOverride, handleProtectedScopeTool } = require("./protected_scope_gate");
const { RESOURCE_ACCESS_TOOL_DEFS, ensureResourceAccessSchema, resourceAccessCheck, handleResourceAccessTool } = require("./resource_access_control");
const { RUNTIME_GOVERNANCE_TOOL_DEFS, ensureRuntimeGovernanceSchema, handleRuntimeGovernanceTool, runtimeToolReceiptStart } = require("./runtime_governance");
const { MEMORY_CONSOLIDATION_TOOL_DEFS, ensureMemoryConsolidationSchema, handleMemoryConsolidationTool } = require("./memory_consolidation");
const { AGENT_GOVERNANCE_TOOL_DEFS, ensureAgentGovernanceSchema, handleAgentGovernanceTool, capabilityTokenCheck, requiresCapabilityToken } = require("./agent_governance");

const readline = require("readline");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const SERVER_NAME = "mnemo";
const SERVER_VERSION = "0.2.0";

// ============================================================
// Cross-host hub routing
// ============================================================
// When a brief targets an agent that does NOT live on this PC, the operation
// must be forwarded to the cross-host hub instead of the local SQLite.
// LOCAL_AGENTS = comma-separated list of lowercase agent names that live here.
// Anything else is treated as remote and routed via HTTP to MNEMO_HUB_URL.
//
// Set MNEMO_LOCAL_AGENTS to comma-separated lowercase agent names that live here.
// Disable hub routing entirely with MNEMO_HUB_URL="" (empty).
const HUB_URL = process.env.MNEMO_HUB_URL || "";
const HUB_PRIMARY = process.env.MNEMO_HUB_PRIMARY === "1";
const HUB_PRIMARY_STRICT = process.env.MNEMO_HUB_PRIMARY_STRICT !== "0";
const LOCAL_AGENTS = new Set(
  String(process.env.MNEMO_LOCAL_AGENTS || "")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
const HUB_PRIMARY_LOCAL_ONLY = new Set([
  "mem_code_outline",
  "mem_code_unfold",
  "mem_context_preview",
]);
const HUB_CANONICAL_OPS_TOOLS = new Set([
  "mem_autonomy_sweep",
  "mem_autonomy_next",
  "mem_autonomy_task_update",
  "mem_brief_requeue_stale",
  "mem_connect_channel_list",
  "mem_connect_list",
  "mem_agent_mail_account_upsert",
  "mem_agent_mail_account_list",
  "mem_agent_mail_inbox",
  "mem_agent_mail_outbox",
  "mem_agent_mail_record_inbound",
  "mem_agent_mail_dispatch",
  "mem_agent_mail_queue_outbound",
  "mem_agent_mail_mark",
  "mem_access_upsert",
  "mem_access_list",
  "mem_access_guide",
  "mem_access_route_resolve",
  "mem_access_preflight",
  "mem_access_event_log",
  "mem_runtime_binding_upsert",
  "mem_runtime_binding_list",
  "mem_runtime_capability_upsert",
  "mem_runtime_capability_list",
  "mem_runtime_capability_check",
  "mem_runtime_tool_receipt_start",
  "mem_runtime_tool_receipt_finish",
  "mem_runtime_tool_receipt_list",
  "mem_memory_layer_status",
  "mem_memory_rem_plan",
  "mem_memory_rem_run",
  "mem_memory_consolidation_list",
  "mem_department_journal_add",
  "mem_department_journal_list",
  "mem_agent_sleep_note_add",
  "mem_agent_sleep_note_list",
  "mem_memory_promotion_propose",
  "mem_memory_promotion_list",
  "mem_memory_promotion_decide",
  "mem_company_rem_brief",
  "mem_work_order_template_list",
  "mem_work_order_template_upsert",
  "mem_work_order_create_from_template",
  "mem_quality_gate_template_list",
  "mem_quality_gate_run",
  "mem_context_snapshot_create",
  "mem_context_restore_brief",
  "mem_work_order_create",
  "mem_work_order_list",
  "mem_work_order_complete",
  "mem_capability_token_issue",
  "mem_capability_token_check",
  "mem_capability_token_revoke",
  "mem_department_charter_set",
  "mem_department_charter_get",
  "mem_department_charter_list",
  "mem_intent_route",
  "mem_autonomy_score_report",
  "mem_media_capture",
  "mem_media_recent",
  "mem_media_search",
  "mem_media_get",
  "mem_firm_readiness_board",
  "mem_project_registry_upsert",
  "mem_project_registry_get",
  "mem_project_registry_list",
  "mem_project_rules_set",
  "mem_project_rules_get",
  "mem_project_rules_list",
  "mem_quality_finding_report",
  "mem_quality_finding_list",
  "mem_quality_finding_resolve",
]);
function resolveTeamBriefTargets() {
  const configured = uniqueAgentNames(parseAgentCsv(process.env.MNEMO_TEAM_AGENTS || process.env.MNEMO_LOCAL_AGENTS));
  if (configured.length) return configured;
  try {
    const online = db.prepare("SELECT agent_name FROM agent_registry WHERE status='online' ORDER BY agent_name").all().map((r) => r.agent_name);
    const resolved = uniqueAgentNames(online);
    if (resolved.length) return resolved;
  } catch {}
  try {
    return uniqueAgentNames(db.prepare("SELECT agent_name FROM agent_registry ORDER BY last_seen_at DESC, agent_name ASC LIMIT 20").all().map((r) => r.agent_name));
  } catch {
    return [];
  }
}
const TEAM_QUALITY_WRITE_TOOLS = new Set([
  "mem_agent_training_rule_upsert",
  "mem_correction_capture",
  "mem_site_contract_set",
  "mem_site_golden_check_report",
]);
function isRemoteAgent(name) {
  if (!HUB_URL) return false;
  if (!name) return false;
  return !LOCAL_AGENTS.has(String(name).toLowerCase());
}
async function callHub(toolName, args) {
  if (!HUB_URL) throw new Error("hub disabled (MNEMO_HUB_URL empty)");
  const res = await fetch(`${HUB_URL}/tool/${toolName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`hub ${toolName} ${res.status}: ${txt.slice(0, 200)}`);
  }
  const j = await res.json();
  // Hub responses are wrapped: {tool, result}. Unwrap.
  return j && typeof j === "object" && "result" in j ? j.result : j;
}

function shouldUseHubPrimary(toolName) {
  const name = String(toolName || "");
  return !!(HUB_URL && name.startsWith("mem_") && !HUB_PRIMARY_LOCAL_ONLY.has(name) && (HUB_PRIMARY || HUB_CANONICAL_OPS_TOOLS.has(name)));
}

async function callTeamQualityTool(toolName, args) {
  if (HUB_URL) {
    try {
      return await callHub(toolName, args || {});
    } catch (e) {
      if (TEAM_QUALITY_WRITE_TOOLS.has(toolName)) {
        return {
          ok: false,
          error: "hub unavailable; not writing team-quality state to local fallback",
          _routed: "hub-required",
          _hub_error: String(e.message || e),
        };
      }
      const local = handleTeamQualityTool(db, toolName, args || {});
      if (!local.handled) return { error: "tool not found: " + toolName };
      if (local.result && typeof local.result === "object" && !Array.isArray(local.result)) {
        return Object.assign({}, local.result, { _routed: "local-fallback", _hub_error: String(e.message || e) });
      }
      return { result: local.result, _routed: "local-fallback", _hub_error: String(e.message || e) };
    }
  }
  const local = handleTeamQualityTool(db, toolName, args || {});
  return local.handled ? local.result : { error: "tool not found: " + toolName };
}

const db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
ensureAgentMailTables(db);
ensureAccessRouteSchema(db);
ensureProtectedScopeSchema(db);
seedDefaultProtectedScopes(db);
ensureResourceAccessSchema(db);
ensureRuntimeGovernanceSchema(db);
ensureMemoryConsolidationSchema(db);
ensureAgentGovernanceSchema(db);

function ensureReminderTables() {
  db.exec(`
CREATE TABLE IF NOT EXISTS reminder (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_name TEXT NOT NULL DEFAULT 'owner',
  agent_name TEXT,
  scope TEXT,
  title TEXT NOT NULL,
  details TEXT,
  due_at TEXT,
  due_text TEXT,
  due_precision TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT,
  source_ref TEXT,
  channel TEXT,
  actor TEXT,
  actor_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  notified_at TEXT,
  notify_count INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT UNIQUE,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_status_due ON reminder(status, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_owner_due ON reminder(owner_name, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_agent_due ON reminder(agent_name, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_source_ref ON reminder(source, source_ref);
`);
}

function insertReminder(a = {}) {
  ensureReminderTables();
  const text = a.text || a.details || a.title || "";
  const parsed = a.due_at
    ? { due_at: isoOrNull(a.due_at), due_text: a.due_text || String(a.due_at), due_precision: a.due_precision || "explicit", confidence: "high" }
    : parseReminderDue(text, a.base_time || a.occurred_at);
  const dueAt = parsed.due_at || null;
  const status = a.status || (dueAt ? "open" : "needs_due_at");
  const title = a.title || reminderTitleFromText(text);
  const owner = a.owner_name || process.env.MNEMO_OWNER_NAME || "owner";
  const sourceRef = a.source_ref || (a.ref_kind && a.ref_id != null ? `${a.ref_kind}:${a.ref_id}` : null);
  const dedupeKey = a.dedupe_key || crypto.createHash("sha256").update(["reminder", owner, sourceRef || "", title, dueAt || parsed.due_text || "", text].join("|")).digest("hex");
  const meta = Object.assign({}, a.meta || {}, { confidence: parsed.confidence, captured_from_text: !!a.text });
  const info = db.prepare(`
    INSERT OR IGNORE INTO reminder
      (owner_name, agent_name, scope, title, details, due_at, due_text, due_precision, timezone, status, source, source_ref, channel, actor, actor_id, created_by, dedupe_key, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    owner,
    a.agent_name || null,
    a.scope || a.project || null,
    title,
    a.details || text || null,
    dueAt,
    parsed.due_text || a.due_text || null,
    parsed.due_precision || a.due_precision || null,
    a.timezone || null,
    status,
    a.source || null,
    sourceRef,
    a.channel || null,
    a.actor || null,
    a.actor_id || null,
    a.created_by || a.agent_name || a.actor || null,
    dedupeKey,
    JSON.stringify(meta)
  );
  const row = info.changes > 0
    ? db.prepare("SELECT * FROM reminder WHERE id=?").get(info.lastInsertRowid)
    : db.prepare("SELECT * FROM reminder WHERE dedupe_key=?").get(dedupeKey);
  if (row) {
    try {
      db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('reminder', ?, ?, ?, ?)")
        .run(String(row.id), row.agent_name || row.actor || row.owner_name || "", row.title, [row.title, row.details, row.due_text, row.due_at].filter(Boolean).join("\n"));
    } catch {}
  }
  return Object.assign({ ok: true, inserted: info.changes > 0 }, reminderRow(row));
}

function reminderWhere(a = {}) {
  const where = [];
  const params = [];
  if (a.status) { where.push("status=?"); params.push(String(a.status)); }
  else if (!a.include_done) where.push("status IN ('open','needs_due_at','snoozed')");
  if (a.owner_name) { where.push("owner_name=?"); params.push(String(a.owner_name)); }
  if (a.agent_name) { where.push("(agent_name=? OR agent_name IS NULL)"); params.push(String(a.agent_name)); }
  if (a.scope || a.project) { where.push("scope=?"); params.push(String(a.scope || a.project)); }
  if (a.due_before) { where.push("due_at IS NOT NULL AND due_at<=?"); params.push(isoOrNull(a.due_before) || String(a.due_before)); }
  if (a.due_after) { where.push("due_at IS NOT NULL AND due_at>=?"); params.push(isoOrNull(a.due_after) || String(a.due_after)); }
  if (a.query) { where.push("(title LIKE ? OR details LIKE ? OR meta_json LIKE ?)"); const q = "%" + String(a.query) + "%"; params.push(q, q, q); }
  return { where: where.length ? where : ["1=1"], params };
}

function isValidRuntimeAgentName(name) {
  const s = String(name || "").trim();
  if (!s || s === "null" || s === "undefined") return false;
  if (s.includes("/") || s.includes("\\")) return false;
  if (s.length > 80) return false;
  return true;
}

function invalidRuntimeAgentRow(r) {
  return {
    agent_name: r && r.agent_name != null ? String(r.agent_name) : null,
    display_name: r && r.display_name != null ? String(r.display_name) : null,
    host: r && r.host != null ? String(r.host) : null,
    status: r && r.status != null ? String(r.status) : null,
    last_seen_at: r && r.last_seen_at || null,
  };
}

function runtimeHealth(a = {}) {
  const staleSec = Math.max(60, parseInt(a.stale_sec || 300, 10));
  const nowMs = Date.now();
  ensureUniversalJournalSchema();
  let registry = [];
  try {
    registry = db.prepare("SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json FROM agent_registry ORDER BY agent_name").all();
  } catch {}
  let liveByAgent = new Map();
  try {
    const liveRows = db.prepare("SELECT * FROM agent_status_live").all();
    liveByAgent = new Map(liveRows.map((r) => [r.agent_name, r]));
  } catch {}
  let pendingByAgent = new Map();
  try {
    pendingByAgent = new Map(db.prepare("SELECT agent_name, COUNT(*) c FROM agent_brief WHERE status='pending' GROUP BY agent_name").all().map(r => [r.agent_name, r.c]));
  } catch {}
  let errorsByAgent = new Map();
  try {
    errorsByAgent = new Map(db.prepare("SELECT agent_name, COUNT(*) c FROM agent_action WHERE status IN ('error','failed','auth_failed','completion_guard_missing','regression_guard_missing','site_contract_guard_missing') AND started_at > datetime('now','-1 hour') GROUP BY agent_name").all().map(r => [r.agent_name, r.c]));
  } catch {}
  let dueReminders = 0;
  try {
    ensureReminderTables();
    dueReminders = db.prepare("SELECT COUNT(*) c FROM reminder WHERE status='open' AND due_at IS NOT NULL AND due_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')").get().c || 0;
  } catch {}
  const invalidRegistryRows = [];
  const validRegistry = [];
  for (const raw of registry) {
    const r = Object.assign({}, raw, { agent_name: raw && raw.agent_name != null ? String(raw.agent_name).trim() : "" });
    if (!isValidRuntimeAgentName(r.agent_name)) {
      invalidRegistryRows.push(invalidRuntimeAgentRow(raw));
      continue;
    }
    validRegistry.push(r);
  }
  const agents = validRegistry.map((r) => {
    const meta = parseMetaJson(r.meta_json);
    const live = liveByAgent.get(r.agent_name) || null;
    const liveMeta = live ? parseMetaJson(live.meta_json) : {};
    const preflight = meta.last_runtime_preflight || liveMeta.last_runtime_preflight || null;
    const passport = agentPassportData(db, r.agent_name);
    const lastSeenMs = r.last_seen_at ? Date.parse(r.last_seen_at) : 0;
    const ageSec = lastSeenMs ? Math.max(0, Math.round((nowMs - lastSeenMs) / 1000)) : null;
    const stale = ageSec == null || ageSec > staleSec;
    const dirty = !!(meta.mnemo_dirty || liveMeta.mnemo_dirty);
    const blocked = r.status === "blocked" || !!meta.engine_blocked || !!liveMeta.engine_blocked || !!(live && live.blocked_on) || !!(preflight && preflight.status === "blocked");
    const errorCount = errorsByAgent.get(r.agent_name) || 0;
    const health = stale ? "offline" : (blocked ? "blocked" : (dirty ? "dirty" : (errorCount ? "degraded" : "ok")));
    return {
      agent_name: r.agent_name,
      status: r.status,
      health,
      host: r.host,
      pid: r.pid,
      last_seen_at: r.last_seen_at,
      age_sec: ageSec,
      pending_briefs: pendingByAgent.get(r.agent_name) || 0,
      errors_1h: errorCount,
      current_task: live && live.current_task || null,
      blocked_on: live && live.blocked_on || null,
      loop_version: meta.loop_version || liveMeta.loop_version || null,
      requested_engine: meta.requested_engine || liveMeta.requested_engine || null,
      engine: meta.engine || liveMeta.engine || null,
      engine_command: meta.engine_command || liveMeta.engine_command || null,
      mnemo_git_commit: meta.mnemo_git_commit || liveMeta.mnemo_git_commit || null,
      mnemo_git_branch: meta.mnemo_git_branch || liveMeta.mnemo_git_branch || null,
      mnemo_dirty: dirty,
      workspace: meta.workspace || liveMeta.workspace || null,
      workspace_git_commit: meta.workspace_git_commit || liveMeta.workspace_git_commit || null,
      workspace_dirty: !!(meta.workspace_dirty || liveMeta.workspace_dirty),
      last_runtime_preflight: preflight,
      runtime_preflight_status: preflight && preflight.status || null,
      runtime_preflight_blocked_on: preflight && preflight.blocked_on || null,
      runtime_preflight_degraded_on: preflight && preflight.degraded_on || null,
      passport_source: passport.source_kind,
      passport_status: passport.status,
      passport_lane: passport.lane,
      passport_departments: passport.departments,
      live_write: passport.live_write,
      review_required: passport.review_required,
      approval_class: passport.approval_class,
    };
  });
  const connectors = connectorListData(db, { include_derived: true, include_access_routes: false, stale_days: a.connector_stale_days || 30 });
  const explicitPassports = db.prepare("SELECT COUNT(*) c FROM agent_passport").get().c || 0;
  const summary = {
    total: agents.length,
    ok: agents.filter(a => a.health === "ok").length,
    dirty: agents.filter(a => a.health === "dirty").length,
    degraded: agents.filter(a => a.health === "degraded").length,
    blocked: agents.filter(a => a.health === "blocked").length,
    offline: agents.filter(a => a.health === "offline").length,
    pending_briefs: agents.reduce((sum, a) => sum + (a.pending_briefs || 0), 0),
    errors_1h: agents.reduce((sum, a) => sum + (a.errors_1h || 0), 0),
    due_reminders: dueReminders,
    invalid_registry_rows: invalidRegistryRows.length,
    connectors_total: connectors.length,
    connectors_stale: connectors.filter((connector) => ["stale", "critical"].includes(connector.freshness_status)).length,
    connectors_unhealthy: connectors.filter((connector) => ["error", "degraded", "stale"].includes(String(connector.health_status || ""))).length,
    explicit_passports: explicitPassports,
    derived_passports: Math.max(0, agents.length - explicitPassports),
  };
  const out = { checked_at: new Date().toISOString(), stale_sec: staleSec, summary, agents };
  if (a.include_invalid) out.invalid_registry_rows = invalidRegistryRows;
  return out;
}

const { ensureUniversalJournalSchema: _ensureJournalSchemaShared, ensureProjectRegistryTable: _ensureProjectRegistryTableShared, ensureFirmOpsTables: _ensureFirmOpsTablesShared } = require("./journal_schema");
function ensureUniversalJournalSchema() { _ensureJournalSchemaShared(db); }

function journalEvent(event) {
  if (!event || !event.event_kind) return null;
  try { ensureUniversalJournalSchema(); } catch {}
  const content = compactContent(event.content, event.max_content_chars || 8000);
  const payload = event.payload_json !== undefined ? event.payload_json : jsonSafe(event.payload, event.max_payload_chars || 12000);
  const meta = event.meta_json !== undefined ? event.meta_json : jsonSafe(event.meta, event.max_meta_chars || 12000);
  try {
    const r = db.prepare(
      "INSERT INTO mnemo_event_journal (source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      event.source || "mnemo",
      event.channel || null,
      event.direction || "internal",
      event.actor || null,
      event.actor_id || null,
      event.event_kind,
      event.ref_kind || null,
      event.ref_id != null ? String(event.ref_id) : null,
      event.thread_id || null,
      event.status || null,
      content,
      payload,
      meta,
      event.occurred_at || new Date().toISOString()
    );
    return { id: r.lastInsertRowid };
  } catch {
    return null;
  }
}

function sha256(value) {
  return require("crypto").createHash("sha256").update(String(value)).digest("hex");
}

function captureDedupeKey(a, contentHash) {
  if (a.dedupe_key) return String(a.dedupe_key);
  if (a.source_ref) return sha256(["capture", a.source || "", a.channel || "", a.source_ref].join("|"));
  if (a.ref_id != null) return sha256(["capture", a.source || "", a.channel || "", a.ref_kind || "", String(a.ref_id)].join("|"));
  return sha256(["capture", a.source || "", a.channel || "", a.direction || "", a.actor_id || a.actor || "", a.occurred_at || "", contentHash || ""].join("|"));
}

function mediaCaptureDetails(a = {}) {
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const payload = a.payload && typeof a.payload === "object" ? a.payload : {};
  const mediaPath = a.media_path || meta.media_path || payload.media_path || a.file_path || meta.file_path || payload.file_path || "";
  const originalFileName = a.file_name || meta.file_name || payload.file_name || baseName(mediaPath);
  const fileName = originalFileName;
  const ext = extensionName(fileName || mediaPath);
  const mediaKind = inferMediaKind(a, meta, payload, fileName, ext);
  const mediaType = a.media_type || meta.media_type || payload.media_type || inferMediaType(ext, mediaKind);
  const project = a.project || meta.project || payload.project || "";
  const pageUrl = a.page_url || meta.page_url || payload.page_url || meta.url || payload.url || "";
  const route = a.route || meta.route || payload.route || "";
  const actor = a.actor || a.speaker || meta.actor || "";
  const contextText = a.context_text || a.content || a.text || meta.context_text || meta.caption || meta.message_text || meta.notes || payload.context_text || payload.caption || payload.message_text || payload.notes || "";
  const labels = uniqueStrings([]
    .concat(a.labels || [])
    .concat(meta.labels || [])
    .concat(payload.labels || [])
    .concat(project ? [project] : [])
    .concat(route ? [route] : [])
    .concat(mediaKind ? [mediaKind] : [])
    .concat(mediaType ? [mediaType] : [])
    .concat(actor ? [actor] : [])
    .concat(a.channel ? [a.channel] : []));
  const title = buildMediaTitle(Object.assign({}, a, { meta, payload, project, media_kind: mediaKind, route, page_url: pageUrl, file_name: fileName, context_text: contextText }));
  const canonicalName = buildCanonicalMediaFileName({ source: a.source, channel: a.channel, occurred_at: a.occurred_at, title, file_ext: ext || extensionName(mediaPath), file_name: fileName, media_path: mediaPath });
  return {
    media_path: mediaPath,
    file_name: canonicalName,
    original_file_name: originalFileName || null,
    canonical_name: canonicalName,
    file_ext: ext,
    media_kind: mediaKind,
    media_type: mediaType,
    project,
    page_url: pageUrl,
    route,
    labels,
    title: title || `${mediaKind || "media"} | ${a.source || "capture"}`,
    context_text: contextText || null
  };
}

function materializeMediaFile(details, occurred) {
  if (process.env.MNEMO_MEDIA_STORE === "0") return null;
  const sourcePath = details && details.media_path ? String(details.media_path) : "";
  if (!sourcePath || (/^[a-z]+:/i.test(sourcePath) && !/^[a-z]:[\\/]/i.test(sourcePath))) return null;
  let realSource;
  let stat;
  try {
    realSource = path.resolve(sourcePath);
    stat = fs.statSync(realSource);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const maxBytes = Math.max(1024, parseInt(process.env.MNEMO_MEDIA_COPY_MAX_BYTES || String(25 * 1024 * 1024), 10));
  if (stat.size > maxBytes) return null;
  const root = process.env.MNEMO_MEDIA_DIR || path.join(__dirname, "media");
  const datePart = String(occurred || new Date().toISOString()).slice(0, 10) || "undated";
  const projectPart = slugFilePart(details.project || "unassigned", 80);
  const destDir = path.join(root, projectPart, datePart);
  const destPath = path.join(destDir, details.canonical_name || details.file_name || baseName(realSource));
  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (path.resolve(destPath) !== realSource && !fs.existsSync(destPath)) fs.copyFileSync(realSource, destPath);
    return destPath;
  } catch {
    return null;
  }
}

function ensureMediaAssetRuntimeSchema(target = db) {
  target.exec(`
CREATE TABLE IF NOT EXISTS media_asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE,
  source TEXT NOT NULL,
  channel TEXT,
  thread_id TEXT,
  actor TEXT,
  event_kind TEXT,
  media_kind TEXT NOT NULL,
  media_type TEXT,
  title TEXT NOT NULL,
  file_name TEXT,
  original_file_name TEXT,
  canonical_name TEXT,
  file_ext TEXT,
  media_path TEXT,
  storage_path TEXT,
  content_ref TEXT,
  page_url TEXT,
  route TEXT,
  project TEXT,
  labels_json TEXT,
  notes TEXT,
  ref_kind TEXT,
  ref_id TEXT,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'captured',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
  const cols = target.prepare("PRAGMA table_info(media_asset)").all().map((c) => c.name);
  if (!cols.includes("original_file_name")) target.exec("ALTER TABLE media_asset ADD COLUMN original_file_name TEXT");
  if (!cols.includes("canonical_name")) target.exec("ALTER TABLE media_asset ADD COLUMN canonical_name TEXT");
  if (!cols.includes("storage_path")) target.exec("ALTER TABLE media_asset ADD COLUMN storage_path TEXT");
  if (!cols.includes("content_ref")) target.exec("ALTER TABLE media_asset ADD COLUMN content_ref TEXT");
  target.exec(`
CREATE INDEX IF NOT EXISTS idx_media_occurred ON media_asset(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_project ON media_asset(project, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media_asset(media_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_thread ON media_asset(thread_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_canonical ON media_asset(canonical_name);
`);
}

function upsertMediaAssetFromCapture(a = {}, dedupeKey, occurred, meta) {
  const details = mediaCaptureDetails(Object.assign({}, a, { occurred_at: a.occurred_at || occurred }));
  if (!details.media_path && !details.file_name && !details.media_kind) return null;
  ensureMediaAssetRuntimeSchema(db);
  const storagePath = materializeMediaFile(details, occurred);
  const contentRef = a.ref_kind && a.ref_id != null ? `${a.ref_kind}:${a.ref_id}` : (a.source_ref || a.thread_id || a.session_id || null);
  const existing = db.prepare("SELECT id FROM media_asset WHERE dedupe_key=?").get(dedupeKey);
  const payload = {
    dedupe_key: dedupeKey,
    source: a.source || "capture",
    channel: a.channel || null,
    thread_id: a.thread_id || a.session_id || null,
    actor: a.actor || a.speaker || null,
    event_kind: a.event_kind || "message",
    media_kind: details.media_kind || "file",
    media_type: details.media_type || null,
    title: details.title,
    file_name: details.file_name || null,
    original_file_name: details.original_file_name || null,
    canonical_name: details.canonical_name || details.file_name || null,
    file_ext: details.file_ext || null,
    media_path: details.media_path || null,
    storage_path: storagePath || null,
    content_ref: contentRef || null,
    page_url: details.page_url || null,
    route: details.route || null,
    project: details.project || null,
    labels_json: JSON.stringify(details.labels || []),
    notes: a.notes || (meta && meta.notes) || null,
    ref_kind: a.ref_kind || null,
    ref_id: a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
    occurred_at: occurred,
    status: a.status || "captured",
    meta_json: JSON.stringify(Object.assign({}, meta || {}, { media_indexed: true, original_file_name: details.original_file_name || null, canonical_name: details.canonical_name || null, storage_path: storagePath || null, context_text: details.context_text || null }))
  };
  if (existing) {
    db.prepare("UPDATE media_asset SET source=?, channel=?, thread_id=?, actor=?, event_kind=?, media_kind=?, media_type=?, title=?, file_name=?, original_file_name=?, canonical_name=?, file_ext=?, media_path=?, storage_path=?, content_ref=?, page_url=?, route=?, project=?, labels_json=?, notes=?, ref_kind=?, ref_id=?, occurred_at=?, status=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dedupe_key=?")
      .run(payload.source, payload.channel, payload.thread_id, payload.actor, payload.event_kind, payload.media_kind, payload.media_type, payload.title, payload.file_name, payload.original_file_name, payload.canonical_name, payload.file_ext, payload.media_path, payload.storage_path, payload.content_ref, payload.page_url, payload.route, payload.project, payload.labels_json, payload.notes, payload.ref_kind, payload.ref_id, payload.occurred_at, payload.status, payload.meta_json, dedupeKey);
    return { id: existing.id, status: "updated", title: payload.title, media_kind: payload.media_kind };
  }
  const info = db.prepare("INSERT INTO media_asset (dedupe_key, source, channel, thread_id, actor, event_kind, media_kind, media_type, title, file_name, original_file_name, canonical_name, file_ext, media_path, storage_path, content_ref, page_url, route, project, labels_json, notes, ref_kind, ref_id, occurred_at, status, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(payload.dedupe_key, payload.source, payload.channel, payload.thread_id, payload.actor, payload.event_kind, payload.media_kind, payload.media_type, payload.title, payload.file_name, payload.original_file_name, payload.canonical_name, payload.file_ext, payload.media_path, payload.storage_path, payload.content_ref, payload.page_url, payload.route, payload.project, payload.labels_json, payload.notes, payload.ref_kind, payload.ref_id, payload.occurred_at, payload.status, payload.meta_json);
  return { id: info.lastInsertRowid, status: "created", title: payload.title, media_kind: payload.media_kind };
}

function insertCaptureMemory(a, content, dedupeKey, meta) {
  const kind = a.memory_kind || a.kind || "message";
  const source = a.source || "capture";
  const sourceRef = a.source_ref || (a.ref_kind && a.ref_id != null ? `${a.ref_kind}:${a.ref_id}` : dedupeKey);
  const occurred = a.occurred_at || new Date().toISOString();
  const hash = sha256([kind, sourceRef || "", occurred, content].join("|"));
  const info = db.prepare(`
    INSERT OR IGNORE INTO memory
      (kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta_json, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    kind,
    source,
    sourceRef,
    occurred,
    a.actor || a.speaker || null,
    a.actor_id || null,
    a.topic || a.channel || null,
    a.importance ?? 4,
    content,
    meta ? JSON.stringify(meta) : null,
    hash
  );
  if (info.changes > 0) return info.lastInsertRowid;
  const row = db.prepare("SELECT id FROM memory WHERE hash=?").get(hash);
  return row ? row.id : null;
}

function captureHasMedia(a = {}) {
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const payload = a.payload && typeof a.payload === "object" ? a.payload : {};
  return !!(
    a.media_path || a.file_path || a.file_name ||
    meta.media_path || meta.file_path || meta.file_name ||
    payload.media_path || payload.file_path || payload.file_name
  );
}

function validateCaptureEnvelope(a = {}, content) {
  const source = String(a.source || "").trim().toLowerCase();
  const channel = String(a.channel || "").trim().toLowerCase();
  const refKind = String(a.ref_kind || "").trim().toLowerCase();
  const refId = a.ref_id != null ? String(a.ref_id).trim() : "";
  const threadId = String(a.thread_id || a.session_id || "").trim();
  const actor = String(a.actor || a.speaker || "").trim();
  const actorId = String(a.actor_id || "").trim();
  const occurredAt = String(a.occurred_at || "").trim();
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const hasMedia = captureHasMedia(a);
  const chatId = String(meta.chat_id || "").trim();
  const messageId = meta.message_id != null ? String(meta.message_id).trim() : "";
  const isTelegram = source === "telegram" || channel.startsWith("telegram-");
  if (!isTelegram) return { ok: true, errors: [] };
  const errors = [];
  const isChatScoped = channel.startsWith("telegram-chat:") || channel.startsWith("telegram-dm:");
  if (!channel) errors.push("channel required");
  if (!actor) errors.push("actor/speaker required");
  if (!occurredAt) errors.push("occurred_at required");
  if (!threadId) errors.push("thread_id/session_id required");
  if (!content && !hasMedia) errors.push("content or media attachment required");
  if (isChatScoped || refKind === "telegram_message") {
    if (!actorId) errors.push("actor_id required for telegram message");
    if (!chatId) errors.push("meta.chat_id required for telegram message");
    if (!messageId && !refId) errors.push("meta.message_id or ref_id required for telegram message");
    if (refKind && refKind !== "telegram_message") errors.push("ref_kind must be telegram_message for telegram message capture");
  }
  if (hasMedia) {
    if (!threadId) errors.push("thread binding required for media capture");
    if (!chatId) errors.push("meta.chat_id required for telegram media");
    if (!messageId && !refId) errors.push("meta.message_id or ref_id required for telegram media");
  }
  return { ok: errors.length === 0, errors, isTelegram, isChatScoped, hasMedia };
}

function captureIngest(a = {}) {
  try { ensureUniversalJournalSchema(); } catch {}
  if (!a.source) return { ok: false, error: "source required" };
  const eventKind = a.event_kind || "message";
  const occurred = a.occurred_at || new Date().toISOString();
  const direction = a.direction || "internal";
  const content = compactContent(a.content !== undefined ? a.content : a.text, a.max_content_chars || 8000) || "";
  const validation = validateCaptureEnvelope(Object.assign({}, a, { occurred_at: occurred, direction }), content);
  if (!validation.ok) {
    const error = `capture_validation_failed: ${validation.errors.join("; ")}`;
    try {
      journalEvent({
        source: a.source || "capture",
        channel: a.channel || null,
        direction,
        actor: a.actor || a.speaker || null,
        actor_id: a.actor_id || null,
        event_kind: "capture_validation_failed",
        ref_kind: a.ref_kind || null,
        ref_id: a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
        thread_id: a.thread_id || a.session_id || null,
        status: "error",
        content,
        payload: a.payload || null,
        meta: Object.assign({}, a.meta || {}, { validation_errors: validation.errors }),
        occurred_at: occurred
      });
    } catch {}
    return { ok: false, error, validation_errors: validation.errors };
  }
  const contentHash = content ? sha256(content) : null;
  const dedupeKey = captureDedupeKey(Object.assign({}, a, { occurred_at: occurred, direction }), contentHash);
  const existing = db.prepare("SELECT dedupe_key, event_id, transcript_id, memory_id, seen_count FROM capture_receipt WHERE dedupe_key=?").get(dedupeKey);
  const meta = Object.assign({}, a.meta || {}, {
    dedupe_key: dedupeKey,
    source_ref: a.source_ref || null,
    capture_policy: "capture-by-default"
  });

  if (existing) {
    db.prepare("UPDATE capture_receipt SET seen_count=seen_count+1, last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status='duplicate' WHERE dedupe_key=?").run(dedupeKey);
    const duplicateEvent = journalEvent({
      source: a.source,
      channel: a.channel || null,
      direction,
      actor: a.actor || a.speaker || null,
      actor_id: a.actor_id || null,
      event_kind: "capture_duplicate",
      ref_kind: a.ref_kind || "capture_receipt",
      ref_id: a.ref_id != null ? String(a.ref_id) : dedupeKey,
      thread_id: a.thread_id || a.session_id || null,
      status: "duplicate",
      content,
      payload: { dedupe_key: dedupeKey, existing },
      meta
    });
    return { ok: true, status: "duplicate", duplicate: true, dedupe_key: dedupeKey, audit_event_id: duplicateEvent && duplicateEvent.id, existing };
  }

  let eventId = null;
  let transcriptId = null;
  let memoryId = null;
  let mediaId = null;
  const txn = db.transaction(() => {
    const event = journalEvent({
      source: a.source,
      channel: a.channel || null,
      direction,
      actor: a.actor || a.speaker || null,
      actor_id: a.actor_id || null,
      event_kind: eventKind,
      ref_kind: a.ref_kind || null,
      ref_id: a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
      thread_id: a.thread_id || a.session_id || null,
      status: a.status || "captured",
      content,
      payload: a.payload || null,
      meta,
      occurred_at: occurred
    });
    eventId = event && event.id;
    if (content && a.promote_transcript !== false) {
      const info = db.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(a.source, a.channel || null, direction === "outbound" ? "outbound" : "inbound", a.speaker || a.actor || null, content, JSON.stringify(meta), occurred, a.ref_kind || "capture", a.ref_id != null ? String(a.ref_id) : dedupeKey);
      transcriptId = info.lastInsertRowid;
      try { db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)").run(String(transcriptId), a.speaker || a.actor || a.source || "", (direction || "") + (a.channel ? " @ " + a.channel : ""), content.slice(0, 8000)); } catch {}
    }
    if (content && (a.promote_memory === true || a.remember === true)) {
      memoryId = insertCaptureMemory(a, content, dedupeKey, meta);
    }
    const media = upsertMediaAssetFromCapture(a, dedupeKey, occurred, meta);
    mediaId = media && media.id || null;
    db.prepare(`
      INSERT INTO capture_receipt
        (dedupe_key, source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, occurred_at, content_hash, content_preview, event_id, transcript_id, memory_id, status, meta_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      dedupeKey,
      a.source,
      a.channel || null,
      direction,
      a.actor || a.speaker || null,
      a.actor_id || null,
      eventKind,
      a.ref_kind || null,
      a.ref_id != null ? String(a.ref_id) : (a.source_ref || null),
      a.thread_id || a.session_id || null,
      occurred,
      contentHash,
      content.slice(0, 500),
      eventId,
      transcriptId,
      memoryId,
      "captured",
      JSON.stringify(meta)
    );
  });
  txn();
  return { ok: true, status: "captured", duplicate: false, dedupe_key: dedupeKey, event_id: eventId, transcript_id: transcriptId, memory_id: memoryId, media_id: mediaId };
}

function mirrorTranscriptCapture(a = {}, transcriptId, content, privateRedacted) {
  try { ensureUniversalJournalSchema(); } catch {}
  if (!transcriptId || !a.source || !content) return { ok: false, skipped: true };
  const direction = a.direction || "internal";
  const occurred = a.occurred_at || new Date().toISOString();
  const refId = a.ref_id != null ? String(a.ref_id) : null;
  const sourceRef = a.source_ref || (a.ref_kind && refId ? `${a.ref_kind}:${refId}` : `transcript:${transcriptId}`);
  const contentHash = sha256(content);
  const threadId = a.thread_id || a.session_id || (a.meta && (a.meta.thread_id || a.meta.console_thread_id)) || null;
  const meta = Object.assign({}, a.meta || {}, {
    dedupe_key: null,
    source_ref: sourceRef,
    capture_policy: "transcript-mirror",
    mirrored_from: "mem_transcript_log",
    transcript_id: transcriptId,
    private_redacted: !!privateRedacted
  });
  const dedupeKey = captureDedupeKey(Object.assign({}, a, {
    occurred_at: occurred,
    direction,
    ref_id: refId,
    source_ref: sourceRef,
    thread_id: threadId
  }), contentHash);
  meta.dedupe_key = dedupeKey;
  const existing = db.prepare("SELECT dedupe_key, transcript_id, event_id, memory_id, seen_count, status FROM capture_receipt WHERE dedupe_key=?").get(dedupeKey);
  if (existing) {
    db.prepare(
      "UPDATE capture_receipt SET transcript_id=COALESCE(transcript_id, ?), last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), seen_count=seen_count+1, status=CASE WHEN status='captured' THEN status ELSE 'duplicate' END, meta_json=? WHERE dedupe_key=?"
    ).run(transcriptId, JSON.stringify(meta), dedupeKey);
    return { ok: true, duplicate: true, dedupe_key: dedupeKey, existing };
  }
  const event = journalEvent({
    source: a.source,
    channel: a.channel || null,
    direction,
    actor: a.speaker || a.actor || null,
    actor_id: a.actor_id || null,
    event_kind: a.event_kind || "transcript",
    ref_kind: a.ref_kind || "transcript",
    ref_id: refId || String(transcriptId),
    thread_id: threadId,
    status: a.status || "captured",
    content,
    payload: a.payload || null,
    meta,
    occurred_at: occurred
  });
  let memoryId = null;
  if (a.remember === true || a.promote_memory === true) {
    memoryId = insertCaptureMemory(a, content, dedupeKey, meta);
  }
  db.prepare(`
    INSERT INTO capture_receipt
      (dedupe_key, source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, occurred_at, content_hash, content_preview, event_id, transcript_id, memory_id, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    dedupeKey,
    a.source,
    a.channel || null,
    direction,
    a.speaker || a.actor || null,
    a.actor_id || null,
    a.event_kind || "transcript",
    a.ref_kind || "transcript",
    refId || String(transcriptId),
    threadId,
    occurred,
    contentHash,
    content.slice(0, 500),
    event && event.id || null,
    transcriptId,
    memoryId,
    "captured",
    JSON.stringify(meta)
  );
  return { ok: true, duplicate: false, dedupe_key: dedupeKey, event_id: event && event.id || null, transcript_id: transcriptId, memory_id: memoryId };
}

function captureBriefConversation(briefId, agentName, sourceAgent, content, channel, meta, options = {}) {
  if (!briefId || !content) return { ok: false, skipped: true };
  const direction = options.direction || "inbound";
  const actor = direction === "outbound" ? (agentName || sourceAgent || null) : (sourceAgent || agentName || null);
  const captureMeta = Object.assign({}, meta || {}, options.meta || {}, {
    brief_id: briefId,
    brief_agent: agentName || null,
    brief_source_agent: sourceAgent || null
  });
  return captureIngest({
    source: options.source || "brief",
    channel: channel || options.channel || "brief",
    direction,
    actor,
    speaker: actor,
    event_kind: options.event_kind || "brief_message",
    ref_kind: "agent_brief",
    ref_id: String(briefId),
    source_ref: `agent_brief:${briefId}`,
    thread_id: captureMeta.thread_id || `brief:${briefId}`,
    occurred_at: options.occurred_at || captureMeta.occurred_at || new Date().toISOString(),
    content,
    promote_transcript: true,
    promote_memory: options.promote_memory !== false,
    remember: options.remember !== false,
    importance: options.importance != null ? options.importance : 7,
    meta: captureMeta
  });
}

const FACTS_DIR = process.env.MNEMO_FACTS_DIR || path.join(__dirname, "facts");
const DEFAULT_SCOPE = cleanScope(process.env.MNEMO_DEFAULT_SCOPE || "default");
const DEFAULT_AGENT = process.env.MNEMO_DEFAULT_AGENT || process.env.MNEMO_AGENT || "agent";
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function factsPathFor(scope, suffix) {
  return path.join(FACTS_DIR, scopeName(scope) + (suffix || "") + ".json");
}

// Load sqlite-vec extension (semantic recall). Soft-fail if unavailable.
let _vecLoaded = false;
let _embeddings = null;
try {
  const sv = require("sqlite-vec");
  sv.load(db);
  // Make sure vec_memory exists (idempotent)
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[384])");
  _vecLoaded = true;
} catch (e) {
  console.error("[mnemo-mcp] sqlite-vec not loaded:", e.message);
}
try { _embeddings = require("./embeddings"); } catch (e) { console.error("[mnemo-mcp] embeddings module missing:", e.message); }


db.exec(`
CREATE TABLE IF NOT EXISTS agent_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT,
  result_json TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  latency_ms INTEGER,
  session_id TEXT,
  topic TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_agent_started ON agent_action(agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_kind ON agent_action(action_kind);
CREATE INDEX IF NOT EXISTS idx_action_topic ON agent_action(topic);
`);

// Ensure Phase 1.5 tables exist regardless of whether scanners (commitments.js) ran.
// Without this, mem_commitment_open / mem_commitment_due fail with "table missing".
db.exec(`
CREATE TABLE IF NOT EXISTS commitment (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_name           TEXT NOT NULL,
  origin_memory_id     INTEGER REFERENCES memory(id) ON DELETE CASCADE,
  text                 TEXT NOT NULL,
  category             TEXT,
  expected_followup_at TEXT,
  detected_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  surfaced_at          TEXT,
  closed_at            TEXT,
  outcome              TEXT,
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'open',
  UNIQUE(origin_memory_id, text)
);
CREATE INDEX IF NOT EXISTS idx_commit_status ON commitment(status);
CREATE INDEX IF NOT EXISTS idx_commit_followup ON commitment(expected_followup_at);

CREATE TABLE IF NOT EXISTS agent_brief (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name      TEXT NOT NULL,
  source_agent    TEXT,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at   TEXT,
  done_at         TEXT,
  outcome         TEXT,
  meta_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_brief_agent_status ON agent_brief(agent_name, status);
CREATE INDEX IF NOT EXISTS idx_brief_created ON agent_brief(created_at);

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_name      TEXT PRIMARY KEY,
  display_name    TEXT,
  host            TEXT,
  pid             INTEGER,
  skills_json     TEXT,
  status          TEXT NOT NULL DEFAULT 'online',
  registered_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_registry_lastseen ON agent_registry(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);

CREATE TABLE IF NOT EXISTS channel (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS channel_subscription (
  channel_name    TEXT NOT NULL REFERENCES channel(name) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL REFERENCES agent_registry(agent_name) ON DELETE CASCADE,
  subscribed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_name, agent_name)
);
`);

// Add channel column to agent_brief if missing (idempotent migration).
try {
  const cols = db.prepare("PRAGMA table_info(agent_brief)").all().map(c => c.name);
  if (!cols.includes("channel")) {
    db.exec("ALTER TABLE agent_brief ADD COLUMN channel TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_brief_channel_status ON agent_brief(channel, status)");
  }
} catch (e) { console.error("[mnemo-mcp] agent_brief migration failed:", e.message); }

try { ensureUniversalJournalSchema(); } catch (e) { console.error("[mnemo-mcp] journal schema failed:", e.message); }


// ===========================================================================
// firm_os Phase 1 — Mnemo as a structured-firm coordination layer
// Added 2026-05-07. Goal: every move/file/page/decision/wish tracked, every
// agent's status visible, no silent context loss across PCs and local runtime lanes.
// All idempotent; safe to re-run on existing DBs.
// ===========================================================================
db.exec(`
-- generic registry of structured entities the firm cares about.
-- kind: 'employee' | 'agent' | 'project' | 'page' | 'function' | 'skill' | 'tool' | 'customer' | 'investor' | 'vendor' | 'server' | 'domain'
CREATE TABLE IF NOT EXISTS entity (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'default',
  owner_agent     TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  parent_id       INTEGER REFERENCES entity(id) ON DELETE SET NULL,
  url             TEXT,
  meta_json       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(kind, name, scope)
);
CREATE INDEX IF NOT EXISTS idx_entity_kind_status ON entity(kind, status);
CREATE INDEX IF NOT EXISTS idx_entity_owner ON entity(owner_agent);
CREATE INDEX IF NOT EXISTS idx_entity_scope ON entity(scope);

-- typed cross-links between entities (e.g. function uses skill, page belongs to project, customer at company).
CREATE TABLE IF NOT EXISTS entity_link (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id         INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  to_id           INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  rel             TEXT NOT NULL,
  meta_json       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(from_id, to_id, rel)
);
CREATE INDEX IF NOT EXISTS idx_entity_link_from ON entity_link(from_id, rel);
CREATE INDEX IF NOT EXISTS idx_entity_link_to ON entity_link(to_id, rel);

-- file ownership: every tracked file gets a primary agent + history of editors.
-- prevents "wer hat den Header gebaut" being a guess.
CREATE TABLE IF NOT EXISTS file_ownership (
  file_path           TEXT PRIMARY KEY,
  host                TEXT,
  primary_agent       TEXT,
  secondary_agents    TEXT,
  last_edit_agent     TEXT,
  last_edit_at        TEXT,
  last_commit_sha     TEXT,
  project_entity_id   INTEGER REFERENCES entity(id) ON DELETE SET NULL,
  meta_json           TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_file_ownership_primary ON file_ownership(primary_agent);
CREATE INDEX IF NOT EXISTS idx_file_ownership_lastedit ON file_ownership(last_edit_at);

-- wish_buffer: every casual owner "I would like X" gets captured here, NOT auto-built.
-- agents review weekly, owner approves/rejects/files-as-roadmap.
CREATE TABLE IF NOT EXISTS wish_buffer (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel      TEXT,
  source_chat_id      TEXT,
  source_message_id   TEXT,
  captured_text       TEXT NOT NULL,
  captured_by_agent   TEXT,
  captured_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  classification      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  reviewed_by         TEXT,
  reviewed_at         TEXT,
  decision_id         INTEGER,
  meta_json           TEXT
);
CREATE INDEX IF NOT EXISTS idx_wish_status ON wish_buffer(status, captured_at);
CREATE INDEX IF NOT EXISTS idx_wish_classification ON wish_buffer(classification);

-- decision_log: every binding owner directive, architectural decision, or legal decision with file impact.
-- replaces the loose "memory" entries we use today for decisions.
CREATE TABLE IF NOT EXISTS decision_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT NOT NULL DEFAULT 'default',
  title               TEXT NOT NULL,
  body                TEXT,
  decided_by          TEXT NOT NULL,
  decided_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agents_involved     TEXT,
  files_affected      TEXT,
  entities_affected   TEXT,
  parent_decision_id  INTEGER REFERENCES decision_log(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  superseded_by       INTEGER REFERENCES decision_log(id) ON DELETE SET NULL,
  meta_json           TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_decided_at ON decision_log(decided_at);
CREATE INDEX IF NOT EXISTS idx_decision_status ON decision_log(status);
CREATE INDEX IF NOT EXISTS idx_decision_decided_by ON decision_log(decided_by);

-- live agent status: what each agent is doing right now, plus DND flag.
-- used by routers to decide who can take a new task and who's busy.
CREATE TABLE IF NOT EXISTS agent_status_live (
  agent_name          TEXT PRIMARY KEY,
  current_task        TEXT,
  current_brief_id    INTEGER REFERENCES agent_brief(id) ON DELETE SET NULL,
  blocked_on          TEXT,
  dnd_until           TEXT,
  last_heartbeat_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  host                TEXT,
  pid                 INTEGER,
  meta_json           TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_status_dnd ON agent_status_live(dnd_until);
`);

function ensureFirmOpsTables(tdb) { _ensureFirmOpsTablesShared(tdb || db); }

function workReportFeedData(dbx, input = {}) {
  ensureAutonomyTables(dbx);
  const project = input.project ? String(input.project) : null;
  const agentName = input.agent_name ? String(input.agent_name) : null;
  const includeBlocked = !!input.include_blocked;
  const limit = Math.max(1, Math.min(parseInt(input.limit || 20, 10) || 20, 200));

  const handoffWhere = [];
  const handoffParams = [];
  if (project) {
    handoffWhere.push("project=?");
    handoffParams.push(project);
  }
  if (agentName) {
    handoffWhere.push("agent_name=?");
    handoffParams.push(agentName);
  }
  handoffParams.push(limit);
  const reports = dbx.prepare(
    "SELECT id, agent_name, project, summary, changed_files, tests, deploys, blockers, next_actions, claims_released, meta_json, created_at " +
    "FROM session_handoff " +
    (handoffWhere.length ? "WHERE " + handoffWhere.join(" AND ") + " " : "") +
    "ORDER BY created_at DESC LIMIT ?"
  ).all(...handoffParams).map(row => ({
    id: row.id,
    kind: "report",
    at: row.created_at,
    agent_name: row.agent_name,
    project: row.project || null,
    summary: row.summary,
    changed_files: parseMaybeJson(row.changed_files, []),
    tests: parseMaybeJson(row.tests, []),
    deploys: parseMaybeJson(row.deploys, []),
    blockers: parseMaybeJson(row.blockers, []),
    next_actions: parseMaybeJson(row.next_actions, []),
    claims_released: parseMaybeJson(row.claims_released, []),
    meta: parseMaybeJson(row.meta_json, {})
  }));

  const doneStatuses = includeBlocked
    ? ["review", "done", "closed", "resolved", "blocked"]
    : ["review", "done", "closed", "resolved"];
  const taskWhere = ["status IN (" + doneStatuses.map(() => "?").join(",") + ")"];
  const taskParams = [...doneStatuses];
  if (project) {
    taskWhere.push("project=?");
    taskParams.push(project);
  }
  if (agentName) {
    taskWhere.push("(assigned_agent=? OR reviewer_agent=?)");
    taskParams.push(agentName, agentName);
  }
  taskParams.push(limit);
  const completedTasks = dbx.prepare(
    "SELECT id, project, department_name, title, category, severity, status, assigned_agent, reviewer_agent, source_kind, source_id, checklist_json, notes, meta_json, created_at, updated_at, done_at " +
    "FROM autonomy_task WHERE " + taskWhere.join(" AND ") + " " +
    "ORDER BY COALESCE(done_at, updated_at, created_at) DESC LIMIT ?"
  ).all(...taskParams).map(row => ({
    id: row.id,
    kind: "completed_task",
    at: row.done_at || row.updated_at || row.created_at,
    project: row.project,
    department_name: row.department_name,
    title: row.title,
    category: row.category,
    severity: row.severity,
    status: row.status,
    assigned_agent: row.assigned_agent || null,
    reviewer_agent: row.reviewer_agent || null,
    source_kind: row.source_kind || null,
    source_id: row.source_id || null,
    checklist: parseMaybeJson(row.checklist_json, []),
    notes: row.notes || "",
    meta: parseMaybeJson(row.meta_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    done_at: row.done_at || null
  }));

  const feed = reports
    .concat(completedTasks)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, limit);

  return {
    ok: true,
    project,
    agent_name: agentName,
    include_blocked: includeBlocked,
    limit,
    reports_count: reports.length,
    completed_tasks_count: completedTasks.length,
    feed_count: feed.length,
    feed,
    reports,
    completed_tasks: completedTasks,
    protocol: [
      "Read this unified feed before starting new work.",
      "Use the latest reports to avoid duplicate implementation.",
      "If you finish work from a brief, mark that brief done or include it in session_handoff completed_brief_ids."
    ]
  };
}

function loadProjectRuleDefaults(scope) {
  const sc = scopeName(scope);
  const file = factsPathFor(sc, "-project-rules");
  if (!fs.existsSync(file)) return { error: "missing seed file", scope: sc, file };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: "seed file parse error: " + e.message, scope: sc, file };
  }
}

function ensureProjectRegistryTable(tdb) { _ensureProjectRegistryTableShared(tdb); }

function ensureAutonomyTables(tdb = db) {
  ensureFirmOpsTables();
  ensureProjectRegistryTable(tdb);
  tdb.exec(`
CREATE TABLE IF NOT EXISTS department (
  name TEXT PRIMARY KEY,
  mission TEXT NOT NULL,
  lead_agent TEXT,
  review_agent TEXT,
  skills_json TEXT,
  responsibilities_json TEXT,
  required_gates_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS department_member (
  department_name TEXT NOT NULL REFERENCES department(name) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  skills_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (department_name, agent_name)
);
CREATE TABLE IF NOT EXISTS autonomy_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  department_name TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent TEXT,
  reviewer_agent TEXT,
  source_kind TEXT,
  source_id TEXT,
  checklist_json TEXT,
  notes TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  done_at TEXT,
  UNIQUE(project, department_name, title)
);
CREATE INDEX IF NOT EXISTS idx_autonomy_task_status ON autonomy_task(status, department_name, severity);
CREATE INDEX IF NOT EXISTS idx_autonomy_task_agent ON autonomy_task(assigned_agent, status);
CREATE INDEX IF NOT EXISTS idx_autonomy_task_project ON autonomy_task(project, status);
`);
}

function defaultDepartments(agentMap = {}) {
  const coordinator = agentMap.review || agentMap.coordinator || agentMap.default || DEFAULT_AGENT;
  return [
    {
      name: "strategy-review",
      mission: "Own final review, cross-project consistency, priorities, and live-readiness sign-off.",
      lead_agent: coordinator,
      review_agent: coordinator,
      skills: ["review", "planning", "readiness", "coordination"],
      responsibilities: ["final review", "verify all gates", "prevent duplicate work", "route tasks"],
      required_gates: ["all"]
    },
    {
      name: "frontend",
      mission: "Own landing pages, app chrome, menus, header/footer, responsive UI, i18n, and visual consistency.",
      lead_agent: agentMap.frontend || agentMap.design || coordinator,
      review_agent: coordinator,
      skills: ["frontend", "design", "navigation", "mobile", "i18n"],
      responsibilities: ["landing pages", "menus", "links", "header/footer", "mobile", "language parity"],
      required_gates: ["nav", "header_footer", "links", "mobile", "i18n", "design"]
    },
    {
      name: "backend",
      mission: "Own APIs, auth crossover, account data, sessions, integrations, and security-sensitive flows.",
      lead_agent: agentMap.backend || coordinator,
      review_agent: coordinator,
      skills: ["backend", "auth", "api", "security", "integrations"],
      responsibilities: ["auth", "account APIs", "data model", "webhooks", "security"],
      required_gates: ["auth", "api", "security", "data"]
    },
    {
      name: "billing",
      mission: "Own pricing source of truth, checkout, billing portal, subscriptions, refunds, VAT/OSS, and payment webhooks.",
      lead_agent: agentMap.billing || agentMap.backend || coordinator,
      review_agent: coordinator,
      skills: ["pricing", "checkout", "stripe", "vat", "billing"],
      responsibilities: ["pricing", "checkout", "billing", "VAT/OSS", "refunds", "webhooks"],
      required_gates: ["pricing", "checkout", "billing", "vat"]
    },
    {
      name: "qa",
      mission: "Own defect discovery, regression checks, browser/mobile verification, link checks, and language parity checks.",
      lead_agent: agentMap.qa || coordinator,
      review_agent: coordinator,
      skills: ["qa", "browser", "mobile", "links", "regression"],
      responsibilities: ["cross-over checks", "bug reports", "regressions", "verification evidence"],
      required_gates: ["qa", "links", "mobile", "i18n"]
    },
    {
      name: "deploy-ops",
      mission: "Own environments, server state, deploy gates, monitoring, CORS, secrets, and rollback readiness.",
      lead_agent: agentMap.ops || agentMap.deploy || coordinator,
      review_agent: coordinator,
      skills: ["deploy", "server", "monitoring", "env", "cors"],
      responsibilities: ["deploy", "monitoring", "server config", "CORS", "secrets", "rollback"],
      required_gates: ["deploy", "monitoring", "cors", "env"]
    },
    {
      name: "content-legal",
      mission: "Own legal pages, public claims, copy consistency, policy pages, and compliance wording.",
      lead_agent: agentMap.content || agentMap.legal || coordinator,
      review_agent: coordinator,
      skills: ["content", "legal", "copy", "compliance"],
      responsibilities: ["legal pages", "privacy", "terms", "public claims", "copy"],
      required_gates: ["legal", "content", "privacy", "terms"]
    }
  ];
}

function gateDepartment(gate) {
  const g = String(gate || "").toLowerCase();
  if (["nav", "header_footer", "links", "mobile", "i18n", "language", "design"].includes(g)) return "frontend";
  if (["auth", "api", "security", "data"].includes(g)) return "backend";
  if (["pricing", "checkout", "billing", "vat", "oss", "stripe"].includes(g)) return "billing";
  if (["deploy", "monitoring", "cors", "env"].includes(g)) return "deploy-ops";
  if (["legal", "content", "privacy", "terms"].includes(g)) return "content-legal";
  if (["qa", "regression"].includes(g)) return "qa";
  return "strategy-review";
}

function categoryDepartment(category) {
  const c = String(category || "").toLowerCase();
  if (["brand", "nav", "header_footer", "links", "mobile", "language", "i18n", "design", "content"].includes(c)) return c === "content" ? "content-legal" : "frontend";
  if (["auth", "api", "security", "data", "bug"].includes(c)) return "backend";
  if (["pricing", "checkout", "billing", "vat", "oss", "stripe"].includes(c)) return "billing";
  if (["deploy", "monitoring", "cors", "env"].includes(c)) return "deploy-ops";
  if (["legal", "privacy", "terms"].includes(c)) return "content-legal";
  return "qa";
}

function departmentInfo(tdb, name) {
  ensureAutonomyTables(tdb);
  const row = tdb.prepare("SELECT * FROM department WHERE name=?").get(name);
  if (!row) return null;
  row.skills = parseMaybeJson(row.skills_json, []);
  row.responsibilities = parseMaybeJson(row.responsibilities_json, []);
  row.required_gates = parseMaybeJson(row.required_gates_json, []);
  return row;
}

function taskAssignee(tdb, departmentName) {
  const dep = departmentInfo(tdb, departmentName);
  if (!dep) return { assigned_agent: DEFAULT_AGENT, reviewer_agent: DEFAULT_AGENT };
  return { assigned_agent: dep.lead_agent || DEFAULT_AGENT, reviewer_agent: dep.review_agent || dep.lead_agent || DEFAULT_AGENT };
}

function departmentMembers(tdb, name) {
  ensureAutonomyTables(tdb);
  return tdb.prepare("SELECT agent_name, role, status FROM department_member WHERE department_name=? AND status='active' ORDER BY role, agent_name").all(name);
}

function buildTeamOperatingModel(tdb, agentName = null) {
  ensureAutonomyTables(tdb);
  const departments = tdb.prepare("SELECT name, mission, lead_agent, review_agent, status FROM department WHERE status='active' ORDER BY name").all()
    .map((row) => Object.assign({}, row, { members: departmentMembers(tdb, row.name) }));
  const pausedAgents = new Set(
    tdb.prepare("SELECT agent_name FROM agent_registry WHERE lower(status) IN ('paused','disabled','inactive')").all().map((row) => String(row.agent_name || "").toLowerCase())
  );
  const activeAgentSet = new Set();
  for (const dep of departments) {
    if (dep.lead_agent && !pausedAgents.has(String(dep.lead_agent).toLowerCase())) activeAgentSet.add(dep.lead_agent);
    if (dep.review_agent && !pausedAgents.has(String(dep.review_agent).toLowerCase())) activeAgentSet.add(dep.review_agent);
    for (const member of dep.members) {
      if (member.agent_name && !pausedAgents.has(String(member.agent_name).toLowerCase())) activeAgentSet.add(member.agent_name);
    }
  }
  const coverage = agentName ? departments.filter((dep) => {
    const lower = String(agentName || "").toLowerCase();
    return String(dep.lead_agent || "").toLowerCase() === lower ||
      String(dep.review_agent || "").toLowerCase() === lower ||
      dep.members.some((member) => String(member.agent_name || "").toLowerCase() === lower);
  }).map((dep) => ({
    department_name: dep.name,
    lead_agent: dep.lead_agent,
    review_agent: dep.review_agent,
    roles: dep.members.filter((member) => String(member.agent_name || "").toLowerCase() === String(agentName || "").toLowerCase()).map((member) => member.role || "member")
  })) : [];
  const rosterStatus = agentName
    ? (pausedAgents.has(String(agentName).toLowerCase()) ? "paused" : (activeAgentSet.has(agentName) ? "active" : "unassigned"))
    : null;
  return {
    status: "ok",
    fixed_roster: true,
    active_agents: Array.from(activeAgentSet).sort(),
    paused_agents: Array.from(pausedAgents).sort(),
    departments,
    collaboration_rules: [
      "Read the unified work report feed and recent handoffs before new work.",
      "Stay in your department unless you are the assigned reviewer or the work is explicitly handed off.",
      "One finished task must create one work report or handoff before another agent continues it.",
      "Paused agents do not receive new work."
    ],
    agent_name: agentName || null,
    agent_status: rosterStatus,
    department_coverage: coverage
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return uniqueAgentNames(value.map((item) => String(item || "").trim()));
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return uniqueAgentNames(parsed.map((item) => String(item || "").trim()));
  return uniqueAgentNames(String(value || "").split(/[\n,;]+/).map((item) => item.trim()));
}

function normalizeProjectList(value) {
  return Array.from(new Set(normalizeStringList(value)));
}

function normalizeScopeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const DEFAULT_CLAIM_TTL_MINUTES = 240;
const DEFAULT_CLAIM_STALE_SEC = 1800;

function normalizeClaimKind(value) {
  const kind = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!kind || kind === "file_path") return "file";
  return kind;
}

function buildClaimTarget(input = {}) {
  const claimKind = normalizeClaimKind(input.claim_kind || (input.file_path ? "file" : ""));
  const rawValue = input.file_path || input.scope_value || input.route || input.domain || input.server || input.service_name || input.task_key || input.module || "";
  const scopeValue = String(rawValue || "").trim();
  if (!scopeValue) return null;
  const filePath = claimKind === "file"
    ? scopeValue.replace(/\\/g, "/")
    : (input.file_path ? String(input.file_path || "").trim().replace(/\\/g, "/") : scopeValue);
  const scopeKeyBase = claimKind === "file" ? filePath.toLowerCase() : normalizeScopeKey(scopeValue);
  return {
    claim_kind: claimKind,
    scope_value: scopeValue,
    scope_key: `${claimKind}:${scopeKeyBase}`,
    file_path: filePath,
  };
}

function parseClaimMeta(value, fallback = {}) {
  const parsed = parseMaybeJson(value, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

function ensureWorkClaimSchema(dbx) {
  dbx.exec(`
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
  const cols = dbx.prepare("PRAGMA table_info(work_claim)").all().map((c) => c.name);
  if (!cols.includes("claim_kind")) dbx.exec("ALTER TABLE work_claim ADD COLUMN claim_kind TEXT NOT NULL DEFAULT 'file'");
  if (!cols.includes("scope_value")) dbx.exec("ALTER TABLE work_claim ADD COLUMN scope_value TEXT");
  if (!cols.includes("scope_key")) dbx.exec("ALTER TABLE work_claim ADD COLUMN scope_key TEXT");
  if (!cols.includes("heartbeat_at")) dbx.exec("ALTER TABLE work_claim ADD COLUMN heartbeat_at TEXT");
  if (!cols.includes("stale_after_sec")) dbx.exec("ALTER TABLE work_claim ADD COLUMN stale_after_sec INTEGER NOT NULL DEFAULT 1800");
  if (!cols.includes("released_at")) dbx.exec("ALTER TABLE work_claim ADD COLUMN released_at TEXT");
  if (!cols.includes("takeover_count")) dbx.exec("ALTER TABLE work_claim ADD COLUMN takeover_count INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("meta_json")) dbx.exec("ALTER TABLE work_claim ADD COLUMN meta_json TEXT");
  try { dbx.prepare("UPDATE work_claim SET claim_kind='file' WHERE claim_kind IS NULL OR trim(claim_kind)=''").run(); } catch {}
  try { dbx.prepare("UPDATE work_claim SET scope_value=file_path WHERE scope_value IS NULL OR trim(scope_value)=''").run(); } catch {}
  try { dbx.prepare("UPDATE work_claim SET scope_key='file:' || lower(replace(file_path, '\\\\', '/')) WHERE scope_key IS NULL OR trim(scope_key)=''").run(); } catch {}
  try { dbx.prepare("UPDATE work_claim SET heartbeat_at=COALESCE(heartbeat_at, claimed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(); } catch {}
  try { dbx.prepare("UPDATE work_claim SET stale_after_sec=COALESCE(stale_after_sec, ?)").run(DEFAULT_CLAIM_STALE_SEC); } catch {}
  try { dbx.prepare("UPDATE work_claim SET takeover_count=COALESCE(takeover_count, 0)").run(); } catch {}
  try { dbx.exec("CREATE INDEX IF NOT EXISTS idx_work_claim_scope_active ON work_claim(project, scope_key, status, expires_at)"); } catch {}
  try { dbx.exec("CREATE INDEX IF NOT EXISTS idx_work_claim_agent_status ON work_claim(agent_name, status, claimed_at DESC)"); } catch {}
  try { dbx.exec("CREATE INDEX IF NOT EXISTS idx_work_claim_kind_status ON work_claim(claim_kind, status, claimed_at DESC)"); } catch {}
}

function cleanupWorkClaims(dbx) {
  ensureWorkClaimSchema(dbx);
  try {
    dbx.prepare("UPDATE work_claim SET status='expired', released_at=COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE status='active' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
  } catch {}
  try {
    dbx.prepare(
      "UPDATE work_claim SET status='stale', released_at=COALESCE(released_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
      "WHERE status='active' AND ((julianday('now') - julianday(COALESCE(heartbeat_at, claimed_at))) * 86400.0) > COALESCE(stale_after_sec, ?)"
    ).run(DEFAULT_CLAIM_STALE_SEC);
  } catch {}
}

function workClaimRowData(row) {
  if (!row) return null;
  return Object.assign({}, row, { meta: parseClaimMeta(row.meta_json, {}) });
}

function claimLookupSql(input = {}) {
  if (input.id) return { sql: "SELECT * FROM work_claim WHERE id=?", params: [input.id] };
  const target = buildClaimTarget(input);
  if (!target || !input.agent_name) return null;
  return {
    sql: "SELECT * FROM work_claim WHERE project=? AND scope_key=? AND agent_name=? AND status IN ('active','stale') ORDER BY id DESC LIMIT 1",
    params: [input.project || null, target.scope_key, input.agent_name],
  };
}

function extractClaimTargets(input = {}) {
  const targets = [];
  for (const file of Array.isArray(input.files) ? input.files : []) {
    const target = buildClaimTarget({ claim_kind: "file", file_path: file });
    if (target) targets.push(target);
  }
  for (const claim of Array.isArray(input.claims) ? input.claims : []) {
    const target = buildClaimTarget(claim || {});
    if (target) targets.push(target);
  }
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.scope_key)) return false;
    seen.add(target.scope_key);
    return true;
  });
}

function handleWorkClaim(dbx, input = {}) {
  if (!input.project || !input.agent_name) return { error: "project + agent_name required" };
  const target = buildClaimTarget(input || {});
  if (!target) return { error: "file_path or (claim_kind + scope_value) required" };
  const ttl = Math.max(1, Math.min(1440, input.ttl_minutes || DEFAULT_CLAIM_TTL_MINUTES));
  const staleAfterSec = Math.max(60, Math.min(86400, parseInt(input.stale_after_sec || DEFAULT_CLAIM_STALE_SEC, 10) || DEFAULT_CLAIM_STALE_SEC));
  ensureWorkClaimSchema(dbx);
  cleanupWorkClaims(dbx);
  const existing = dbx.prepare("SELECT * FROM work_claim WHERE project=? AND scope_key=? AND status IN ('active','stale') ORDER BY id DESC LIMIT 1").get(input.project, target.scope_key);
  if (existing && existing.agent_name !== input.agent_name) {
    const staleClaim = String(existing.status || "") === "stale";
    if (!input.allow_takeover || !staleClaim) {
      return {
        ok: false,
        blocked_by: existing.agent_name,
        existing_id: existing.id,
        stale: staleClaim,
        can_takeover: staleClaim,
        claim: workClaimRowData(existing),
        hint: staleClaim ? "Pass allow_takeover:true to recover this stale claim." : "Coordinate with " + existing.agent_name + " or wait until " + existing.expires_at + ".",
      };
    }
    dbx.prepare("UPDATE work_claim SET status='stale_recovered', released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(existing.id);
  }
  const expires = new Date(Date.now() + ttl * 60000).toISOString();
  const now = new Date().toISOString();
  if (existing && existing.agent_name === input.agent_name) {
    dbx.prepare("UPDATE work_claim SET status='active', summary=COALESCE(?, summary), expires_at=?, heartbeat_at=?, stale_after_sec=?, meta_json=COALESCE(?, meta_json), released_at=NULL WHERE id=?")
      .run(input.summary || null, expires, now, staleAfterSec, input.meta ? JSON.stringify(input.meta) : null, existing.id);
    return { ok: true, id: existing.id, action: "refreshed", claim_kind: target.claim_kind, scope_value: target.scope_value, expires_at: expires, heartbeat_at: now };
  }
  const takeoverCount = existing && existing.agent_name !== input.agent_name ? Number(existing.takeover_count || 0) + 1 : 0;
  const meta = Object.assign({}, input.meta || {}, existing && existing.agent_name !== input.agent_name ? { takeover_from_claim_id: existing.id, takeover_from_agent: existing.agent_name } : {});
  const info = dbx.prepare("INSERT INTO work_claim (project, file_path, agent_name, summary, claim_kind, scope_value, scope_key, heartbeat_at, stale_after_sec, expires_at, status, released_at, takeover_count, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(input.project, target.file_path, input.agent_name, input.summary || null, target.claim_kind, target.scope_value, target.scope_key, now, staleAfterSec, expires, "active", null, takeoverCount, JSON.stringify(meta));
  return { ok: true, id: info.lastInsertRowid, action: existing ? "taken_over" : "claimed", claim_kind: target.claim_kind, scope_value: target.scope_value, expires_at: expires, heartbeat_at: now, takeover_from: existing && existing.agent_name !== input.agent_name ? existing.agent_name : null };
}

function handleWorkHeartbeat(dbx, input = {}) {
  ensureWorkClaimSchema(dbx);
  cleanupWorkClaims(dbx);
  const lookup = claimLookupSql(input || {});
  if (!lookup) return { error: "id OR (project + agent_name + file_path/scope) required" };
  const row = dbx.prepare(lookup.sql).get(...lookup.params);
  if (!row) return { error: "no active claim found" };
  const now = new Date().toISOString();
  const expires = input.ttl_minutes ? new Date(Date.now() + Math.max(1, Math.min(1440, input.ttl_minutes)) * 60000).toISOString() : row.expires_at;
  dbx.prepare("UPDATE work_claim SET status='active', heartbeat_at=?, expires_at=?, released_at=NULL WHERE id=?").run(now, expires, row.id);
  return { ok: true, id: row.id, heartbeat_at: now, expires_at: expires, claim_kind: row.claim_kind, scope_value: row.scope_value || row.file_path };
}

function handleWorkHeartbeatBatch(dbx, input = {}) {
  if (!input.agent_name) return { error: "agent_name required" };
  ensureWorkClaimSchema(dbx);
  cleanupWorkClaims(dbx);
  const where = ["status IN ('active','stale')", "agent_name=?"];
  const params = [input.agent_name];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  const rows = dbx.prepare("SELECT id, claim_kind, scope_value, file_path, expires_at FROM work_claim WHERE " + where.join(" AND ")).all(...params);
  if (!rows.length) return { ok: true, refreshed: 0, claims: [] };
  const now = new Date().toISOString();
  const ttl = input.ttl_minutes ? Math.max(1, Math.min(1440, input.ttl_minutes)) : 0;
  const stmt = ttl
    ? dbx.prepare("UPDATE work_claim SET status='active', heartbeat_at=?, expires_at=?, released_at=NULL WHERE id=?")
    : dbx.prepare("UPDATE work_claim SET status='active', heartbeat_at=?, released_at=NULL WHERE id=?");
  const txn = dbx.transaction(() => {
    for (const r of rows) {
      if (ttl) {
        stmt.run(now, new Date(Date.now() + ttl * 60000).toISOString(), r.id);
      } else {
        stmt.run(now, r.id);
      }
    }
  });
  txn();
  return { ok: true, refreshed: rows.length, heartbeat_at: now, claims: rows.map((r) => ({ id: r.id, claim_kind: r.claim_kind, scope_value: r.scope_value || r.file_path })) };
}

function handleWorkRelease(dbx, input = {}) {
  ensureWorkClaimSchema(dbx);
  const lookup = claimLookupSql(input || {});
  if (!lookup) return { error: "id OR (project + agent_name + file_path/scope) required" };
  const row = dbx.prepare(lookup.sql).get(...lookup.params);
  if (!row) return { error: "no active claim found" };
  const status = input.status || "released";
  dbx.prepare("UPDATE work_claim SET status=?, summary=COALESCE(?, summary), released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(status, input.outcome ? "released: " + input.outcome : null, row.id);
  return { ok: true, id: row.id, claim_kind: row.claim_kind, scope_value: row.scope_value || row.file_path, status };
}

function handleWorkActive(dbx, input = {}) {
  ensureWorkClaimSchema(dbx);
  cleanupWorkClaims(dbx);
  const where = [input.include_stale ? "status IN ('active','stale')" : "status='active'"];
  const params = [];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(input.agent_name); }
  if (input.claim_kind) { where.push("claim_kind=?"); params.push(normalizeClaimKind(input.claim_kind)); }
  if (input.scope_value) {
    const target = buildClaimTarget({ claim_kind: input.claim_kind, scope_value: input.scope_value, file_path: input.claim_kind === "file" ? input.scope_value : null });
    if (target) { where.push("scope_key=?"); params.push(target.scope_key); }
  }
  const lim = Math.min(input.limit || 50, 200);
  params.push(lim);
  const rows = dbx.prepare("SELECT * FROM work_claim WHERE " + where.join(" AND ") + " ORDER BY claimed_at DESC LIMIT ?").all(...params).map(workClaimRowData);
  return { count: rows.length, claims: rows };
}

function handleWorkSimilar(dbx, input = {}) {
  ensureWorkClaimSchema(dbx);
  cleanupWorkClaims(dbx);
  const target = buildClaimTarget(input || {});
  if (!target) return { error: "file_path or (claim_kind + scope_value) required" };
  const lim = Math.min(input.limit || 20, 100);
  let rows = [];
  if (target.claim_kind === "file") {
    const dir = target.file_path.includes("/") ? target.file_path.replace(/\/[^\/]+$/, "/") : target.file_path;
    const pattern = dir + "%";
    const params = [target.scope_key, pattern];
    let where = "(scope_key=? OR file_path LIKE ?)";
    if (input.project) { where += " AND project=?"; params.push(input.project); }
    where += " AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day') OR COALESCE(released_at, claimed_at) > datetime('now','-1 day'))";
    params.push(lim);
    rows = dbx.prepare("SELECT * FROM work_claim WHERE " + where + " ORDER BY claimed_at DESC LIMIT ?").all(...params).map(workClaimRowData);
  } else {
    const params = [target.claim_kind, target.scope_key, target.scope_value];
    let where = "claim_kind=? AND (scope_key=? OR scope_value=?)";
    if (input.project) { where += " AND project=?"; params.push(input.project); }
    where += " AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day') OR COALESCE(released_at, claimed_at) > datetime('now','-1 day'))";
    params.push(lim);
    rows = dbx.prepare("SELECT * FROM work_claim WHERE " + where + " ORDER BY claimed_at DESC LIMIT ?").all(...params).map(workClaimRowData);
  }
  return { count: rows.length, similar: rows, exact_match_count: rows.filter((row) => String(row.scope_key || "") === target.scope_key).length };
}

function connectorListData(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const staleDays = Math.max(1, parseInt(input.stale_days || 30, 10) || 30);
  const includeDerived = input.include_derived !== false;
  const includeAccessRoutes = input.include_access_routes !== false;
  const where = [];
  const params = [];
  if (input.scope) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(scopeName(input.scope)); }
  if (input.project) { where.push("project=?"); params.push(String(input.project)); }
  if (input.system_name) { where.push("system_name=?"); params.push(String(input.system_name)); }
  if (input.owner_agent) { where.push("owner_agent=?"); params.push(String(input.owner_agent)); }
  if (input.lifecycle_status) { where.push("lifecycle_status=?"); params.push(String(input.lifecycle_status)); }
  const rows = db.prepare(
    "SELECT * FROM connector_registry" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY project, system_name"
  ).all(...params);
  const explicitSystems = new Set();
  const connectors = rows.map((row) => {
    explicitSystems.add(String(row.scope || "default") + "::" + String(row.system_name || ""));
    const allowedAgents = normalizeStringList(row.allowed_agents_json);
    const ageDays = isoAgeDays(row.last_health_at || row.last_verified_at || row.updated_at);
    const freshness = freshnessFromAgeDays(ageDays, staleDays, Math.max(staleDays + 15, staleDays * 2));
    const connector = {
      id: row.id,
      scope: row.scope,
      project: row.project || null,
      system_name: row.system_name,
      owner_agent: row.owner_agent || null,
      auth_type: row.auth_type || null,
      secret_ref: row.secret_ref || null,
      rate_limit: row.rate_limit || null,
      allowed_agents: allowedAgents,
      read_enabled: !!row.read_enabled,
      write_enabled: !!row.write_enabled,
      live_write_enabled: !!row.live_write_enabled,
      lifecycle_status: row.lifecycle_status,
      approval_class: row.approval_class,
      endpoint: row.endpoint || null,
      health_status: row.health_status || "unknown",
      health_summary: row.health_summary || null,
      last_health_at: row.last_health_at || null,
      last_verified_at: row.last_verified_at || null,
      freshness_status: freshness,
      freshness_age_days: ageDays,
      runbook: parseMaybeJson(row.runbook_json, {}),
      dependencies: parseMaybeJson(row.dependency_json, []),
      rollback: parseMaybeJson(row.rollback_json, {}),
      notes: row.notes || null,
      meta: parseMaybeJson(row.meta_json, {}),
      updated_by: row.updated_by || null,
      updated_at: row.updated_at,
      created_at: row.created_at,
      source_kind: "explicit",
    };
    if (includeAccessRoutes) {
      connector.access_routes = db.prepare(
        "SELECT id, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at " +
        "FROM access_inventory WHERE scope=? AND system_name=? ORDER BY updated_at DESC"
      ).all(row.scope, row.system_name).map((route) => ({
        id: route.id,
        access_kind: route.access_kind,
        entrypoint: route.entrypoint || null,
        account_hint: route.account_hint || null,
        secret_ref: route.secret_ref || null,
        allowed_agents: normalizeStringList(route.allowed_agents),
        status: route.status,
        last_verified_at: route.last_verified_at || null,
        verification_method: route.verification_method || null,
        notes: route.notes || null,
        updated_by: route.updated_by || null,
        updated_at: route.updated_at,
      }));
    }
    return connector;
  });
  if (includeDerived) {
    const derivedRows = db.prepare(
      "SELECT scope, project, system_name, MAX(updated_at) latest_update, MAX(last_verified_at) latest_verify " +
      "FROM access_inventory" +
      (input.scope || input.project || input.system_name ? " WHERE " + [
        input.scope ? "LOWER(COALESCE(scope,''))=?" : null,
        input.project ? "project=?" : null,
        input.system_name ? "system_name=?" : null
      ].filter(Boolean).join(" AND ") : "") +
      " GROUP BY scope, project, system_name ORDER BY project, system_name"
    ).all(...[
      input.scope ? scopeName(input.scope) : null,
      input.project != null ? String(input.project) : null,
      input.system_name != null ? String(input.system_name) : null,
    ].filter((value) => value != null));
    for (const row of derivedRows) {
      const key = String(row.scope || "default") + "::" + String(row.system_name || "");
      if (explicitSystems.has(key)) continue;
      const routes = db.prepare(
        "SELECT id, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at " +
        "FROM access_inventory WHERE scope=? AND system_name=? ORDER BY updated_at DESC"
      ).all(row.scope, row.system_name);
      const allowedAgents = uniqueAgentNames(routes.flatMap((route) => normalizeStringList(route.allowed_agents)));
      const ageDays = isoAgeDays(row.latest_verify || row.latest_update);
      const freshness = freshnessFromAgeDays(ageDays, staleDays, Math.max(staleDays + 15, staleDays * 2));
      connectors.push({
        id: null,
        scope: row.scope,
        project: row.project || null,
        system_name: row.system_name,
        owner_agent: null,
        auth_type: null,
        secret_ref: routes.find((route) => route.secret_ref)?.secret_ref || null,
        rate_limit: null,
        allowed_agents: allowedAgents,
        read_enabled: true,
        write_enabled: routes.some((route) => /write|admin|deploy|ssh|db/i.test(String(route.access_kind || ""))),
        live_write_enabled: false,
        lifecycle_status: "verified",
        approval_class: "normal_fix",
        endpoint: routes.find((route) => route.entrypoint)?.entrypoint || null,
        health_status: freshness === "critical" ? "stale" : "unknown",
        health_summary: "derived from access_inventory",
        last_health_at: null,
        last_verified_at: row.latest_verify || null,
        freshness_status: freshness,
        freshness_age_days: ageDays,
        runbook: {},
        dependencies: [],
        rollback: {},
        notes: null,
        meta: {},
        updated_by: routes[0] ? routes[0].updated_by : null,
        updated_at: row.latest_update,
        created_at: row.latest_update,
        source_kind: "derived_access_inventory",
        access_routes: includeAccessRoutes ? routes.map((route) => ({
          id: route.id,
          access_kind: route.access_kind,
          entrypoint: route.entrypoint || null,
          account_hint: route.account_hint || null,
          secret_ref: route.secret_ref || null,
          allowed_agents: normalizeStringList(route.allowed_agents),
          status: route.status,
          last_verified_at: route.last_verified_at || null,
          verification_method: route.verification_method || null,
          notes: route.notes || null,
          updated_by: route.updated_by || null,
          updated_at: route.updated_at,
        })) : [],
      });
    }
  }
  if (input.allowed_agent) {
    const agent = String(input.allowed_agent).toLowerCase();
    return connectors.filter((connector) => connector.allowed_agents.some((name) => String(name || "").toLowerCase() === agent));
  }
  return connectors;
}

function deriveAgentPassport(tdb, agentName) {
  const normalized = normalizeAgentName(agentName);
  const team = buildTeamOperatingModel(tdb, normalized);
  const coverage = team.department_coverage || [];
  const departments = uniqueAgentNames(coverage.map((row) => row.department_name));
  const capabilities = capabilityMatrixForDepartments(departments);
  const connectors = connectorListData(tdb, { include_derived: true, include_access_routes: false, allowed_agent: normalized });
  const allowedSystems = uniqueAgentNames(connectors.map((connector) => connector.system_name));
  const lane = departments.join(", ") || "unassigned";
  const reviewRequired = departments.some((dep) => dep !== "strategy-review");
  const approvalClass = capabilities.production || capabilities.auth || capabilities.billing ? "live_risk" : (capabilities.edit ? "normal_fix" : "read_only");
  return {
    agent_name: normalized,
    display_name: normalized,
    department_name: departments[0] || null,
    lane,
    departments,
    allowed_projects: [],
    allowed_projects_policy: "assigned-by-brief-or-task",
    allowed_systems: allowedSystems,
    allowed_environments: capabilities.production ? ["production", "staging", "dev"] : ["staging", "dev"],
    capability_matrix: capabilities,
    live_write: !!capabilities.edit,
    review_required: reviewRequired,
    needs_handoff: true,
    can_deploy: !!capabilities.deploy,
    can_touch_auth: !!capabilities.auth,
    can_touch_billing: !!capabilities.billing,
    can_manage_production: !!capabilities.production,
    approval_class: approvalClass,
    status: team.agent_status === "active" ? "active" : team.agent_status,
    source_kind: "derived_team_model",
    freshness_status: "fresh",
    meta: { derived: true, coverage },
  };
}

function agentPassportData(tdb, agentName) {
  ensureUniversalJournalSchema();
  const normalized = normalizeAgentName(agentName);
  const row = db.prepare("SELECT * FROM agent_passport WHERE agent_name=?").get(normalized);
  if (!row) return deriveAgentPassport(tdb, normalized);
  const capabilityMatrix = parseMaybeJson(row.capability_matrix_json, {}) || {};
  const ageDays = isoAgeDays(row.updated_at);
  return {
    agent_name: row.agent_name,
    display_name: row.display_name || row.agent_name,
    department_name: row.department_name || null,
    lane: row.lane || null,
    departments: uniqueAgentNames([row.department_name].concat(String(row.lane || "").split(",").map((item) => item.trim())).filter(Boolean)),
    allowed_projects: normalizeProjectList(row.allowed_projects_json),
    allowed_projects_policy: "explicit",
    allowed_systems: normalizeStringList(row.allowed_systems_json),
    allowed_environments: normalizeStringList(row.allowed_environments_json),
    capability_matrix: Object.assign(capabilityMatrix, {
      edit: boolFlag(capabilityMatrix.edit, !!row.live_write),
      deploy: boolFlag(capabilityMatrix.deploy, !!row.can_deploy),
      billing: boolFlag(capabilityMatrix.billing, !!row.can_touch_billing),
      auth: boolFlag(capabilityMatrix.auth, !!row.can_touch_auth),
      production: boolFlag(capabilityMatrix.production, !!row.can_manage_production),
      report: boolFlag(capabilityMatrix.report, true),
      read: boolFlag(capabilityMatrix.read, true),
    }),
    live_write: !!row.live_write,
    review_required: !!row.review_required,
    needs_handoff: !!row.needs_handoff,
    can_deploy: !!row.can_deploy,
    can_touch_auth: !!row.can_touch_auth,
    can_touch_billing: !!row.can_touch_billing,
    can_manage_production: !!row.can_manage_production,
    approval_class: row.approval_class || "read_only",
    status: row.status || "active",
    source_kind: row.source_kind || "manual",
    freshness_status: freshnessFromAgeDays(ageDays, 14, 45),
    freshness_age_days: ageDays,
    updated_by: row.updated_by || null,
    updated_at: row.updated_at,
    created_at: row.created_at,
    meta: parseMaybeJson(row.meta_json, {}),
  };
}

function agentPassportListData(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const explicitRows = db.prepare("SELECT agent_name FROM agent_passport ORDER BY agent_name").all().map((row) => row.agent_name);
  const names = new Set(explicitRows.map((name) => normalizeAgentName(name)));
  if (input.include_derived !== false) {
    for (const dep of buildTeamOperatingModel(tdb).active_agents || []) names.add(normalizeAgentName(dep));
  }
  let passports = Array.from(names).map((name) => agentPassportData(tdb, name));
  if (input.status) passports = passports.filter((passport) => passport.status === input.status);
  if (input.department_name) passports = passports.filter((passport) => passport.departments.includes(String(input.department_name)));
  return passports.sort((a, b) => String(a.agent_name).localeCompare(String(b.agent_name)));
}

function buildDriftCheckReport(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const scope = String(input.scope || "default");
  const actor = input.actor || input.agent_name || DEFAULT_AGENT;
  const staleDays = Math.max(1, parseInt(input.stale_days || 30, 10) || 30);
  const runtime = runtimeHealth({ stale_sec: input.runtime_stale_sec || 300 });
  const findings = [];
  const push = (finding) => findings.push(Object.assign({
    scope,
    project: null,
    system_name: null,
    drift_kind: "unknown",
    severity: "M",
    status: "open",
    freshness_status: "fresh",
    expected: null,
    actual: null,
    details: {},
    source_ref: null,
  }, finding || {}));

  for (const agent of runtime.agents || []) {
    if (["blocked", "offline", "dirty", "degraded"].includes(agent.health)) {
      push({
        project: null,
        system_name: agent.agent_name,
        drift_kind: "agent_runtime",
        severity: agent.health === "blocked" || agent.health === "offline" ? "H" : "M",
        freshness_status: agent.health === "offline" ? "critical" : "stale",
        expected: "agent loop healthy and current",
        actual: `health=${agent.health}${agent.blocked_on ? " blocked_on=" + agent.blocked_on : ""}`,
        details: agent,
      });
    }
  }

  const connectors = connectorListData(tdb, { scope, include_derived: true, include_access_routes: false, stale_days: staleDays });
  for (const connector of connectors) {
    if (["critical", "stale"].includes(connector.freshness_status) || ["error", "degraded", "stale"].includes(String(connector.health_status || ""))) {
      push({
        project: connector.project || null,
        system_name: connector.system_name,
        drift_kind: "connector_freshness",
        severity: connector.freshness_status === "critical" ? "H" : "M",
        freshness_status: connector.freshness_status,
        expected: "connector verified and healthy",
        actual: `health=${connector.health_status || "unknown"} last_verified=${connector.last_verified_at || "never"}`,
        details: connector,
      });
    }
  }

  try {
    const projects = db.prepare("SELECT name, live_status, live_url, auth_system, health_checklist, missing_blocks, updated_at FROM project_registry ORDER BY name").all();
    for (const project of projects) {
      const missing = normalizeStringList(project.missing_blocks);
      if ((project.live_status && String(project.live_status).toLowerCase() === "live") && (!project.live_url || !project.auth_system || missing.length)) {
        push({
          project: project.name,
          system_name: project.name,
          drift_kind: "project_registry_gap",
          severity: "M",
          freshness_status: freshnessFromAgeDays(isoAgeDays(project.updated_at), 14, 45),
          expected: "live project has live_url, auth_system, and no missing blocks",
          actual: `live_url=${project.live_url || "missing"} auth_system=${project.auth_system || "missing"} missing_blocks=${missing.join(", ") || "none"}`,
          details: {
            live_status: project.live_status,
            live_url: project.live_url || null,
            auth_system: project.auth_system || null,
            missing_blocks: missing,
            health_checklist: normalizeStringList(project.health_checklist),
            updated_at: project.updated_at,
          },
        });
      }
    }
  } catch {}

  try {
    const writers = db.prepare("SELECT writer, status, last_write_at, last_check_at, rows_written FROM writer_health ORDER BY writer").all();
    for (const writer of writers) {
      const ageDays = isoAgeDays(writer.last_write_at || writer.last_check_at);
      const freshness = freshnessFromAgeDays(ageDays, 2, 7);
      if ((writer.status && writer.status !== "ok") || freshness !== "fresh") {
        push({
          system_name: writer.writer,
          drift_kind: "writer_health",
          severity: freshness === "critical" ? "H" : "M",
          freshness_status: freshness,
          expected: "writer recently healthy",
          actual: `status=${writer.status || "unknown"} last_write=${writer.last_write_at || "never"}`,
          details: writer,
        });
      }
    }
  } catch {}

  if (input.persist !== false) {
    const stmt = db.prepare(
      "INSERT INTO drift_check_result (scope, project, system_name, drift_kind, severity, status, freshness_status, expected, actual, details_json, source_ref, checked_by, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    );
    for (const finding of findings) {
      stmt.run(
        finding.scope,
        finding.project || null,
        finding.system_name || null,
        finding.drift_kind,
        finding.severity || "M",
        finding.status || "open",
        finding.freshness_status || "fresh",
        finding.expected || null,
        finding.actual || null,
        JSON.stringify(finding.details || {}),
        finding.source_ref || null,
        actor
      );
    }
  }

  const summary = {
    total: findings.length,
    high: findings.filter((finding) => finding.severity === "H").length,
    medium: findings.filter((finding) => finding.severity === "M").length,
    low: findings.filter((finding) => finding.severity === "L").length,
    critical_freshness: findings.filter((finding) => finding.freshness_status === "critical").length,
    stale_freshness: findings.filter((finding) => finding.freshness_status === "stale").length,
  };
  return {
    ok: true,
    scope,
    checked_at: new Date().toISOString(),
    persisted: input.persist !== false,
    runtime_summary: runtime.summary,
    summary,
    findings,
  };
}

function classifyActionRisk(input = {}) {
  const text = [
    input.project,
    input.task,
    input.summary,
    input.action_type,
    Array.isArray(input.topics) ? input.topics.join(" ") : "",
    Array.isArray(input.files) ? input.files.join(" ") : "",
    Array.isArray(input.system_names) ? input.system_names.join(" ") : ""
  ].filter(Boolean).join(" ");
  const normalized = String(text || "").toLowerCase();
  const touchesProduction = /\b(production|prod|live|deploy|pm2|nginx|dns|ssl|cert|rollback)\b/.test(normalized);
  const touchesBilling = /\b(stripe|billing|invoice|pricing|checkout|refund|vat|vies|oss|subscription|plan)\b/.test(normalized);
  const touchesAuth = /\b(auth|login|signup|signin|sign-in|sso|session|cookie|oauth|password|reset|forgot|verify|onboarding|account)\b/.test(normalized);
  const writeIntent = /\b(edit|change|fix|implement|update|deploy|restart|migrate|patch|write|remove|delete|rename|refactor|create|build|rollout)\b/.test(normalized);
  const environment = input.environment || (touchesProduction ? "production" : "staging");
  return {
    text,
    write_intent: writeIntent,
    touches_production: touchesProduction,
    touches_billing: touchesBilling,
    touches_auth: touchesAuth,
    environment,
  };
}

function writeGateCheck(tdb, input = {}) {
  const passport = agentPassportData(tdb, input.agent_name || DEFAULT_AGENT);
  const risk = classifyActionRisk(input);
  const blockers = [];
  const checks = [];
  const explicitProjects = Array.isArray(passport.allowed_projects) ? passport.allowed_projects : [];
  const explicitSystems = Array.isArray(passport.allowed_systems) ? passport.allowed_systems : [];
  const status = String(passport.status || "").toLowerCase();

  checks.push({ name: "passport", source_kind: passport.source_kind, status: passport.status, lane: passport.lane, approval_class: passport.approval_class });

  if (passport.source_kind === "manual" && ["paused", "disabled", "inactive", "onboarding", "probation"].includes(status)) {
    blockers.push(`agent passport status blocks write activity: ${passport.status}`);
  }
  if (risk.write_intent && !passport.live_write) {
    blockers.push("agent passport does not allow live write/edit activity");
  }
  if (risk.touches_production && !passport.can_manage_production) {
    blockers.push("agent passport does not allow production-risk changes");
  }
  if (/deploy/i.test(String(input.action_type || "")) && !passport.can_deploy) {
    blockers.push("agent passport does not allow deploy actions");
  }
  if (risk.touches_auth && !passport.can_touch_auth) {
    blockers.push("agent passport does not allow auth/login work");
  }
  if (risk.touches_billing && !passport.can_touch_billing) {
    blockers.push("agent passport does not allow billing/pricing work");
  }
  const requestedProject = normalizeScopeKey(input.project);
  const explicitProjectKeys = explicitProjects.map(normalizeScopeKey).filter(Boolean);
  if (requestedProject && explicitProjectKeys.length && !explicitProjectKeys.includes(requestedProject)) {
    blockers.push("project is outside explicit passport project scope");
  }

  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const explicitSystemKeys = explicitSystems.map(normalizeScopeKey).filter(Boolean);
  const relevantConnectors = systemNames.length
    ? connectorListData(tdb, { include_derived: true }).filter((connector) => systemNames.includes(connector.system_name))
    : [];
  if (systemNames.length) {
    checks.push({ name: "systems", requested: systemNames, matched: relevantConnectors.map((connector) => connector.system_name) });
  }
  if (explicitSystems.length) {
    const unauthorized = systemNames.filter((name) => !explicitSystemKeys.includes(normalizeScopeKey(name)));
    if (unauthorized.length) blockers.push("systems outside explicit passport scope: " + unauthorized.join(", "));
  }
  for (const connector of relevantConnectors) {
    if (connector.allowed_agents.length && !connector.allowed_agents.some((name) => String(name || "").toLowerCase() === String(passport.agent_name || "").toLowerCase())) {
      blockers.push(`connector ${connector.system_name} does not list ${passport.agent_name} as allowed agent`);
    }
    if (risk.touches_production && !connector.live_write_enabled && connector.source_kind === "explicit" && connector.lifecycle_status === "live") {
      blockers.push(`connector ${connector.system_name} is not approved for live write`);
    }
  }

  const freeze = freezeCheck(tdb, input);
  const windowCheck = maintenanceWindowCheck(tdb, input);
  const artifactLock = artifactLockCheck(tdb, input);
  checks.push({
    name: "dependency_freeze",
    result: freeze.status,
    active_freezes: freeze.active_freezes.length,
    overrides: freeze.overrides.length
  });
  checks.push({
    name: "maintenance_window",
    result: windowCheck.status,
    required: windowCheck.required,
    active_windows: windowCheck.active_windows.length,
    overrides: windowCheck.overrides.length
  });
  checks.push({
    name: "artifact_lock",
    result: artifactLock.status,
    active_locks: artifactLock.active_locks.length,
    overrides: artifactLock.overrides.length
  });
  blockers.push(...freeze.blockers);
  blockers.push(...windowCheck.blockers);
  blockers.push(...artifactLock.blockers);

  return {
    status: blockers.length ? "block" : "ok",
    blockers,
    checks,
    passport,
    risk,
    matched_connectors: relevantConnectors,
    freeze,
    maintenance_window: windowCheck,
    artifact_lock: artifactLock,
  };
}

function extractTaskKeywords(input = {}) {
  const text = [
    input.project,
    input.task,
    input.summary,
    Array.isArray(input.topics) ? input.topics.join(" ") : "",
    Array.isArray(input.files) ? input.files.join(" ") : ""
  ].filter(Boolean).join(" ").toLowerCase();
  return Array.from(new Set((text.match(/[a-z0-9_-]{4,}/g) || [])
    .filter((token) => !["http", "https", "with", "from", "that", "this", "have", "were", "your", "into", "about", "project", "files", "task", "summary"].includes(token))
    .slice(0, 18)));
}

function duplicateWorkCheck(tdb, input = {}) {
  ensureAutonomyTables(tdb);
  cleanupWorkClaims(tdb);
  const project = input.project || null;
  const files = Array.isArray(input.files) ? input.files.map((file) => String(file || "").trim()).filter(Boolean) : [];
  const claimTargets = extractClaimTargets(input);
  const keywords = extractTaskKeywords(input);
  const blockers = [];
  const warnings = [];
  const evidence = { active_claims: [], stale_claims: [], recent_handoffs: [], overlapping_tasks: [], similar_claims: [] };

  for (const target of claimTargets) {
    try {
      const exact = tdb.prepare(
        "SELECT * FROM work_claim WHERE project=? AND scope_key=? AND status IN ('active','stale') ORDER BY claimed_at DESC"
      ).all(project || "unknown", target.scope_key).map(workClaimRowData);
      for (const claim of exact) {
        if (String(claim.agent_name || "").toLowerCase() === String(input.agent_name || "").toLowerCase()) continue;
        if (claim.status === "stale") {
          warnings.push(`stale ${claim.claim_kind} claim exists: ${claim.scope_value} by ${claim.agent_name}`);
          evidence.stale_claims.push(claim);
        } else {
          blockers.push(`${claim.claim_kind} already claimed by ${claim.agent_name}: ${claim.scope_value}`);
          evidence.active_claims.push(claim);
        }
      }
    } catch {}
    try {
      if (target.claim_kind === "file") {
        const basename = String(target.file_path || "").split(/[\\/]/).pop();
        const similar = tdb.prepare(
          "SELECT * FROM work_claim WHERE project=? AND (scope_key=? OR file_path LIKE ?) AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day')) ORDER BY claimed_at DESC LIMIT 10"
        ).all(project || "unknown", target.scope_key, "%" + basename).map(workClaimRowData);
        for (const claim of similar) {
          if (String(claim.agent_name || "").toLowerCase() !== String(input.agent_name || "").toLowerCase()) evidence.similar_claims.push(claim);
        }
      } else {
        const similar = tdb.prepare(
          "SELECT * FROM work_claim WHERE project=? AND claim_kind=? AND (scope_key=? OR scope_value=?) AND (status IN ('active','stale') OR claimed_at > datetime('now','-1 day')) ORDER BY claimed_at DESC LIMIT 10"
        ).all(project || "unknown", target.claim_kind, target.scope_key, target.scope_value).map(workClaimRowData);
        for (const claim of similar) {
          if (String(claim.agent_name || "").toLowerCase() !== String(input.agent_name || "").toLowerCase()) evidence.similar_claims.push(claim);
        }
      }
    } catch {}
  }

  if (project) {
    try {
      const handoffs = db.prepare(
        "SELECT id, agent_name, summary, changed_files, created_at FROM session_handoff WHERE project=? AND created_at >= datetime('now','-3 day') ORDER BY created_at DESC LIMIT 20"
      ).all(project);
      for (const row of handoffs) {
        const changed = parseMaybeJson(row.changed_files, []);
        const overlap = files.length ? changed.filter((file) => files.includes(file)) : [];
        const text = (row.summary || "").toLowerCase();
        const keywordOverlap = keywords.filter((keyword) => text.includes(keyword));
        if (overlap.length || keywordOverlap.length >= 2) {
          evidence.recent_handoffs.push({ id: row.id, agent_name: row.agent_name, summary: row.summary, changed_files: changed, created_at: row.created_at, overlap, keyword_overlap: keywordOverlap });
          if (String(row.agent_name || "").toLowerCase() !== String(input.agent_name || "").toLowerCase()) warnings.push(`recent handoff overlaps this scope: #${row.id} by ${row.agent_name}`);
        }
      }
    } catch {}
    try {
      const tasks = db.prepare(
        "SELECT id, department_name, title, status, assigned_agent, reviewer_agent, updated_at FROM autonomy_task " +
        "WHERE project=? AND status IN ('open','claimed','blocked','review') ORDER BY updated_at DESC, created_at DESC LIMIT 30"
      ).all(project);
      for (const task of tasks) {
        const title = String(task.title || "").toLowerCase();
        const overlap = keywords.filter((keyword) => title.includes(keyword));
        if (overlap.length >= 2) {
          evidence.overlapping_tasks.push(Object.assign({}, task, { keyword_overlap: overlap }));
          if (task.assigned_agent && String(task.assigned_agent).toLowerCase() !== String(input.agent_name || "").toLowerCase()) {
            blockers.push(`open autonomy task overlaps this work: #${task.id} assigned to ${task.assigned_agent}`);
          }
        }
      }
    } catch {}
  }

  return {
    status: blockers.length ? "block" : (warnings.length ? "warn" : "ok"),
    blockers: uniqueAgentNames(blockers),
    warnings: uniqueAgentNames(warnings),
    evidence,
    hint: blockers.length ? "Coordinate, reuse the prior work, or pick a different scope before editing." : "No blocking duplicate scope found.",
  };
}

function buildImpactMap(tdb, input = {}) {
  ensureAutonomyTables(tdb);
  const project = input.project || null;
  const risk = classifyActionRisk(input);
  const result = {
    ok: true,
    project,
    domains: [],
    servers: [],
    portals: [],
    agents: [],
    connectors: [],
    auth_projects: [],
    ui_projects: [],
    files: Array.isArray(input.files) ? input.files : [],
    topics: Array.isArray(input.topics) ? input.topics : [],
    environment: risk.environment,
  };
  const addUnique = (list, value) => {
    if (!value) return;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (!list.some((item) => JSON.stringify(item) === JSON.stringify(value))) list.push(value);
  };
  let designFamily = null;
  let authScope = null;
  if (project) {
    try {
      const reg = db.prepare("SELECT * FROM project_registry WHERE name=?").get(project);
      if (reg) {
        addUnique(result.servers, reg.server || null);
        addUnique(result.domains, reg.domain || null);
        addUnique(result.domains, reg.live_url || null);
        addUnique(result.domains, reg.staging_url || null);
        addUnique(result.domains, reg.admin_url || null);
        addUnique(result.portals, { project: reg.name, live_status: reg.live_status || null, auth_system: reg.auth_system || null });
        if (reg.auth_system) addUnique(result.auth_projects, reg.auth_system);
      }
    } catch {}
    try {
      const rulesRow = db.prepare("SELECT project, allowed_domains, auth_matrix, design_rules FROM project_rules WHERE project=?").get(project);
      if (rulesRow) {
        for (const domain of parseMaybeJson(rulesRow.allowed_domains, [])) addUnique(result.domains, domain);
        const auth = parseMaybeJson(rulesRow.auth_matrix, {}) || {};
        const design = parseMaybeJson(rulesRow.design_rules, {}) || {};
        authScope = auth.shared_identity_scope || null;
        designFamily = design.shared_ui_family || null;
        addUnique(result.auth_projects, auth.canonical_project || null);
        addUnique(result.ui_projects, design.canonical_brand_project || null);
        addUnique(result.ui_projects, design.canonical_header_project || null);
        addUnique(result.ui_projects, design.canonical_button_project || null);
        for (const portal of [].concat(auth.portals || [], design.portals || [])) addUnique(result.portals, portal);
      }
    } catch {}
  }
  try {
    const connectors = connectorListData(tdb, { include_derived: true, project: project || undefined, include_access_routes: false });
    for (const connector of connectors) {
      addUnique(result.connectors, {
        system_name: connector.system_name,
        project: connector.project || null,
        endpoint: connector.endpoint || null,
        owner_agent: connector.owner_agent || null,
        lifecycle_status: connector.lifecycle_status,
      });
      addUnique(result.servers, connector.endpoint && /@|^\d{1,3}(\.\d{1,3}){3}$|^\/root\//.test(connector.endpoint) ? connector.endpoint : null);
    }
  } catch {}
  try {
    const rows = db.prepare("SELECT project, auth_matrix, design_rules FROM project_rules").all();
    for (const row of rows) {
      const auth = parseMaybeJson(row.auth_matrix, {}) || {};
      const design = parseMaybeJson(row.design_rules, {}) || {};
      if (authScope && auth.shared_identity_scope === authScope) addUnique(result.auth_projects, row.project);
      if (designFamily && design.shared_ui_family === designFamily) addUnique(result.ui_projects, row.project);
    }
  } catch {}
  try {
    const team = buildTeamOperatingModel(tdb, input.agent_name || null);
    for (const dep of team.departments || []) {
      if (!project || inferDepartmentTargets(input.task || "", input.topics || [], input.files || []).includes(dep.name)) {
        addUnique(result.agents, { agent_name: dep.lead_agent || null, role: "lead", department: dep.name });
        addUnique(result.agents, { agent_name: dep.review_agent || null, role: "reviewer", department: dep.name });
      }
    }
  } catch {}
  result.summary = {
    domains: result.domains.filter(Boolean).length,
    servers: result.servers.filter(Boolean).length,
    portals: result.portals.filter(Boolean).length,
    agents: result.agents.filter((agent) => agent && agent.agent_name).length,
    connectors: result.connectors.length,
    auth_projects: result.auth_projects.filter(Boolean).length,
    ui_projects: result.ui_projects.filter(Boolean).length,
  };
  return result;
}

function isoNow() {
  return new Date().toISOString();
}

function isoMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function rowMatchesScopeProjectSystem(row, scope, project, systemNames) {
  const sc = String(scope || DEFAULT_SCOPE || "default");
  if (row.scope && row.scope !== sc) return false;
  if (row.project && project && row.project !== project) return false;
  if (row.project && !project && !row.system_name) return false;
  if (row.system_name && systemNames.length) {
    if (!systemNames.includes(String(row.system_name))) return false;
  }
  return true;
}

function normalizeArtifactKind(kind) {
  const raw = String(kind || "").trim().toLowerCase();
  if (["url", "route", "domain", "file", "project", "system", "component", "page", "artifact"].includes(raw)) return raw;
  if (raw === "path") return "file";
  return raw || "artifact";
}

function normalizeArtifactValue(kind, value) {
  const normalizedKind = normalizeArtifactKind(kind);
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (normalizedKind === "file") return raw.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (normalizedKind === "domain") {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .trim()
      .toLowerCase();
  }
  if (normalizedKind === "route") {
    let route = raw;
    try {
      if (/^https?:\/\//i.test(route)) route = new URL(route).pathname || "/";
    } catch {}
    route = route.trim();
    if (!route.startsWith("/")) route = "/" + route.replace(/^\/+/, "");
    route = route.replace(/\/{2,}/g, "/");
    if (route.length > 1) route = route.replace(/\/+$/, "");
    return route.toLowerCase();
  }
  if (normalizedKind === "url") {
    try {
      const parsed = new URL(raw);
      parsed.hash = "";
      let href = parsed.toString();
      if (href.endsWith("/") && parsed.pathname !== "/") href = href.replace(/\/+$/, "");
      return href.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }
  return raw.toLowerCase();
}

function extractArtifactTargets(input = {}) {
  const targets = [];
  const seen = new Set();
  const addTarget = (kind, value, extras = {}) => {
    const artifact_kind = normalizeArtifactKind(kind);
    const artifact_key = normalizeArtifactValue(artifact_kind, value);
    if (!artifact_key) return;
    const dedupeKey = artifact_kind + ":" + artifact_key;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    targets.push(Object.assign({ artifact_kind, artifact_key, artifact_label: String(value || "").trim() || artifact_key }, extras));
  };
  for (const file of Array.isArray(input.files) ? input.files : []) addTarget("file", file);
  for (const domain of Array.isArray(input.domains) ? input.domains : []) addTarget("domain", domain);
  for (const route of Array.isArray(input.routes) ? input.routes : []) addTarget("route", route);
  for (const url of Array.isArray(input.urls) ? input.urls : []) {
    addTarget("url", url);
    addTarget("domain", url);
    addTarget("route", url);
  }
  const freeText = [
    input.task,
    input.summary,
    Array.isArray(input.topics) ? input.topics.join(" ") : "",
  ].filter(Boolean).join(" ");
  const urlMatches = String(freeText || "").match(/https?:\/\/[^\s)>"']+/gi) || [];
  for (const url of urlMatches) {
    addTarget("url", url);
    addTarget("domain", url);
    addTarget("route", url);
  }
  if (input.project) addTarget("project", input.project, { artifact_label: input.project });
  for (const systemName of [].concat(Array.isArray(input.system_names) ? input.system_names : []).concat(Array.isArray(input.connectors) ? input.connectors : [])) {
    addTarget("system", systemName, { artifact_label: systemName });
  }
  return targets;
}

function artifactLockRowMatches(row, project, systemNames, targets) {
  const kind = normalizeArtifactKind(row.artifact_kind);
  const key = normalizeArtifactValue(kind, row.artifact_key);
  if (!key) return false;
  if (kind === "project") return !!project && normalizeScopeKey(project) === normalizeScopeKey(key);
  if (kind === "system") return systemNames.some((name) => normalizeScopeKey(name) === normalizeScopeKey(key));
  return targets.some((target) => target.artifact_kind === kind && target.artifact_key === key);
}

function currentArtifactLockRows(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const scope = scopeName(input.scope);
  const scopes = Array.from(new Set([scope, "default"].filter(Boolean)));
  const project = input.project || null;
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const targets = extractArtifactTargets(input);
  const now = isoMs(input.now || isoNow());
  const placeholders = scopes.map(() => "?").join(",");
  const rows = tdb.prepare(
    "SELECT * FROM artifact_lock WHERE scope IN (" + placeholders + ") AND status='active' ORDER BY started_at DESC"
  ).all(...scopes);
  return rows.filter((row) => {
    if (!rowMatchesScopeProjectSystem(row, row.scope || scope, project, systemNames)) return false;
    const end = isoMs(row.expires_at);
    if (end != null && end < now) return false;
    return artifactLockRowMatches(row, project, systemNames, targets);
  }).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
}

function artifactLockCheck(tdb, input = {}) {
  const locks = currentArtifactLockRows(tdb, input);
  const overrides = currentOverrideRows(tdb, Object.assign({}, input, { gate_kind: "artifact_lock" }));
  const blockers = [];
  if (locks.length && !overrides.length) {
    const labels = locks.slice(0, 5).map((row) => row.artifact_label || row.artifact_key);
    blockers.push("protected final artifact blocks changes: " + labels.join(", "));
  }
  return {
    status: blockers.length ? "block" : "ok",
    blockers,
    active_locks: locks,
    overrides,
    matched_targets: extractArtifactTargets(input),
  };
}

function currentWindowRows(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const scope = scopeName(input.scope);
  const project = input.project || null;
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const now = isoMs(input.now || isoNow());
  const rows = tdb.prepare(
    "SELECT * FROM maintenance_window WHERE scope=? AND status IN ('approved','active','open') ORDER BY starts_at ASC"
  ).all(scope);
  const matched = [];
  const upcoming = [];
  for (const row of rows) {
    if (!rowMatchesScopeProjectSystem(row, scope, project, systemNames)) continue;
    const start = isoMs(row.starts_at);
    const end = isoMs(row.ends_at);
    if (start == null || end == null) continue;
    const shaped = Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) });
    if (start <= now && end >= now) matched.push(shaped);
    else if (start > now) upcoming.push(shaped);
  }
  return { active: matched, upcoming };
}

function currentOverrideRows(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const scope = scopeName(input.scope);
  const project = input.project || null;
  const gateKind = input.gate_kind || null;
  const agentName = normalizeAgentName(input.agent_name || "");
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const now = isoMs(input.now || isoNow());
  const rows = tdb.prepare(
    "SELECT * FROM override_log WHERE scope=? AND status='active' ORDER BY starts_at DESC"
  ).all(scope);
  return rows.filter((row) => {
    if (!rowMatchesScopeProjectSystem(row, scope, project, systemNames)) return false;
    if (gateKind && row.gate_kind !== gateKind && row.gate_kind !== "all") return false;
    if (row.agent_name && normalizeAgentName(row.agent_name) !== agentName) return false;
    const start = isoMs(row.starts_at) ?? now;
    const end = isoMs(row.expires_at);
    if (start > now) return false;
    if (end != null && end < now) return false;
    return true;
  }).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
}

function currentFreezeRows(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const scope = scopeName(input.scope);
  const project = input.project || null;
  const systemNames = uniqueAgentNames([]
    .concat(Array.isArray(input.system_names) ? input.system_names : [])
    .concat(Array.isArray(input.connectors) ? input.connectors : []));
  const now = isoMs(input.now || isoNow());
  const rows = tdb.prepare(
    "SELECT * FROM dependency_freeze WHERE scope=? AND status='active' ORDER BY started_at DESC"
  ).all(scope);
  return rows.filter((row) => {
    if (!rowMatchesScopeProjectSystem(row, scope, project, systemNames)) return false;
    const end = isoMs(row.expires_at);
    return end == null || end >= now;
  }).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
}

function maintenanceWindowCheck(tdb, input = {}) {
  const risk = classifyActionRisk(input);
  const requiresWindow = !!(risk.write_intent && (risk.touches_production || risk.touches_auth || risk.touches_billing || /deploy/i.test(String(input.action_type || ""))));
  const windows = currentWindowRows(tdb, input);
  const overrides = currentOverrideRows(tdb, Object.assign({}, input, { gate_kind: "maintenance_window" }));
  const blockers = [];
  const warnings = [];
  if (requiresWindow && !windows.active.length && !overrides.length) {
    blockers.push("no active maintenance window for this high-risk change");
  }
  if (requiresWindow && !windows.active.length && windows.upcoming.length) {
    const next = windows.upcoming[0];
    warnings.push("next maintenance window starts at " + next.starts_at);
  }
  return {
    status: blockers.length ? "block" : "ok",
    required: requiresWindow,
    blockers,
    warnings,
    active_windows: windows.active,
    upcoming_windows: windows.upcoming.slice(0, 5),
    overrides,
  };
}

function freezeCheck(tdb, input = {}) {
  const freezes = currentFreezeRows(tdb, input);
  const overrides = currentOverrideRows(tdb, Object.assign({}, input, { gate_kind: "freeze" }));
  const blockers = [];
  if (freezes.length && !overrides.length) {
    blockers.push("active dependency freeze blocks this scope");
  }
  return {
    status: blockers.length ? "block" : "ok",
    blockers,
    active_freezes: freezes,
    overrides,
  };
}

function buildStatusBoard(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const wanted = Array.isArray(input.projects) && input.projects.length ? new Set(input.projects) : null;
  const names = new Set();
  try { for (const row of tdb.prepare("SELECT name FROM project_registry").all()) names.add(row.name); } catch {}
  try { for (const row of tdb.prepare("SELECT project FROM project_rules").all()) names.add(row.project); } catch {}
  try { for (const row of tdb.prepare("SELECT DISTINCT project FROM quality_finding WHERE project IS NOT NULL").all()) names.add(row.project); } catch {}
  try { for (const row of tdb.prepare("SELECT DISTINCT project FROM work_claim WHERE project IS NOT NULL").all()) names.add(row.project); } catch {}
  const board = [];
  for (const name of Array.from(names).sort()) {
    if (wanted && !wanted.has(name)) continue;
    const registry = (() => { try { return tdb.prepare("SELECT name, domain, server, live_status, live_url, updated_at FROM project_registry WHERE name=?").get(name); } catch { return null; } })();
    const openFindings = (() => { try { return tdb.prepare("SELECT COUNT(*) c, SUM(CASE WHEN severity IN ('H','critical') THEN 1 ELSE 0 END) high FROM quality_finding WHERE project=? AND status='open'").get(name); } catch { return { c: 0, high: 0 }; } })();
    const activeClaims = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM work_claim WHERE project=? AND status='active' AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(name); } catch { return { c: 0 }; } })();
    const openDrift = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM drift_check_result WHERE project=? AND status='open'").get(name); } catch { return { c: 0 }; } })();
    const activeFreeze = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM dependency_freeze WHERE project=? AND status='active' AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))").get(name); } catch { return { c: 0 }; } })();
    const activeLocks = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM artifact_lock WHERE project=? AND status='active' AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))").get(name); } catch { return { c: 0 }; } })();
    const activeWindows = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM maintenance_window WHERE project=? AND status IN ('approved','active','open') AND starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ends_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(name); } catch { return { c: 0 }; } })();
    const openIncidents = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM ops_incident WHERE project=? AND status='open'").get(name); } catch { return { c: 0 }; } })();
    board.push({
      project: name,
      live_status: registry && registry.live_status || "unknown",
      live_url: registry && registry.live_url || null,
      domain: registry && registry.domain || null,
      server: registry && registry.server || null,
      last_registry_update_at: registry && registry.updated_at || null,
      open_findings: openFindings.c || 0,
      high_findings: openFindings.high || 0,
      active_claims: activeClaims.c || 0,
      open_drift: openDrift.c || 0,
      active_freezes: activeFreeze.c || 0,
      active_artifact_locks: activeLocks.c || 0,
      active_windows: activeWindows.c || 0,
      open_incidents: openIncidents.c || 0,
    });
  }
  return {
    ok: true,
    count: board.length,
    summary: {
      projects: board.length,
      blocked_projects: board.filter((row) => row.active_freezes || row.active_artifact_locks || row.high_findings || row.open_incidents).length,
      open_findings: board.reduce((sum, row) => sum + row.open_findings, 0),
      open_incidents: board.reduce((sum, row) => sum + row.open_incidents, 0),
      active_artifact_locks: board.reduce((sum, row) => sum + row.active_artifact_locks, 0),
    },
    board,
  };
}

function buildLearningLoopReport(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const days = Math.max(1, Math.min(parseInt(input.days || 14, 10) || 14, 120));
  const since = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
  const drift = (() => { try { return tdb.prepare("SELECT COALESCE(project,'(none)') project, drift_kind, COUNT(*) count FROM drift_check_result WHERE checked_at >= ? GROUP BY project, drift_kind HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20").all(since); } catch { return []; } })();
  const findings = (() => { try { return tdb.prepare("SELECT COALESCE(project,'(none)') project, category, COUNT(*) count FROM quality_finding WHERE created_at >= ? GROUP BY project, category HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20").all(since); } catch { return []; } })();
  const blockedPreflights = (() => { try { return tdb.prepare("SELECT COUNT(*) c FROM agent_action WHERE action_kind='agent_preflight' AND status='block' AND started_at >= ?").get(since).c; } catch { return 0; } })();
  const scarPatterns = (() => { try { return tdb.prepare("SELECT COALESCE(pattern_id,0) pattern_id, COUNT(*) count FROM scar_event WHERE occurred_at >= ? GROUP BY pattern_id HAVING COUNT(*) >= 2 ORDER BY count DESC LIMIT 20").all(since); } catch { return []; } })();
  const recommendations = [];
  for (const row of drift.slice(0, 8)) recommendations.push({ type: "drift_rule", project: row.project, key: row.drift_kind, reason: `${row.count} repeated drift checks` });
  for (const row of findings.slice(0, 8)) recommendations.push({ type: "finding_gate", project: row.project, key: row.category, reason: `${row.count} repeated findings` });
  for (const row of scarPatterns.slice(0, 5)) recommendations.push({ type: "scar_prevention", pattern_id: row.pattern_id, reason: `${row.count} repeated scar events` });
  if (blockedPreflights >= 3) recommendations.push({ type: "preflight_noise", reason: `${blockedPreflights} blocked preflights in ${days}d`, action: "tighten rules or add explicit overrides/runbooks" });
  return {
    ok: true,
    since,
    summary: {
      repeated_drift: drift.length,
      repeated_findings: findings.length,
      repeated_scars: scarPatterns.length,
      blocked_preflights: blockedPreflights,
      recommendations: recommendations.length,
    },
    drift,
    findings,
    scar_patterns: scarPatterns,
    recommendations,
  };
}

function runSearchReindex(tdb, input = {}) {
  ensureUniversalJournalSchema();
  const scopes = Array.isArray(input.scopes) && input.scopes.length ? input.scopes : ["transcript", "brief", "event", "memory"];
  const limit = Math.max(1, Math.min(parseInt(input.limit || 5000, 10) || 5000, 50000));
  const reset = input.reset !== false;
  const inserted = {};
  const per_scope = {};
  const ins = tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES (?,?,?,?,?)");
  const delOne = tdb.prepare("DELETE FROM mnemo_search_fts WHERE scope=? AND ref_id=?");
  const sourceCount = (scope) => {
    try {
      if (scope === "transcript") return tdb.prepare("SELECT COUNT(*) c FROM transcript").get().c;
      if (scope === "brief") return tdb.prepare("SELECT COUNT(*) c FROM agent_brief").get().c;
      if (scope === "event") return tdb.prepare("SELECT COUNT(*) c FROM mnemo_event_journal").get().c;
      if (scope === "memory") return tdb.prepare("SELECT COUNT(*) c FROM memory").get().c;
    } catch {}
    return null;
  };
  for (const scope of scopes) {
    inserted[scope] = 0;
    const available = sourceCount(scope);
    let indexed_before = null;
    let indexed_after = null;
    try { indexed_before = tdb.prepare("SELECT COUNT(*) c FROM mnemo_search_fts WHERE scope=?").get(scope).c; } catch {}
    if (reset) {
      try { tdb.prepare("DELETE FROM mnemo_search_fts WHERE scope=?").run(scope); } catch {}
    }
    if (scope === "transcript") {
      const rows = tdb.prepare("SELECT id, source, channel, direction, speaker, content FROM transcript ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        delOne.run("transcript", String(row.id));
        ins.run("transcript", String(row.id), row.speaker || row.source || "", `${row.direction || ""}${row.channel ? " @ " + row.channel : ""}`, String(row.content || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    } else if (scope === "brief") {
      const rows = tdb.prepare("SELECT id, agent_name, source_agent, content FROM agent_brief ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        delOne.run("brief", String(row.id));
        ins.run("brief", String(row.id), row.agent_name || "", row.source_agent || "", String(row.content || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    } else if (scope === "event") {
      const rows = tdb.prepare("SELECT id, source, channel, actor, event_kind, content, payload_json FROM mnemo_event_journal ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        const content = [row.content, row.payload_json].filter(Boolean).join("\n");
        delOne.run("event", String(row.id));
        ins.run("event", String(row.id), row.actor || row.source || "", `${row.event_kind || ""}${row.channel ? " @ " + row.channel : ""}`, String(content || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    } else if (scope === "memory") {
      const rows = tdb.prepare("SELECT id, actor, source, text FROM memory ORDER BY id DESC LIMIT ?").all(limit);
      for (const row of rows) {
        delOne.run("memory", String(row.id));
        ins.run("memory", String(row.id), row.actor || row.source || "", row.source || "", String(row.text || "").slice(0, 8000));
        inserted[scope] += 1;
      }
    }
    try { indexed_after = tdb.prepare("SELECT COUNT(*) c FROM mnemo_search_fts WHERE scope=?").get(scope).c; } catch {}
    per_scope[scope] = {
      available,
      indexed_before,
      indexed_after,
      inserted: inserted[scope],
      limit_applied: limit,
      has_more: typeof available === "number" ? available > inserted[scope] : null,
      remaining_estimate: typeof available === "number" ? Math.max(0, available - inserted[scope]) : null,
    };
  }
  return {
    ok: true,
    scopes,
    reset,
    inserted,
    per_scope,
    total_inserted: Object.values(inserted).reduce((sum, value) => sum + value, 0),
  };
}

function normalizeJournalRecallScopes(scopes) {
  const allowed = new Set(["transcript", "brief", "event"]);
  const requested = Array.isArray(scopes) && scopes.length ? scopes : ["transcript", "brief", "event"];
  return requested.map((scope) => String(scope || "").trim().toLowerCase()).filter((scope) => allowed.has(scope));
}

function searchJournalRecallRows(tdb, input = {}, limit = 20, queryText = "") {
  if (input.include_journal === false) return [];
  const scopes = normalizeJournalRecallScopes(input.journal_scopes);
  if (!scopes.length || !queryText) return [];
  const lim = Math.max(1, Math.min(limit, 200));
  const rows = [];
  for (const scope of scopes) {
    try {
      if (scope === "transcript") {
        const params = [queryText];
        let sql = `
          SELECT
            'transcript' AS surface,
            CAST(t.id AS TEXT) AS ref_id,
            'transcript' AS kind,
            COALESCE(NULLIF(t.speaker,''), NULLIF(t.source,''), '') AS actor,
            t.occurred_at AS occurred_at,
            COALESCE(mnemo_search_fts.summary, '') AS topic,
            snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS preview,
            bm25(mnemo_search_fts) AS bm25
          FROM mnemo_search_fts
          JOIN transcript t ON mnemo_search_fts.scope='transcript' AND CAST(t.id AS TEXT)=mnemo_search_fts.ref_id
          WHERE mnemo_search_fts.scope='transcript' AND mnemo_search_fts MATCH ?
        `;
        if (input.since) { sql += " AND t.occurred_at >= ?"; params.push(input.since); }
        if (input.actor) { sql += " AND (t.speaker = ? OR t.source = ?)"; params.push(input.actor, input.actor); }
        sql += " ORDER BY bm25 ASC, t.occurred_at DESC LIMIT ?";
        params.push(lim);
        rows.push(...tdb.prepare(sql).all(...params));
      } else if (scope === "brief") {
        const params = [queryText];
        let sql = `
          SELECT
            'brief' AS surface,
            CAST(b.id AS TEXT) AS ref_id,
            'brief' AS kind,
            COALESCE(NULLIF(b.source_agent,''), NULLIF(b.agent_name,''), '') AS actor,
            b.created_at AS occurred_at,
            COALESCE(b.source_agent, b.agent_name, '') AS topic,
            snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS preview,
            bm25(mnemo_search_fts) AS bm25
          FROM mnemo_search_fts
          JOIN agent_brief b ON mnemo_search_fts.scope='brief' AND CAST(b.id AS TEXT)=mnemo_search_fts.ref_id
          WHERE mnemo_search_fts.scope='brief' AND mnemo_search_fts MATCH ?
        `;
        if (input.since) { sql += " AND b.created_at >= ?"; params.push(input.since); }
        if (input.actor) { sql += " AND (b.source_agent = ? OR b.agent_name = ?)"; params.push(input.actor, input.actor); }
        sql += " ORDER BY bm25 ASC, b.created_at DESC LIMIT ?";
        params.push(lim);
        rows.push(...tdb.prepare(sql).all(...params));
      } else if (scope === "event") {
        const params = [queryText];
        let sql = `
          SELECT
            'event' AS surface,
            CAST(e.id AS TEXT) AS ref_id,
            'event' AS kind,
            COALESCE(NULLIF(e.actor,''), NULLIF(e.source,''), '') AS actor,
            e.occurred_at AS occurred_at,
            COALESCE(e.event_kind, '') AS topic,
            snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS preview,
            bm25(mnemo_search_fts) AS bm25
          FROM mnemo_search_fts
          JOIN mnemo_event_journal e ON mnemo_search_fts.scope='event' AND CAST(e.id AS TEXT)=mnemo_search_fts.ref_id
          WHERE mnemo_search_fts.scope='event' AND mnemo_search_fts MATCH ?
        `;
        if (input.since) { sql += " AND e.occurred_at >= ?"; params.push(input.since); }
        if (input.actor) { sql += " AND (e.actor = ? OR e.source = ?)"; params.push(input.actor, input.actor); }
        sql += " ORDER BY bm25 ASC, e.occurred_at DESC LIMIT ?";
        params.push(lim);
        rows.push(...tdb.prepare(sql).all(...params));
      }
    } catch {}
  }
  return rows;
}

function inferDepartmentTargets(task, topics, files) {
  const hits = new Set();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const dep = gateDepartment(topic) || categoryDepartment(topic);
    if (dep) hits.add(dep);
  }
  const text = [task, ...(Array.isArray(files) ? files : [])].filter(Boolean).join(" ").toLowerCase();
  const patterns = [
    { dep: "frontend", re: /\b(header|footer|nav|menu|logo|dark ?mode|light ?mode|mobile|responsive|font|button|layout|ui|design|i18n|language)\b/ },
    { dep: "backend", re: /\b(api|backend|server|db|database|schema|auth|login|session|cookie|token|webhook)\b/ },
    { dep: "billing", re: /\b(stripe|billing|invoice|pricing|checkout|refund|vat|vies|oss|subscription|plan)\b/ },
    { dep: "deploy-ops", re: /\b(deploy|pm2|nginx|env|dns|ssl|cert|monitor|cors)\b/ },
    { dep: "content-legal", re: /\b(copy|content|legal|privacy|terms|impressum|policy)\b/ },
    { dep: "qa", re: /\b(test|qa|verify|regression|audit|smoke)\b/ }
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(text)) hits.add(pattern.dep);
  }
  return Array.from(hits);
}

function preflightDepartmentOwnership(tdb, agentName, task, topics, files) {
  const team = buildTeamOperatingModel(tdb, agentName);
  const blockers = [];
  if (team.agent_status === "paused") blockers.push(agentName + " is paused and must not receive new work");
  if (team.agent_status === "unassigned") blockers.push(agentName + " is not in the active department roster");
  const targetDepartments = inferDepartmentTargets(task, topics, files);
  const owned = new Set((team.department_coverage || []).map((row) => row.department_name));
  const missing = targetDepartments.filter((dep) => !owned.has(dep));
  for (const dep of missing) {
    const info = departmentInfo(tdb, dep);
    blockers.push("work belongs to " + dep + " and must be handled by " + (info && info.lead_agent || "the assigned lead") + (info && info.review_agent ? " with review by " + info.review_agent : ""));
  }
  return { team, target_departments: targetDepartments, blockers };
}

function autonomyTaskResult(row, action) {
  if (!row) return null;
  const out = Object.assign({}, row, {
    action,
    department: row.department_name,
    checklist: parseMaybeJson(row.checklist_json, null),
    meta: parseMaybeJson(row.meta_json, null),
  });
  return out;
}

function insertAutonomyTask(tdb, task) {
  ensureAutonomyTables(tdb);
  const assignee = task.assigned_agent ? { assigned_agent: task.assigned_agent, reviewer_agent: task.reviewer_agent || taskAssignee(tdb, task.department_name).reviewer_agent } : taskAssignee(tdb, task.department_name);
  const checklist = task.checklist ? JSON.stringify(task.checklist) : null;
  const meta = task.meta ? JSON.stringify(task.meta) : null;
  const existing = tdb.prepare("SELECT * FROM autonomy_task WHERE project=? AND department_name=? AND title=?").get(task.project, task.department_name, task.title);
  if (existing) return autonomyTaskResult(existing, "kept");
  const info = tdb.prepare(`
    INSERT INTO autonomy_task (project, department_name, title, category, severity, assigned_agent, reviewer_agent, source_kind, source_id, checklist_json, notes, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(task.project, task.department_name, task.title, task.category || "coordination", task.severity || "M", assignee.assigned_agent || null, assignee.reviewer_agent || null, task.source_kind || null, task.source_id != null ? String(task.source_id) : null, checklist, task.notes || null, meta);
  const row = tdb.prepare("SELECT * FROM autonomy_task WHERE id=?").get(info.lastInsertRowid);
  return autonomyTaskResult(row, "created");
}

function recentAutonomyBriefExists(tdb, agent, taskId, minutes = 30) {
  if (!agent || !taskId) return true;
  const since = `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${Math.max(1, minutes)} minutes')`;
  try {
    const row = tdb.prepare(
      "SELECT id FROM agent_brief WHERE lower(agent_name)=lower(?) " +
      "AND (status='pending' OR created_at > " + since + ") " +
      "AND (meta_json LIKE ? OR meta_json LIKE ? OR meta_json LIKE ? OR content LIKE ? OR content LIKE ?) LIMIT 1"
    ).get(
      agent,
      '%"autonomy_task_id":' + taskId + '%',
      '%"blocked_autonomy_task_id":' + taskId + '%',
      '%"task_id":' + taskId + '%',
      '%Autonomy task #' + taskId + '%',
      '%Blocked autonomy review #' + taskId + '%'
    );
    return !!row;
  } catch {
    return false;
  }
}

function autonomySweepBatchLines(batchInfo) {
  if (!batchInfo || !batchInfo.total_available) return [];
  const lines = [
    "## Sweep batch",
    "- Brief: " + batchInfo.index + " of " + batchInfo.total_available + " eligible tasks in this sweep",
    "- Batch limit: " + batchInfo.batch_limit
  ];
  if (batchInfo.remaining > 0) lines.push("- Remaining after this brief: " + batchInfo.remaining);
  return lines;
}

function autonomyBriefContent(t, agent, batchInfo) {
  const batchLines = autonomySweepBatchLines(batchInfo);
  return [
    "# Autonomy task #" + t.id,
    "",
    ...batchLines,
    ...(batchLines.length ? [""] : []),
    "- Project: " + t.project,
    "- Department: " + t.department,
    "- Title: " + t.title,
    "- Reviewer: " + (t.reviewer_agent || "strategy-review"),
    "",
    "This is an execution brief, not a status ping.",
    "Do not wait for the owner when the next safe action is clear.",
    "Start with `mem_autonomy_next({agent_name:\"" + agent + "\", claim:true, allow_takeover:true})`, load project rules/session context, claim files before edits, verify, then update the task.",
    "If this is not your lane, brief the responsible agent with exact URL/file/evidence and immediately pull the next task in your lane.",
    "Website/front-end Done requires real checks for header/menu/footer, links, light/dark logos, mobile/desktop, locales/languages, allowed domains, pricing/checkout/auth/legal crossover where relevant."
  ].join("\n");
}

function compactReason(value, max = 260) {
  if (value == null) return "";
  if (Array.isArray(value)) value = value.filter(Boolean).join("; ");
  else if (typeof value === "object") value = JSON.stringify(value);
  value = String(value || "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 3) + "..." : value;
}

function firstReasonObject(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    const text = compactReason(value);
    if (text) return text;
  }
  return "";
}

function autonomyBlockedReasonLines(tdb, t) {
  const lines = [];
  const checklist = t.checklist || parseMaybeJson(t.checklist_json, null) || {};
  const meta = t.meta || parseMaybeJson(t.meta_json, null) || {};
  const notes = compactReason(t.notes, 360);
  if (notes) lines.push("- Blocker notes: " + notes);
  const checklistReason = firstReasonObject(checklist, ["blocked_reason", "blocker", "blockers", "missing", "reason", "next_action"]);
  if (checklistReason) lines.push("- Checklist blocker: " + checklistReason);
  const metaReason = firstReasonObject(meta, ["blocked_reason", "blocker", "blockers", "missing", "missing_blocks", "reason", "next_action", "source"]);
  if (metaReason) lines.push("- Meta blocker: " + metaReason);
  const sourceKind = t.source_kind || meta.source_kind || "";
  const sourceId = t.source_id || meta.source_id || (checklist && checklist.finding_id) || "";
  if (String(sourceKind) === "quality_finding" || sourceId) {
    try {
      const f = tdb.prepare("SELECT id, project, category, severity, title, url, expected, actual, status FROM quality_finding WHERE id=?").get(String(sourceId));
      if (f) {
        lines.push("- Source finding: #" + f.id + " [" + (f.severity || "M") + "/" + (f.status || "open") + "] " + compactReason(f.title, 220));
        if (f.url) lines.push("- URL: " + f.url);
        if (f.expected) lines.push("- Expected: " + compactReason(f.expected, 220));
        if (f.actual) lines.push("- Actual: " + compactReason(f.actual, 260));
      }
    } catch {}
  }
  if (!lines.length) {
    lines.push("- Blocker reason: not recorded on the autonomy task yet.");
    lines.push("- First unblock step: inspect source_kind/source_id, then update the task with notes or meta.blocked_reason so the next reviewer does not restart from zero.");
  }
  return lines;
}

function blockedAutonomyReviewContent(t, agent, tdb, batchInfo) {
  const blockerLines = autonomyBlockedReasonLines(tdb, t);
  const batchLines = autonomySweepBatchLines(batchInfo);
  return [
    "# Blocked autonomy review #" + t.id,
    "",
    ...batchLines,
    ...(batchLines.length ? [""] : []),
    "- Project: " + t.project,
    "- Department: " + t.department,
    "- Status: " + (t.status || "blocked"),
    "- Title: " + t.title,
    "- Assigned agent: " + (t.assigned_agent || "unassigned"),
    "- Reviewer: " + (t.reviewer_agent || agent || "strategy-review"),
    "",
    "## Why this is blocked",
    blockerLines.join("\n"),
    "",
    "This is an execution brief, not a status ping and not a passive autonomy pointer.",
    "Read the task/finding/handoff, identify the exact unblock step, and act.",
    "If you can safely fix it, fix it and verify it. If another lane owns it, brief that agent with exact URL/file/evidence. If only owner/server access can unblock it, write one precise blocker with the exact access or decision needed.",
    "After acting, update the task with mem_autonomy_task_update so the blocked state cannot silently stay stale."
  ].join("\n");
}

function resolveAutonomyTaskUpdateId(tdb, inputId) {
  const raw = parseInt(inputId, 10);
  if (!Number.isFinite(raw)) return { id: inputId, error: "invalid id" };
  const direct = tdb.prepare("SELECT id, meta_json FROM autonomy_task WHERE id=?").get(raw);
  if (direct) return { id: raw, resolved_from: "autonomy_task.id" };
  const candidates = [];
  try {
    const brief = tdb.prepare("SELECT id, content, meta_json FROM agent_brief WHERE id=?").get(raw);
    if (brief) {
      const meta = parseMaybeJson(brief.meta_json, {}) || {};
      ["autonomy_task_id", "blocked_autonomy_task_id", "task_id"].forEach((key) => {
        const value = parseInt(meta[key], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "agent_brief.meta." + key });
      });
      const content = String(brief.content || "");
      const re = /(?:Autonomy task|Blocked autonomy review)\s*#(\d+)/gi;
      let match;
      while ((match = re.exec(content))) {
        const value = parseInt(match[1], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "agent_brief.content" });
      }
    }
  } catch {}
  try {
    const mem = tdb.prepare("SELECT id, text, meta_json FROM memory WHERE id=?").get(raw);
    if (mem) {
      const meta = parseMaybeJson(mem.meta_json, {}) || {};
      ["autonomy_task_id", "blocked_autonomy_task_id", "task_id"].forEach((key) => {
        const value = parseInt(meta[key], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "memory.meta." + key });
      });
      const re = /(?:Autonomy task|Blocked autonomy review)\s*#(\d+)/gi;
      let match;
      while ((match = re.exec(String(mem.text || "")))) {
        const value = parseInt(match[1], 10);
        if (Number.isFinite(value)) candidates.push({ id: value, source: "memory.text" });
      }
    }
  } catch {}
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const row = tdb.prepare("SELECT id FROM autonomy_task WHERE id=?").get(candidate.id);
    if (row) return { id: candidate.id, resolved_from: candidate.source, input_id: raw };
  }
  return { id: raw, error: "task not found", candidates };
}

function qualityFindingExists(tdb, project, title) {
  try { return tdb.prepare("SELECT id, status FROM quality_finding WHERE project=? AND title=? ORDER BY id DESC LIMIT 1").get(project, title); } catch { return null; }
}

function createQualityFindingOnce(tdb, finding) {
  const existing = qualityFindingExists(tdb, finding.project, finding.title);
  if (existing && existing.status === "open") return { action: "kept", id: existing.id, status: existing.status };
  const info = tdb.prepare("INSERT INTO quality_finding (project, category, severity, title, url, expected, actual, source_agent, evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(finding.project, finding.category, finding.severity || "M", finding.title, finding.url || null, finding.expected || null, finding.actual || null, finding.source_agent || null, finding.evidence ? JSON.stringify(finding.evidence) : null);
  return { action: "created", id: info.lastInsertRowid, status: "open" };
}

const LIVE_GATES = ["nav", "header_footer", "links", "auth", "pricing", "checkout", "billing", "vat", "legal", "mobile", "i18n", "deploy", "monitoring"];
function blunTopDirectives(project, rulesRow) {
  const auth = parseMaybeJson(rulesRow && rulesRow.auth_matrix, {}) || {};
  const design = parseMaybeJson(rulesRow && rulesRow.design_rules, {}) || {};
  const projectName = String(project || rulesRow && rulesRow.project || "");
  const canonicalLoginUrl = String(auth.canonical_login_url || "");
  const isBlun =
    /blun/i.test(projectName) ||
    auth.canonical_project === "account.blun.ai" ||
    /https?:\/\/account\.blun\.ai(\/|$)/i.test(canonicalLoginUrl) ||
    design.canonical_brand_project === "blun.ai" ||
    design.canonical_header_project === "blun.ai" ||
    design.canonical_button_project === "blun.ai" ||
    design.shared_ui_family === "blun";
  if (!isBlun) return [];
  return [
    "BLUN top directive: account.blun.ai login/auth is canonical. Every public BLUN portal must route account entry through account.blun.ai and must not invent a different login flow, account flow, or session model.",
    "BLUN top directive: shared login does not mean shared pricing. Each portal keeps its own pricing and entitlement model unless an explicit cross-portal bundle is documented.",
    "BLUN top directive: admin.blun.ai is the separate central admin surface. Customer account flows and normal user login behavior stay in account.blun.ai; internal admin, oversight, audit, and portal/customer management stay in admin.blun.ai behind separate role/elevation checks.",
    "BLUN top directive: blun.ai defines the canonical header structure, button system, and light/dark visual behavior for linked portals.",
    "BLUN top directive: language and theme switching belong in account/settings surfaces, not in shared public header chrome. Language defaults to the browser unless account.blun.ai stores an explicit override. Do not add DE/EN toggles or theme toggles to the canonical BLUN header unless project rules declare a written exception.",
    "BLUN top directive: fonts, font sizes, light-logo PNG, dark-logo PNG, button sizing, and header spacing must mirror the canonical BLUN source exactly.",
    "BLUN top directive: no local reinterpretation. If a portal deviates from account.blun.ai auth or blun.ai header/buttons/theme, block the work and fix the contract before coding."
  ];
}

function buildProjectCrossoverCheck(tdb, a) {
  ensureAutonomyTables(tdb);
  const project = a.project || a.name;
  if (!project) return { error: "project required" };
  const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(project) || null;
  const rules = tdb.prepare("SELECT * FROM project_rules WHERE project=?").get(project) || null;
  const checklist = reg ? parseMaybeJson(reg.health_checklist, {}) || {} : {};
  const required = new Set(LIVE_GATES);
  if (rules) {
    for (const gate of parseMaybeJson(rules.required_gates, []) || []) required.add(gate);
  }
  const checks = [];
  const findings = [];
  function addFinding(category, severity, title, expected, actual, evidence) {
    const finding = { project, category, severity, title, expected, actual, evidence, source_agent: a.source_agent || a.agent_name || "crossover-check" };
    findings.push(finding);
    checks.push({ category, status: "finding", severity, title });
  }
  if (!reg) addFinding("deploy", "H", "Project registry missing", "Project has registry row with domain, live_url, server and health checklist.", "No project_registry row found.", {});
  if (!rules) addFinding("coordination", "H", "Project rules missing", "Project has canonical nav, auth, pricing, checkout, VAT, legal, design and deploy rules.", "No project_rules row found.", {});
  if (reg && !reg.live_url) addFinding("deploy", "M", "Live URL missing", "Project registry declares the live URL used for checks.", "live_url is empty.", { registry: reg.name });
  if (reg && !reg.domain) addFinding("deploy", "M", "Domain missing", "Project registry declares canonical domain.", "domain is empty.", { registry: reg.name });
  if (rules) {
    const nav = parseMaybeJson(rules.canonical_nav, []);
    const navItems = Array.isArray(nav)
      ? nav
      : [nav?.primary, nav?.items, nav?.menu, nav?.links].find((items) => Array.isArray(items)) || [];
    if (navItems.length === 0) addFinding("nav", "H", "Canonical menu missing", "Landing/app pages use the same documented menu items and targets.", "canonical_nav is empty.", {});
    const auth = parseMaybeJson(rules.auth_matrix, {});
    if (!auth || auth.status === "unknown") addFinding("auth", "H", "Auth crossover unknown", "Document whether one login works across related sites and which pages share account state.", "auth_matrix.status is unknown or missing.", auth || {});
    const authContract = authContractReport(tdb, project, ensureFirmOpsTables);
    if (authContract.status === "block") {
      for (const blocker of authContract.blockers || []) {
        addFinding("auth", "H", "Canonical auth contract mismatch", "Every linked portal follows one documented login/SSO contract.", blocker, { canonical_project: authContract.canonical_project, missing: authContract.missing, mismatches: authContract.mismatches });
      }
    } else {
      checks.push({ category: "auth", status: "pass", title: "Canonical auth contract consistent" });
    }
    const pricing = parseMaybeJson(rules.pricing_rules, {});
    if (!pricing || pricing.status === "unknown" || pricing.source_of_truth === "unknown") addFinding("pricing", "H", "Pricing source of truth unknown", "Every pricing page and admin price change points to one source of truth.", "pricing_rules are incomplete.", pricing || {});
    const checkout = parseMaybeJson(rules.checkout_rules, {});
    if (!checkout || checkout.status === "unknown" || checkout.provider === "unknown") addFinding("checkout", "H", "Checkout rules unknown", "Checkout provider, products, prices, customer portal, refunds and webhooks are documented.", "checkout_rules are incomplete.", checkout || {});
    const vat = parseMaybeJson(rules.vat_rules, {});
    if (!vat || vat.status === "unknown") addFinding("vat", "H", "VAT/OSS check unknown", "VAT/OSS/VIES requirements are documented and checked before live.", "vat_rules.status is unknown or missing.", vat || {});
    const language = parseMaybeJson(rules.language_matrix, {});
    if (!language || language.status === "unknown") addFinding("i18n", "M", "Language parity unknown", "Every required language has the same nav, pages and user flow coverage.", "language_matrix.status is unknown or missing.", language || {});
    const uiContract = uiContractReport(tdb, project, ensureFirmOpsTables);
    if (uiContract.status === "block") {
      for (const blocker of uiContract.blockers || []) {
        addFinding("design", "H", "Canonical UI contract mismatch", "Every linked portal follows blun.ai for header structure, buttons, and light/dark behavior.", blocker, { missing: uiContract.missing, mismatches: uiContract.mismatches });
      }
    } else {
      checks.push({ category: "design", status: "pass", title: "Canonical UI contract consistent" });
    }
  }
  for (const gate of required) {
    const status = checklist[gate];
    if (status === "block") addFinding(gate, "H", "Live gate blocked: " + gate, "Gate is pass before live deploy.", "health_checklist." + gate + " is block.", { gate });
    else if (status !== "pass") checks.push({ category: gate, status: "unknown", title: "Gate not passed: " + gate });
  }
  const created = [];
  if (a.create_findings !== false) {
    for (const f of findings) created.push(Object.assign({}, createQualityFindingOnce(tdb, f), { title: f.title, category: f.category, severity: f.severity }));
  }
  const status = findings.some(f => f.severity === "H" || f.severity === "critical") ? "block" : (findings.length || checks.some(c => c.status === "unknown") ? "attention" : "ok");
  return { ok: status === "ok", status, project, checks, findings: created.length ? created : findings, required_gates: Array.from(required) };
}

function runAutonomySweep(tdb, a) {
  ensureAutonomyTables(tdb);
  const depCount = tdb.prepare("SELECT COUNT(*) AS c FROM department WHERE status='active'").get().c;
  if (!depCount) {
    const depStmt = tdb.prepare("INSERT INTO department (name, mission, lead_agent, review_agent, skills_json, responsibilities_json, required_gates_json, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO NOTHING");
    for (const d of defaultDepartments(a.agent_map || {})) {
      depStmt.run(d.name, d.mission, d.lead_agent || null, d.review_agent || null, JSON.stringify(d.skills || []), JSON.stringify(d.responsibilities || []), JSON.stringify(d.required_gates || []), a.agent_name || DEFAULT_AGENT);
    }
  }
  const scope = scopeName(a.scope);
  const board = buildFirmReadinessBoard(tdb, { scope, project: a.project, include_seed: a.include_seed !== false, include_smoke: a.include_smoke === true });
  const tasks = [];
  const projects = a.project ? board.projects.filter(p => p.name === a.project) : board.projects;
  for (const p of projects) {
    const reviewTask = insertAutonomyTask(tdb, {
      project: p.name,
      department_name: "strategy-review",
      title: "Review readiness and coordinate outstanding work for " + p.name,
      category: "coordination",
      severity: p.status === "block" ? "H" : "M",
      checklist: { gates: p.gates, missing: p.missing, findings: p.findings },
      meta: { source: "autonomy_sweep", status: p.status }
    });
    tasks.push(Object.assign({ project: p.name, department: "strategy-review", title: "Review readiness and coordinate outstanding work for " + p.name }, reviewTask));
    for (const gate of p.gates.unknown.concat(p.gates.blocked)) {
      const dep = gateDepartment(gate);
      const t = insertAutonomyTask(tdb, {
        project: p.name,
        department_name: dep,
        title: "Resolve live gate " + gate + " for " + p.name,
        category: gate,
        severity: p.gates.blocked.includes(gate) ? "H" : "M",
        checklist: { gate, expected: "pass", current: p.gates.blocked.includes(gate) ? "block" : "unknown" },
        meta: { source: "readiness_board" }
      });
      tasks.push(Object.assign({ project: p.name, department: dep, title: "Resolve live gate " + gate + " for " + p.name }, t));
    }
    for (const missing of p.missing || []) {
      const dep = missing === "project_rules" || missing === "registry" ? "strategy-review" : gateDepartment(missing);
      const t = insertAutonomyTask(tdb, {
        project: p.name,
        department_name: dep,
        title: "Fill missing " + missing + " for " + p.name,
        category: missing,
        severity: missing === "project_rules" || missing === "registry" ? "H" : "M",
        checklist: { missing },
        meta: { source: "readiness_missing" }
      });
      tasks.push(Object.assign({ project: p.name, department: dep, title: "Fill missing " + missing + " for " + p.name }, t));
    }
  }
  const openFindings = tdb.prepare("SELECT id, project, category, severity, title FROM quality_finding WHERE status='open' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at DESC LIMIT ?").all(Math.min(a.finding_limit || 100, 500));
  for (const f of openFindings) {
    if (a.project && f.project !== a.project) continue;
    const dep = categoryDepartment(f.category);
    const t = insertAutonomyTask(tdb, {
      project: f.project,
      department_name: dep,
      title: "Fix finding #" + f.id + ": " + f.title,
      category: f.category,
      severity: f.severity,
      source_kind: "quality_finding",
      source_id: f.id,
      checklist: { finding_id: f.id, verify_before_resolve: true },
      meta: { source: "quality_finding" }
    });
    tasks.push(Object.assign({ project: f.project, department: dep, title: "Fix finding #" + f.id + ": " + f.title }, t));
  }
  const created = tasks.filter(t => t.action === "created");
  const briefedTasks = [];
  if (a.drop_briefs) {
    const briefed = new Set();
    const briefLimit = Math.max(1, Math.min(parseInt(a.brief_limit || 25, 10) || 25, 200));
    const briefable = tasks.filter(t => t.action === "created" || t.status === "open" || t.status === "claimed" || t.status === "blocked" || t.status === "review");
    const eligible = [];
    for (const t of briefable) {
      if (briefedTasks.length >= briefLimit) break;
      const reviewRequired = t.status === "blocked" || t.status === "review";
      const agent = reviewRequired ? (t.reviewer_agent || t.assigned_agent) : t.assigned_agent;
      if (!agent || briefed.has(agent + ":" + t.id)) continue;
      if (t.action !== "created" && recentAutonomyBriefExists(tdb, agent, t.id, reviewRequired ? Math.max(30, a.blocked_rebrief_minutes || 120) : 30)) continue;
      briefed.add(agent + ":" + t.id);
      eligible.push({ t, agent, reviewRequired });
    }
    const totalAvailable = eligible.length;
    for (let i = 0; i < Math.min(totalAvailable, briefLimit); i++) {
      const { t, agent, reviewRequired } = eligible[i];
      const batchInfo = {
        index: i + 1,
        total_available: totalAvailable,
        batch_limit: briefLimit,
        remaining: Math.max(0, totalAvailable - i - 1)
      };
      const content = reviewRequired ? blockedAutonomyReviewContent(t, agent, tdb, batchInfo) : autonomyBriefContent(t, agent, batchInfo);
      const meta = reviewRequired
        ? { type: "blocked_autonomy_review", blocked_autonomy_task_id: t.id, department: t.department, project: t.project, task_status: t.status, execution_required: true, sweep_batch: batchInfo }
        : { autonomy_task_id: t.id, department: t.department, project: t.project, sweep_batch: batchInfo };
      try {
        tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)").run(agent, a.agent_name || "autonomy-sweep", content, JSON.stringify(meta));
        briefedTasks.push({ id: t.id, agent, project: t.project, department: t.department, status: t.status, review_required: reviewRequired, sweep_batch: batchInfo });
      } catch {}
    }
  }
  try { tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'autonomy_sweep', ?, 'done', ?, 'autonomy')").run(a.agent_name || "autonomy-sweep", scope, JSON.stringify({ tasks: tasks.length, created: created.length, briefed: briefedTasks.length, brief_limit: a.drop_briefs ? Math.max(1, Math.min(parseInt(a.brief_limit || 25, 10) || 25, 200)) : 0, board: board.summary })); } catch {}
  return { ok: true, scope, board: board.summary, tasks_count: tasks.length, created_count: created.length, briefed_count: briefedTasks.length, briefed: briefedTasks, tasks };
}

function buildFirmReadinessBoard(tdb, a) {
  ensureFirmOpsTables();
  ensureProjectRegistryTable(tdb);
  try { tdb.exec("CREATE TABLE IF NOT EXISTS work_claim (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, file_path TEXT NOT NULL, agent_name TEXT NOT NULL, summary TEXT, claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')"); } catch {}
  const defaults = ["auth","billing","vat","legal","mobile","header_footer","pricing","checkout"];
  const names = new Set();
  try { for (const r of tdb.prepare("SELECT name FROM project_registry").all()) names.add(r.name); } catch {}
  try { for (const r of tdb.prepare("SELECT project FROM project_rules").all()) names.add(r.project); } catch {}
  try { for (const r of tdb.prepare("SELECT DISTINCT project FROM quality_finding").all()) names.add(r.project); } catch {}
  if (a.include_seed !== false) {
    const seed = loadProjectRuleDefaults(a.scope);
    for (const p of seed.projects || []) names.add(p.name);
  }
  const filter = Array.isArray(a.projects) && a.projects.length ? new Set(a.projects) : null;
  const projects = [];
  for (const name of Array.from(names).sort()) {
    if (filter && !filter.has(name)) continue;
    if (!a.include_smoke && (/^__smoke/i.test(name) || /^Smoke\s/i.test(name))) continue;
    const reg = tdb.prepare("SELECT * FROM project_registry WHERE name=?").get(name) || null;
    const rules = tdb.prepare("SELECT * FROM project_rules WHERE project=?").get(name) || null;
    const checklist = reg ? parseMaybeJson(reg.health_checklist, {}) || {} : {};
    const required = rules ? (parseMaybeJson(rules.required_gates, defaults) || defaults) : defaults;
    const passed = [];
    const blocked = [];
    const unknown = [];
    for (const gate of required) {
      const v = checklist[gate];
      if (v === "pass") passed.push(gate);
      else if (v === "block") blocked.push(gate);
      else unknown.push(gate);
    }
    const findings = tdb.prepare("SELECT COUNT(*) AS open, SUM(CASE WHEN severity IN ('H','critical') THEN 1 ELSE 0 END) AS high FROM quality_finding WHERE project=? AND status='open'").get(name) || { open: 0, high: 0 };
    const claims = tdb.prepare("SELECT COUNT(*) AS active FROM work_claim WHERE project=? AND status='active' AND expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')").get(name) || { active: 0 };
    const missing = [];
    if (!reg) missing.push("registry");
    if (!rules) missing.push("project_rules");
    if (reg && !reg.domain) missing.push("domain");
    if (reg && !reg.server) missing.push("server");
    if (reg && !reg.live_url) missing.push("live_url");
    if (rules && !rules.auth_matrix) missing.push("auth_matrix");
    if (rules && !rules.pricing_rules) missing.push("pricing_rules");
    if (rules && !rules.checkout_rules) missing.push("checkout_rules");
    if (rules && !rules.vat_rules) missing.push("vat_rules");
    let status = "ready";
    if (blocked.length || Number(findings.high || 0) > 0) status = "block";
    else if (unknown.length || missing.length || Number(findings.open || 0) > 0) status = "attention";
    projects.push({
      name,
      status,
      domain: reg ? reg.domain : null,
      live_url: reg ? reg.live_url : null,
      live_status: reg ? reg.live_status : null,
      gates: { required, passed, blocked, unknown },
      findings: { open: Number(findings.open || 0), high: Number(findings.high || 0) },
      active_claims: Number(claims.active || 0),
      missing,
      updated_at: reg && reg.updated_at ? reg.updated_at : (rules ? rules.updated_at : null)
    });
  }
  projects.sort((x, y) => {
    const rank = { block: 0, attention: 1, ready: 2 };
    return (rank[x.status] - rank[y.status]) || x.name.localeCompare(y.name);
  });
  const summary = {
    total: projects.length,
    ready: projects.filter(p => p.status === "ready").length,
    attention: projects.filter(p => p.status === "attention").length,
    block: projects.filter(p => p.status === "block").length,
    open_findings: projects.reduce((n, p) => n + p.findings.open, 0),
    high_findings: projects.reduce((n, p) => n + p.findings.high, 0)
  };
  const lines = ["# Firm readiness board", "", `Total: ${summary.total} | ready: ${summary.ready} | attention: ${summary.attention} | block: ${summary.block}`, ""];
  for (const p of projects) {
    lines.push(`## ${p.name}`);
    lines.push(`- Status: ${p.status}`);
    if (p.live_url) lines.push(`- URL: ${p.live_url}`);
    if (p.gates.blocked.length) lines.push(`- Blocked gates: ${p.gates.blocked.join(", ")}`);
    if (p.gates.unknown.length) lines.push(`- Unknown gates: ${p.gates.unknown.join(", ")}`);
    if (p.findings.open) lines.push(`- Open findings: ${p.findings.open} (${p.findings.high} high/critical)`);
    if (p.active_claims) lines.push(`- Active claims: ${p.active_claims}`);
    if (p.missing.length) lines.push(`- Missing: ${p.missing.join(", ")}`);
    lines.push("");
  }
  return { summary, projects, doc: lines.join("\n") };
}

const RECALL_STOPWORDS = new Set([
  "der", "die", "das", "den", "dem", "und", "oder", "aber", "mit", "fuer", "für", "von", "vom", "zur", "zum", "ist", "sind", "war", "was", "wie", "ich", "du", "wir", "ihr", "sie", "ein", "eine", "einer", "einen", "nicht", "noch", "auch", "auf", "aus", "bei", "nach", "dass", "the", "and", "or", "for", "with", "from", "that", "this", "what", "when", "where", "why", "how"
]);

function sanitizeFtsQuery(q) {
  if (!q) return q;
  const text = String(q).trim();
  if (/^".*"$/.test(text)) return text;
  return text.split(/\s+/).filter(Boolean).map((token) => {
    if (/^[A-Za-z0-9_]+$/.test(token)) return token;
    return '"' + token.replace(/"/g, '""') + '"';
  }).join(" ");
}

function recallSearchTokens(query) {
  const raw = String(query || "").toLowerCase();
  const folded = raw.normalize ? raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") : raw;
  const seen = new Set();
  const out = [];
  for (const token of (raw + " " + folded).match(/[\p{L}\p{N}_]{3,}/gu) || []) {
    if (RECALL_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token.slice(0, 48));
    if (out.length >= 10) break;
  }
  return out;
}

function fuzzyFtsQuery(query) {
  const tokens = recallSearchTokens(query).slice(0, 8);
  if (!tokens.length) return "";
  return tokens.map((token) => token + "*").join(" OR ");
}

function memoryFtsRecallRows(tdb, input = {}, limit = 20, ftsQuery = "", matchMode = "fts") {
  if (!ftsQuery) return [];
  try {
    const where = ["memory_fts MATCH ?"];
    const params = [ftsQuery];
    if (input.since) { where.push("m.occurred_at >= ?"); params.push(input.since); }
    if (input.kind) { where.push("m.kind = ?"); params.push(input.kind); }
    if (input.actor) { where.push("m.actor = ?"); params.push(input.actor); }
    const rows = tdb.prepare(`
      SELECT m.id, m.kind, m.actor, m.occurred_at, m.topic, m.importance,
             substr(m.text, 1, 400) AS preview,
             bm25(memory_fts) AS bm25
      FROM memory_fts
      JOIN memory m ON m.id = memory_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY bm25 ASC, m.occurred_at DESC
      LIMIT ?
    `).all(...params, Math.max(1, limit));
    return rows.map((row) => Object.assign({ surface: "memory", ref_id: String(row.id), match_mode: matchMode }, row));
  } catch {
    return [];
  }
}

function memoryLikeRecallRows(tdb, input = {}, limit = 20, queryText = "") {
  const tokens = recallSearchTokens(queryText);
  const phrase = String(queryText || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
  const terms = Array.from(new Set([phrase, ...tokens].filter((term) => term && term.length >= 3))).slice(0, 9);
  if (!terms.length) return [];
  try {
    const where = [];
    const params = [];
    const clauses = [];
    for (const term of terms) {
      clauses.push("(lower(m.text) LIKE ? OR lower(COALESCE(m.topic,'')) LIKE ? OR lower(COALESCE(m.actor,'')) LIKE ?)");
      params.push("%" + term + "%", "%" + term + "%", "%" + term + "%");
    }
    where.push("(" + clauses.join(" OR ") + ")");
    if (input.since) { where.push("m.occurred_at >= ?"); params.push(input.since); }
    if (input.kind) { where.push("m.kind = ?"); params.push(input.kind); }
    if (input.actor) { where.push("m.actor = ?"); params.push(input.actor); }
    params.push(Math.max(1, limit));
    return tdb.prepare(`
      SELECT m.id, m.kind, m.actor, m.occurred_at, m.topic, m.importance,
             substr(m.text, 1, 400) AS preview,
             999.0 AS bm25
      FROM memory m
      WHERE ${where.join(" AND ")}
      ORDER BY m.importance DESC, m.occurred_at DESC
      LIMIT ?
    `).all(...params).map((row) => Object.assign({ surface: "memory", ref_id: String(row.id), match_mode: "like" }, row));
  } catch {
    return [];
  }
}

function journalLikeRecallRows(tdb, input = {}, limit = 20, queryText = "") {
  if (input.include_journal === false) return [];
  const scopes = Array.isArray(input.journal_scopes) && input.journal_scopes.length ? input.journal_scopes : ["transcript", "brief", "event"];
  const allowed = scopes.filter((s) => ["transcript", "brief", "event"].includes(s));
  if (!allowed.length) return [];
  const tokens = recallSearchTokens(queryText);
  const phrase = String(queryText || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
  const terms = Array.from(new Set([phrase, ...tokens].filter((term) => term && term.length >= 3))).slice(0, 9);
  if (!terms.length) return [];
  try {
    const placeholders = allowed.map(() => "?").join(",");
    const params = [...allowed];
    const clauses = [];
    for (const term of terms) {
      clauses.push("(lower(COALESCE(content,'')) LIKE ? OR lower(COALESCE(summary,'')) LIKE ? OR lower(COALESCE(agent_name,'')) LIKE ?)");
      params.push("%" + term + "%", "%" + term + "%", "%" + term + "%");
    }
    if (input.actor) {
      clauses.push("lower(COALESCE(agent_name,'')) LIKE ?");
      params.push("%" + String(input.actor).toLowerCase() + "%");
    }
    params.push(Math.max(1, limit));
    return tdb.prepare(`
      SELECT scope AS kind, scope AS surface, ref_id, agent_name AS actor,
             COALESCE(summary, '') AS topic,
             substr(COALESCE(content, summary, ''), 1, 400) AS preview,
             999.0 AS bm25,
             'journal_like' AS match_mode
      FROM mnemo_search_fts
      WHERE scope IN (${placeholders}) AND (${clauses.join(" OR ")})
      LIMIT ?
    `).all(...params);
  } catch {
    return [];
  }
}

function dedupeRecallRows(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = `${row.surface || "memory"}:${row.ref_id || row.id}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (limit && out.length >= limit) break;
  }
  return out;
}


// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
const tools = {
  mem_recall: {
    description: "Search over memory plus indexed transcripts/briefs/events. Default mode 'hybrid' blends memory FTS5 + semantic recall, then mixes in journal/search-index hits so backfill and live capture stay findable. Set mode='fts' for exact-keyword only, or 'semantic' for vector-only memory search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query text. For FTS: supports OR/AND/NEAR/prefix*. For semantic: any natural-language phrase." },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 200 },
        mode: { type: "string", enum: ["fts", "semantic", "hybrid"], default: "hybrid" },
        since: { type: "string", description: "ISO date filter (e.g. 2026-04-15)." },
        kind: { type: "string", description: "Filter by kind: message|scar|dream|memory_md|edit|tool_call|decision|belief|reflection." },
        actor: { type: "string", description: "Filter by actor name." },
        include_journal: { type: "boolean", default: true, description: "Also search transcript/brief/event backfill from mnemo_search_fts." },
        journal_scopes: { type: "array", items: { type: "string", enum: ["transcript", "brief", "event"] }, description: "Optional journal scopes to include. Default: transcript, brief, event." },
      },
      required: ["query"],
    },
    handler: async ({ query, limit = 20, mode = "hybrid", since, kind, actor, include_journal = true, journal_scopes }) => {
      const lim = Math.min(limit, 200);
      const journalInput = { include_journal, journal_scopes, since, actor };
      const baseInput = { since, kind, actor };
      const exactQuery = sanitizeFtsQuery(query);

      const ftsRows = memoryFtsRecallRows(db, baseInput, lim * 2, exactQuery, "fts");
      const journalRows = mode === "semantic" ? [] : searchJournalRecallRows(db, journalInput, lim * 2, exactQuery);
      let fallbackRows = [];
      if (mode !== "semantic" && (ftsRows.length + journalRows.length) < Math.min(lim, 5)) {
        const fuzzyQuery = fuzzyFtsQuery(query);
        const fuzzyRows = fuzzyQuery && fuzzyQuery !== exactQuery
          ? memoryFtsRecallRows(db, baseInput, lim * 2, fuzzyQuery, "fuzzy_fts")
          : [];
        fallbackRows = dedupeRecallRows([
          ...fuzzyRows,
          ...memoryLikeRecallRows(db, baseInput, lim * 2, query),
          ...journalLikeRecallRows(db, journalInput, lim * 2, query)
        ]);
      }

      // Semantic branch
      let semRows = [];
      if (mode !== "fts" && _vecLoaded && _embeddings) {
        try {
          const vec = await _embeddings.embedText(query);
          const buf = _embeddings.bufFromVector(vec);
          const where = ["v.embedding MATCH ?", "k = ?"];
          const params = [buf, lim * 2];
          let sql = `
            SELECT m.id, m.kind, m.actor, m.occurred_at, m.topic, m.importance,
                   substr(m.text, 1, 400) AS preview,
                   v.distance
            FROM vec_memory v
            JOIN memory m ON m.id = v.rowid
            WHERE ${where.join(" AND ")}
          `;
          if (since)  { sql += " AND m.occurred_at >= ?"; params.push(since); }
          if (kind)   { sql += " AND m.kind = ?";        params.push(kind); }
          if (actor)  { sql += " AND m.actor = ?";       params.push(actor); }
          sql += " ORDER BY v.distance ASC";
          semRows = db.prepare(sql).all(...params).map((row) => Object.assign({ surface: "memory", ref_id: String(row.id) }, row));
        } catch (e) { semRows = []; }
      }

      if (mode === "fts") {
        return dedupeRecallRows([...ftsRows, ...journalRows, ...fallbackRows])
          .sort((a, b) => (Number(a.bm25 ?? Number.POSITIVE_INFINITY) - Number(b.bm25 ?? Number.POSITIVE_INFINITY)) || String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")))
          .slice(0, lim);
      }
      if (mode === "semantic") return semRows.slice(0, lim);

      // Hybrid: rank-fuse with reciprocal rank fusion
      const RRF_K = 60;
      const score = new Map();
      const meta = new Map();
      const rowKey = (row) => `${row.surface || "memory"}:${row.ref_id || row.id}`;
      [...ftsRows, ...journalRows, ...fallbackRows].forEach((r, i) => {
        const key = rowKey(r);
        score.set(key, (score.get(key) || 0) + 1 / (RRF_K + i + 1));
        meta.set(key, r);
      });
      semRows.forEach((r, i) => {
        const key = rowKey(r);
        score.set(key, (score.get(key) || 0) + 1 / (RRF_K + i + 1));
        if (!meta.has(key)) meta.set(key, r);
      });
      const fused = Array.from(score.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, lim)
        .map(([key, s]) => ({ ...meta.get(key), fused_score: Math.round(s * 10000) / 10000 }));
      return fused;
    },
  },

  mem_who_am_i: {
    description: "Returns current self-state: active core values, top-weighted traits, last daily reflection, statistics.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const values = db.prepare("SELECT name, statement, scope FROM core_value WHERE is_active=1 ORDER BY name").all();
      const traits = db.prepare("SELECT name, dimension, weight, evidence_count, notes FROM personality_trait ORDER BY weight DESC").all();
      const lastReflection = db.prepare("SELECT * FROM daily_reflection ORDER BY reflection_date DESC LIMIT 1").get();
      const stats = {
        memory_rows: db.prepare("SELECT COUNT(*) c FROM memory").get().c,
        date_range: db.prepare("SELECT MIN(occurred_at) min, MAX(occurred_at) max FROM memory").get(),
        beliefs_active: db.prepare("SELECT COUNT(*) c FROM belief WHERE status='active'").get().c,
      };
      return { values, traits, last_reflection: lastReflection, stats };
    },
  },

  mem_timeline: {
    description: "Chronological window of memories on a given date or range.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date YYYY-MM-DD" },
        to: { type: "string", description: "ISO date YYYY-MM-DD (default = same as from)" },
        actor: { type: "string" },
        limit: { type: "integer", default: 100, maximum: 500 },
      },
      required: ["from"],
    },
    handler: ({ from, to, actor, limit = 100 }) => {
      const fromTs = from + "T00:00:00Z";
      const toTs = (to || from) + "T23:59:59Z";
      const where = ["occurred_at BETWEEN ? AND ?"];
      const params = [fromTs, toTs];
      if (actor) { where.push("actor = ?"); params.push(actor); }
      params.push(Math.min(limit, 500));
      return db.prepare(`
        SELECT id, kind, actor, occurred_at, substr(text, 1, 300) AS preview
        FROM memory
        WHERE ${where.join(" AND ")}
        ORDER BY occurred_at ASC
        LIMIT ?
      `).all(...params);
    },
  },

  mem_health: {
    description: "Writer-health: which ingestion sources are alive, when each last wrote, dead-since timestamps.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const writers = db.prepare("SELECT * FROM writer_health ORDER BY last_write_at DESC NULLS LAST").all();
      const recent = db.prepare(`
        SELECT source, COUNT(*) c, MAX(occurred_at) last_at
        FROM memory
        WHERE ingested_at >= date('now', '-1 day')
        GROUP BY source
      `).all();
      return { writers, last_24h_by_source: recent };
    },
  },

  mem_runtime_health: {
    description: "Agent operations health: loop version, git commit/dirty state, heartbeat age, pending briefs, due reminders, recent errors, and runtime preflight state.",
    inputSchema: {
      type: "object",
      properties: {
        stale_sec: { type: "integer", default: 300, minimum: 60 },
      },
    },
    handler: (a = {}) => runtimeHealth(a),
  },

  mem_agent_memory_health: {
    description: "Memory-hook health per agent: last SessionStart/UserPromptSubmit/PreCompact/PostToolUse/Stop/SessionEnd, transcript sync, prompt capture, and prior recall status. Mission Control should use this to detect agents that are not using memory.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        since: { type: "string" },
        stale_minutes: { type: "integer", default: 1440 },
        window_minutes: { type: "integer", default: 1440 },
        limit: { type: "integer", default: 2000 }
      }
    },
    handler: (a = {}) => memoryHealth(db, a || {}),
  },

  mem_add: {
    description: "Insert a memory row directly. Use sparingly — most ingestion should go through daemons.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        text: { type: "string" },
        source: { type: "string", default: "manual" },
        actor: { type: "string" },
        topic: { type: "string" },
        importance: { type: "integer", minimum: 0, maximum: 10, default: 5 },
        meta: { type: "object" },
      },
      required: ["kind", "text"],
    },
    handler: ({ kind, text, source = "manual", actor, topic, importance = 5, meta }) => {
      const crypto = require("crypto");
      const scrubbed = stripPrivate(text);
      const cleanText = scrubbed.text;
      const occurred = new Date().toISOString();
      const hash = crypto.createHash("sha256")
        .update([kind, "manual", occurred, cleanText].join("|"))
        .digest("hex");
      const r = db.prepare(`
        INSERT INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json, hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(kind, source, "manual:" + Date.now(), occurred, actor || null, topic || null, importance, cleanText, meta ? JSON.stringify(Object.assign({}, meta, scrubbed.hadPrivate ? { private_redacted: true } : {})) : (scrubbed.hadPrivate ? JSON.stringify({ private_redacted: true }) : null), hash);
      return { id: r.lastInsertRowid, hash, occurred_at: occurred, private_redacted: scrubbed.hadPrivate };
    },
  },

  mem_link: {
    description: "Add a typed edge between two memory rows.",
    inputSchema: {
      type: "object",
      properties: {
        from_id: { type: "integer" },
        to_id: { type: "integer" },
        kind: { type: "string", description: "replies_to|references|corrects|resolves|partOf|causedBy|similar" },
        weight: { type: "number", default: 1.0 },
      },
      required: ["from_id", "to_id", "kind"],
    },
    handler: ({ from_id, to_id, kind, weight = 1.0 }) => {
      const r = db.prepare(
        "INSERT OR IGNORE INTO memory_link (from_id, to_id, kind, weight) VALUES (?,?,?,?)"
      ).run(from_id, to_id, kind, weight);
      return { inserted: r.changes > 0, id: r.lastInsertRowid };
    },
  },

  mem_recall_ids: {
    description: "Token-frugal recall: returns surface/ref_id + kind + score + snippet per hit. Memory hits still pair with mem_get / mem_timeline / mem_neighbors; transcript/brief/event hits are marked explicitly so agents do not mistake them for memory row ids.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
        mode: { type: "string", enum: ["fts", "semantic", "hybrid"], default: "hybrid" },
        since: { type: "string" },
        kind: { type: "string" },
        actor: { type: "string" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const fat = await tools.mem_recall.handler(args);
      return fat.map(r => ({
        id: (r.surface || "memory") === "memory" ? r.id : null,
        ref_id: r.ref_id || String(r.id),
        surface: r.surface || "memory",
        kind: r.kind,
        score: r.fused_score ?? (r.bm25 != null ? Math.round(r.bm25 * 1000) / 1000 : (r.distance != null ? Math.round((1 - r.distance) * 1000) / 1000 : null)),
        snippet: (r.preview || "").replace(/\s+/g, " ").slice(0, 80),
        at: r.occurred_at,
      }));
    },
  },

  mem_get: {
    description: "Fetch one or more memory rows by id, full payload (no truncation). Companion to mem_recall_ids.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "integer" }, description: "List of memory ids" },
        id: { type: "integer", description: "Single id (alternative to ids[])" },
      },
    },
    handler: ({ ids, id }) => {
      const list = ids && ids.length ? ids : (id != null ? [id] : []);
      if (!list.length) return [];
      const placeholders = list.map(() => "?").join(",");
      return db.prepare(`SELECT id, kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json FROM memory WHERE id IN (${placeholders}) ORDER BY occurred_at ASC`).all(...list);
    },
  },

  mem_reminder_add: {
    description: "Create a dated reminder. Use this when the due date/time is already explicit. For natural chat text, use mem_reminder_capture.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        details: { type: "string" },
        due_at: { type: "string", description: "ISO-like date/time, e.g. 2026-05-14T09:00:00+02:00" },
        owner_name: { type: "string" },
        agent_name: { type: "string" },
        scope: { type: "string" },
        timezone: { type: "string" },
        source: { type: "string" },
        source_ref: { type: "string" },
        channel: { type: "string" },
        actor: { type: "string" },
        meta: { type: "object" },
      },
      required: ["due_at"],
    },
    handler: (a = {}) => {
      if (!a.title && !a.text && !a.details) return { error: "title, text, or details required" };
      const dueAt = isoOrNull(a.due_at);
      if (!dueAt) return { error: "due_at must be ISO-like date/time" };
      return insertReminder(Object.assign({}, a, { due_at: dueAt }));
    },
  },

  mem_reminder_capture: {
    description: "Capture a reminder from natural chat text such as 'erinnere mich naechste Woche ans Meeting'. If the date is ambiguous, stores status=needs_due_at instead of losing it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        title: { type: "string" },
        details: { type: "string" },
        base_time: { type: "string" },
        owner_name: { type: "string" },
        agent_name: { type: "string" },
        scope: { type: "string" },
        source: { type: "string" },
        source_ref: { type: "string" },
        channel: { type: "string" },
        actor: { type: "string" },
        actor_id: { type: "string" },
        meta: { type: "object" },
      },
      required: ["text"],
    },
    handler: (a = {}) => {
      if (!a.text && !a.title && !a.details) return { error: "text required" };
      return insertReminder(a);
    },
  },

  mem_reminder_list: {
    description: "List open, due, or unresolved reminders. Agents should check this before claiming they forgot a date.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        owner_name: { type: "string" },
        agent_name: { type: "string" },
        scope: { type: "string" },
        due_before: { type: "string" },
        due_after: { type: "string" },
        query: { type: "string" },
        include_done: { type: "boolean" },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
      },
    },
    handler: (a = {}) => {
      ensureReminderTables();
      const lim = Math.min(a.limit || 50, 500);
      const { where, params } = reminderWhere(a);
      params.push(lim);
      const rows = db.prepare("SELECT * FROM reminder WHERE " + where.join(" AND ") + " ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT ?").all(...params);
      return { count: rows.length, reminders: rows.map(reminderRow) };
    },
  },

  mem_reminder_due: {
    description: "Return reminders due now or before a given timestamp. Loop workers should call this during heartbeat.",
    inputSchema: {
      type: "object",
      properties: {
        before: { type: "string" },
        owner_name: { type: "string" },
        agent_name: { type: "string" },
        mark_notified: { type: "boolean" },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
      },
    },
    handler: (a = {}) => {
      ensureReminderTables();
      const before = isoOrNull(a.before || a.due_before) || new Date().toISOString();
      const lim = Math.min(a.limit || 50, 500);
      const params = [before];
      let where = "status='open' AND due_at IS NOT NULL AND due_at<=?";
      if (a.owner_name) { where += " AND owner_name=?"; params.push(String(a.owner_name)); }
      if (a.agent_name) { where += " AND (agent_name=? OR agent_name IS NULL)"; params.push(String(a.agent_name)); }
      params.push(lim);
      const rows = db.prepare("SELECT * FROM reminder WHERE " + where + " ORDER BY due_at ASC, id ASC LIMIT ?").all(...params);
      if (a.mark_notified && rows.length) {
        const ids = rows.map(r => r.id);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare("UPDATE reminder SET notified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), notify_count=notify_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (" + placeholders + ")").run(...ids);
      }
      return { count: rows.length, before, reminders: rows.map(reminderRow) };
    },
  },

  mem_reminder_done: {
    description: "Mark a reminder done after the owner was reminded or the task is no longer needed.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, meta: { type: "object" } }, required: ["id"] },
    handler: (a = {}) => {
      ensureReminderTables();
      const info = db.prepare("UPDATE reminder SET status='done', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=COALESCE(?, meta_json) WHERE id=?").run(a.meta ? JSON.stringify(a.meta) : null, a.id);
      return { ok: info.changes > 0, id: a.id, status: "done" };
    },
  },

  mem_reminder_snooze: {
    description: "Move an open reminder to a new due time.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, until: { type: "string" } }, required: ["id", "until"] },
    handler: (a = {}) => {
      ensureReminderTables();
      const dueAt = isoOrNull(a.until);
      if (!dueAt) return { error: "until must be ISO-like date/time" };
      const info = db.prepare("UPDATE reminder SET due_at=?, status='open', notified_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(dueAt, a.id);
      return { ok: info.changes > 0, id: a.id, due_at: dueAt, status: "open" };
    },
  },

  mem_neighbors: {
    description: "Walk the typed-edge graph (memory_link) outward from a seed memory id. Returns rows reachable within depth, with edge kind and hop distance. Use this for 'show me everything related to scar X', 'what does this decision resolve', 'cluster around this belief'. Pairs with mem_link (write) and mem_recall_ids (find seeds).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Seed memory id" },
        depth: { type: "integer", default: 1, minimum: 1, maximum: 5 },
        kinds: { type: "array", items: { type: "string" }, description: "Filter to these edge kinds (replies_to|references|corrects|resolves|partOf|causedBy|similar). Empty = all." },
        direction: { type: "string", enum: ["out", "in", "both"], default: "both" },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
      },
      required: ["id"],
    },
    handler: ({ id, depth = 1, kinds, direction = "both", limit = 50 }) => {
      const kindFilter = (Array.isArray(kinds) && kinds.length) ? kinds : null;
      const visited = new Map();
      visited.set(id, { hop: 0, via: null, edge_kind: null });
      let frontier = [id];
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next = [];
        const placeholders = frontier.map(() => "?").join(",");
        const edges = [];
        if (direction === "out" || direction === "both") {
          let sql = `SELECT from_id, to_id, kind, weight FROM memory_link WHERE from_id IN (${placeholders})`;
          const p = [...frontier];
          if (kindFilter) { sql += ` AND kind IN (${kindFilter.map(() => "?").join(",")})`; p.push(...kindFilter); }
          edges.push(...db.prepare(sql).all(...p).map(e => ({ src: e.from_id, dst: e.to_id, kind: e.kind, weight: e.weight })));
        }
        if (direction === "in" || direction === "both") {
          let sql = `SELECT from_id, to_id, kind, weight FROM memory_link WHERE to_id IN (${placeholders})`;
          const p = [...frontier];
          if (kindFilter) { sql += ` AND kind IN (${kindFilter.map(() => "?").join(",")})`; p.push(...kindFilter); }
          edges.push(...db.prepare(sql).all(...p).map(e => ({ src: e.to_id, dst: e.from_id, kind: e.kind, weight: e.weight })));
        }
        for (const e of edges) {
          if (!visited.has(e.dst)) {
            visited.set(e.dst, { hop: d, via: e.src, edge_kind: e.kind, weight: e.weight });
            next.push(e.dst);
            if (visited.size - 1 >= limit) break;
          }
        }
        frontier = next;
        if (visited.size - 1 >= limit) break;
      }
      const ids = Array.from(visited.keys()).filter(x => x !== id);
      if (!ids.length) return { seed: id, neighbors: [] };
      const placeholders = ids.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, kind, actor, occurred_at, topic, importance, substr(text, 1, 200) AS preview FROM memory WHERE id IN (${placeholders})`).all(...ids);
      const neighbors = rows.map(r => ({
        ...r,
        hop: visited.get(r.id).hop,
        via: visited.get(r.id).via,
        edge_kind: visited.get(r.id).edge_kind,
        edge_weight: visited.get(r.id).weight,
      })).sort((a, b) => a.hop - b.hop || (b.importance || 0) - (a.importance || 0));
      return { seed: id, neighbors };
    },
  },

  mem_value_get: {
    description: "Get owner-set core values. Optional name filter.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
    handler: ({ name }) => {
      if (name) return db.prepare("SELECT * FROM core_value WHERE name=? AND is_active=1").get(name);
      return db.prepare("SELECT name, statement, scope, set_at FROM core_value WHERE is_active=1 ORDER BY name").all();
    },
  },

  mem_belief_get: {
    description: "Get active beliefs, optional topic filter.",
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
    handler: ({ topic }) => {
      if (topic) return db.prepare("SELECT * FROM belief WHERE topic=? AND status='active' ORDER BY confidence DESC").all(topic);
      return db.prepare("SELECT id, statement, topic, confidence, evidence_for, evidence_against FROM belief WHERE status='active' ORDER BY confidence DESC LIMIT 50").all();
    },
  },

  mem_trait_get: {
    description: "Get personality traits, optional dimension filter.",
    inputSchema: { type: "object", properties: { dimension: { type: "string" } } },
    handler: ({ dimension }) => {
      if (dimension) return db.prepare("SELECT * FROM personality_trait WHERE dimension=? ORDER BY weight DESC").all(dimension);
      return db.prepare("SELECT name, dimension, weight, evidence_count, notes FROM personality_trait ORDER BY weight DESC").all();
    },
  },

  mem_duration_history: {
    description: "Returns historical actual durations for a given task_type. Use this INSTEAD of guessing/projecting fantasy ETAs. Returns count, min, max, avg, p50, p90 in minutes plus last 5 raw runs.",
    inputSchema: {
      type: "object",
      properties: {
        task_type: { type: "string", description: "e.g. 'mcp_server_scaffold', 'telegram_hook_fix', 'backfill_ingest'." },
        like: { type: "string", description: "fuzzy match alternative — uses LIKE on task_type." },
      },
    },
    handler: ({ task_type, like }) => {
      let where = "completed_at IS NOT NULL AND duration_min IS NOT NULL";
      const params = [];
      if (task_type) { where += " AND task_type = ?"; params.push(task_type); }
      else if (like) { where += " AND task_type LIKE ?"; params.push("%" + like + "%"); }
      const rows = db.prepare(`SELECT task_type, started_at, completed_at, duration_min, outcome, notes FROM task_run WHERE ${where} ORDER BY completed_at DESC LIMIT 20`).all(...params);
      if (rows.length === 0) {
        return { count: 0, message: "No historical data yet — do not invent. Acknowledge unknown duration." };
      }
      const durations = rows.map(r => r.duration_min).sort((a,b) => a-b);
      const avg = durations.reduce((a,b)=>a+b,0) / durations.length;
      const p50 = durations[Math.floor(durations.length / 2)];
      const p90 = durations[Math.min(durations.length-1, Math.floor(durations.length * 0.9))];
      return {
        count: rows.length,
        min_min: durations[0],
        max_min: durations[durations.length - 1],
        avg_min: Math.round(avg * 10) / 10,
        p50_min: p50,
        p90_min: p90,
        recent: rows.slice(0, 5),
        guidance: "Quote the recent actuals when speaking. Do not project a single point estimate.",
      };
    },
  },

  mem_task_start: {
    description: "Begin tracking a task run. Returns task_run.id which you should pass to mem_task_finish later.",
    inputSchema: {
      type: "object",
      properties: {
        task_type: { type: "string" },
        description: { type: "string" },
        scope: { type: "object" },
      },
      required: ["task_type", "description"],
    },
    handler: ({ task_type, description, scope }) => {
      const r = db.prepare(`INSERT INTO task_run (task_type, description, scope_json, started_at, outcome) VALUES (?,?,?,?,?)`)
        .run(task_type, description, scope ? JSON.stringify(scope) : null, new Date().toISOString(), "in_progress");
      return { id: r.lastInsertRowid, started_at: new Date().toISOString() };
    },
  },

  mem_task_finish: {
    description: "Complete a previously-started task run. Computes duration_min automatically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        outcome: { type: "string", description: "success | abandoned | partial" },
        notes: { type: "string" },
      },
      required: ["id", "outcome"],
    },
    handler: ({ id, outcome, notes }) => {
      const row = db.prepare("SELECT started_at FROM task_run WHERE id=?").get(id);
      if (!row) return { error: "task_run not found" };
      const completed = new Date().toISOString();
      const minutes = (new Date(completed).getTime() - new Date(row.started_at).getTime()) / 60000;
      db.prepare(`UPDATE task_run SET completed_at=?, duration_min=?, outcome=?, notes=COALESCE(?, notes) WHERE id=?`)
        .run(completed, Math.round(minutes * 10) / 10, outcome, notes || null, id);
      return { id, completed_at: completed, duration_min: Math.round(minutes * 10) / 10, outcome };
    },
  },


  mem_action_log: {
    description: "Log the start of an action (tool call, command, edit, deploy etc.) to Mnemo's episodic action layer. Returns id; pass to mem_action_finish later. Use this to give yourself persistent memory across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        action_kind: { type: "string", description: "e.g. tool_call | bash | edit | deploy | scrape | brief | commit" },
        target: { type: "string", description: "what was acted on (file path, URL, service name)" },
        agent_name: { type: "string", description: "who did it (default from MNEMO_DEFAULT_AGENT)" },
        payload: { type: "object", description: "structured args of the action" },
        topic: { type: "string", description: "free-form group label" },
        session_id: { type: "string" },
        status: { type: "string", description: "started | ok | error (default: started)" },
        meta: { type: "object" },
      },
      required: ["action_kind"],
    },
    handler: (a) => {
      const r = db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, started_at, session_id, topic, meta_json) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          a.agent_name || DEFAULT_AGENT,
          a.action_kind,
          a.target || null,
          a.status || "started",
          a.payload ? JSON.stringify(a.payload) : null,
          a.started_at || new Date().toISOString(),
          a.session_id || null,
          a.topic || null,
          a.meta ? JSON.stringify(a.meta) : null
        );
      return { id: r.lastInsertRowid, agent_name: a.agent_name || DEFAULT_AGENT, action_kind: a.action_kind };
    },
  },

  mem_action_finish: {
    description: "Mark an action as complete. Computes latency_ms automatically from started_at. Pair with every mem_action_log call.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string", description: "ok | error | partial (default: ok)" },
        result: { type: "object" },
      },
      required: ["id"],
    },
    handler: (a) => {
      const finishedAt = new Date().toISOString();
      const row = db.prepare("SELECT started_at FROM agent_action WHERE id=?").get(a.id);
      if (!row) return { error: "agent_action not found" };
      const latency = Date.parse(finishedAt) - Date.parse(row.started_at);
      db.prepare("UPDATE agent_action SET status=?, finished_at=?, latency_ms=?, result_json=? WHERE id=?")
        .run(a.status || "ok", finishedAt, latency, a.result ? JSON.stringify(a.result) : null, a.id);
      return { id: a.id, status: a.status || "ok", latency_ms: latency };
    },
  },

  mem_actions_recent: {
    description: "List recent actions, filterable by agent_name, action_kind, topic, or since-timestamp. Use to remember what you did.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        action_kind: { type: "string" },
        topic: { type: "string" },
        since: { type: "string", description: "ISO timestamp" },
        limit: { type: "integer", description: "default 50, max 500" },
      },
    },
    handler: (a) => {
      const where = ["1=1"]; const params = [];
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.action_kind) { where.push("action_kind=?"); params.push(a.action_kind); }
      if (a.topic) { where.push("topic=?"); params.push(a.topic); }
      if (a.since) { where.push("started_at >= ?"); params.push(a.since); }
      params.push(Math.min(a.limit || 50, 500));
      const rows = db.prepare(
        "SELECT id, agent_name, action_kind, target, status, started_at, finished_at, latency_ms, " +
        "substr(payload_json,1,200) AS payload_preview, substr(result_json,1,200) AS result_preview, " +
        "session_id, topic " +
        "FROM agent_action WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, actions: rows };
    },
  },

  mem_actions_search: {
    description: "LIKE-search across action target, payload, result and topic. For finding past actions by what they touched.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["q"],
    },
    handler: (a) => {
      const q = String(a.q || "").trim();
      if (!q) return { error: "q required" };
      const like = "%" + q + "%";
      const rows = db.prepare(
        "SELECT id, agent_name, action_kind, target, status, started_at, latency_ms " +
        "FROM agent_action WHERE target LIKE ? OR payload_json LIKE ? OR result_json LIKE ? OR topic LIKE ? " +
        "ORDER BY started_at DESC LIMIT ?"
      ).all(like, like, like, like, Math.min(a.limit || 30, 200));
      return { count: rows.length, actions: rows };
    },
  },


  mem_reflect_now: {
    description: "In-the-moment self-orientation snapshot. Returns the agent's last 20 actions, in-flight actions (started but not finished), pending briefs, and last daily reflection. Call this BEFORE making decisions about what to do next so you don't repeat yourself, leave open work, or ignore your inbox.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "default from MNEMO_DEFAULT_AGENT" },
        lookback_minutes: { type: "integer", description: "how far back to look (default 60)" },
      },
    },
    handler: (a) => {
      const agent = a.agent_name || DEFAULT_AGENT;
      const sinceIso = a.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const counts = db.prepare(
        "SELECT COUNT(*) c, SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) inflight " +
        "FROM agent_action WHERE agent_name=? AND started_at >= ?"
      ).get(agent, sinceIso);
      const topTopics = db.prepare(
        "SELECT COALESCE(topic,'(none)') AS topic, COUNT(*) AS n FROM agent_action " +
        "WHERE agent_name=? AND started_at >= ? GROUP BY topic ORDER BY n DESC LIMIT 5"
      ).all(agent, sinceIso);
      const lastFew = db.prepare(
        "SELECT id, action_kind, target, status, started_at FROM agent_action " +
        "WHERE agent_name=? AND started_at >= ? ORDER BY started_at DESC LIMIT 5"
      ).all(agent, sinceIso);
      const inflightTop = db.prepare(
        "SELECT id, action_kind, target, started_at FROM agent_action " +
        "WHERE agent_name=? AND finished_at IS NULL AND started_at >= ? " +
        "ORDER BY started_at DESC LIMIT 5"
      ).all(agent, sinceIso);
      let pendingBriefs = [];
      try {
        pendingBriefs = db.prepare(
          "SELECT id, source_agent, channel, created_at, substr(content,1,160) AS preview " +
          "FROM agent_brief WHERE agent_name=? AND status IN ('pending','dispatched') " +
          "ORDER BY created_at DESC LIMIT 5"
        ).all(agent);
      } catch (e) {}
      let lastReflection = null;
      try {
        lastReflection = db.prepare(
          "SELECT date, substr(text,1,400) AS preview FROM daily_reflection ORDER BY date DESC LIMIT 1"
        ).get();
      } catch (e) {}
      return {
        agent_name: agent,
        now: new Date().toISOString(),
        since: sinceIso,
        counts: { actions: counts.c || 0, inflight: counts.inflight || 0, pending_briefs: pendingBriefs.length },
        top_topics: topTopics,
        last_few_actions: lastFew,
        inflight_actions: inflightTop,
        pending_briefs: pendingBriefs,
        last_daily_reflection: lastReflection,
        hint: "actions=total today, inflight=started but not finished. Address inflight + pending_briefs before starting new work.",
      };
    },
  },

  mem_skill_search: {
    description: "Search the local skills/ folder by trigger-phrase or name. Returns matching SKILL.md descriptors. Use BEFORE attempting any new task — if a recipe exists, follow it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "phrase from the owner's request, e.g. 'book me a flight'" },
      },
      required: ["query"],
    },
    handler: ({ query }) => {
      const SKILLS_DIR = process.env.MNEMO_SKILLS || path.join(__dirname, "skills");
      const matches = [];
      try {
        const entries = fs.readdirSync(SKILLS_DIR);
        for (const e of entries) {
          const skillFile = path.join(SKILLS_DIR, e, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          const content = fs.readFileSync(skillFile, "utf8");
          // Extract trigger_phrases from YAML frontmatter (simple parse)
          const triggers = [];
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const tm = fm.match(/trigger_phrases:\s*\n((?:\s+-\s+.*\n?)+)/);
            if (tm) {
              for (const line of tm[1].split("\n")) {
                const m = line.match(/-\s+'([^']+)'/) || line.match(/-\s+"([^"]+)"/) || line.match(/-\s+(.+)/);
                if (m) triggers.push(m[1].trim());
              }
            }
          }
          let matched = false;
          for (const t of triggers) {
            try { if (new RegExp(t, "i").test(query)) { matched = true; break; } } catch {}
          }
          if (e.toLowerCase().includes(query.toLowerCase())) matched = true;
          if (matched) {
            matches.push({ name: e, path: skillFile, descriptor: content });
          }
        }
      } catch (e) { return { error: String(e.message) }; }
      return { count: matches.length, matches };
    },
  },

  mem_skill_record: {
    description: "Record a newly-learned skill into skills/ folder. Use AFTER successfully completing a previously-unknown task — captures the recipe for next time.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "snake_case identifier" },
        description: { type: "string" },
        trigger_phrases: { type: "array", items: { type: "string" } },
        sandbox: { type: "string", description: "browser_only | shell | docker | none" },
        requires_confirmation: { type: "boolean" },
        sensitive_data: { type: "array", items: { type: "string" } },
        recipe_steps: { type: "array", items: { type: "string" } },
        first_invocation_outcome: { type: "string" },
      },
      required: ["name", "description"],
    },
    handler: (args) => {
      const SKILLS_DIR = process.env.MNEMO_SKILLS || path.join(__dirname, "skills");
      const dir = path.join(SKILLS_DIR, args.name);
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const triggers = (args.trigger_phrases || []).map(t => `  - '${t.replace(/'/g, "''")}'`).join("\n");
        const sensitive = (args.sensitive_data || []).map(s => `  - '${s}'`).join("\n");
        const steps = (args.recipe_steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
        const md = `---
name: ${args.name}
description: ${args.description}
trigger_phrases:
${triggers || "  []"}
sandbox: ${args.sandbox || "none"}
requires_confirmation: ${args.requires_confirmation !== false}
sensitive_data:
${sensitive || "  []"}
status: learned
first_recorded_at: ${new Date().toISOString()}
---

## Recipe steps

${steps || "(no steps recorded yet)"}

## First invocation outcome

${args.first_invocation_outcome || "(none)"}
`;
        fs.writeFileSync(path.join(dir, "SKILL.md"), md);
        return { ok: true, path: path.join(dir, "SKILL.md") };
      } catch (e) {
        return { error: String(e.message) };
      }
    },
  },

  mem_promise_open: {
    description: "Returns currently-open promises an actor has made and not yet fulfilled. Use during self-checks.",
    inputSchema: { type: "object", properties: { actor: { type: "string" } } },
    handler: ({ actor = DEFAULT_AGENT }) => {
      // Heuristic: search outbound messages for commit-phrases since last 7 days
      // that don't have matching task_run completion. Returns top-20.
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const candidates = db.prepare(`
        SELECT id, occurred_at, substr(text, 1, 300) preview
        FROM memory
        WHERE actor = ? AND kind='message' AND occurred_at > ?
          AND (
            text LIKE '%mach ich%' OR text LIKE '%bau ich%' OR text LIKE '%fixe ich%'
            OR text LIKE '%komm gleich%' OR text LIKE '%schreib ich%' OR text LIKE '%push ich%'
            OR text LIKE '%deploye ich%' OR text LIKE '%check ich%' OR text LIKE '%ziehe ich%'
          )
        ORDER BY occurred_at DESC LIMIT 50
      `).all(actor, since);
      // For each, compute completion-likelihood by checking whether the actor wrote a status update mentioning the same topic afterward.
      // V1: just return the candidates with a flag.
      return { count: candidates.length, candidates };
    },
  },

  mem_reflect: {
    description: "Run reflection cycle for a date — counts corrections/praises in messages, generates a summary, writes daily_reflection row.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD, default = today" } },
    },
    handler: ({ date }) => {
      const d = date || new Date().toISOString().slice(0, 10);
      const fromTs = d + "T00:00:00Z";
      const toTs = d + "T23:59:59Z";
      const events = db.prepare(`
        SELECT actor, text FROM memory
        WHERE kind='message' AND occurred_at BETWEEN ? AND ?
        ORDER BY occurred_at ASC
      `).all(fromTs, toTs);
      let corrections = 0, praises = 0;
      const correctionPatterns = /\b(nicht so|nein|stop|hör auf|falsch|kein|fantasi|verarscht|kacke|scheiße|kaputt)/i;
      const praisePatterns = /\b(geil|super|perfekt|top|stark|hammer|granate|geil gemacht)/i;
      const ownerName = OWNER_NAME;
      for (const e of events) {
        if (e.actor !== ownerName) continue;
        if (correctionPatterns.test(e.text)) corrections++;
        if (praisePatterns.test(e.text)) praises++;
      }
      const summary = `${events.length} messages, ${corrections} corrections, ${praises} praises on ${d}.`;
      db.prepare(`
        INSERT INTO daily_reflection (reflection_date, events_examined, corrections, praises, summary, trait_diffs_json, belief_diffs_json)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(reflection_date) DO UPDATE SET
          events_examined=excluded.events_examined,
          corrections=excluded.corrections,
          praises=excluded.praises,
          summary=excluded.summary,
          generated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(d, events.length, corrections, praises, summary, "{}", "{}");
      return { date: d, events: events.length, corrections, praises, summary };
    },
  },

  // ----------------------------------------------------------------------
  // Phase 1.5 additions — cycles + commitments + session-route + delegate
  // ----------------------------------------------------------------------

  mem_cycle_recent: {
    description: "Recent consolidation-cycle events. Phase: pulse (hourly cluster) | settle (nightly synth) | arc (weekly drift). Returns most-recent first with summary + delta.",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "string", enum: ["pulse", "settle", "arc", "all"], default: "all" },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      },
    },
    handler: ({ phase = "all", limit = 10 }) => {
      try {
        const where = phase === "all" ? "1=1" : "phase = ?";
        const params = phase === "all" ? [] : [phase];
        params.push(Math.min(limit, 50));
        return db.prepare(
          `SELECT id, phase, ran_at, window_from, window_to, inputs_count, promoted_count, summary, delta_json
           FROM cycle_event WHERE ${where} ORDER BY ran_at DESC LIMIT ?`
        ).all(...params);
      } catch (e) { return { error: "cycle_event missing — run cycles.js first", detail: String(e.message) }; }
    },
  },

  mem_commitment_open: {
    description: "Owner-side inferred commitments (meetings/deadlines/events) currently open. Distinct from mem_promise_open which tracks agent-side promises.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "filter by category: meeting | interview | deadline | event | trip" },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 200 },
      },
    },
    handler: ({ category, limit = 50 }) => {
      try {
        const where = ["status = 'open'"];
        const params = [];
        if (category) { where.push("category = ?"); params.push(category); }
        params.push(Math.min(limit, 200));
        return db.prepare(
          `SELECT id, text, category, expected_followup_at, detected_at, origin_memory_id
           FROM commitment WHERE ${where.join(" AND ")} ORDER BY expected_followup_at ASC NULLS LAST LIMIT ?`
        ).all(...params);
      } catch (e) { return { error: "commitment table missing — run commitments.js scan first", detail: String(e.message) }; }
    },
  },

  mem_commitment_due: {
    description: "Commitments due within the next horizon-hours (default 24). Use during morning/evening self-checks to surface what to follow up on today.",
    inputSchema: {
      type: "object",
      properties: { horizon_hours: { type: "integer", default: 24, minimum: 1, maximum: 720 } },
    },
    handler: ({ horizon_hours = 24 }) => {
      try {
        const horizon = new Date(Date.now() + horizon_hours * 3600e3).toISOString();
        return db.prepare(
          `SELECT id, text, category, expected_followup_at, detected_at
           FROM commitment WHERE status='open' AND expected_followup_at IS NOT NULL AND expected_followup_at <= ?
           ORDER BY expected_followup_at ASC`
        ).all(horizon);
      } catch (e) { return { error: "commitment table missing", detail: String(e.message) }; }
    },
  },

  mem_commitment_close: {
    description: "Mark a commitment as closed with an outcome (happened | postponed | cancelled | unknown).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        outcome: { type: "string", enum: ["happened", "postponed", "cancelled", "unknown"] },
        notes: { type: "string" },
      },
      required: ["id", "outcome"],
    },
    handler: ({ id, outcome, notes }) => {
      try {
        db.prepare(
          "UPDATE commitment SET status='closed', closed_at=?, outcome=?, notes=COALESCE(?, notes) WHERE id=?"
        ).run(new Date().toISOString(), outcome, notes || null, id);
        return { id, closed: true, outcome };
      } catch (e) { return { error: String(e.message) }; }
    },
  },

  mem_session_route_set: {
    description: "Set the active outbound channel route for a session_id (used for mid-thread channel switching). Returns the recorded route.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        channel: { type: "string", description: "telegram | whatsapp | email | <future>" },
        recipient: { type: "string", description: "chat_id / phone / email" },
        set_by: { type: "string", default: "owner" },
        notes: { type: "string" },
      },
      required: ["session_id", "channel", "recipient"],
    },
    handler: ({ session_id, channel, recipient, set_by = "owner", notes }) => {
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS session_route (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, channel TEXT NOT NULL,
          recipient TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          set_by TEXT, notes TEXT
        )`);
        const r = db.prepare(
          "INSERT INTO session_route (session_id, channel, recipient, set_by, notes) VALUES (?,?,?,?,?)"
        ).run(session_id, channel, recipient, set_by, notes || null);
        return { id: r.lastInsertRowid, session_id, channel, recipient };
      } catch (e) { return { error: String(e.message) }; }
    },
  },

  mem_session_route_get: {
    description: "Current outbound channel route for a session_id, plus the route history.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, history_limit: { type: "integer", default: 10 } },
      required: ["session_id"],
    },
    handler: ({ session_id, history_limit = 10 }) => {
      try {
        const current = db.prepare(
          "SELECT channel, recipient, set_at, set_by FROM session_route WHERE session_id=? ORDER BY set_at DESC LIMIT 1"
        ).get(session_id) || null;
        const history = db.prepare(
          "SELECT channel, recipient, set_at, set_by, notes FROM session_route WHERE session_id=? ORDER BY set_at DESC LIMIT ?"
        ).all(session_id, Math.min(history_limit, 100));
        return { current, history };
      } catch (e) { return { error: String(e.message), current: null, history: [] }; }
    },
  },

  mem_agent_register: {
    description: "Register a new agent identity hosted by this Mnemo. Each agent has its own display_name + optional channels + optional SOUL.md path.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "internal handle (snake_case)" },
        display_name: { type: "string", description: "how it signs (for example: 'Ops Bot')" },
        email: { type: "string" },
        channels: { type: "array", items: { type: "object", properties: { channel: { type: "string" }, recipient: { type: "string" } } } },
        soul_path: { type: "string" },
      },
      required: ["name", "display_name"],
    },
    handler: ({ name, display_name, email, channels, soul_path }) => {
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS agent_identity (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
          email TEXT, channels TEXT, soul_path TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), status TEXT NOT NULL DEFAULT 'active'
        )`);
        const r = db.prepare(
          "INSERT OR IGNORE INTO agent_identity (name, display_name, email, channels, soul_path) VALUES (?,?,?,?,?)"
        ).run(name, display_name, email || null, channels ? JSON.stringify(channels) : null, soul_path || null);
        return { name, display_name, inserted: r.changes > 0 };
      } catch (e) { return { error: String(e.message) }; }
    },
  },

  mem_agent_list: {
    description: "List all agent identities hosted by this Mnemo.",
    inputSchema: { type: "object", properties: { active_only: { type: "boolean", default: true } } },
    handler: ({ active_only = true }) => {
      try {
        const where = active_only ? "WHERE status='active'" : "";
        return db.prepare(`SELECT name, display_name, email, channels, soul_path, status FROM agent_identity ${where} ORDER BY name`).all()
          .map(r => ({ ...r, channels: r.channels ? JSON.parse(r.channels) : [] }));
      } catch (e) { return []; }
    },
  },

  mem_delegation_grant: {
    description: "Grant an agent the authority to act on behalf of a principal within a scope. Scope can be 'all' | 'comms' | 'finance' | comma-list of skill names.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        principal: { type: "string", description: "name of the human/org the agent acts for" },
        scope: { type: "string", default: "all" },
        notes: { type: "string" },
      },
      required: ["agent_name", "principal"],
    },
    handler: ({ agent_name, principal, scope = "all", notes }) => {
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS delegation (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, principal TEXT NOT NULL,
          scope TEXT NOT NULL, granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          revoked_at TEXT, notes TEXT
        )`);
        const r = db.prepare(
          "INSERT INTO delegation (agent_name, principal, scope, notes) VALUES (?,?,?,?)"
        ).run(agent_name, principal, scope, notes || null);
        return { id: r.lastInsertRowid, agent_name, principal, scope };
      } catch (e) { return { error: String(e.message) }; }
    },
  },

  mem_session_brief: {
    description: "Layered session-bootstrap. Returns identity + critical context shaped to a token budget so an agent can wake up oriented in a few hundred tokens instead of doing 30 min of mem_recall. Same surface for the host agent and any tenant agent — DB routes via the calling daemon, layer shape is identical.",
    inputSchema: {
      type: "object",
      properties: {
        token_budget: { type: "integer", default: 200, minimum: 50, maximum: 4000, description: "approximate token budget; layers are added in order until budget is reached" },
        layers: { type: "array", items: { type: "string", enum: ["identity", "traits", "open_loops", "today", "recent_decisions"] }, description: "explicit layer set; defaults to all up to budget" },
        owner_name: { type: "string", description: "filter open promises/commitments to this owner; default reads from $MNEMO_OWNER_NAME" },
      },
    },
    handler: ({ token_budget = 200, layers, owner_name }) => {
      // crude token estimate: ~4 chars per token
      const est = (s) => Math.ceil(String(s || "").length / 4);
      const owner = owner_name || process.env.MNEMO_OWNER_NAME || "owner";
      const want = new Set(layers && layers.length ? layers : ["identity", "traits", "open_loops", "today", "recent_decisions"]);
      const out = { generated_at: new Date().toISOString(), token_budget, layers: {} };
      let used = 0;

      // L0 — identity (~50 tokens): owner, top 3 hard-locked values, top 1 trait
      if (want.has("identity")) {
        try {
          const values = db.prepare(
            "SELECT name, statement FROM core_value WHERE is_active=1 ORDER BY name LIMIT 3"
          ).all();
          const trait = db.prepare(
            "SELECT name, weight FROM personality_trait ORDER BY weight DESC LIMIT 1"
          ).get();
          const identity = {
            owner,
            top_values: values.map(v => ({ name: v.name, statement: v.statement.slice(0, 80) })),
            top_trait: trait ? { name: trait.name, weight: trait.weight } : null,
          };
          out.layers.identity = identity;
          used += est(JSON.stringify(identity));
        } catch (e) { out.layers.identity = { error: e.message }; }
      }

      // L1 — traits + last reflection (~120 tokens cumulative)
      if (want.has("traits") && used < token_budget) {
        try {
          const traits = db.prepare(
            "SELECT name, weight, notes FROM personality_trait ORDER BY weight DESC LIMIT 8"
          ).all();
          const lastRefl = db.prepare(
            "SELECT reflection_date, summary, next_day_focus FROM daily_reflection ORDER BY reflection_date DESC LIMIT 1"
          ).get();
          const block = { traits: traits.map(t => ({ name: t.name, w: Math.round(t.weight * 100) / 100, capped: !!(t.notes && /HARD_CAP/.test(t.notes)) })), last_reflection: lastRefl };
          out.layers.traits = block;
          used += est(JSON.stringify(block));
        } catch (e) { out.layers.traits = { error: e.message }; }
      }

      // L2 — open loops: open promises + open commitments
      if (want.has("open_loops") && used < token_budget) {
        try {
          let openPromises = [];
          try {
            openPromises = db.prepare(
              "SELECT id, substr(text,1,120) preview, promised_at FROM promise WHERE status='open' ORDER BY promised_at DESC LIMIT 5"
            ).all();
          } catch {}
          let openCommitments = [];
          try {
            openCommitments = db.prepare(
              "SELECT id, substr(text,1,120) preview, category, expected_followup_at FROM commitment WHERE status='open' ORDER BY expected_followup_at ASC NULLS LAST LIMIT 5"
            ).all();
          } catch {}
          const block = { open_promises: openPromises, open_commitments: openCommitments };
          out.layers.open_loops = block;
          used += est(JSON.stringify(block));
        } catch (e) { out.layers.open_loops = { error: e.message }; }
      }

      // L2.5 — today: recent messages from owner (last 24h, top 5 by importance)
      if (want.has("today") && used < token_budget) {
        try {
          const since = new Date(Date.now() - 24 * 3600e3).toISOString();
          const rows = db.prepare(
            "SELECT actor, substr(text,1,140) preview, occurred_at FROM memory WHERE kind='message' AND occurred_at > ? AND actor=? ORDER BY importance DESC, occurred_at DESC LIMIT 5"
          ).all(since, owner);
          const block = { window: "last_24h", from: owner, recent: rows };
          out.layers.today = block;
          used += est(JSON.stringify(block));
        } catch (e) { out.layers.today = { error: e.message }; }
      }

      // L3 — recent decisions (last 7 days, kind=decision OR importance>=8)
      if (want.has("recent_decisions") && used < token_budget) {
        try {
          const since = new Date(Date.now() - 7 * 86400e3).toISOString();
          const rows = db.prepare(
            "SELECT actor, kind, substr(text,1,180) preview, occurred_at, importance FROM memory WHERE occurred_at > ? AND (kind='decision' OR importance >= 8) ORDER BY occurred_at DESC LIMIT 8"
          ).all(since);
          const block = { window: "last_7d", decisions_or_high_importance: rows };
          out.layers.recent_decisions = block;
          used += est(JSON.stringify(block));
        } catch (e) { out.layers.recent_decisions = { error: e.message }; }
      }

      out.estimated_tokens = used;
      out.over_budget = used > token_budget;
      return out;
    },
  },

  mem_skill_run: {
    description: "Execute a skill by name. Routes through sandbox.js — Docker-isolated for skills with needs_sandbox: true, inline for sandbox: none, surfaced as not-yet-supported for browser_only.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "skill folder name in skills/" },
        input: { type: "object", description: "JSON input passed to run.js on stdin" },
        timeout_sec: { type: "integer", default: 60, minimum: 1, maximum: 600 },
      },
      required: ["name"],
    },
    handler: async ({ name, input = {}, timeout_sec = 60 }) => {
      try {
        const { runSkill } = require("./sandbox");
        return await runSkill(name, input, { timeout_sec });
      } catch (e) { return { ok: false, error: String(e.message) }; }
    },
  },

  mem_delegation_active: {
    description: "List active (non-revoked) delegations. Filter by agent_name or principal.",
    inputSchema: {
      type: "object",
      properties: { agent_name: { type: "string" }, principal: { type: "string" } },
    },
    handler: ({ agent_name, principal }) => {
      try {
        const where = ["revoked_at IS NULL"];
        const params = [];
        if (agent_name) { where.push("agent_name=?"); params.push(agent_name); }
        if (principal) { where.push("principal=?"); params.push(principal); }
        return db.prepare(
          `SELECT id, agent_name, principal, scope, granted_at, notes
           FROM delegation WHERE ${where.join(" AND ")} ORDER BY granted_at DESC`
        ).all(...params);
      } catch (e) { return []; }
    },
  },

  mem_brief_drop: {
    description: "Drop a brief into a named agent's inbox. Team aliases (team, group, gruppe, all, crew, everyone) fan out to configured agents.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "target agent name" },
        content: { type: "string", description: "the brief markdown body" },
        source_agent: { type: "string", description: "who is dropping the brief" },
        channel: { type: "string", description: "optional source channel, e.g. telegram, mission-control, cli" },
        meta: { type: "object", description: "optional structured meta" },
      },
      required: ["agent_name", "content"],
    },
    handler: async ({ agent_name, content, source_agent, channel, meta }) => {
      const normalized = normalizeBriefContent(content, meta, { source_channel: channel || null });
      if (isTeamBriefTarget(agent_name)) {
        if (HUB_URL) return await callHub("mem_brief_drop", { agent_name, content: normalized.content, source_agent, channel, meta: normalized.meta });
        const targets = resolveTeamBriefTargets();
        if (!targets.length) return { error: "team_brief_no_targets", agent_name };
        const scrub = stripPrivate(normalized.content);
        const body = scrub.text;
        const baseMeta = normalized.meta;
        const fanoutMeta = JSON.stringify({ ...baseMeta, _team_fanout: true, _team_target: agent_name });
        const ins = db.prepare(
          "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?, ?, ?, ?, ?)"
        );
        const txn = db.transaction((names) => names.map((name) => {
          const info = ins.run(name, source_agent || null, body, channel || String(agent_name || "team"), fanoutMeta);
          return { id: info.lastInsertRowid, agent_name: name };
        }));
        const inserted = txn(targets);
        for (const row of inserted) {
          try {
            captureBriefConversation(row.id, row.agent_name, source_agent || null, body, channel || String(agent_name || "team"), baseMeta, {
              source: "brief",
              event_kind: "brief_drop",
              importance: 7
            });
          } catch {}
        }
        return { agent_name, status: "pending", fanout: inserted.length, brief_ids: inserted.map((row) => row.id), inserted, _routed: "team-fanout" };
      }
      const targetAgent = normalizeAgentName(agent_name);
      // Route to cross-host hub if target lives on another PC.
      if (isRemoteAgent(targetAgent)) {
        try {
          return await callHub("mem_brief_drop", { agent_name: targetAgent, content: normalized.content, source_agent, channel, meta: normalized.meta });
        } catch (e) {
          // Fall through to local insert as a soft fallback so we never lose data.
          // Tag the meta so the operator knows it didn't reach the hub.
          const fallback = { ...(normalized.meta || {}), _hub_error: String(e.message || e) };
          const info = db.prepare(
            "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?, ?, ?, ?, ?)"
          ).run(targetAgent, source_agent || null, normalized.content, channel || null, JSON.stringify(fallback));
          try {
            captureBriefConversation(info.lastInsertRowid, targetAgent, source_agent || null, normalized.content, channel || null, fallback, {
              source: "brief",
              event_kind: "brief_drop",
              importance: 7
            });
          } catch {}
          return { id: info.lastInsertRowid, agent_name: targetAgent, status: "pending", _routed: "local-fallback", _hub_error: String(e.message || e) };
        }
      }
      const info = db.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?, ?, ?, ?, ?)"
      ).run(targetAgent, source_agent || null, normalized.content, channel || null, normalized.meta ? JSON.stringify(normalized.meta) : null);
      try {
        captureBriefConversation(info.lastInsertRowid, targetAgent, source_agent || null, normalized.content, channel || null, normalized.meta, {
          source: "brief",
          event_kind: "brief_drop",
          importance: 7
        });
      } catch {}
      return { id: info.lastInsertRowid, agent_name: targetAgent, status: "pending" };
    },
  },

  mem_brief_pull: {
    description: "Pull pending briefs for the named agent. Marks them dispatched. Agent should process and call mem_brief_done.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        limit: { type: "integer", default: 5, minimum: 1, maximum: 50 },
        peek: { type: "boolean", description: "if true, do not mark as dispatched" },
        auto_requeue: { type: "boolean", description: "if false, skip the stale dispatched brief requeue sweep" },
        requeue_after_minutes: { type: "integer", description: "minutes before dispatched briefs for offline agents are requeued" },
      },
      required: ["agent_name"],
    },
    handler: async ({ agent_name, limit = 5, peek = false, auto_requeue = true, requeue_after_minutes }) => {
      const targetAgent = normalizeAgentName(agent_name);
      const requeueResult = auto_requeue === false ? null : briefCoordination.requeueStaleDispatchedBriefs(db, {
        older_than_minutes: requeue_after_minutes || process.env.MNEMO_BRIEF_REQUEUE_MIN || 30,
        agent_stale_sec: process.env.MNEMO_AGENT_OFFLINE_SEC || 300,
        limit: 100
      });
      // For local agents on this PC, merge hub + local results so cross-machine
      // briefs (other agents dropping on hub) become visible alongside the local queue.
      const localRows = db.prepare(
        "SELECT id, agent_name, source_agent, content, created_at, meta_json FROM agent_brief WHERE lower(agent_name)=lower(?) AND status='pending' ORDER BY CASE WHEN lower(COALESCE(meta_json,'')) LIKE '%mission-control-agent-console%' OR lower(COALESCE(meta_json,'')) LIKE '%mission_agent_console%' THEN 0 ELSE 1 END, created_at ASC LIMIT ?"
      ).all(targetAgent, limit);
      let hubRows = [];
      if (!isRemoteAgent(targetAgent) && HUB_URL) {
        try {
          const hubRes = await callHub("mem_brief_pull", { agent_name: targetAgent, limit, peek });
          hubRows = (hubRes && hubRes.briefs) || [];
          // Tag hub-sourced rows so caller knows where to mark done.
          hubRows = hubRows.map((r) => ({ ...r, _src: "hub" }));
        } catch (e) {
          // Hub unreachable — fall back to local-only with a tag.
          hubRows = [];
        }
      }
      if (!peek && localRows.length) {
        const now = new Date().toISOString();
        const upd = db.prepare("UPDATE agent_brief SET status='dispatched', dispatched_at=? WHERE id=?");
        for (const r of localRows) upd.run(now, r.id);
      }
      const all = [...hubRows, ...localRows.map((r) => ({ ...r, _src: "local" }))]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);
      return { count: all.length, briefs: all, auto_requeue: requeueResult };
    },
  },

  mem_brief_done: {
    description: "Mark a brief as completed (or failed) with an outcome string.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string", enum: ["done", "failed"] },
        outcome: { type: "string" },
      },
      required: ["id", "status"],
    },
    handler: ({ id, status, outcome }) => {
      const brief = db.prepare("SELECT id, agent_name, channel, meta_json FROM agent_brief WHERE id=?").get(id) || null;
      db.prepare("UPDATE agent_brief SET status=?, done_at=?, outcome=? WHERE id=?")
        .run(status, new Date().toISOString(), outcome || null, id);
      try {
        const meta = brief && brief.meta_json ? JSON.parse(brief.meta_json) : {};
        const outcomeText = (outcome && String(outcome).trim()) || `Brief #${id} marked ${status}.`;
        captureBriefConversation(id, brief && brief.agent_name || null, brief && brief.agent_name || null, outcomeText, brief && brief.channel || null, meta, {
          source: "brief",
          direction: "outbound",
          event_kind: "brief_done",
          importance: status === "failed" ? 8 : 6,
          meta: { brief_status: status }
        });
      } catch {}
      return { id, status };
    },
  },

  mem_brief_list: {
    description: "List briefs for an agent (or all) optionally filtered by status. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        status: { type: "string", enum: ["pending", "dispatched", "done", "failed"] },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 200 },
        include_content: { type: "boolean", default: false },
      },
    },
    handler: async ({ agent_name, status, limit = 20, include_content = false }) => {
      const where = ["1=1"]; const params = [];
      const targetAgent = normalizeAgentName(agent_name);
      if (targetAgent) { where.push("lower(agent_name)=lower(?)"); params.push(targetAgent); }
      if (status) { where.push("status=?"); params.push(status); }
      params.push(Math.min(limit, 200));
      const localRows = db.prepare(
        `SELECT id, agent_name, source_agent, status, created_at, dispatched_at, done_at,
                substr(content,1,160) AS preview, ${include_content ? "content," : ""} outcome
         FROM agent_brief WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
      ).all(...params);
      // For remote-targeted listings, query hub instead/also.
      let hubRows = [];
      if (HUB_URL && targetAgent && (isRemoteAgent(targetAgent) || true)) {
        // Always merge hub when caller asked about a specific agent_name —
        // gives consistent visibility regardless of where briefs were dropped.
        try {
          const hubRes = await callHub("mem_brief_list", { agent_name: targetAgent, status, limit, include_content });
          hubRows = (hubRes && hubRes.briefs) || [];
          hubRows = hubRows.map((r) => ({ ...r, _src: "hub" }));
        } catch (e) {
          hubRows = [];
        }
      }
      const all = [...hubRows, ...localRows.map((r) => ({ ...r, _src: "local" }))]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
      return { count: all.length, briefs: all };
    },
  },

  mem_connect_register: {
    description: "Mnemo Connect: register or refresh an agent in the cross-machine registry. Each running agent (CLI / daemon / bot) calls this on startup, then mem_connect_heartbeat periodically. Distinct from mem_agent_register (which manages the Mnemo-internal agent_identity / delegation table).",
    inputSchema: {
      type: "object",
      properties: {
        agent_name:   { type: "string", description: "stable id, e.g. 'agent-a'" },
        display_name: { type: "string" },
        host:         { type: "string", description: "machine hostname" },
        pid:          { type: "integer" },
        skills:       { type: "array", items: { type: "string" }, description: "e.g. ['scraper','postal','deploy']" },
        meta:         { type: "object" },
      },
      required: ["agent_name"],
    },
    handler: ({ agent_name, display_name, host, pid, skills, meta }) => {
      const normalizedAgent = normalizeAgentName(agent_name);
      db.prepare(
        "INSERT INTO agent_registry (agent_name, display_name, host, pid, skills_json, status, registered_at, last_seen_at, meta_json) " +
        "VALUES (?,?,?,?,?, 'online', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?) " +
        "ON CONFLICT(agent_name) DO UPDATE SET " +
        "display_name=excluded.display_name, host=excluded.host, pid=excluded.pid, " +
        "skills_json=excluded.skills_json, status='online', " +
        "last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=excluded.meta_json"
      ).run(
        normalizedAgent, display_name || agent_name, host || null, pid || null,
        JSON.stringify(skills || []), meta ? JSON.stringify(meta) : null
      );
      return { agent_name: normalizedAgent, status: "online" };
    },
  },

  mem_connect_heartbeat: {
    description: "Mnemo Connect heartbeat. Bumps last_seen_at and optionally updates runtime metadata. Agents not seen in 5 minutes are auto-marked offline on next mem_connect_list read.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        status: { type: "string", enum: ["online","busy","idle","offline"] },
        meta: { type: "object" },
      },
      required: ["agent_name"],
    },
    handler: ({ agent_name, status, meta }) => {
      const normalizedAgent = normalizeAgentName(agent_name);
      const r = db.prepare(
        "UPDATE agent_registry SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=COALESCE(?, status), meta_json=COALESCE(?, meta_json) WHERE agent_name=?"
      ).run(status || null, meta ? JSON.stringify(meta) : null, normalizedAgent);
      return { agent_name: normalizedAgent, updated: r.changes > 0 };
    },
  },

  mem_connect_list: {
    description: "List agents registered with Mnemo Connect. Stale agents (>5min) auto-marked offline.",
    inputSchema: { type: "object", properties: { only_online: { type: "boolean" }, auto_requeue: { type: "boolean" }, requeue_after_minutes: { type: "integer" }, agent_stale_sec: { type: "integer" } } },
    handler: (args) => {
      const only_online = !!(args && args.only_online);
      const marked_offline = briefCoordination.markStaleAgentsOffline(db, args && args.agent_stale_sec || 300);
      const auto_requeue = args && args.auto_requeue === false ? null : briefCoordination.requeueStaleDispatchedBriefs(db, {
        older_than_minutes: args && args.requeue_after_minutes || process.env.MNEMO_BRIEF_REQUEUE_MIN || 30,
        agent_stale_sec: args && args.agent_stale_sec || 300,
        limit: args && args.requeue_limit || 100
      });
      const where = only_online ? "WHERE status='online'" : "";
      const rows = db.prepare(
        "SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json " +
        "FROM agent_registry " + where + " ORDER BY last_seen_at DESC"
      ).all();
      return {
        count: rows.length,
        marked_offline,
        auto_requeue,
        agents: rows.map(r => ({
          ...r,
          skills: r.skills_json ? JSON.parse(r.skills_json) : [],
          meta: r.meta_json ? JSON.parse(r.meta_json) : null,
        })),
      };
    },
  },

  mem_connect_channel_upsert: {
    description: "Mnemo Connect: create or update a channel. Channels fan briefs out to all subscribed agents.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "e.g. 'listings', 'customer-pitch'" },
        description: { type: "string" },
      },
      required: ["name"],
    },
    handler: ({ name, description }) => {
      db.prepare(
        "INSERT INTO channel (name, description) VALUES (?,?) " +
        "ON CONFLICT(name) DO UPDATE SET description=COALESCE(excluded.description, channel.description)"
      ).run(name, description || null);
      return { name };
    },
  },

  mem_connect_channel_subscribe: {
    description: "Subscribe an agent to a channel. Idempotent.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, agent_name: { type: "string" } },
      required: ["channel","agent_name"],
    },
    handler: ({ channel, agent_name }) => {
      db.prepare("INSERT INTO channel (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(channel);
      db.prepare("INSERT INTO channel_subscription (channel_name, agent_name) VALUES (?,?) ON CONFLICT DO NOTHING")
        .run(channel, agent_name);
      return { channel, agent_name, subscribed: true };
    },
  },

  mem_connect_channel_post: {
    description: "Mnemo Connect: post a brief to a channel. Fans out one agent_brief row per subscriber, optionally filtered by required skill. Returns the list of created brief ids.",
    inputSchema: {
      type: "object",
      properties: {
        channel:       { type: "string" },
        content:       { type: "string" },
        source_agent:  { type: "string" },
        require_skill: { type: "string", description: "filter to subscribers whose skills include this" },
        meta:          { type: "object" },
      },
      required: ["channel","content"],
    },
    handler: ({ channel, content, source_agent, require_skill, meta }) => {
      const normalized = normalizeBriefContent(content, meta, { source_channel: channel || null, route: "channel_post" });
      let subs = db.prepare(
        "SELECT s.agent_name, r.skills_json FROM channel_subscription s " +
        "LEFT JOIN agent_registry r ON r.agent_name = s.agent_name " +
        "WHERE s.channel_name = ?"
      ).all(channel);
      if (require_skill) {
        subs = subs.filter(s => {
          try { return (JSON.parse(s.skills_json || "[]")).includes(require_skill); }
          catch { return false; }
        });
      }
      const ids = [];
      const ins = db.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?,?,?,?,?)"
      );
      for (const s of subs) {
        const info = ins.run(s.agent_name, source_agent || null, normalized.content, channel,
                             normalized.meta ? JSON.stringify(normalized.meta) : null);
        ids.push(info.lastInsertRowid);
      }
      const channelState = (briefCoordination.channelListWithSubscribers(db, { active_window_sec: 300 }).channels || []).find((row) => row.name === channel) || null;
      return { channel, fanout: subs.length, brief_ids: ids, channel_state: channelState };
    },
  },

  mem_connect_channel_list: {
    description: "List Mnemo Connect channels with subscriber counts and live heartbeat status for each subscribed agent.",
    inputSchema: { type: "object", properties: { include_subscribers: { type: "boolean" }, active_window_sec: { type: "integer" } } },
    handler: (args = {}) => briefCoordination.channelListWithSubscribers(db, args),
  },
  mem_brief_requeue_stale: {
    description: "Requeue dispatched briefs that are older than the threshold and assigned to offline or non-heartbeating agents.",
    inputSchema: { type: "object", properties: { older_than_minutes: { type: "integer" }, agent_stale_sec: { type: "integer" }, limit: { type: "integer" }, dry_run: { type: "boolean" } } },
    handler: (args = {}) => briefCoordination.requeueStaleDispatchedBriefs(db, args),
  },
  mem_brief_status: {
    description: "Full status of a brief by id (status, timestamps, supersedes-chain, parent_id, reactions).",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    handler: ({ id }) => {
      const row = db.prepare("SELECT id, agent_name, source_agent, channel, status, created_at, dispatched_at, done_at, outcome, parent_id, supersedes_id, superseded_by_id, length(content) AS content_len FROM agent_brief WHERE id=?").get(id);
      if (!row) return { error: "not_found", id };
      const reactions = db.prepare("SELECT id, agent_name, kind, payload, created_at FROM agent_brief_reaction WHERE brief_id=? ORDER BY created_at ASC").all(id);
      row.reactions = reactions;
      return row;
    },
  },
  mem_brief_react: {
    description: "Lightweight reaction on a brief (ack/blocker/question/progress/done) instead of full reply-brief.",
    inputSchema: { type: "object", properties: { brief_id: { type: "integer" }, agent_name: { type: "string" }, kind: { type: "string" }, payload: {} }, required: ["brief_id","agent_name","kind"] },
    handler: ({ brief_id, agent_name, kind, payload }) => {
      const info = db.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)").run(brief_id, agent_name, kind, payload ? (typeof payload === "string" ? payload : JSON.stringify(payload)) : null);
      return { id: info.lastInsertRowid, brief_id, agent_name, kind };
    },
  },
  mem_agent_set_notify: {
    description: "Configure per-agent push (telegram_chat or webhook URL) for brief insert/reaction events.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, webhook: { type: "string" }, telegram_chat: { type: "string" } }, required: ["agent_name"] },
    handler: ({ agent_name, webhook, telegram_chat }) => {
      const cur = db.prepare("SELECT agent_name FROM agent_registry WHERE agent_name=?").get(agent_name);
      if (!cur) return { error: "agent_not_registered", agent_name };
      db.prepare("UPDATE agent_registry SET notify_webhook=?, notify_telegram_chat=? WHERE agent_name=?").run(webhook || null, telegram_chat ? String(telegram_chat) : null, agent_name);
      return { agent_name, webhook: webhook || null, telegram_chat: telegram_chat || null };
    },
  },
  mem_agent_set_peer: {
    description: "Set agent peer_endpoint URL for direct P2P delivery + idle_after_min for hibernate signaling.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, peer_endpoint: { type: "string" }, idle_after_min: { type: "integer" } }, required: ["agent_name"] },
    handler: ({ agent_name, peer_endpoint, idle_after_min }) => {
      const cur = db.prepare("SELECT agent_name FROM agent_registry WHERE agent_name=?").get(agent_name);
      if (!cur) return { error: "agent_not_registered", agent_name };
      db.prepare("UPDATE agent_registry SET peer_endpoint=?, idle_after_min=? WHERE agent_name=?").run(peer_endpoint || null, idle_after_min || null, agent_name);
      return { agent_name, peer_endpoint: peer_endpoint || null, idle_after_min: idle_after_min || null };
    },
  },
  mem_brief_health: {
    description: "Brief-queue health snapshot.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const tot = db.prepare("SELECT COUNT(*) c FROM agent_brief").get().c;
      const pending = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='pending'").get().c;
      const dispatched = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='dispatched'").get().c;
      const done = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='done' OR status='deploy-issue'").get().c;
      const stale = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='stale'").get().c;
      const superseded = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='superseded'").get().c;
      const perAgent = db.prepare("SELECT agent_name, COUNT(*) pending FROM agent_brief WHERE status='pending' GROUP BY agent_name ORDER BY 2 DESC").all();
      const lastHour = db.prepare("SELECT COUNT(*) c FROM agent_brief WHERE created_at > datetime('now','-1 hour')").get().c;
      return { briefs_total: tot, pending, dispatched, done, stale, superseded, last_hour_drops: lastHour, queue_per_agent: perAgent, limits: { payload_max_kb: 4096, drops_per_hour_per_agent: 200, default_pull_limit: 50 } };
    },
  },
  mem_search: {
    description: "FTS5 cross-source search (default scope: ['brief']) with porter+unicode61 tokenizer + snippet highlighting.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, scope: { type: "array", items: { type: "string" } }, limit: { type: "integer" } }, required: ["query"] },
    handler: ({ query, scope, limit }) => {
      const scopes = Array.isArray(scope) && scope.length ? scope : ["brief"];
      const lim = Math.min(limit || 20, 100);
      const raw = String(query || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!raw) return { error: "query required" };
      const q = raw.split(/\s+/).filter(Boolean).map(t => '"' + t + '"').join(" ");
      const placeholders = scopes.map(() => "?").join(",");
      try {
        const rows = db.prepare("SELECT scope, ref_id, agent_name, summary, snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS snippet, rank FROM mnemo_search_fts WHERE scope IN (" + placeholders + ") AND mnemo_search_fts MATCH ? ORDER BY rank LIMIT ?").all(...scopes, q, lim);
        return { count: rows.length, query: q, scopes, results: rows };
      } catch (e) { return { error: e.message }; }
    },
  },
  mem_brief_drop_batch: {
    description: "Atomic multi-insert: array of briefs in single call.",
    inputSchema: { type: "object", properties: { briefs: { type: "array", items: { type: "object", properties: { agent_name: { type: "string" }, source_agent: { type: "string" }, content: { type: "string" }, meta: { type: "object" }, parent_id: { type: "integer" }, supersedes: { type: "integer" } }, required: ["agent_name","content"] } }, source_agent: { type: "string" } }, required: ["briefs"] },
    handler: async ({ briefs, source_agent }) => {
      const items = Array.isArray(briefs) ? briefs : [];
      if (!items.length) return { error: "briefs array required" };
      if (items.some((item) => isTeamBriefTarget(item.agent_name)) && HUB_URL) {
        return await callHub("mem_brief_drop_batch", {
          briefs: items.map((item) => {
            const normalized = normalizeBriefContent(item.content, item.meta, { source_channel: item.channel || null });
            return { ...item, content: normalized.content, meta: normalized.meta };
          }),
          source_agent,
        });
      }
      const teamTargets = resolveTeamBriefTargets();
      const expanded = [];
      for (const item of items) {
        const normalized = normalizeBriefContent(item.content, item.meta, { source_channel: item.channel || null });
        const scrub = stripPrivate(normalized.content);
        const content = scrub.text;
        if (isTeamBriefTarget(item.agent_name)) {
          if (!teamTargets.length) return { error: "team_brief_no_targets", agent_name: item.agent_name };
          const baseMeta = normalized.meta;
          for (const target of teamTargets) {
            expanded.push({ ...item, agent_name: target, content, channel: String(item.agent_name || "team"), meta: { ...baseMeta, _team_fanout: true, _team_target: item.agent_name } });
          }
        } else {
          expanded.push({ ...item, content, channel: null, meta: normalized.meta });
        }
      }
      const ins = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?,?)");
      const txn = db.transaction(rows => { const out = []; for (const r of rows) { const info = ins.run(r.agent_name, r.source_agent || source_agent || null, r.content, r.channel || null, r.meta ? JSON.stringify(r.meta) : null, r.parent_id || null, r.supersedes || null); out.push({ id: info.lastInsertRowid, agent_name: r.agent_name }); } return out; });
      const inserted = txn(expanded);
      return { count: inserted.length, ids: inserted.map(x => x.id), inserted };
    },
  },
  mem_brief_drop_multi: {
    description: "Fan-out one content to N agents. Team aliases expand to configured agents.",
    inputSchema: { type: "object", properties: { agent_names: { type: "array", items: { type: "string" } }, content: { type: "string" }, source_agent: { type: "string" }, meta: { type: "object" }, parent_id: { type: "integer" }, supersedes: { type: "integer" } }, required: ["agent_names","content"] },
    handler: async ({ agent_names, content, source_agent, meta, parent_id, supersedes }) => {
      const targets = Array.isArray(agent_names) ? agent_names : [];
      if (!targets.length) return { error: "agent_names required" };
      if (HUB_URL && targets.some((name) => isTeamBriefTarget(name) || isRemoteAgent(name))) {
        const normalized = normalizeBriefContent(content, meta);
        return await callHub("mem_brief_drop_multi", { agent_names: targets, content: normalized.content, source_agent, meta: normalized.meta, parent_id, supersedes });
      }
      const teamTargets = resolveTeamBriefTargets();
      const expandedTargets = uniqueAgentNames(targets.flatMap((name) => isTeamBriefTarget(name) ? teamTargets : [name]));
      if (!expandedTargets.length) return { error: "team_brief_no_targets", agent_names: targets };
      const normalized = normalizeBriefContent(content, meta);
      const scrub = stripPrivate(normalized.content);
      const body = scrub.text;
      const hasTeamTarget = targets.some((name) => isTeamBriefTarget(name));
      const baseMeta = normalized.meta;
      const metaJson = JSON.stringify(hasTeamTarget ? { ...baseMeta, _team_fanout: true, _team_target: targets.filter((name) => isTeamBriefTarget(name)).join(",") } : baseMeta);
      const ins = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const ids = [];
      const txn = db.transaction(names => { for (const n of names) { const info = ins.run(n, source_agent || null, body, metaJson, parent_id || null, supersedes || null); ids.push({ id: info.lastInsertRowid, agent_name: n }); } });
      txn(expandedTargets);
      return { fanout: ids.length, brief_ids: ids.map(x => x.id), inserted: ids };
    },
  },
  mem_brief_drop_from_template: {
    description: "Drop using registered template + var substitution.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, template: { type: "string" }, vars: { type: "object" }, source_agent: { type: "string" } }, required: ["agent_name","template"] },
    handler: ({ agent_name, template, vars, source_agent }) => {
      const tpl = db.prepare("SELECT body_template FROM brief_template WHERE name=?").get(template);
      if (!tpl) return { error: "template_not_found", template };
      let body = tpl.body_template;
      const v = vars || {};
      for (const k of Object.keys(v)) { const re = new RegExp("\\{\\{\\s*" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}\\}", "g"); body = body.replace(re, String(v[k] == null ? "" : v[k])); }
      const normalized = normalizeBriefContent(body, { template, vars });
      const info = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)").run(agent_name, source_agent || null, normalized.content, JSON.stringify(normalized.meta));
      return { id: info.lastInsertRowid, agent_name, template };
    },
  },
  mem_brief_template_list: {
    description: "List brief templates.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const rows = db.prepare("SELECT name, description, length(body_template) AS body_len FROM brief_template ORDER BY name").all();
      return { count: rows.length, templates: rows };
    },
  },
  mem_skill_list: {
    description: "List registered skills.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const rows = db.prepare("SELECT name, description, sandbox, requires_confirmation, status, source_path, length(body) AS body_len FROM skill_registry ORDER BY name").all();
      return { count: rows.length, skills: rows };
    },
  },
  mem_skill_match: {
    description: "Regex-match input text against registered skill trigger_phrases.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: ({ text }) => {
      if (!text) return { matches: [] };
      const skills = db.prepare("SELECT name, description, trigger_phrases FROM skill_registry WHERE status IN ('active','stub')").all();
      const matches = [];
      for (const sk of skills) {
        let triggers = [];
        try { triggers = JSON.parse(sk.trigger_phrases || "[]"); } catch {}
        for (const tp of triggers) {
          try { if (new RegExp(tp, "i").test(text)) { matches.push({ name: sk.name, description: sk.description, matched: tp }); break; } } catch {}
        }
      }
      return { matches };
    },
  },
  mem_query_layer: {
    description: "Query memory by hierarchical layer (procedural/semantic/episodic).",
    inputSchema: { type: "object", properties: { layer: { type: "string" }, limit: { type: "integer" } }, required: ["layer"] },
    handler: ({ layer, limit }) => {
      const lim = Math.min(limit || 50, 200);
      const rows = db.prepare("SELECT id, kind, source, actor, topic, importance, occurred_at, substr(text,1,300) preview FROM memory WHERE layer=? ORDER BY importance DESC, occurred_at DESC LIMIT ?").all(layer, lim);
      return { layer, count: rows.length, rows };
    },
  },
  mem_recall_layered: {
    description: "FTS recall with layer-bias weighting (default semantic 1.5x, procedural 1.2x, episodic 1.0x).",
    inputSchema: { type: "object", properties: { query: { type: "string" }, bias: { type: "object" }, limit: { type: "integer" } }, required: ["query"] },
    handler: ({ query, bias, limit }) => {
      const q = String(query || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!q) return { error: "query required" };
      const tokens = q.split(/\s+/).filter(Boolean).map(t => '"' + t + '"').join(" ");
      const lim = Math.min(limit || 20, 100);
      const b = bias || { semantic: 1.5, procedural: 1.2, episodic: 1.0 };
      const rows = db.prepare("SELECT m.id, m.kind, m.layer, m.actor, m.topic, m.importance, m.occurred_at, substr(m.text,1,400) preview, bm25(memory_fts) raw_rank FROM memory_fts JOIN memory m ON m.id=memory_fts.rowid WHERE memory_fts MATCH ? ORDER BY raw_rank LIMIT ?").all(tokens, lim * 3);
      for (const r of rows) { const w = b[r.layer || 'episodic'] || 1.0; r.weighted_rank = (r.raw_rank || 0) / w; }
      rows.sort((a, b) => a.weighted_rank - b.weighted_rank);
      return { query: q, count: rows.length, results: rows.slice(0, lim) };
    },
  },
  mem_nudge_check: {
    description: "Reflection nudge: returns reflect_recommended=true if agent has done N+ actions since last reflect entry.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, threshold: { type: "integer" } }, required: ["agent_name"] },
    handler: ({ agent_name, threshold }) => {
      const N = parseInt(threshold || 30, 10);
      const lastReflect = db.prepare("SELECT MAX(started_at) ts FROM agent_action WHERE agent_name=? AND topic='reflect'").get(agent_name);
      const since = lastReflect && lastReflect.ts ? lastReflect.ts : '1970-01-01';
      const actCount = db.prepare("SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND started_at > ? AND status != 'rollup'").get(agent_name, since).c;
      return { agent_name, since, actions_since: actCount, threshold: N, reflect_recommended: actCount >= N };
    },
  },
  mem_propose: {
    description: "Proactive idea emission with 3-filter scoring (project_fit/user_fit/cost, each H/M/L). Score 3-9. score>=7 AND cost=L → ship_eligible (auto-ship gate).",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, idea: { type: "string" }, project: { type: "string" }, project_fit: { type: "string", enum: ["H","M","L"] }, user_fit: { type: "string", enum: ["H","M","L"] }, cost: { type: "string", enum: ["H","M","L"] } }, required: ["agent_name","idea"] },
    handler: ({ agent_name, idea, project, project_fit, user_fit, cost }) => {
      const fit = ['H','M','L'];
      const pf = fit.includes(project_fit) ? project_fit : 'M';
      const uf = fit.includes(user_fit) ? user_fit : 'M';
      const cs = fit.includes(cost) ? cost : 'M';
      const fitMap = { H: 3, M: 2, L: 1 };
      const costInv = { L: 3, M: 2, H: 1 };
      const score = (fitMap[pf] || 1) + (fitMap[uf] || 1) + (costInv[cs] || 1);
      const ship_eligible = (score >= 7 && cs === 'L') ? 1 : 0;
      let status = 'queued', reason = null;
      if (score < 5) { status = 'discarded'; reason = 'score_below_threshold'; }
      else if (ship_eligible) status = 'ship_eligible';
      const info = db.prepare("INSERT INTO agent_proposal (agent_name, idea, project, project_fit, user_fit, cost, score, ship_eligible, status, reason) VALUES (?,?,?,?,?,?,?,?,?,?)").run(agent_name, idea, project || null, pf, uf, cs, score, ship_eligible, status, reason);
      return { id: info.lastInsertRowid, agent_name, score, ship_eligible: !!ship_eligible, status, reason };
    },
  },
  mem_proposals_pending: {
    description: "List queued + ship_eligible proposals.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, project: { type: "string" }, limit: { type: "integer" } } },
    handler: ({ agent_name, project, limit }) => {
      const where = ["status IN ('queued','ship_eligible')"]; const params = [];
      if (agent_name) { where.push("agent_name=?"); params.push(agent_name); }
      if (project) { where.push("project=?"); params.push(project); }
      params.push(Math.min(limit || 50, 200));
      const rows = db.prepare("SELECT id, agent_name, idea, project, project_fit, user_fit, cost, score, ship_eligible, status, created_at FROM agent_proposal WHERE " + where.join(" AND ") + " ORDER BY score DESC, created_at DESC LIMIT ?").all(...params);
      return { count: rows.length, proposals: rows };
    },
  },
  mem_proposal_update: {
    description: "Update proposal status (queued|ship_eligible|shipped|discarded). Optionally link brief_id when shipped.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, status: { type: "string" }, brief_id: { type: "integer" }, reason: { type: "string" } }, required: ["id","status"] },
    handler: ({ id, status, brief_id, reason }) => {
      db.prepare("UPDATE agent_proposal SET status=?, brief_id=COALESCE(?, brief_id), shipped_at=CASE WHEN ?='shipped' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE shipped_at END, reason=COALESCE(?, reason) WHERE id=?").run(status, brief_id || null, status, reason || null, id);
      return { id, status };
    },
  },
  mem_project_state_set: {
    description: "Snapshot a project context (kind: inflight|stalled|blocked|recent_decisions|known_gaps) with TTL hours (default 6).",
    inputSchema: { type: "object", properties: { project: { type: "string" }, kind: { type: "string" }, content: {}, ttl_hours: { type: "integer" } }, required: ["project","kind","content"] },
    handler: ({ project, kind, content, ttl_hours }) => {
      const ttl = ttl_hours || 6;
      const expires = new Date(Date.now() + ttl * 3600 * 1000).toISOString();
      const info = db.prepare("INSERT INTO project_state_snapshot (project, kind, content, expires_at) VALUES (?,?,?,?)").run(project, kind, typeof content === 'string' ? content : JSON.stringify(content), expires);
      return { id: info.lastInsertRowid, project, kind, expires_at: expires };
    },
  },
  mem_project_state_get: {
    description: "Latest non-expired project_state snapshot. Returns stale=true if older than 6h.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, kind: { type: "string" } }, required: ["project"] },
    handler: ({ project, kind }) => {
      const where = ["project=?"]; const params = [project];
      if (kind) { where.push("kind=?"); params.push(kind); }
      where.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
      const rows = db.prepare("SELECT id, project, kind, content, created_at, expires_at FROM project_state_snapshot WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT 1").all(...params);
      if (!rows.length) return { project, kind: kind || null, stale: true, snapshot: null };
      const r = rows[0];
      const ageMs = Date.now() - new Date(r.created_at).getTime();
      return { project: r.project, kind: r.kind, snapshot: r, age_minutes: Math.round(ageMs / 60000), stale: ageMs > 6 * 3600 * 1000 };
    },
  },
  mem_idle_loop_set: {
    description: "Enable/disable autonomous idle-cycle for an agent + interval in minutes (default 30).",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, enabled: { type: "boolean" }, interval_min: { type: "integer" } }, required: ["agent_name"] },
    handler: ({ agent_name, enabled, interval_min }) => {
      const en = enabled ? 1 : 0;
      const interval = parseInt(interval_min || 30, 10);
      db.prepare("INSERT INTO agent_idle_config (agent_name, enabled, interval_min, updated_at) VALUES (?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(agent_name) DO UPDATE SET enabled=excluded.enabled, interval_min=excluded.interval_min, updated_at=excluded.updated_at").run(agent_name, en, interval);
      return { agent_name, enabled: !!en, interval_min: interval };
    },
  },
  mem_idle_loop_status: {
    description: "List all agents' idle-loop configs and last cycle timestamps.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const rows = db.prepare("SELECT agent_name, enabled, interval_min, last_cycle_at FROM agent_idle_config ORDER BY agent_name").all();
      return { count: rows.length, agents: rows };
    },
  },
  mem_set_mode: {
    description: "Set agent mode (active | vacation | maintenance) with optional until-ISO and digest_chat_id for daily Telegram summary.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, mode: { type: "string", enum: ["active","vacation","maintenance"] }, until: { type: "string" }, digest_chat_id: { type: "string" } }, required: ["agent_name","mode"] },
    handler: ({ agent_name, mode, until, digest_chat_id }) => {
      db.prepare("INSERT INTO agent_mode (agent_name, mode, until, digest_chat_id, updated_at) VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(agent_name) DO UPDATE SET mode=excluded.mode, until=excluded.until, digest_chat_id=COALESCE(excluded.digest_chat_id, agent_mode.digest_chat_id), updated_at=excluded.updated_at").run(agent_name, mode, until || null, digest_chat_id ? String(digest_chat_id) : null);
      return { agent_name, mode, until: until || null };
    },
  },
  mem_get_mode: {
    description: "Get agent mode + auto-resets to active when until expires.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] },
    handler: ({ agent_name }) => {
      const row = db.prepare("SELECT agent_name, mode, until, digest_chat_id, last_digest_at, updated_at FROM agent_mode WHERE agent_name=?").get(agent_name);
      if (!row) return { agent_name, mode: 'active', until: null };
      if (row.until && new Date(row.until) < new Date()) {
        db.prepare("UPDATE agent_mode SET mode='active', until=NULL WHERE agent_name=?").run(agent_name);
        return { agent_name, mode: 'active', until: null, expired_from: row.mode };
      }
      return row;
    },
  },
  mem_skill_outcome_record: {
    description: "Log post-execution outcome for a skill (reaction: done|ack|blocker|skipped, optional metric).",
    inputSchema: { type: "object", properties: { skill_name: { type: "string" }, reaction: { type: "string" }, proposal_id: { type: "integer" }, brief_id: { type: "integer" }, metric: { type: "object" } }, required: ["skill_name","reaction"] },
    handler: ({ skill_name, reaction, proposal_id, brief_id, metric }) => {
      const info = db.prepare("INSERT INTO skill_outcome (skill_name, proposal_id, brief_id, reaction, metric_json) VALUES (?,?,?,?,?)").run(skill_name, proposal_id || null, brief_id || null, reaction, metric ? JSON.stringify(metric) : null);
      return { id: info.lastInsertRowid, skill_name, reaction };
    },
  },
  mem_skill_outcome_stats: {
    description: "Per-skill outcome breakdown + success_rate (done+ack)/total. Used to weight future propose-cycles.",
    inputSchema: { type: "object", properties: { skill_name: { type: "string" }, since: { type: "string" } } },
    handler: ({ skill_name, since }) => {
      const where = []; const params = [];
      if (skill_name) { where.push("skill_name=?"); params.push(skill_name); }
      if (since) { where.push("recorded_at >= ?"); params.push(since); }
      const sql = "SELECT skill_name, reaction, COUNT(*) c FROM skill_outcome" + (where.length ? " WHERE " + where.join(" AND ") : "") + " GROUP BY skill_name, reaction ORDER BY skill_name, reaction";
      const rows = db.prepare(sql).all(...params);
      const bySkill = {};
      for (const r of rows) {
        if (!bySkill[r.skill_name]) bySkill[r.skill_name] = { skill_name: r.skill_name, reactions: {}, total: 0, success_rate: 0 };
        bySkill[r.skill_name].reactions[r.reaction] = r.c;
        bySkill[r.skill_name].total += r.c;
      }
      for (const k of Object.keys(bySkill)) {
        const obj = bySkill[k];
        const ok = (obj.reactions["done"] || 0) + (obj.reactions["ack"] || 0);
        obj.success_rate = obj.total > 0 ? Math.round(1000 * ok / obj.total) / 1000 : 0;
      }
      return { count: Object.keys(bySkill).length, skills: Object.values(bySkill) };
    },
  },
  mem_project_create: {
    description: "Create a long-running project owned by an agent. Each agent owns N projects, briefs/actions can link via project_id.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, owner_agent: { type: "string" }, goal_text: { type: "string" }, current_milestone: { type: "string" } }, required: ["name","owner_agent"] },
    handler: ({ name, owner_agent, goal_text, current_milestone }) => {
      try { const info = db.prepare("INSERT INTO agent_project (name, owner_agent, goal_text, current_milestone) VALUES (?,?,?,?)").run(name, owner_agent, goal_text || null, current_milestone || null); return { id: info.lastInsertRowid, name, owner_agent, status: "active" }; }
      catch (e) { return String(e.message).includes("UNIQUE") ? { error: "project_exists", name } : { error: e.message }; }
    },
  },
  mem_project_update: {
    description: "Update project fields (owner_agent, goal_text, status, current_milestone, blocker).",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, owner_agent: { type: "string" }, goal_text: { type: "string" }, status: { type: "string" }, current_milestone: { type: "string" }, blocker: { type: "string" } } },
    handler: (a) => {
      const fields = []; const params = [];
      for (const k of ["owner_agent","goal_text","status","current_milestone","blocker"]) if (a[k] !== undefined) { fields.push(k + "=?"); params.push(a[k]); }
      fields.push("last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      const where = a.id ? "id=?" : "name=?";
      params.push(a.id || a.name);
      db.prepare("UPDATE agent_project SET " + fields.join(", ") + " WHERE " + where).run(...params);
      return { ok: true, identifier: a.id || a.name };
    },
  },
  mem_project_list: {
    description: "List projects (filter by owner_agent, status).",
    inputSchema: { type: "object", properties: { owner_agent: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
    handler: ({ owner_agent, status, limit }) => {
      const where = []; const params = [];
      if (owner_agent) { where.push("owner_agent=?"); params.push(owner_agent); }
      if (status) { where.push("status=?"); params.push(status); }
      params.push(Math.min(limit || 50, 200));
      const rows = db.prepare("SELECT id, name, owner_agent, goal_text, status, current_milestone, blocker, started_at, last_active_at FROM agent_project" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY last_active_at DESC LIMIT ?").all(...params);
      return { count: rows.length, projects: rows };
    },
  },
  mem_project_close: {
    description: "Close project (status=done).",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
    handler: ({ id, name }) => {
      const where = id ? "id=?" : "name=?";
      db.prepare("UPDATE agent_project SET status='done', last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE " + where).run(id || name);
      return { ok: true };
    },
  },
  mem_task_create: {
    description: "Create shared task on the team task-board. Optional project_id, priority H/M/L, skills_required array.",
    inputSchema: { type: "object", properties: { project_id: { type: "integer" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, skills_required: { type: "array", items: { type: "string" } } }, required: ["title"] },
    handler: ({ project_id, title, description, priority, skills_required }) => {
      const skills = Array.isArray(skills_required) ? skills_required : [];
      const info = db.prepare("INSERT INTO shared_task (project_id, title, description, priority, skills_required) VALUES (?,?,?,?,?)").run(project_id || null, title, description || null, priority || 'M', JSON.stringify(skills));
      return { id: info.lastInsertRowid, title, status: "open" };
    },
  },
  mem_task_claim: {
    description: "Atomic claim — fails if already claimed by another agent.",
    inputSchema: { type: "object", properties: { task_id: { type: "integer" }, agent_name: { type: "string" } }, required: ["task_id","agent_name"] },
    handler: ({ task_id, agent_name }) => {
      const r = db.prepare("UPDATE shared_task SET claim_agent=?, status='claimed', claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'").run(agent_name, task_id);
      if (r.changes === 0) { const cur = db.prepare("SELECT status, claim_agent FROM shared_task WHERE id=?").get(task_id); return { error: "claim_failed", current: cur }; }
      return { ok: true, task_id, agent_name };
    },
  },
  mem_task_release: {
    description: "Release claim, task back to open.",
    inputSchema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
    handler: ({ task_id }) => { db.prepare("UPDATE shared_task SET claim_agent=NULL, status='open', claimed_at=NULL WHERE id=?").run(task_id); return { ok: true }; },
  },
  mem_task_block: {
    description: "Mark task blocked with reason.",
    inputSchema: { type: "object", properties: { task_id: { type: "integer" }, reason: { type: "string" } }, required: ["task_id","reason"] },
    handler: ({ task_id, reason }) => { db.prepare("UPDATE shared_task SET status='blocked', blocker_reason=? WHERE id=?").run(reason, task_id); return { ok: true }; },
  },
  mem_task_done: {
    description: "Mark task done.",
    inputSchema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] },
    handler: ({ task_id }) => { db.prepare("UPDATE shared_task SET status='done', done_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(task_id); return { ok: true }; },
  },
  mem_task_available: {
    description: "List open tasks the calling agent could claim. Filters by skills, priority H>M>L.",
    inputSchema: { type: "object", properties: { skills: { type: "array", items: { type: "string" } }, limit: { type: "integer" } } },
    handler: ({ skills, limit }) => {
      const lim = Math.min(limit || 20, 100);
      let rows = db.prepare("SELECT id, project_id, title, description, priority, skills_required, created_at FROM shared_task WHERE status='open' ORDER BY CASE priority WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at ASC LIMIT ?").all(lim * 3);
      if (Array.isArray(skills) && skills.length) rows = rows.filter(r => { let req = []; try { req = JSON.parse(r.skills_required || "[]"); } catch {} return !req.length || req.some(x => skills.includes(x)); });
      return { count: rows.slice(0, lim).length, tasks: rows.slice(0, lim) };
    },
  },
  mem_watchdog_register: {
    description: "Register http portal-monitor (target URL, owner_agent, optional thresholds).",
    inputSchema: { type: "object", properties: { target: { type: "string" }, check_kind: { type: "string" }, owner_agent: { type: "string" }, threshold: { type: "object" }, enabled: { type: "boolean" } }, required: ["target"] },
    handler: ({ target, check_kind, owner_agent, threshold, enabled }) => { const info = db.prepare("INSERT INTO watchdog (target, check_kind, owner_agent, threshold_json, enabled) VALUES (?,?,?,?,?)").run(target, check_kind || 'http', owner_agent || null, threshold ? JSON.stringify(threshold) : null, enabled === false ? 0 : 1); return { id: info.lastInsertRowid, target }; },
  },
  mem_watchdog_list: {
    description: "List all registered watchdogs.",
    inputSchema: { type: "object", properties: {} },
    handler: () => { const rows = db.prepare("SELECT id, target, check_kind, owner_agent, enabled, last_check_at, last_status, consecutive_failures FROM watchdog ORDER BY enabled DESC, target").all(); return { count: rows.length, watchdogs: rows }; },
  },
  mem_watchdog_incidents: {
    description: "Watchdog incidents (open or all).",
    inputSchema: { type: "object", properties: { status: { type: "string" }, watchdog_id: { type: "integer" }, limit: { type: "integer" } } },
    handler: (a) => {
      const where = []; const params = [];
      if (a.status) { where.push("i.status=?"); params.push(a.status); }
      if (a.watchdog_id) { where.push("i.watchdog_id=?"); params.push(a.watchdog_id); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = db.prepare("SELECT i.id, i.watchdog_id, w.target, i.opened_at, i.closed_at, i.status, i.notes FROM watchdog_incident i LEFT JOIN watchdog w ON w.id=i.watchdog_id" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY i.opened_at DESC LIMIT ?").all(...params);
      return { count: rows.length, incidents: rows };
    },
  },
  mem_escalate: {
    description: "Escalate decision/blocker/customer/legal with kind+urgency+requested_authority. Auto-routes high urgency owner/customer items to immediate notify, decision items to the coordinator brief, and low urgency items to digest.",
    inputSchema: { type: "object", properties: { source_agent: { type: "string" }, kind: { type: "string" }, urgency: { type: "string" }, summary: { type: "string" }, requested_authority: { type: "string" } }, required: ["kind","summary"] },
    handler: (a) => {
      const authority = a.requested_authority || DEFAULT_AGENT;
      const info = db.prepare("INSERT INTO escalation (source_agent, kind, urgency, summary, requested_authority) VALUES (?,?,?,?,?)").run(a.source_agent || null, a.kind, a.urgency || 'M', a.summary, authority);
      const id = info.lastInsertRowid;
      const route = (a.kind === 'blocker' && a.urgency === 'H' && authority === OWNER_NAME) ? 'telegram_immediate' : (a.kind === 'customer' && a.urgency === 'H') ? 'telegram_immediate' : (a.kind === 'decision') ? 'brief_to_coordinator' : (a.urgency === 'L') ? 'digest_only' : 'brief_to_coordinator';
      try { if (route === 'brief_to_coordinator') db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run(authority, a.source_agent || null, "[ESCALATION #" + id + "] " + a.kind + "/" + a.urgency + ": " + a.summary); } catch (e) {}
      return { id, route, kind: a.kind, urgency: a.urgency };
    },
  },
  mem_escalate_resolve: {
    description: "Mark escalation resolved.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, resolution: { type: "string" } }, required: ["id"] },
    handler: ({ id, resolution }) => { db.prepare("UPDATE escalation SET status='resolved', resolution=?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(resolution || null, id); return { ok: true, id }; },
  },
  mem_escalations_pending: {
    description: "List pending escalations sorted by urgency.",
    inputSchema: { type: "object", properties: { kind: { type: "string" }, urgency: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const where = ["status='open'"]; const params = [];
      if (a.kind) { where.push("kind=?"); params.push(a.kind); }
      if (a.urgency) { where.push("urgency=?"); params.push(a.urgency); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = db.prepare("SELECT id, source_agent, kind, urgency, summary, requested_authority, created_at FROM escalation WHERE " + where.join(" AND ") + " ORDER BY CASE urgency WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at DESC LIMIT ?").all(...params);
      return { count: rows.length, escalations: rows };
    },
  },
  mem_problem_create: {
    description: "Open-problems registry. Pre-retry: list mem_problem_attempts → wenn ähnlicher approach 2x failed → escalate.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, project_id: { type: "integer" }, severity: { type: "string" }, owner_agent: { type: "string" } }, required: ["title"] },
    handler: ({ title, project_id, severity, owner_agent }) => { const info = db.prepare("INSERT INTO open_problem (title, project_id, severity, owner_agent) VALUES (?,?,?,?)").run(title, project_id || null, severity || 'M', owner_agent || null); return { id: info.lastInsertRowid, title, status: "open" }; },
  },
  mem_problem_attempt: {
    description: "Log an attempted approach to a problem (success or fail with reason).",
    inputSchema: { type: "object", properties: { problem_id: { type: "integer" }, agent_name: { type: "string" }, approach: { type: "string" }, outcome: { type: "string" }, failure_reason: { type: "string" } }, required: ["problem_id","agent_name"] },
    handler: ({ problem_id, agent_name, approach, outcome, failure_reason }) => { const info = db.prepare("INSERT INTO problem_attempt (problem_id, agent_name, approach, outcome, failure_reason) VALUES (?,?,?,?,?)").run(problem_id, agent_name, approach || null, outcome || null, failure_reason || null); return { id: info.lastInsertRowid }; },
  },
  mem_problem_attempts: {
    description: "List all attempts on a problem (newest first).",
    inputSchema: { type: "object", properties: { problem_id: { type: "integer" } }, required: ["problem_id"] },
    handler: ({ problem_id }) => { const rows = db.prepare("SELECT id, agent_name, approach, outcome, failure_reason, created_at FROM problem_attempt WHERE problem_id=? ORDER BY created_at DESC").all(problem_id); return { count: rows.length, attempts: rows }; },
  },
  mem_problem_close: {
    description: "Close problem with resolution.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, resolution: { type: "string" } }, required: ["id"] },
    handler: ({ id, resolution }) => { db.prepare("UPDATE open_problem SET status='closed', solved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution=? WHERE id=?").run(resolution || null, id); return { ok: true }; },
  },
  mem_problems_open: {
    description: "List open problems.",
    inputSchema: { type: "object", properties: { owner_agent: { type: "string" }, project_id: { type: "integer" }, limit: { type: "integer" } } },
    handler: (a) => {
      const where = ["status='open'"]; const params = [];
      if (a.owner_agent) { where.push("owner_agent=?"); params.push(a.owner_agent); }
      if (a.project_id) { where.push("project_id=?"); params.push(a.project_id); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = db.prepare("SELECT id, title, project_id, severity, owner_agent, opened_at FROM open_problem WHERE " + where.join(" AND ") + " ORDER BY CASE severity WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, opened_at DESC LIMIT ?").all(...params);
      return { count: rows.length, problems: rows };
    },
  },
  mem_consult_peer: {
    description: "Lightweight back-and-forth ask between agents (lighter than brief, heavier than reaction).",
    inputSchema: { type: "object", properties: { source_agent: { type: "string" }, target_agent: { type: "string" }, question: { type: "string" }, context: { type: "string" } }, required: ["source_agent","target_agent","question"] },
    handler: (a) => { const info = db.prepare("INSERT INTO peer_consult (source_agent, target_agent, question, context) VALUES (?,?,?,?)").run(a.source_agent, a.target_agent, a.question, a.context || null); return { id: info.lastInsertRowid, target_agent: a.target_agent }; },
  },
  mem_consults_inbox: {
    description: "Open peer-consults addressed to the calling agent.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, limit: { type: "integer" } }, required: ["agent_name"] },
    handler: ({ agent_name, limit }) => { const rows = db.prepare("SELECT id, source_agent, question, context, status, created_at FROM peer_consult WHERE target_agent=? AND status='open' ORDER BY created_at DESC LIMIT ?").all(agent_name, Math.min(limit || 20, 100)); return { count: rows.length, consults: rows }; },
  },
  mem_consult_answer: {
    description: "Reply to a peer-consult.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, response: { type: "string" } }, required: ["id","response"] },
    handler: ({ id, response }) => { db.prepare("UPDATE peer_consult SET response=?, status='answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(response, id); return { ok: true }; },
  },
  mem_meeting_open: {
    description: "Open a multi-agent collaborative thread on a topic/problem/project.",
    inputSchema: { type: "object", properties: { topic: { type: "string" }, project_id: { type: "integer" }, problem_id: { type: "integer" }, created_by: { type: "string" } }, required: ["topic"] },
    handler: (a) => { const info = db.prepare("INSERT INTO meeting (topic, project_id, problem_id, created_by) VALUES (?,?,?,?)").run(a.topic, a.project_id || null, a.problem_id || null, a.created_by || null); return { id: info.lastInsertRowid, topic: a.topic, status: "open" }; },
  },
  mem_meeting_post: {
    description: "Post a turn in meeting (turn_kind: propose|agree|disagree|question|synthesis).",
    inputSchema: { type: "object", properties: { meeting_id: { type: "integer" }, agent_name: { type: "string" }, content: { type: "string" }, turn_kind: { type: "string" } }, required: ["meeting_id","agent_name","content"] },
    handler: (a) => { const valid = ['propose','agree','disagree','question','synthesis']; const kind = valid.includes(a.turn_kind) ? a.turn_kind : 'propose'; const info = db.prepare("INSERT INTO meeting_turn (meeting_id, agent_name, content, turn_kind) VALUES (?,?,?,?)").run(a.meeting_id, a.agent_name, a.content, kind); return { id: info.lastInsertRowid, turn_kind: kind }; },
  },
  mem_meeting_close: {
    description: "Close meeting with decision_summary (auto-logged for audit).",
    inputSchema: { type: "object", properties: { meeting_id: { type: "integer" }, decision_summary: { type: "string" } }, required: ["meeting_id"] },
    handler: ({ meeting_id, decision_summary }) => { db.prepare("UPDATE meeting SET status='closed', decision_summary=?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(decision_summary || null, meeting_id); return { ok: true }; },
  },
  mem_meeting_turns: {
    description: "Read all turns of a meeting.",
    inputSchema: { type: "object", properties: { meeting_id: { type: "integer" } }, required: ["meeting_id"] },
    handler: ({ meeting_id }) => { const rows = db.prepare("SELECT id, agent_name, content, turn_kind, created_at FROM meeting_turn WHERE meeting_id=? ORDER BY created_at ASC").all(meeting_id); return { count: rows.length, turns: rows }; },
  },
  mem_consult_agent: {
    description: "Queue a programming-specialist consult for local runtime CLI to answer. Use when stuck on code-problems after 2+ failed attempts. context_files = optional array of {path, snippet?} hints.",
    inputSchema: { type: "object", properties: { requesting_agent: { type: "string" }, problem_id: { type: "integer" }, question: { type: "string" }, context_files: { type: "array" } }, required: ["requesting_agent","question"] },
    handler: (a) => { const info = db.prepare("INSERT INTO agent_consult (requesting_agent, problem_id, question, context_files) VALUES (?,?,?,?)").run(a.requesting_agent, a.problem_id || null, a.question, a.context_files ? JSON.stringify(a.context_files) : null); return { id: info.lastInsertRowid, requesting_agent: a.requesting_agent, status: "pending" }; },
  },
  mem_consult_agent_pending: {
    description: "List pending local runtime consults (for the agent-operator/cron to pick up and answer).",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    handler: ({ limit }) => { const lim = Math.min(limit || 20, 100); const rows = db.prepare("SELECT id, requesting_agent, problem_id, question, context_files, status, created_at FROM agent_consult WHERE status='pending' ORDER BY created_at ASC LIMIT ?").all(lim); for (const r of rows) { if (r.context_files) { try { r.context_files = JSON.parse(r.context_files); } catch (e) {} } } return { count: rows.length, consults: rows }; },
  },
  mem_consult_agent_answer: {
    description: "Fill a pending consult with local runtime's proposed_solution. Marks status=answered, sets answered_at.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, proposed_solution: { type: "string" } }, required: ["id","proposed_solution"] },
    handler: ({ id, proposed_solution }) => { db.prepare("UPDATE agent_consult SET proposed_solution=?, status='answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(proposed_solution, id); return { ok: true, id, status: "answered" }; },
  },
  mem_consult_agent_status: {
    description: "Get full status of a local runtime consult (question, proposed_solution if answered, lifecycle timestamps).",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    handler: ({ id }) => { const row = db.prepare("SELECT id, requesting_agent, problem_id, question, context_files, proposed_solution, used_in_attempt_id, status, created_at, answered_at FROM agent_consult WHERE id=?").get(id); if (!row) return { error: "not_found", id }; if (row.context_files) { try { row.context_files = JSON.parse(row.context_files); } catch (e) {} } return row; },
  },
  mem_consult_agent_use: {
    description: "Mark a local runtime consult as used in a specific problem-attempt. Closes the loop for skill-outcome learning.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, attempt_id: { type: "integer" } }, required: ["id"] },
    handler: ({ id, attempt_id }) => { db.prepare("UPDATE agent_consult SET used_in_attempt_id=?, status='used' WHERE id=?").run(attempt_id || null, id); return { ok: true, id, status: "used" }; },
  },
  mem_transcript_log: {
    description: "Verbatim episodic log: append one transcript row. source='telegram'|'web'|'cli'|... direction='inbound'|'outbound'. Pass occurred_at to override timestamp; otherwise NOW. Use this for every chat message both directions so 'what was said at time X' is queryable. Auto-indexes into mnemo_search_fts so mem_question_answer covers it.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, channel: { type: "string" }, direction: { type: "string", enum: ["inbound","outbound"] }, speaker: { type: "string" }, content: { type: "string" }, meta: { type: "object" }, occurred_at: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" } }, required: ["source","direction","content"] },
    handler: (a) => {
      const scrubbed = stripPrivate(a.content);
      const content = scrubbed.text;
      const occurredAt = a.occurred_at || null;
      const info = (occurredAt
        ? db.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, content, a.meta ? JSON.stringify(a.meta) : null, occurredAt, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
        : db.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, content, a.meta ? JSON.stringify(a.meta) : null, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
      );
      try { db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)").run(String(info.lastInsertRowid), a.speaker || a.source || '', a.direction + (a.channel ? ' @ ' + a.channel : ''), (content || '').slice(0, 8000)); } catch (e) {}
      try { mirrorTranscriptCapture(a, info.lastInsertRowid, content, scrubbed.hadPrivate); } catch (e) {}
      return { id: info.lastInsertRowid, source: a.source, direction: a.direction, occurred_at: occurredAt, private_redacted: scrubbed.hadPrivate };
    },
  },
  mem_question_answer: {
    description: "Ask a question across all stored knowledge (transcripts + briefs + memories + actions). RAG-style search returns ranked evidence with snippets. Pass date='YYYY-MM-DD' to constrain to one day. Pass scope=['transcript'] to limit to chat history.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, scope: { type: "array", items: { type: "string" } }, date: { type: "string" }, limit: { type: "integer" } }, required: ["question"] },
    handler: (a) => {
      const lim = Math.min(a.limit || 10, 50);
      const scopes = Array.isArray(a.scope) && a.scope.length ? a.scope : ['transcript','brief','memory','action'];
      const raw = String(a.question || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!raw) return { error: "question must contain searchable terms" };
      const tokens = raw.split(/\s+/).filter(t => t.length > 1).map(t => '"' + t + '"').join(" ");
      const placeholders = scopes.map(() => "?").join(",");
      let dateClause = "";
      const dateParams = [];
      if (a.date) {
        dateClause = " AND ref_id IN (SELECT id FROM transcript WHERE date(occurred_at) = ? UNION SELECT id FROM agent_brief WHERE date(created_at) = ? UNION SELECT id FROM agent_action WHERE date(started_at) = ?)";
        dateParams.push(a.date, a.date, a.date);
      }
      try {
        const rows = db.prepare("SELECT scope, ref_id, agent_name, summary, snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS snippet, rank FROM mnemo_search_fts WHERE scope IN (" + placeholders + ") AND mnemo_search_fts MATCH ?" + dateClause + " ORDER BY rank LIMIT ?").all(...scopes, tokens, ...dateParams, lim);
        const evidence = rows.map(r => {
          const ev = { scope: r.scope, ref_id: r.ref_id, agent: r.agent_name, summary: r.summary, snippet: r.snippet, rank: r.rank };
          try {
            if (r.scope === 'transcript') {
              const tr = db.prepare("SELECT occurred_at, speaker, source, direction, content FROM transcript WHERE id=?").get(r.ref_id);
              if (tr) { ev.occurred_at = tr.occurred_at; ev.speaker = tr.speaker; ev.direction = tr.direction; ev.content = tr.content; }
            } else if (r.scope === 'brief') {
              const br = db.prepare("SELECT created_at, agent_name, source_agent FROM agent_brief WHERE id=?").get(r.ref_id);
              if (br) { ev.occurred_at = br.created_at; ev.agent = br.agent_name; ev.source = br.source_agent; }
            }
          } catch (e) {}
          return ev;
        });
        return { question: a.question, count: evidence.length, scopes, date_filter: a.date || null, evidence };
      } catch (e) { return { error: e.message }; }
    },
  },
  mem_recall_at_time: {
    description: "Recall transcripts around a specific timestamp. Pass timestamp (ISO or 'YYYY-MM-DDTHH:MM') and window_minutes (default 5, max 360). Use for queries like 'what did we write at 15:00 on May 4'.",
    inputSchema: { type: "object", properties: { timestamp: { type: "string" }, window_minutes: { type: "integer" }, limit: { type: "integer" } }, required: ["timestamp"] },
    handler: (a) => {
      const windowMin = Math.max(1, Math.min(a.window_minutes || 5, 360));
      const lim = Math.min(a.limit || 50, 500);
      const ts = String(a.timestamp);
      const rows = db.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id, ABS((julianday(occurred_at) - julianday(?)) * 1440) AS minutes_diff FROM transcript WHERE ABS((julianday(occurred_at) - julianday(?)) * 1440) <= ? ORDER BY occurred_at ASC LIMIT ?").all(ts, ts, windowMin, lim);
      return { count: rows.length, timestamp: ts, window_minutes: windowMin, transcripts: rows };
    },
  },
  mem_recall_on_date: {
    description: "Recall all transcripts on a given date (YYYY-MM-DD). Returns chronological order.",
    inputSchema: { type: "object", properties: { date: { type: "string" }, limit: { type: "integer" } }, required: ["date"] },
    handler: (a) => {
      const lim = Math.min(a.limit || 200, 1000);
      const rows = db.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript WHERE date(occurred_at) = ? ORDER BY occurred_at ASC LIMIT ?").all(String(a.date), lim);
      return { count: rows.length, date: a.date, transcripts: rows };
    },
  },
  mem_recall_between: {
    description: "Recall transcripts between two timestamps (inclusive). ISO format expected.",
    inputSchema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" }, limit: { type: "integer" } }, required: ["start","end"] },
    handler: (a) => {
      const lim = Math.min(a.limit || 200, 1000);
      const rows = db.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at ASC LIMIT ?").all(String(a.start), String(a.end), lim);
      return { count: rows.length, start: a.start, end: a.end, transcripts: rows };
    },
  },
  // ===== firm_os Phase 1 tools =====
  mem_entity_upsert: {
    description: "Upsert a structured entity (employee/agent/project/page/function/skill/tool/customer/investor/vendor/server/domain). Returns id. Use this whenever you discover or create something the firm should know about — pages built, functions added, customers signed up.",
    inputSchema: { type: "object", properties: { kind: { type: "string" }, name: { type: "string" }, scope: { type: "string" }, owner_agent: { type: "string" }, status: { type: "string" }, parent_id: { type: "integer" }, url: { type: "string" }, meta: { type: "object" } }, required: ["kind", "name"] },
    handler: ({ kind, name, scope, owner_agent, status, parent_id, url, meta }) => {
      const sc = scopeName(scope);
      const st = status || "active";
      const meta_json = meta ? JSON.stringify(meta) : null;
      const existing = db.prepare("SELECT id FROM entity WHERE kind=? AND name=? AND scope=?").get(kind, name, sc);
      if (existing) {
        db.prepare("UPDATE entity SET owner_agent=COALESCE(?, owner_agent), status=?, parent_id=COALESCE(?, parent_id), url=COALESCE(?, url), meta_json=COALESCE(?, meta_json), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(owner_agent || null, st, parent_id || null, url || null, meta_json, existing.id);
        return { id: existing.id, kind, name, scope: sc, action: "updated" };
      }
      const info = db.prepare("INSERT INTO entity (kind, name, scope, owner_agent, status, parent_id, url, meta_json) VALUES (?,?,?,?,?,?,?,?)").run(kind, name, sc, owner_agent || null, st, parent_id || null, url || null, meta_json);
      return { id: info.lastInsertRowid, kind, name, scope: sc, action: "created" };
    },
  },
  mem_entity_get: {
    description: "Get entity by id, or by (kind+name[+scope]).",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, kind: { type: "string" }, name: { type: "string" }, scope: { type: "string" } } },
    handler: ({ id, kind, name, scope }) => {
      let row;
      if (id) row = db.prepare("SELECT * FROM entity WHERE id=?").get(id);
      else if (kind && name) row = db.prepare("SELECT * FROM entity WHERE kind=? AND name=? AND scope=?").get(kind, name, scopeName(scope));
      else return { error: "id OR (kind+name) required" };
      if (!row) return { error: "not found" };
      if (row.meta_json) try { row.meta = JSON.parse(row.meta_json); } catch {}
      return row;
    },
  },
  mem_entity_list: {
    description: "List entities filtered by kind/owner/status. Pagination via limit/offset.",
    inputSchema: { type: "object", properties: { kind: { type: "string" }, owner_agent: { type: "string" }, status: { type: "string" }, scope: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } } },
    handler: ({ kind, owner_agent, status, scope, limit, offset }) => {
      const where = []; const params = [];
      if (kind) { where.push("kind=?"); params.push(kind); }
      if (owner_agent) { where.push("owner_agent=?"); params.push(owner_agent); }
      if (status) { where.push("status=?"); params.push(status); }
      if (scope) { where.push("scope=?"); params.push(scope); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const lim = Math.min(limit || 100, 500);
      const off = offset || 0;
      const rows = db.prepare(`SELECT id, kind, name, scope, owner_agent, status, url, updated_at FROM entity ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
      return { count: rows.length, entities: rows };
    },
  },
  mem_entity_link: {
    description: "Create a typed link between two entities (rel: 'belongs_to' | 'depends_on' | 'uses_skill' | 'owns' | 'lives_at' | etc).",
    inputSchema: { type: "object", properties: { from_id: { type: "integer" }, to_id: { type: "integer" }, rel: { type: "string" }, meta: { type: "object" } }, required: ["from_id", "to_id", "rel"] },
    handler: ({ from_id, to_id, rel, meta }) => {
      try {
        const info = db.prepare("INSERT OR IGNORE INTO entity_link (from_id, to_id, rel, meta_json) VALUES (?,?,?,?)").run(from_id, to_id, rel, meta ? JSON.stringify(meta) : null);
        return { id: info.lastInsertRowid || null, from_id, to_id, rel, action: info.changes ? "created" : "exists" };
      } catch (e) { return { error: e.message }; }
    },
  },
  mem_file_owner_set: {
    description: "Record file ownership and last-editor. Call this from git post-commit hooks or manual edit logs. file_path is canonical (absolute on the host or repo-relative).",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, host: { type: "string" }, primary_agent: { type: "string" }, last_edit_agent: { type: "string" }, last_commit_sha: { type: "string" }, project_entity_id: { type: "integer" }, add_secondary: { type: "string" } }, required: ["file_path"] },
    handler: ({ file_path, host, primary_agent, last_edit_agent, last_commit_sha, project_entity_id, add_secondary }) => {
      const now = new Date().toISOString();
      const existing = db.prepare("SELECT * FROM file_ownership WHERE file_path=?").get(file_path);
      let secondary = existing && existing.secondary_agents ? JSON.parse(existing.secondary_agents) : [];
      if (add_secondary && !secondary.includes(add_secondary) && add_secondary !== (primary_agent || (existing && existing.primary_agent))) {
        secondary.push(add_secondary);
      }
      if (existing) {
        db.prepare("UPDATE file_ownership SET host=COALESCE(?, host), primary_agent=COALESCE(?, primary_agent), secondary_agents=?, last_edit_agent=COALESCE(?, last_edit_agent), last_edit_at=?, last_commit_sha=COALESCE(?, last_commit_sha), project_entity_id=COALESCE(?, project_entity_id), updated_at=? WHERE file_path=?").run(host || null, primary_agent || null, JSON.stringify(secondary), last_edit_agent || null, now, last_commit_sha || null, project_entity_id || null, now, file_path);
        return { file_path, action: "updated" };
      }
      db.prepare("INSERT INTO file_ownership (file_path, host, primary_agent, secondary_agents, last_edit_agent, last_edit_at, last_commit_sha, project_entity_id) VALUES (?,?,?,?,?,?,?,?)").run(file_path, host || null, primary_agent || null, JSON.stringify(secondary), last_edit_agent || null, now, last_commit_sha || null, project_entity_id || null);
      return { file_path, action: "created" };
    },
  },
  mem_file_owner_get: {
    description: "Get file ownership info by path, or list files owned by an agent.",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, primary_agent: { type: "string" }, limit: { type: "integer" } } },
    handler: ({ file_path, primary_agent, limit }) => {
      if (file_path) {
        const row = db.prepare("SELECT * FROM file_ownership WHERE file_path=?").get(file_path);
        if (!row) return { error: "not found", file_path };
        if (row.secondary_agents) try { row.secondary_agents = JSON.parse(row.secondary_agents); } catch {}
        return row;
      }
      if (primary_agent) {
        const rows = db.prepare("SELECT file_path, host, last_edit_agent, last_edit_at, last_commit_sha FROM file_ownership WHERE primary_agent=? ORDER BY last_edit_at DESC LIMIT ?").all(primary_agent, Math.min(limit || 100, 500));
        return { count: rows.length, files: rows };
      }
      return { error: "file_path OR primary_agent required" };
    },
  },
  mem_wish_capture: {
    description: "Capture an owner wish or any non-explicit-task signal into the wish_buffer instead of auto-building it. Default classification 'wish'. Status starts as 'pending' until reviewed.",
    inputSchema: { type: "object", properties: { captured_text: { type: "string" }, source_channel: { type: "string" }, source_chat_id: { type: "string" }, source_message_id: { type: "string" }, captured_by_agent: { type: "string" }, classification: { type: "string", enum: ["wish", "idea", "feedback", "complaint", "question"] }, meta: { type: "object" } }, required: ["captured_text"] },
    handler: ({ captured_text, source_channel, source_chat_id, source_message_id, captured_by_agent, classification, meta }) => {
      const info = db.prepare("INSERT INTO wish_buffer (source_channel, source_chat_id, source_message_id, captured_text, captured_by_agent, classification, meta_json) VALUES (?,?,?,?,?,?,?)").run(source_channel || null, source_chat_id || null, source_message_id || null, captured_text, captured_by_agent || null, classification || "wish", meta ? JSON.stringify(meta) : null);
      return { id: info.lastInsertRowid, classification: classification || "wish", status: "pending" };
    },
  },
  mem_wish_list: {
    description: "List wishes by status. Default returns pending.",
    inputSchema: { type: "object", properties: { status: { type: "string" }, classification: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
    handler: ({ status, classification, since, limit }) => {
      const where = []; const params = [];
      where.push("status=?"); params.push(status || "pending");
      if (classification) { where.push("classification=?"); params.push(classification); }
      if (since) { where.push("captured_at >= ?"); params.push(since); }
      const lim = Math.min(limit || 100, 500);
      const rows = db.prepare(`SELECT id, captured_text, classification, captured_by_agent, captured_at, status, source_channel FROM wish_buffer WHERE ${where.join(" AND ")} ORDER BY captured_at DESC LIMIT ?`).all(...params, lim);
      return { count: rows.length, wishes: rows };
    },
  },
  mem_wish_review: {
    description: "Review/decide a wish: status in (approved, rejected, roadmap, idea, deferred). Optional decision_id links to a decision_log entry.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, status: { type: "string", enum: ["approved", "rejected", "roadmap", "idea", "deferred"] }, reviewed_by: { type: "string" }, decision_id: { type: "integer" } }, required: ["id", "status"] },
    handler: ({ id, status, reviewed_by, decision_id }) => {
      const info = db.prepare("UPDATE wish_buffer SET status=?, reviewed_by=?, reviewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_id=COALESCE(?, decision_id) WHERE id=?").run(status, reviewed_by || null, decision_id || null, id);
      return { id, status, updated: info.changes };
    },
  },
  mem_decision_log: {
    description: "Record a binding decision with linked files/agents/entities. Use for owner directives, architectural calls, and legal positions. body is markdown.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, decided_by: { type: "string" }, scope: { type: "string" }, agents_involved: { type: "array", items: { type: "string" } }, files_affected: { type: "array", items: { type: "string" } }, entities_affected: { type: "array", items: { type: "integer" } }, parent_decision_id: { type: "integer" }, meta: { type: "object" } }, required: ["title", "decided_by"] },
    handler: ({ title, body, decided_by, scope, agents_involved, files_affected, entities_affected, parent_decision_id, meta }) => {
      const info = db.prepare("INSERT INTO decision_log (scope, title, body, decided_by, agents_involved, files_affected, entities_affected, parent_decision_id, meta_json) VALUES (?,?,?,?,?,?,?,?,?)").run(scopeName(scope), title, body || null, decided_by, agents_involved ? JSON.stringify(agents_involved) : null, files_affected ? JSON.stringify(files_affected) : null, entities_affected ? JSON.stringify(entities_affected) : null, parent_decision_id || null, meta ? JSON.stringify(meta) : null);
      return { id: info.lastInsertRowid, title, decided_by, status: "active" };
    },
  },
  mem_decision_get: {
    description: "Get a decision by id, or list recent decisions filtered by scope/decided_by.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, scope: { type: "string" }, decided_by: { type: "string" }, status: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
    handler: ({ id, scope, decided_by, status, since, limit }) => {
      if (id) {
        const row = db.prepare("SELECT * FROM decision_log WHERE id=?").get(id);
        if (!row) return { error: "not found" };
        for (const k of ["agents_involved", "files_affected", "entities_affected", "meta_json"]) {
          if (row[k]) try { row[k] = JSON.parse(row[k]); } catch {}
        }
        return row;
      }
      const where = []; const params = [];
      if (scope) { where.push("scope=?"); params.push(scope); }
      if (decided_by) { where.push("decided_by=?"); params.push(decided_by); }
      if (status) { where.push("status=?"); params.push(status); }
      if (since) { where.push("decided_at >= ?"); params.push(since); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const lim = Math.min(limit || 50, 500);
      const rows = db.prepare(`SELECT id, scope, title, decided_by, decided_at, status FROM decision_log ${w} ORDER BY decided_at DESC LIMIT ?`).all(...params, lim);
      return { count: rows.length, decisions: rows };
    },
  },
  mem_agent_status_set: {
    description: "Update an agent's live status: current task, blocked-on reason, host/pid, optional DND-until ISO timestamp. Send heartbeat by calling with no other fields.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, current_task: { type: "string" }, current_brief_id: { type: "integer" }, blocked_on: { type: "string" }, dnd_until: { type: "string" }, host: { type: "string" }, pid: { type: "integer" }, meta: { type: "object" } }, required: ["agent_name"] },
    handler: ({ agent_name, current_task, current_brief_id, blocked_on, dnd_until, host, pid, meta }) => {
      const now = new Date().toISOString();
      const normalizedAgent = normalizeAgentName(agent_name);
      const existing = db.prepare("SELECT agent_name FROM agent_status_live WHERE agent_name=?").get(normalizedAgent);
      if (existing) {
        db.prepare("UPDATE agent_status_live SET current_task=COALESCE(?, current_task), current_brief_id=COALESCE(?, current_brief_id), blocked_on=?, dnd_until=COALESCE(?, dnd_until), host=COALESCE(?, host), pid=COALESCE(?, pid), meta_json=COALESCE(?, meta_json), last_heartbeat_at=? WHERE agent_name=?").run(current_task || null, current_brief_id || null, blocked_on || null, dnd_until || null, host || null, pid || null, meta ? JSON.stringify(meta) : null, now, normalizedAgent);
        return { agent_name: normalizedAgent, action: "updated", last_heartbeat_at: now };
      }
      db.prepare("INSERT INTO agent_status_live (agent_name, current_task, current_brief_id, blocked_on, dnd_until, host, pid, meta_json, last_heartbeat_at) VALUES (?,?,?,?,?,?,?,?,?)").run(normalizedAgent, current_task || null, current_brief_id || null, blocked_on || null, dnd_until || null, host || null, pid || null, meta ? JSON.stringify(meta) : null, now);
      return { agent_name: normalizedAgent, action: "created", last_heartbeat_at: now };
    },
  },
  mem_agent_status_get: {
    description: "Get one agent's status, or list all agents with their live state. Useful before routing a brief: skip agents in DND or blocked.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" } } },
    handler: ({ agent_name }) => {
      if (agent_name) {
        const normalizedAgent = normalizeAgentName(agent_name);
        const row = db.prepare("SELECT * FROM agent_status_live WHERE agent_name=?").get(normalizedAgent);
        if (!row) return { error: "not found", agent_name: normalizedAgent };
        const now = Date.now();
        row.dnd_active = row.dnd_until ? Date.parse(row.dnd_until) > now : false;
        return row;
      }
      const rows = db.prepare("SELECT * FROM agent_status_live ORDER BY last_heartbeat_at DESC").all();
      const now = Date.now();
      for (const r of rows) r.dnd_active = r.dnd_until ? Date.parse(r.dnd_until) > now : false;
      return { count: rows.length, agents: rows };
    },
  },
  mem_today_view: {
    description: "Quick 'what happened today' view across actions, briefs, decisions, file edits, wishes. Single call returns what the owner or an agent needs to scan a day.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; defaults to today (UTC)." }, agent_name: { type: "string" } } },
    handler: ({ date, agent_name }) => {
      const d = date || new Date().toISOString().slice(0, 10);
      const start = d + "T00:00:00.000Z";
      const end = d + "T23:59:59.999Z";
      const params = [start, end];
      const agentClause = agent_name ? " AND agent_name=?" : "";
      if (agent_name) params.push(agent_name);
      const actions = db.prepare(`SELECT id, agent_name, action_kind, target, status, started_at FROM agent_action WHERE started_at BETWEEN ? AND ? ${agentClause} ORDER BY started_at DESC LIMIT 200`).all(...params);
      const briefs = db.prepare(`SELECT id, agent_name, source_agent, status, created_at FROM agent_brief WHERE created_at BETWEEN ? AND ? ${agent_name ? "AND (agent_name=? OR source_agent=?)" : ""} ORDER BY created_at DESC LIMIT 100`).all(start, end, ...(agent_name ? [agent_name, agent_name] : []));
      const decisions = db.prepare("SELECT id, title, decided_by, decided_at, scope, status FROM decision_log WHERE decided_at BETWEEN ? AND ? ORDER BY decided_at DESC LIMIT 50").all(start, end);
      const file_edits = db.prepare(`SELECT file_path, last_edit_agent, last_edit_at, last_commit_sha FROM file_ownership WHERE last_edit_at BETWEEN ? AND ? ${agent_name ? "AND last_edit_agent=?" : ""} ORDER BY last_edit_at DESC LIMIT 200`).all(start, end, ...(agent_name ? [agent_name] : []));
      const wishes = db.prepare("SELECT id, captured_text, classification, captured_by_agent, status FROM wish_buffer WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at DESC LIMIT 50").all(start, end);
      return { date: d, agent_name: agent_name || null, actions: { count: actions.length, items: actions }, briefs: { count: briefs.length, items: briefs }, decisions: { count: decisions.length, items: decisions }, file_edits: { count: file_edits.length, items: file_edits }, wishes: { count: wishes.length, items: wishes } };
    },
  },
  mem_company_fact_get: {
    description: "Get authoritative company facts (team, products, brand, legal, etc). Pass scope (default from MNEMO_DEFAULT_SCOPE, otherwise 'default') and optional topic (e.g. 'team', 'legal', 'products', 'pricing', 'investors', 'infra', 'comms') and optional key for a sub-field. ALWAYS query this BEFORE any external comm/code that mentions team members, prices, legal entity, or product specs. Source-of-truth lives in MNEMO_FACTS_DIR/<scope>.json.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, topic: { type: "string" }, key: { type: "string" } } },
    handler: ({ scope, topic, key }) => {
      const sc = scopeName(scope);
      const factsPath = factsPathFor(sc);
      if (!fs.existsSync(factsPath)) return { error: "no facts file for scope: " + sc, hint: "create a private facts file at " + factsPath + " or set MNEMO_FACTS_DIR" };
      let data;
      try { data = JSON.parse(fs.readFileSync(factsPath, "utf8")); }
      catch (e) { return { error: "facts json parse error: " + e.message }; }
      if (!topic) return { scope: sc, _meta: data._meta, topics: Object.keys(data).filter(k => k !== "_meta") };
      const node = data[topic];
      if (node === undefined) return { error: "unknown topic: " + topic, available: Object.keys(data).filter(k => k !== "_meta") };
      if (!key) return { scope: sc, topic, value: node };
      if (Array.isArray(node)) {
        const matches = node.filter(it => it && (it.name === key || it.sub_brand === key || it.alias === key));
        return { scope: sc, topic, key, matches };
      }
      if (typeof node === "object") return { scope: sc, topic, key, value: node[key] };
      return { scope: sc, topic, key, value: node };
    },
  },
  mem_company_fact_set: {
    description: "Update a company fact. Writes through to packages/core/facts/<scope>.json with auto-backup. Use sparingly — only for canonical changes (new team member, price change, legal entity update). Logs the change to memory layer 'semantic'.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, topic: { type: "string" }, value: {}, actor: { type: "string" } }, required: ["topic","value"] },
    handler: ({ scope, topic, value, actor }) => {
      const sc = scopeName(scope);
      const factsDir = FACTS_DIR;
      try { fs.mkdirSync(factsDir, { recursive: true }); } catch {}
      const factsPath = factsPathFor(sc);
      let data = {};
      if (fs.existsSync(factsPath)) {
        try { data = JSON.parse(fs.readFileSync(factsPath, "utf8")); }
        catch (e) { return { error: "existing facts parse error: " + e.message }; }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        try { fs.copyFileSync(factsPath, factsPath + ".bak-" + ts); } catch {}
      }
      data._meta = data._meta || { scope: sc };
      data._meta.updated = new Date().toISOString().slice(0, 10);
      data._meta.last_actor = actor || "unknown";
      data[topic] = value;
      const tmp = factsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, factsPath);
      try {
        db.prepare("INSERT INTO memory (kind, source, actor, topic, importance, layer, text) VALUES ('company_fact_set', 'mnemo:fact-set', ?, ?, 0.9, 'semantic', ?)").run(actor || "system", topic, "scope=" + sc + " topic=" + topic + " value=" + JSON.stringify(value).slice(0, 500));
      } catch {}
      return { ok: true, scope: sc, topic, updated: data._meta.updated };
    },
  },
  mem_pre_action_check: {
    description: "Pre-action gate. Call BEFORE writing external comms (pitch/email/website/PR/code-with-team-mentions). Pass action_type and the topics the action touches (e.g. ['team','pricing','legal']). Returns required_facts + status='ok' if all canonical facts are loadable, status='block' if any fact is missing. DO NOT proceed if blocked. Logs the check for audit.",
    inputSchema: { type: "object", properties: { action_type: { type: "string" }, scope: { type: "string" }, topics: { type: "array", items: { type: "string" } }, agent_name: { type: "string" }, summary: { type: "string" } }, required: ["action_type","topics"] },
    handler: ({ action_type, scope, topics, agent_name, summary }) => {
      const sc = scopeName(scope);
      const factsPath = factsPathFor(sc);
      const checked = [];
      const missing = [];
      let data = null;
      if (fs.existsSync(factsPath)) {
        try { data = JSON.parse(fs.readFileSync(factsPath, "utf8")); } catch {}
      }
      if (!data) return { status: "block", reason: "no facts file for scope " + sc, action_type, topics };
      for (const t of topics) {
        if (data[t] !== undefined) checked.push({ topic: t, ok: true, preview: Array.isArray(data[t]) ? `${data[t].length} entries` : (typeof data[t] === "object" ? Object.keys(data[t]).join(", ") : String(data[t]).slice(0, 80)) });
        else missing.push(t);
      }
      const status = missing.length === 0 ? "ok" : "block";
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'pre_action_check', ?, ?, ?, 'pre_action_check')").run(agent_name || "unknown", action_type, status, JSON.stringify({ topics, missing, summary, scope: sc }));
      } catch {}
      return { status, action_type, scope: sc, agent_name: agent_name || null, checked, missing, facts: status === "ok" ? topics.reduce((acc, t) => (acc[t] = data[t], acc), {}) : null, hint: status === "block" ? "Add missing topics to facts/" + sc + ".json via mem_company_fact_set before proceeding." : "All required facts present — proceed with canonical values, not memory of memory." };
    },
  },
  mem_project_registry_upsert: {
    description: "Write the operational registry for a project: domain, repo, server, process names, reverse-proxy files, admin URL, auth system, billing IDs, VAT status, supported languages, live status, etc. Agents and humans query this when they need to find where pricing lives, which server runs the API, or which billing account a project uses. Pass any subset of fields; only those provided are updated. Project name (matches mem_project_list) is the key.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" }, repo: { type: "string" }, server: { type: "string" }, pm2_processes: { type: "array", items: { type: "string" } }, nginx_files: { type: "array", items: { type: "string" } }, admin_url: { type: "string" }, auth_system: { type: "string" }, stripe_account: { type: "string" }, stripe_product_ids: { type: "array", items: { type: "string" } }, vat_status: { type: "string", enum: ["none","pending","registered","exempt"] }, vat_id: { type: "string" }, langs: { type: "array", items: { type: "string" } }, live_status: { type: "string", enum: ["live","staging","dev","down","unknown"] }, live_url: { type: "string" }, staging_url: { type: "string" }, last_deploy_at: { type: "string" }, missing_blocks: { type: "array", items: { type: "string" } }, health_checklist: { type: "object" }, notes: { type: "string" }, updated_by: { type: "string" } }, required: ["name"] },
    handler: (a) => {
      ensureProjectRegistryTable(db);
      const fields = ["name"]; const placeholders = ["?"]; const values = [a.name]; const updates = [];
      const stringKeys = ["domain","repo","server","admin_url","auth_system","stripe_account","vat_status","vat_id","live_status","live_url","staging_url","last_deploy_at","notes","updated_by"];
      const jsonKeys = ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"];
      for (const k of stringKeys) if (a[k] !== undefined) { fields.push(k); placeholders.push("?"); values.push(a[k]); updates.push(k + "=excluded." + k); }
      for (const k of jsonKeys) if (a[k] !== undefined) { fields.push(k); placeholders.push("?"); values.push(JSON.stringify(a[k])); updates.push(k + "=excluded." + k); }
      updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      const sql = "INSERT INTO project_registry (" + fields.join(",") + ") VALUES (" + placeholders.join(",") + ") ON CONFLICT(name) DO UPDATE SET " + updates.join(", ");
      db.prepare(sql).run(...values);
      return { ok: true, name: a.name };
    },
  },
  mem_project_registry_get: {
    description: "Read the operational registry for one project. Returns the full record with JSON fields parsed into arrays/objects.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    handler: ({ name }) => {
      ensureProjectRegistryTable(db);
      const row = db.prepare("SELECT * FROM project_registry WHERE name=?").get(name);
      if (!row) return { error: "not found", name };
      for (const k of ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"]) {
        if (row[k]) try { row[k] = JSON.parse(row[k]); } catch {}
      }
      return row;
    },
  },
  mem_project_registry_list: {
    description: "List the operational registry for all projects (or filter by live_status). Use to answer 'which projects are live' / 'which still need VAT' across the board.",
    inputSchema: { type: "object", properties: { live_status: { type: "string" }, limit: { type: "integer" } } },
    handler: ({ live_status, limit }) => {
      ensureProjectRegistryTable(db);
      const where = []; const params = [];
      if (live_status) { where.push("live_status=?"); params.push(live_status); }
      params.push(Math.min(limit || 50, 200));
      const rows = db.prepare("SELECT name, domain, server, live_status, live_url, vat_status, updated_at FROM project_registry" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY updated_at DESC LIMIT ?").all(...params);
      if (rows.length) return { count: rows.length, projects: rows };
      const candidates = [];
      try {
        for (const r of db.prepare("SELECT project AS name, updated_at FROM project_rules ORDER BY updated_at DESC LIMIT ?").all(Math.min(limit || 50, 200))) {
          if (r && r.name) candidates.push({ name: r.name, source: "project_rules", updated_at: r.updated_at || null });
        }
      } catch {}
      try {
        for (const r of db.prepare("SELECT name, owner_agent, status, last_active_at FROM agent_project ORDER BY last_active_at DESC LIMIT ?").all(Math.min(limit || 50, 200))) {
          if (r && r.name && !candidates.some((c) => c.name === r.name)) candidates.push({ name: r.name, source: "agent_project", owner_agent: r.owner_agent || null, status: r.status || null, updated_at: r.last_active_at || null });
        }
      } catch {}
      try {
        const seed = loadProjectRuleDefaults("blun");
        for (const p of seed.projects || []) {
          if (p && p.name && !candidates.some((c) => c.name === p.name)) candidates.push({ name: p.name, source: "facts/blun-project-rules.json" });
        }
      } catch {}
      return {
        count: 0,
        projects: [],
        candidates_count: candidates.length,
        candidates,
        hint: candidates.length
          ? "No structured project_registry rows matched, but project candidates exist in rules/facts. Upsert them with mem_project_registry_upsert so live URLs, repos, servers and gates are queryable."
          : "No structured project_registry rows matched."
      };
    },
  },
  mem_file_echo: {
    description: "Read-Echo: surface what mnemo already knows about a file BEFORE you Read it. Returns ownership history, active work_claims, related briefs (content matching path or basename), related decisions, matching skills. Use this in a PreToolUse hook on Read so the agent gets cached context (who edited last, why, what claim is on it) without paying the file-read tokens up-front.",
    inputSchema: { type: "object", properties: { file_path: { type: "string" }, limit: { type: "integer" } }, required: ["file_path"] },
    handler: ({ file_path, limit }) => {
      const lim = Math.min(limit || 5, 20);
      const basename = file_path.split(/[\\/]/).pop() || file_path;
      const ownership = (() => { try { return db.prepare("SELECT file_path, last_edit_agent, last_edit_at, last_commit_sha FROM file_ownership WHERE file_path=? OR file_path LIKE ? ORDER BY last_edit_at DESC LIMIT ?").all(file_path, '%' + basename, lim); } catch { return []; } })();
      const claims = (() => { try { return db.prepare("SELECT id, agent_name, summary, expires_at FROM work_claim WHERE (file_path=? OR file_path LIKE ?) AND status='active' ORDER BY claimed_at DESC LIMIT ?").all(file_path, '%' + basename, lim); } catch { return []; } })();
      const briefs = (() => { try { return db.prepare("SELECT id, agent_name, source_agent, substr(content,1,180) AS snippet, created_at FROM agent_brief WHERE content LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT ?").all('%' + file_path + '%', '%' + basename + '%', lim); } catch { return []; } })();
      const decisions = (() => { try { return db.prepare("SELECT title, decided_by, decided_at, summary FROM decision_log WHERE summary LIKE ? OR title LIKE ? ORDER BY decided_at DESC LIMIT ?").all('%' + basename + '%', '%' + basename + '%', lim); } catch { return []; } })();
      const skills = (() => { try { return db.prepare("SELECT name, description FROM skill_registry WHERE source_path LIKE ? OR description LIKE ? LIMIT ?").all('%' + basename + '%', '%' + basename + '%', lim); } catch { return []; } })();
      return { file_path, basename, ownership: { count: ownership.length, items: ownership }, active_claims: { count: claims.length, items: claims }, related_briefs: { count: briefs.length, items: briefs }, related_decisions: { count: decisions.length, items: decisions }, matching_skills: { count: skills.length, items: skills } };
    },
  },
  mem_focus_set: {
    description: "Set the agent's current focus (e.g. code | ops | pitch | support | chill | default). The focus narrows what auto-inject pulls into the next session. Slice rules live in the private facts file's focus_modes section and can be edited via mem_company_fact_set without code change.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, focus: { type: "string" }, reason: { type: "string" } }, required: ["agent_name","focus"] },
    handler: ({ agent_name, focus, reason }) => {
      try { db.exec("CREATE TABLE IF NOT EXISTS agent_focus (agent_name TEXT PRIMARY KEY, focus TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), reason TEXT)"); } catch {}
      db.prepare("INSERT INTO agent_focus (agent_name, focus, reason) VALUES (?,?,?) ON CONFLICT(agent_name) DO UPDATE SET focus=excluded.focus, reason=excluded.reason, set_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").run(agent_name, focus, reason || null);
      return { ok: true, agent_name, focus };
    },
  },
  mem_focus_get: {
    description: "Read the agent's current focus + the matching slice config from the private facts file's focus_modes section. Use at SessionStart so auto-inject knows which subset of context to pre-load.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] },
    handler: ({ agent_name }) => {
      try { db.exec("CREATE TABLE IF NOT EXISTS agent_focus (agent_name TEXT PRIMARY KEY, focus TEXT NOT NULL, set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), reason TEXT)"); } catch {}
      const row = db.prepare("SELECT focus, set_at, reason FROM agent_focus WHERE agent_name=?").get(agent_name);
      const focus = row ? row.focus : "default";
      let slice = null;
      try {
        const factsPath = factsPathFor();
        if (fs.existsSync(factsPath)) {
          const f = JSON.parse(fs.readFileSync(factsPath, "utf8"));
          slice = (f.focus_modes && (f.focus_modes[focus] || f.focus_modes.default)) || null;
        }
      } catch {}
      return { agent_name, focus, set_at: row ? row.set_at : null, reason: row ? row.reason : null, slice };
    },
  },
  mem_lens_view: {
    description: "Project-Lens: return a structured JSON bundle scoped to ONE project — registry row, agent_project state, owner agent_status, recent decisions (scope=project), active work_claims (project=), recent briefs mentioning the project, recent file_edits in that project tree. Use when a UI surface or agent wants 'all the live state for X' in one call instead of N. Different from mem_project_doc_render: this returns parsed JSON for programmatic use; the renderer returns Markdown for display.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, limit: { type: "integer" } }, required: ["project"] },
    handler: ({ project, limit }) => {
      const lim = Math.min(limit || 10, 50);
      ensureProjectRegistryTable(db);
      const registry = db.prepare("SELECT * FROM project_registry WHERE name=?").get(project);
      if (registry) {
        for (const k of ["pm2_processes","nginx_files","stripe_product_ids","langs","missing_blocks","health_checklist"]) {
          if (registry[k]) try { registry[k] = JSON.parse(registry[k]); } catch {}
        }
      }
      const apr = (() => { try { return db.prepare("SELECT name, owner_agent, goal_text, status, current_milestone, blocker FROM agent_project WHERE name=?").get(project); } catch { return null; } })();
      const decisions = (() => { try { return db.prepare("SELECT id, title, decided_by, decided_at, summary FROM decision_log WHERE scope=? ORDER BY decided_at DESC LIMIT ?").all(project, lim); } catch { return []; } })();
      const claims = (() => { try { return db.prepare("SELECT id, file_path, agent_name, summary, claimed_at, expires_at FROM work_claim WHERE project=? AND status='active' ORDER BY claimed_at DESC").all(project); } catch { return []; } })();
      const briefs = (() => { try { return db.prepare("SELECT id, agent_name, source_agent, substr(content,1,200) AS snippet, created_at, status FROM agent_brief WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?").all('%' + project + '%', lim); } catch { return []; } })();
      const file_edits = (() => { try { return db.prepare("SELECT file_path, last_edit_agent, last_edit_at FROM file_ownership WHERE last_edit_at >= datetime('now','-7 day') AND (file_path LIKE ? OR project=?) ORDER BY last_edit_at DESC LIMIT ?").all('%' + project.toLowerCase().replace(/\s+/g, '-') + '%', project, lim); } catch { return []; } })();
      const status = (() => { try { return apr ? db.prepare("SELECT agent_name, current_task, last_heartbeat_at FROM agent_status_live WHERE agent_name=?").get(apr.owner_agent || '') : null; } catch { return null; } })();
      return { project, registry, current: apr, owner_status: status, decisions: { count: decisions.length, items: decisions }, active_claims: { count: claims.length, items: claims }, recent_briefs: { count: briefs.length, items: briefs }, recent_file_edits: { count: file_edits.length, items: file_edits } };
    },
  },
  mem_project_doc_render: {
    description: "Auto-render a Markdown Project-Doc for one project. Pulls operations from project_registry, current state from agent_project, active work-claims, recent decisions + briefs mentioning the project, and optionally the legal section from the private facts file. Returns { doc: string }. Use to keep a per-project AGENTS-style file in sync without hand-editing.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, include_legal: { type: "boolean" } }, required: ["name"] },
    handler: ({ name, include_legal }) => {
      ensureProjectRegistryTable(db);
      const reg = db.prepare("SELECT * FROM project_registry WHERE name=?").get(name);
      const apr = (() => { try { return db.prepare("SELECT name, owner_agent, goal_text, status, current_milestone, blocker, last_active_at FROM agent_project WHERE name=?").get(name); } catch { return null; } })();
      let factsLegal = null;
      try {
        const factsPath = factsPathFor();
        if (fs.existsSync(factsPath)) {
          const f = JSON.parse(fs.readFileSync(factsPath, "utf8"));
          factsLegal = f.legal;
        }
      } catch {}
      const recentDecisions = (() => { try { return db.prepare("SELECT title, decided_by, decided_at, summary FROM decision_log WHERE scope=? ORDER BY decided_at DESC LIMIT 10").all(name); } catch { return []; } })();
      const recentBriefs = (() => { try { return db.prepare("SELECT id, agent_name, source_agent, substr(content,1,140) AS content, created_at FROM agent_brief WHERE content LIKE ? ORDER BY created_at DESC LIMIT 8").all('%' + name + '%'); } catch { return []; } })();
      const claims = (() => { try { return db.prepare("SELECT file_path, agent_name, summary, expires_at FROM work_claim WHERE project=? AND status='active' ORDER BY claimed_at DESC").all(name); } catch { return []; } })();
      const lines = [];
      lines.push(`# ${name} — Project-Doc`);
      lines.push("");
      lines.push("> Auto-rendered by mem_project_doc_render. Source-of-truth lives in mnemo (project_registry + private facts + recent decisions). Edit facts, not this file.");
      lines.push("");
      if (reg) {
        lines.push("## Operations");
        if (reg.domain) lines.push(`- **Domain:** ${reg.domain}`);
        if (reg.live_url) lines.push(`- **Live:** ${reg.live_url} (status: ${reg.live_status || 'unknown'})`);
        if (reg.staging_url) lines.push(`- **Staging:** ${reg.staging_url}`);
        if (reg.repo) lines.push(`- **Repo:** ${reg.repo}`);
        if (reg.server) lines.push(`- **Server:** ${reg.server}`);
        if (reg.pm2_processes) try { const arr = JSON.parse(reg.pm2_processes); if (arr.length) lines.push(`- **PM2:** ${arr.join(", ")}`); } catch {}
        if (reg.nginx_files) try { const arr = JSON.parse(reg.nginx_files); if (arr.length) lines.push(`- **Nginx:** ${arr.join(", ")}`); } catch {}
        if (reg.admin_url) lines.push(`- **Admin:** ${reg.admin_url}`);
        if (reg.auth_system) lines.push(`- **Auth:** ${reg.auth_system}`);
        if (reg.stripe_account) lines.push(`- **Stripe:** ${reg.stripe_account}`);
        if (reg.vat_status) lines.push(`- **VAT:** ${reg.vat_status}${reg.vat_id ? " (" + reg.vat_id + ")" : ""}`);
        if (reg.langs) try { const arr = JSON.parse(reg.langs); if (arr.length) lines.push(`- **Langs:** ${arr.join(", ")}`); } catch {}
        if (reg.last_deploy_at) lines.push(`- **Last deploy:** ${reg.last_deploy_at}`);
      } else {
        lines.push("## Operations");
        lines.push("_No project_registry row yet. Create via mem_project_registry_upsert._");
      }
      lines.push("");
      if (apr) {
        lines.push("## Current state");
        if (apr.owner_agent) lines.push(`- **Owner:** ${apr.owner_agent}`);
        if (apr.goal_text) lines.push(`- **Goal:** ${apr.goal_text}`);
        if (apr.current_milestone) lines.push(`- **Milestone:** ${apr.current_milestone}`);
        if (apr.blocker) lines.push(`- **Blocker:** ${apr.blocker}`);
        if (apr.status) lines.push(`- **Status:** ${apr.status}`);
        lines.push("");
      }
      if (reg && reg.health_checklist) {
        try {
          const c = JSON.parse(reg.health_checklist);
          const keys = Object.keys(c);
          if (keys.length) {
            lines.push("## Health gates");
            for (const k of keys) lines.push(`- **${k}:** ${c[k]}`);
            lines.push("");
          }
        } catch {}
      }
      if (claims.length) {
        lines.push("## Active work-claims");
        for (const c of claims) lines.push(`- \`${c.file_path}\` — ${c.agent_name}${c.summary ? ` (${c.summary})` : ""} until ${c.expires_at}`);
        lines.push("");
      }
      if (recentDecisions.length) {
        lines.push("## Recent decisions");
        for (const d of recentDecisions) lines.push(`- ${d.decided_at?.slice(0,10) || ""} **${d.title}** by ${d.decided_by || "?"}${d.summary ? " — " + String(d.summary).slice(0,160) : ""}`);
        lines.push("");
      }
      if (recentBriefs.length) {
        lines.push("## Recent briefs mentioning this project");
        for (const b of recentBriefs) lines.push(`- #${b.id} ${b.created_at?.slice(0,10) || ""} ${b.source_agent || "?"} → ${b.agent_name}: ${(b.content || '').replace(/\s+/g,' ').slice(0,140)}`);
        lines.push("");
      }
      if (factsLegal && (include_legal !== false)) {
        lines.push("## Legal (from private facts)");
        lines.push(`- Entity: ${factsLegal.entity_type || ""} — ${factsLegal.founder || ""}`);
        if (factsLegal.address) lines.push(`- Address: ${factsLegal.address}`);
        if (factsLegal.do_not_use) lines.push(`- Forbidden: ${(factsLegal.do_not_use || []).join(", ")}`);
        lines.push("");
      }
      lines.push("---");
      lines.push(`Rendered ${new Date().toISOString()} from mnemo project_registry + facts.`);
      const doc = lines.join("\n");
      return { project: name, doc, bytes: doc.length };
    },
  },
  mem_project_live_check: {
    description: "Pre-deploy gate. Reads the project_registry health_checklist + computes pass/block. The checklist holds named gates (auth, billing, vat, legal, seo, mobile, header_footer, pricing, checkout, webhooks, analytics, error_monitoring) each as 'pass' | 'block' | 'unknown'. Returns status='block' if ANY required gate is not 'pass'. Logs the check. Use BEFORE setting live_status='live'.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, required_gates: { type: "array", items: { type: "string" } }, agent_name: { type: "string" } }, required: ["name"] },
    handler: ({ name, required_gates, agent_name }) => {
      ensureProjectRegistryTable(db);
      const row = db.prepare("SELECT name, live_status, vat_status, health_checklist FROM project_registry WHERE name=?").get(name);
      if (!row) return { status: "block", reason: "project_registry has no row for " + name, hint: "Create it via mem_project_registry_upsert first." };
      let checklist = {};
      try { checklist = row.health_checklist ? JSON.parse(row.health_checklist) : {}; } catch {}
      const defaults = ["auth","billing","vat","legal","mobile","header_footer","pricing","checkout"];
      const required = Array.isArray(required_gates) && required_gates.length ? required_gates : defaults;
      const passed = []; const blocked = []; const unknown = [];
      for (const g of required) {
        const v = checklist[g];
        if (v === "pass") passed.push(g);
        else if (v === "block") blocked.push(g);
        else unknown.push(g);
      }
      const status = (blocked.length === 0 && unknown.length === 0) ? "ok" : "block";
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_live_check', ?, ?, ?, 'project_live_check')").run(agent_name || "unknown", name, status, JSON.stringify({ required, passed, blocked, unknown }));
      } catch {}
      return { status, project: name, required, passed, blocked, unknown, hint: status === "block" ? "Resolve blocked + unknown gates via mem_project_registry_upsert health_checklist={...} before flipping live_status to 'live'." : "All required gates pass — safe to deploy." };
    },
  },
  mem_department_seed_defaults: {
    description: "Seed the default company departments: strategy-review, frontend, backend, billing, QA, deploy-ops, and content-legal. Departments define ownership, reviewers, skills, and live gates so every agent knows its lane.",
    inputSchema: {
      type: "object",
      properties: {
        agent_map: { type: "object", description: "Optional role map: {review, frontend, backend, billing, qa, ops, content, legal}" },
        updated_by: { type: "string" },
        dry_run: { type: "boolean" },
      },
    },
    handler: (a) => {
      ensureAutonomyTables(db);
      const departments = defaultDepartments(a.agent_map || {});
      if (a.dry_run) return { ok: true, dry_run: true, departments };
      const depStmt = db.prepare("INSERT INTO department (name, mission, lead_agent, review_agent, skills_json, responsibilities_json, required_gates_json, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET mission=excluded.mission, lead_agent=excluded.lead_agent, review_agent=excluded.review_agent, skills_json=excluded.skills_json, responsibilities_json=excluded.responsibilities_json, required_gates_json=excluded.required_gates_json, status='active', updated_by=excluded.updated_by, updated_at=excluded.updated_at");
      const memStmt = db.prepare("INSERT INTO department_member (department_name, agent_name, role, skills_json, updated_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(department_name, agent_name) DO UPDATE SET role=excluded.role, skills_json=excluded.skills_json, status='active', updated_at=excluded.updated_at");
      for (const d of departments) {
        depStmt.run(d.name, d.mission, d.lead_agent || null, d.review_agent || null, JSON.stringify(d.skills || []), JSON.stringify(d.responsibilities || []), JSON.stringify(d.required_gates || []), a.updated_by || DEFAULT_AGENT);
        if (d.lead_agent) memStmt.run(d.name, d.lead_agent, "lead", JSON.stringify(d.skills || []));
        if (d.review_agent && d.review_agent !== d.lead_agent) memStmt.run(d.name, d.review_agent, "reviewer", JSON.stringify(["review"]));
      }
      try { db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'department_seed_defaults', 'departments', 'done', ?, 'autonomy')").run(a.updated_by || DEFAULT_AGENT, JSON.stringify({ count: departments.length })); } catch {}
      return { ok: true, count: departments.length, departments: departments.map(d => ({ name: d.name, lead_agent: d.lead_agent, review_agent: d.review_agent })) };
    },
  },
  mem_department_list: {
    description: "List departments and optionally members. Use to understand ownership before routing work.",
    inputSchema: { type: "object", properties: { include_members: { type: "boolean" } } },
    handler: ({ include_members } = {}) => {
      ensureAutonomyTables(db);
      const rows = db.prepare("SELECT * FROM department WHERE status='active' ORDER BY name").all();
      for (const r of rows) {
        r.skills = parseMaybeJson(r.skills_json, []);
        r.responsibilities = parseMaybeJson(r.responsibilities_json, []);
        r.required_gates = parseMaybeJson(r.required_gates_json, []);
        delete r.skills_json; delete r.responsibilities_json; delete r.required_gates_json;
        if (include_members) r.members = db.prepare("SELECT agent_name, role, skills_json, status FROM department_member WHERE department_name=? AND status='active' ORDER BY role, agent_name").all(r.name).map(m => Object.assign({}, m, { skills: parseMaybeJson(m.skills_json, []) }));
      }
      return { count: rows.length, departments: rows };
    },
  },
  mem_team_operating_model: {
    description: "Return the fixed collaboration roster, active/paused agents, department ownership, and the requesting agent's current lane coverage.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" } } },
    handler: ({ agent_name } = {}) => buildTeamOperatingModel(db, agent_name || null),
  },
  mem_connector_upsert: {
    description: "Create or update the durable connector register for an external system, server, provider, API, admin, or runtime dependency. Supports lifecycle, approval class, runbook, rollback, and allowed agents.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        project: { type: "string" },
        system_name: { type: "string" },
        owner_agent: { type: "string" },
        auth_type: { type: "string" },
        secret_ref: { type: "string" },
        rate_limit: { type: "string" },
        allowed_agents: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        read_enabled: { type: "boolean" },
        write_enabled: { type: "boolean" },
        live_write_enabled: { type: "boolean" },
        lifecycle_status: { type: "string" },
        approval_class: { type: "string" },
        endpoint: { type: "string" },
        health_status: { type: "string" },
        health_summary: { type: "string" },
        last_health_at: { type: "string" },
        last_verified_at: { type: "string" },
        runbook: { type: "object" },
        dependencies: { type: "array", items: { type: "string" } },
        rollback: { type: "object" },
        notes: { type: "string" },
        meta: { type: "object" },
        updated_by: { type: "string" },
        mirror_access: { type: "boolean" },
        access_kind: { type: "string" },
        entrypoint: { type: "string" },
        account_hint: { type: "string" },
      },
      required: ["system_name"],
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const scope = scopeName(a.scope);
      const allowedAgents = normalizeStringList(a.allowed_agents);
      db.prepare(
        "INSERT INTO connector_registry (scope, project, system_name, owner_agent, auth_type, secret_ref, rate_limit, allowed_agents_json, read_enabled, write_enabled, live_write_enabled, lifecycle_status, approval_class, endpoint, health_status, health_summary, last_health_at, last_verified_at, runbook_json, dependency_json, rollback_json, notes, meta_json, updated_by, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
        "ON CONFLICT(scope, system_name) DO UPDATE SET project=excluded.project, owner_agent=excluded.owner_agent, auth_type=excluded.auth_type, secret_ref=excluded.secret_ref, rate_limit=excluded.rate_limit, allowed_agents_json=excluded.allowed_agents_json, read_enabled=excluded.read_enabled, write_enabled=excluded.write_enabled, live_write_enabled=excluded.live_write_enabled, lifecycle_status=excluded.lifecycle_status, approval_class=excluded.approval_class, endpoint=excluded.endpoint, health_status=excluded.health_status, health_summary=excluded.health_summary, last_health_at=COALESCE(excluded.last_health_at, connector_registry.last_health_at), last_verified_at=COALESCE(excluded.last_verified_at, connector_registry.last_verified_at), runbook_json=excluded.runbook_json, dependency_json=excluded.dependency_json, rollback_json=excluded.rollback_json, notes=excluded.notes, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
      ).run(
        scope,
        a.project || null,
        a.system_name,
        a.owner_agent || null,
        a.auth_type || null,
        a.secret_ref || null,
        a.rate_limit || null,
        JSON.stringify(allowedAgents),
        boolFlag(a.read_enabled, true) ? 1 : 0,
        boolFlag(a.write_enabled, false) ? 1 : 0,
        boolFlag(a.live_write_enabled, false) ? 1 : 0,
        a.lifecycle_status || "planned",
        a.approval_class || "normal_fix",
        a.endpoint || null,
        a.health_status || "unknown",
        a.health_summary || null,
        a.last_health_at || null,
        a.last_verified_at || null,
        JSON.stringify(a.runbook || {}),
        JSON.stringify(a.dependencies || []),
        JSON.stringify(a.rollback || {}),
        a.notes || null,
        JSON.stringify(a.meta || {}),
        a.updated_by || DEFAULT_AGENT
      );
      if (a.mirror_access || a.access_kind || a.entrypoint) {
        const entrypoint = a.entrypoint || a.endpoint || "";
        const existing = db.prepare("SELECT id FROM access_inventory WHERE scope=? AND system_name=? AND access_kind=? AND COALESCE(entrypoint,'')=?").get(scope, a.system_name, a.access_kind || "connector", entrypoint);
        if (existing) {
          db.prepare("UPDATE access_inventory SET project=?, entrypoint=?, account_hint=?, secret_ref=?, allowed_agents=?, status=?, last_verified_at=COALESCE(?, last_verified_at), verification_method='connector_registry', notes=COALESCE(?, notes), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .run(a.project || null, entrypoint || null, a.account_hint || null, a.secret_ref || null, allowedAgents.join(","), a.lifecycle_status === "deprecated" ? "deprecated" : "active", a.last_verified_at || null, a.notes || null, a.updated_by || DEFAULT_AGENT, existing.id);
        } else {
          db.prepare("INSERT INTO access_inventory (scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(scope, a.project || null, a.system_name, a.access_kind || "connector", entrypoint || null, a.account_hint || null, a.secret_ref || null, allowedAgents.join(","), a.lifecycle_status === "deprecated" ? "deprecated" : "active", a.last_verified_at || null, "connector_registry", a.notes || null, a.updated_by || DEFAULT_AGENT);
        }
      }
      return { ok: true, connector: connectorListData(db, { scope, system_name: a.system_name, include_derived: false })[0] || null };
    },
  },
  mem_connector_list: {
    description: "List the connector register for systems/providers and optionally derive connector rows from access_inventory. Use this before touching providers, servers, OAuth, Stripe, VAT, mail, PM2, DNS, or other shared systems.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        project: { type: "string" },
        system_name: { type: "string" },
        owner_agent: { type: "string" },
        allowed_agent: { type: "string" },
        lifecycle_status: { type: "string" },
        include_derived: { type: "boolean" },
        include_access_routes: { type: "boolean" },
        stale_days: { type: "integer" },
      },
    },
    handler: (a = {}) => {
      const connectors = connectorListData(db, a || {});
      return {
        ok: true,
        count: connectors.length,
        summary: {
          explicit: connectors.filter((connector) => connector.source_kind === "explicit").length,
          derived: connectors.filter((connector) => connector.source_kind !== "explicit").length,
          stale: connectors.filter((connector) => ["stale", "critical"].includes(connector.freshness_status)).length,
        },
        connectors,
      };
    },
  },
  mem_agent_pass_set: {
    description: "Create or update an agent passport: lane, project/system reach, capability matrix, live-write rights, deploy/auth/billing permissions, and approval class.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        display_name: { type: "string" },
        department_name: { type: "string" },
        lane: { type: "string" },
        allowed_projects: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        allowed_systems: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        allowed_environments: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        capability_matrix: { type: "object" },
        live_write: { type: "boolean" },
        review_required: { type: "boolean" },
        needs_handoff: { type: "boolean" },
        can_deploy: { type: "boolean" },
        can_touch_auth: { type: "boolean" },
        can_touch_billing: { type: "boolean" },
        can_manage_production: { type: "boolean" },
        approval_class: { type: "string" },
        status: { type: "string" },
        meta: { type: "object" },
        updated_by: { type: "string" },
      },
      required: ["agent_name"],
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const agentName = normalizeAgentName(a.agent_name);
      const current = deriveAgentPassport(db, agentName);
      const capabilityMatrix = Object.assign({}, current.capability_matrix || {}, a.capability_matrix || {});
      db.prepare(
        "INSERT INTO agent_passport (agent_name, display_name, department_name, lane, allowed_projects_json, allowed_systems_json, allowed_environments_json, capability_matrix_json, live_write, review_required, needs_handoff, can_deploy, can_touch_auth, can_touch_billing, can_manage_production, approval_class, source_kind, status, meta_json, updated_by, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) " +
        "ON CONFLICT(agent_name) DO UPDATE SET display_name=excluded.display_name, department_name=excluded.department_name, lane=excluded.lane, allowed_projects_json=excluded.allowed_projects_json, allowed_systems_json=excluded.allowed_systems_json, allowed_environments_json=excluded.allowed_environments_json, capability_matrix_json=excluded.capability_matrix_json, live_write=excluded.live_write, review_required=excluded.review_required, needs_handoff=excluded.needs_handoff, can_deploy=excluded.can_deploy, can_touch_auth=excluded.can_touch_auth, can_touch_billing=excluded.can_touch_billing, can_manage_production=excluded.can_manage_production, approval_class=excluded.approval_class, source_kind=excluded.source_kind, status=excluded.status, meta_json=excluded.meta_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at"
      ).run(
        agentName,
        a.display_name || current.display_name || agentName,
        a.department_name || current.department_name || null,
        a.lane || current.lane || null,
        JSON.stringify(normalizeProjectList(a.allowed_projects != null ? a.allowed_projects : current.allowed_projects)),
        JSON.stringify(normalizeStringList(a.allowed_systems != null ? a.allowed_systems : current.allowed_systems)),
        JSON.stringify(normalizeStringList(a.allowed_environments != null ? a.allowed_environments : current.allowed_environments)),
        JSON.stringify(capabilityMatrix),
        boolFlag(a.live_write, current.live_write) ? 1 : 0,
        boolFlag(a.review_required, current.review_required) ? 1 : 0,
        boolFlag(a.needs_handoff, current.needs_handoff) ? 1 : 0,
        boolFlag(a.can_deploy, current.can_deploy) ? 1 : 0,
        boolFlag(a.can_touch_auth, current.can_touch_auth) ? 1 : 0,
        boolFlag(a.can_touch_billing, current.can_touch_billing) ? 1 : 0,
        boolFlag(a.can_manage_production, current.can_manage_production) ? 1 : 0,
        a.approval_class || current.approval_class || "read_only",
        "manual",
        a.status || current.status || "active",
        JSON.stringify(a.meta || current.meta || {}),
        a.updated_by || DEFAULT_AGENT
      );
      return { ok: true, passport: agentPassportData(db, agentName) };
    },
  },
  mem_agent_pass_get: {
    description: "Get the durable agent passport. If no explicit passport exists, returns a derived passport from the team operating model and registered connectors.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" } }, required: ["agent_name"] },
    handler: ({ agent_name } = {}) => {
      if (!agent_name) return { error: "agent_name required" };
      return { ok: true, passport: agentPassportData(db, agent_name) };
    },
  },
  mem_agent_pass_list: {
    description: "List explicit and derived agent passports so the team can see who is allowed to do what.",
    inputSchema: {
      type: "object",
      properties: {
        include_derived: { type: "boolean" },
        status: { type: "string" },
        department_name: { type: "string" },
      },
    },
    handler: (a = {}) => {
      const passports = agentPassportListData(db, a || {});
      return {
        ok: true,
        count: passports.length,
        passports,
      };
    },
  },
  mem_drift_check_report: {
    description: "Run reality checks against runtime health, connector freshness, writer health, and project registry gaps. Persists durable drift findings unless persist=false.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        project: { type: "string" },
        persist: { type: "boolean" },
        stale_days: { type: "integer" },
        runtime_stale_sec: { type: "integer" },
        agent_name: { type: "string" },
        actor: { type: "string" },
      },
    },
    handler: (a = {}) => buildDriftCheckReport(db, a || {}),
  },
  mem_drift_status: {
    description: "List persisted drift findings and freshness state from recent reality checks.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        project: { type: "string" },
        system_name: { type: "string" },
        drift_kind: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer" },
      },
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = [];
      const params = [];
      if (a.scope) { where.push("scope=?"); params.push(String(a.scope)); }
      if (a.project) { where.push("project=?"); params.push(String(a.project)); }
      if (a.system_name) { where.push("system_name=?"); params.push(String(a.system_name)); }
      if (a.drift_kind) { where.push("drift_kind=?"); params.push(String(a.drift_kind)); }
      if (a.status) { where.push("status=?"); params.push(String(a.status)); }
      const limit = Math.max(1, Math.min(parseInt(a.limit || 50, 10) || 50, 200));
      params.push(limit);
      const rows = db.prepare(
        "SELECT * FROM drift_check_result" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY checked_at DESC LIMIT ?"
      ).all(...params).map((row) => ({
        id: row.id,
        scope: row.scope,
        project: row.project || null,
        system_name: row.system_name || null,
        drift_kind: row.drift_kind,
        severity: row.severity,
        status: row.status,
        freshness_status: row.freshness_status,
        expected: row.expected || null,
        actual: row.actual || null,
        source_ref: row.source_ref || null,
        checked_by: row.checked_by || null,
        checked_at: row.checked_at,
        details: parseMaybeJson(row.details_json, {}),
      }));
      return {
        ok: true,
        count: rows.length,
        summary: {
          open: rows.filter((row) => row.status === "open").length,
          critical_freshness: rows.filter((row) => row.freshness_status === "critical").length,
          high: rows.filter((row) => row.severity === "H").length,
        },
        findings: rows,
      };
    },
  },
  mem_duplicate_work_check: {
    description: "Check active claims, recent handoffs, and overlapping open autonomy tasks before starting work on a project or file set. Use to block duplicate work before claiming files.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        summary: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim_kind: { type: "string" },
              scope_value: { type: "string" },
              file_path: { type: "string" }
            }
          }
        },
        topics: { type: "array", items: { type: "string" } },
      },
    },
    handler: (a = {}) => duplicateWorkCheck(db, a || {}),
  },
  mem_impact_map: {
    description: "Show what a change touches before execution: domains, servers, portals, agents, connectors, shared auth, and shared UI family.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        summary: { type: "string" },
        action_type: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        system_names: { type: "array", items: { type: "string" } },
        environment: { type: "string" },
      },
    },
    handler: (a = {}) => buildImpactMap(db, a || {}),
  },
  mem_write_gate_check: {
    description: "Hard write gate for onboarding/read-only agents and sensitive work. Validates the agent passport against project, systems, auth, billing, deploy, production risk, and protected final artifacts before changes start.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        summary: { type: "string" },
        action_type: { type: "string" },
        topics: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        routes: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } },
        system_names: { type: "array", items: { type: "string" } },
        connectors: { type: "array", items: { type: "string" } },
        environment: { type: "string" },
      },
      required: ["agent_name", "task"],
    },
    handler: (a = {}) => writeGateCheck(db, a || {}),
  },
  mem_maintenance_window_upsert: {
    description: "Create or update a maintenance/change window for one project or system. Use for auth, billing, deploy, DNS, nginx, PM2, and other live-risk work.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        scope: { type: "string" },
        project: { type: "string" },
        system_name: { type: "string" },
        title: { type: "string" },
        window_kind: { type: "string" },
        risk_class: { type: "string" },
        starts_at: { type: "string" },
        ends_at: { type: "string" },
        status: { type: "string" },
        notes: { type: "string" },
        approved_by: { type: "string" },
        updated_by: { type: "string" },
        meta: { type: "object" }
      },
      required: ["title", "starts_at", "ends_at"]
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const scope = scopeName(a.scope);
      if (a.id) {
        const current = db.prepare("SELECT id, meta_json FROM maintenance_window WHERE id=?").get(a.id);
        if (!current) return { error: "maintenance_window_not_found", id: a.id };
        db.prepare("UPDATE maintenance_window SET scope=?, project=?, system_name=?, title=?, window_kind=?, risk_class=?, starts_at=?, ends_at=?, status=?, notes=?, approved_by=?, updated_by=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, a.title, a.window_kind || "maintenance", a.risk_class || "normal_fix", a.starts_at, a.ends_at, a.status || "approved", a.notes || null, a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id };
      }
      const info = db.prepare("INSERT INTO maintenance_window (scope, project, system_name, title, window_kind, risk_class, starts_at, ends_at, status, notes, approved_by, updated_by, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, a.title, a.window_kind || "maintenance", a.risk_class || "normal_fix", a.starts_at, a.ends_at, a.status || "approved", a.notes || null, a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
  },
  mem_maintenance_window_list: {
    description: "List planned, active, or past maintenance windows.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare("SELECT * FROM maintenance_window WHERE " + where.join(" AND ") + " ORDER BY starts_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, windows: rows };
    }
  },
  mem_maintenance_window_check: {
    description: "Check whether the requested work is inside an active maintenance window.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" }, project: { type: "string" }, system_names: { type: "array", items: { type: "string" } }, connectors: { type: "array", items: { type: "string" } },
        agent_name: { type: "string" }, task: { type: "string" }, summary: { type: "string" }, action_type: { type: "string" }, topics: { type: "array", items: { type: "string" } }, files: { type: "array", items: { type: "string" } }, environment: { type: "string" }
      }
    },
    handler: (a = {}) => maintenanceWindowCheck(db, a || {})
  },
  mem_override_log: {
    description: "Record a temporary rule override with expiry. Use when a freeze/window/gate must be bypassed intentionally and auditable.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" }, scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, agent_name: { type: "string" },
        gate_kind: { type: "string" }, reason: { type: "string" }, approved_by: { type: "string" }, starts_at: { type: "string" }, expires_at: { type: "string" },
        status: { type: "string" }, notes: { type: "string" }, meta: { type: "object" }
      },
      required: ["gate_kind", "reason"]
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const scope = scopeName(a.scope);
      const overrideGate = validateProtectedScopeOverride(db, Object.assign({}, a, { scope }));
      if (!overrideGate.ok) return overrideGate;
      if (a.id) {
        const current = db.prepare("SELECT id, meta_json FROM override_log WHERE id=?").get(a.id);
        if (!current) return { error: "override_not_found", id: a.id };
        db.prepare("UPDATE override_log SET scope=?, project=?, system_name=?, agent_name=?, gate_kind=?, reason=?, approved_by=?, starts_at=?, expires_at=?, status=?, notes=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, a.agent_name || null, a.gate_kind, a.reason, a.approved_by || null, a.starts_at || isoNow(), a.expires_at || null, a.status || "active", a.notes || null, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id };
      }
      const info = db.prepare("INSERT INTO override_log (scope, project, system_name, agent_name, gate_kind, reason, approved_by, starts_at, expires_at, status, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, a.agent_name || null, a.gate_kind, a.reason, a.approved_by || null, a.starts_at || isoNow(), a.expires_at || null, a.status || "active", a.notes || null, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
  },
  mem_override_list: {
    description: "List temporary override records.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, gate_kind: { type: "string" }, agent_name: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.gate_kind) { where.push("gate_kind=?"); params.push(a.gate_kind); }
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare("SELECT * FROM override_log WHERE " + where.join(" AND ") + " ORDER BY starts_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, overrides: rows };
    }
  },
  mem_override_check: {
    description: "Show active temporary overrides matching one scope/project/system/agent/gate.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_names: { type: "array", items: { type: "string" } }, connectors: { type: "array", items: { type: "string" } }, gate_kind: { type: "string" }, agent_name: { type: "string" } } },
    handler: (a = {}) => ({ ok: true, count: currentOverrideRows(db, a || {}).length, overrides: currentOverrideRows(db, a || {}) })
  },
  mem_artifact_lock_set: {
    description: "Protect one final page, file, route, domain, project, or system so agents must not touch it again without an explicit override.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        scope: { type: "string" },
        project: { type: "string" },
        system_name: { type: "string" },
        artifact_kind: { type: "string" },
        artifact_value: { type: "string" },
        artifact_label: { type: "string" },
        reason: { type: "string" },
        status: { type: "string" },
        locked_by: { type: "string" },
        approved_by: { type: "string" },
        started_at: { type: "string" },
        expires_at: { type: "string" },
        notes: { type: "string" },
        meta: { type: "object" }
      },
      required: ["artifact_kind", "artifact_value", "reason"]
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const scope = scopeName(a.scope);
      const artifactKind = normalizeArtifactKind(a.artifact_kind);
      const artifactKey = normalizeArtifactValue(artifactKind, a.artifact_value);
      if (!artifactKey) return { error: "artifact_value required" };
      if (a.id) {
        const current = db.prepare("SELECT id, meta_json FROM artifact_lock WHERE id=?").get(a.id);
        if (!current) return { error: "artifact_lock_not_found", id: a.id };
        db.prepare("UPDATE artifact_lock SET scope=?, project=?, system_name=?, artifact_kind=?, artifact_key=?, artifact_label=?, reason=?, status=?, locked_by=?, approved_by=?, started_at=?, expires_at=?, notes=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, artifactKind, artifactKey, a.artifact_label || a.artifact_value || artifactKey, a.reason, a.status || "active", a.locked_by || DEFAULT_AGENT, a.approved_by || null, a.started_at || isoNow(), a.expires_at || null, a.notes || null, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id, artifact_kind: artifactKind, artifact_key: artifactKey };
      }
      const existing = db.prepare("SELECT id, meta_json FROM artifact_lock WHERE scope=? AND COALESCE(project,'')=COALESCE(?, '') AND COALESCE(system_name,'')=COALESCE(?, '') AND artifact_kind=? AND artifact_key=? AND status='active' ORDER BY id DESC LIMIT 1")
        .get(scope, a.project || null, a.system_name || null, artifactKind, artifactKey);
      if (existing) {
        db.prepare("UPDATE artifact_lock SET artifact_label=?, reason=?, locked_by=?, approved_by=?, expires_at=?, notes=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(a.artifact_label || a.artifact_value || artifactKey, a.reason, a.locked_by || DEFAULT_AGENT, a.approved_by || null, a.expires_at || null, a.notes || null, JSON.stringify(a.meta || parseMaybeJson(existing.meta_json, {})), existing.id);
        return { ok: true, id: existing.id, artifact_kind: artifactKind, artifact_key: artifactKey, reused: true };
      }
      const info = db.prepare("INSERT INTO artifact_lock (scope, project, system_name, artifact_kind, artifact_key, artifact_label, reason, status, locked_by, approved_by, started_at, expires_at, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, artifactKind, artifactKey, a.artifact_label || a.artifact_value || artifactKey, a.reason, a.status || "active", a.locked_by || DEFAULT_AGENT, a.approved_by || null, a.started_at || isoNow(), a.expires_at || null, a.notes || null, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid, artifact_kind: artifactKind, artifact_key: artifactKey };
    }
  },
  mem_artifact_lock_list: {
    description: "List protected final artifacts that agents must not touch again without an explicit override.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        project: { type: "string" },
        system_name: { type: "string" },
        artifact_kind: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer" }
      }
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.artifact_kind) { where.push("artifact_kind=?"); params.push(normalizeArtifactKind(a.artifact_kind)); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare("SELECT * FROM artifact_lock WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, locks: rows };
    }
  },
  mem_artifact_lock_check: {
    description: "Check whether the requested files, URLs, routes, domains, project, or systems are protected final artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        project: { type: "string" },
        agent_name: { type: "string" },
        task: { type: "string" },
        summary: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        routes: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } },
        system_names: { type: "array", items: { type: "string" } },
        connectors: { type: "array", items: { type: "string" } }
      }
    },
    handler: (a = {}) => artifactLockCheck(db, a || {})
  },
  mem_secret_rotation_log: {
    description: "Record secret rotation and verification history for Stripe, OAuth, SMTP, VAT, APIs, servers, and other connectors.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" }, system_name: { type: "string" }, secret_ref: { type: "string" }, project: { type: "string" }, rotated_by: { type: "string" }, verified_by: { type: "string" },
        rotation_kind: { type: "string" }, status: { type: "string" }, rotated_at: { type: "string" }, verified_at: { type: "string" }, notes: { type: "string" }, meta: { type: "object" }
      },
      required: ["system_name"]
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const info = db.prepare("INSERT INTO secret_rotation_log (scope, system_name, secret_ref, project, rotated_by, verified_by, rotation_kind, status, rotated_at, verified_at, notes, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(scopeName(a.scope), a.system_name, a.secret_ref || null, a.project || null, a.rotated_by || null, a.verified_by || null, a.rotation_kind || "manual", a.status || "rotated", a.rotated_at || isoNow(), a.verified_at || null, a.notes || null, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
  },
  mem_secret_rotation_list: {
    description: "List recent secret rotations.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, system_name: { type: "string" }, secret_ref: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.secret_ref) { where.push("secret_ref=?"); params.push(a.secret_ref); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare("SELECT * FROM secret_rotation_log WHERE " + where.join(" AND ") + " ORDER BY rotated_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, rotations: rows };
    }
  },
  mem_freeze_set: {
    description: "Create or update a dependency freeze marker so no parallel changes hit a critical project/system.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" }, scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, freeze_kind: { type: "string" }, reason: { type: "string" },
        started_at: { type: "string" }, expires_at: { type: "string" }, status: { type: "string" }, approved_by: { type: "string" }, updated_by: { type: "string" }, meta: { type: "object" }
      },
      required: ["reason"]
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const scope = scopeName(a.scope);
      if (a.id) {
        const current = db.prepare("SELECT id, meta_json FROM dependency_freeze WHERE id=?").get(a.id);
        if (!current) return { error: "freeze_not_found", id: a.id };
        db.prepare("UPDATE dependency_freeze SET scope=?, project=?, system_name=?, freeze_kind=?, reason=?, started_at=?, expires_at=?, status=?, approved_by=?, updated_by=?, meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(scope, a.project || null, a.system_name || null, a.freeze_kind || "dependency_freeze", a.reason, a.started_at || isoNow(), a.expires_at || null, a.status || "active", a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || parseMaybeJson(current.meta_json, {})), a.id);
        return { ok: true, id: a.id };
      }
      const info = db.prepare("INSERT INTO dependency_freeze (scope, project, system_name, freeze_kind, reason, started_at, expires_at, status, approved_by, updated_by, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(scope, a.project || null, a.system_name || null, a.freeze_kind || "dependency_freeze", a.reason, a.started_at || isoNow(), a.expires_at || null, a.status || "active", a.approved_by || null, a.updated_by || DEFAULT_AGENT, JSON.stringify(a.meta || {}));
      return { ok: true, id: info.lastInsertRowid };
    }
  },
  mem_freeze_list: {
    description: "List dependency freeze markers.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare("SELECT * FROM dependency_freeze WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, freezes: rows };
    }
  },
  mem_freeze_check: {
    description: "Check whether a project/system is under active freeze.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_names: { type: "array", items: { type: "string" } }, connectors: { type: "array", items: { type: "string" } }, agent_name: { type: "string" } } },
    handler: (a = {}) => freezeCheck(db, a || {})
  },
  mem_incident_report: {
    description: "Create a durable incident/scar record with cause, fix, prevention, and links to findings/decisions.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, title: { type: "string" }, severity: { type: "string" }, status: { type: "string" },
        cause: { type: "string" }, fix_summary: { type: "string" }, prevention: { type: "string" }, source_agent: { type: "string" }, decision_id: { type: "integer" }, quality_finding_id: { type: "integer" },
        scar_pattern_id: { type: "integer" }, evidence: { type: "object" }, meta: { type: "object" }, closed_at: { type: "string" }
      },
      required: ["title"]
    },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const info = db.prepare("INSERT INTO ops_incident (scope, project, system_name, title, severity, status, cause, fix_summary, prevention, source_agent, decision_id, quality_finding_id, scar_pattern_id, evidence_json, meta_json, closed_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
        .run(scopeName(a.scope), a.project || null, a.system_name || null, a.title, a.severity || "M", a.status || "open", a.cause || null, a.fix_summary || null, a.prevention || null, a.source_agent || null, a.decision_id || null, a.quality_finding_id || null, a.scar_pattern_id || null, JSON.stringify(a.evidence || {}), JSON.stringify(a.meta || {}), a.closed_at || null);
      return { ok: true, id: info.lastInsertRowid };
    }
  },
  mem_incident_list: {
    description: "List durable incidents.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, status: { type: "string" }, severity: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => {
      ensureUniversalJournalSchema();
      const where = ["scope=?"];
      const params = [scopeName(a.scope)];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name=?"); params.push(a.system_name); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.severity) { where.push("severity=?"); params.push(a.severity); }
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare("SELECT * FROM ops_incident WHERE " + where.join(" AND ") + " ORDER BY opened_at DESC LIMIT ?").all(...params).map((row) => Object.assign({}, row, { evidence: parseMaybeJson(row.evidence_json, {}), meta: parseMaybeJson(row.meta_json, {}) }));
      return { ok: true, count: rows.length, incidents: rows };
    }
  },
  mem_status_board: {
    description: "Machine-readable operations board per project: live status, findings, drift, claims, freezes, windows, incidents.",
    inputSchema: { type: "object", properties: { projects: { type: "array", items: { type: "string" } } } },
    handler: (a = {}) => buildStatusBoard(db, a || {})
  },
  mem_learning_loop_report: {
    description: "Summarize repeated drift/findings/scars and blocked preflights into rule/runbook recommendations.",
    inputSchema: { type: "object", properties: { days: { type: "integer" } } },
    handler: (a = {}) => buildLearningLoopReport(db, a || {})
  },
  mem_search_reindex: {
    description: "Rebuild mnemo_search_fts for transcript/brief/event/memory rows so recall/search can see historical backfill and live capture.",
    inputSchema: { type: "object", properties: { scopes: { type: "array", items: { type: "string" } }, limit: { type: "integer" }, reset: { type: "boolean" } } },
    handler: (a = {}) => runSearchReindex(db, a || {})
  },
  mem_department_member_set: {
    description: "Assign or update an agent in a department. This is the durable source for who owns frontend, backend, billing, QA, deploy, content/legal, and final review.",
    inputSchema: {
      type: "object",
      properties: { department_name: { type: "string" }, agent_name: { type: "string" }, role: { type: "string" }, skills: { type: "array", items: { type: "string" } } },
      required: ["department_name","agent_name"],
    },
    handler: ({ department_name, agent_name, role, skills }) => {
      ensureAutonomyTables(db);
      const dep = departmentInfo(db, department_name);
      if (!dep) return { error: "department not found", department_name, hint: "Run mem_department_seed_defaults first." };
      db.prepare("INSERT INTO department_member (department_name, agent_name, role, skills_json, updated_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(department_name, agent_name) DO UPDATE SET role=excluded.role, skills_json=excluded.skills_json, status='active', updated_at=excluded.updated_at")
        .run(department_name, agent_name, role || "member", JSON.stringify(skills || []));
      return { ok: true, department_name, agent_name, role: role || "member" };
    },
  },
  mem_project_crossover_check: {
    description: "Audit one project for website/app crossover readiness: landing menu, header/footer, links, shared auth, pricing source of truth, checkout, VAT/OSS, legal, mobile, i18n, deploy and monitoring. Optionally creates durable findings.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, name: { type: "string" }, create_findings: { type: "boolean" }, source_agent: { type: "string" }, agent_name: { type: "string" } },
    },
    handler: (a) => {
      const result = buildProjectCrossoverCheck(db, a || {});
      try { db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_crossover_check', ?, ?, ?, 'autonomy')").run(a.agent_name || a.source_agent || DEFAULT_AGENT, result.project || a.project || a.name || "unknown", result.status || "error", JSON.stringify({ findings: result.findings ? result.findings.length : 0, checks: result.checks ? result.checks.length : 0 })); } catch {}
      return result;
    },
  },
  mem_autonomy_sweep: {
    description: "Automatically turn readiness gaps and open findings into department-owned autonomy tasks. Optionally drops briefs to assigned agents for newly created tasks.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string" }, project: { type: "string" }, include_seed: { type: "boolean" }, include_smoke: { type: "boolean" }, finding_limit: { type: "integer" }, drop_briefs: { type: "boolean" }, agent_name: { type: "string" } },
    },
    handler: (a) => runAutonomySweep(db, a || {}),
  },
  mem_autonomy_next: {
    description: "Return the next open department-owned task for an agent or department. With claim=true the task is marked claimed so no other agent starts the same work. With allow_takeover=true, stale tasks assigned to another agent can be claimed after stale_takeover_minutes.",
    inputSchema: {
      type: "object",
      properties: { agent_name: { type: "string" }, department_name: { type: "string" }, project: { type: "string" }, claim: { type: "boolean" }, limit: { type: "integer" }, allow_takeover: { type: "boolean" }, stale_takeover_minutes: { type: "integer" } },
    },
    handler: (a) => {
      a = a || {};
      ensureAutonomyTables(db);
      const agentName = normalizeAgentName(a.agent_name);
      const allowTakeover = !!(a.allow_takeover && agentName);
      const staleTakeoverMinutes = Math.max(1, Math.min(parseInt(a.stale_takeover_minutes || 20, 10) || 20, 1440));
      const staleBefore = new Date(Date.now() - staleTakeoverMinutes * 60 * 1000).toISOString();
      const where = [allowTakeover ? "(status='open' OR (status='claimed' AND COALESCE(updated_at, claimed_at, created_at) < ?))" : "status='open'"];
      const params = allowTakeover ? [staleBefore] : [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.department_name) { where.push("department_name=?"); params.push(a.department_name); }
      if (agentName) {
        if (allowTakeover) {
          where.push("(lower(COALESCE(assigned_agent,''))=lower(?) OR assigned_agent IS NULL OR assigned_agent='' OR (assigned_agent IS NOT NULL AND assigned_agent<>'' AND lower(assigned_agent)<>lower(?) AND COALESCE(updated_at, claimed_at, created_at) < ?))");
          params.push(agentName, agentName, staleBefore);
        } else {
          where.push("(lower(COALESCE(assigned_agent,''))=lower(?) OR assigned_agent IS NULL OR assigned_agent='')");
          params.push(agentName);
        }
      }
      const limit = Math.min(a.limit || 10, 50);
      const ownerOrder = agentName ? "CASE WHEN lower(COALESCE(assigned_agent,''))=lower(?) THEN 0 WHEN assigned_agent IS NULL OR assigned_agent='' THEN 1 ELSE 2 END, " : "";
      if (agentName) params.push(agentName);
      params.push(limit);
      const rows = db.prepare("SELECT * FROM autonomy_task WHERE " + where.join(" AND ") + " ORDER BY " + ownerOrder + "CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at ASC LIMIT ?").all(...params);
      for (const r of rows) {
        const assignedAgent = normalizeAgentName(r.assigned_agent);
        const lastTouch = Date.parse(r.updated_at || r.claimed_at || r.created_at || "");
        const staleEligible = Number.isFinite(lastTouch) && lastTouch < Date.parse(staleBefore);
        r.takeover_eligible = !!(allowTakeover && assignedAgent && assignedAgent !== agentName && staleEligible);
        r.stale_claim_recovery = !!(allowTakeover && r.status === "claimed" && staleEligible);
        r.previous_assigned_agent = r.takeover_eligible ? r.assigned_agent : null;
        r.checklist = parseMaybeJson(r.checklist_json, null);
        r.meta = parseMaybeJson(r.meta_json, null);
        delete r.checklist_json; delete r.meta_json;
      }
      if (a.claim && rows[0]) {
        const id = rows[0].id;
        const claimSql = "UPDATE autonomy_task SET status='claimed', assigned_agent=COALESCE(?, assigned_agent), claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND " + (allowTakeover ? "(status='open' OR (status='claimed' AND COALESCE(updated_at, claimed_at, created_at) < ?))" : "status='open'");
        const info = allowTakeover
          ? db.prepare(claimSql).run(agentName || null, id, staleBefore)
          : db.prepare(claimSql).run(agentName || null, id);
        if (info.changes < 1) return { count: 0, tasks: [], claim_conflict: true, takeover: { allow_takeover: allowTakeover, stale_takeover_minutes: staleTakeoverMinutes, stale_before: staleBefore } };
        rows[0].status = "claimed";
        rows[0].assigned_agent = agentName || rows[0].assigned_agent;
      }
      return { count: rows.length, tasks: rows, takeover: { allow_takeover: allowTakeover, stale_takeover_minutes: staleTakeoverMinutes, stale_before: staleBefore } };
    },
  },
  mem_autonomy_task_update: {
    description: "Update an autonomy task after work, review, blocker, or completion. Accepts autonomy_task.id or a linked agent_brief.id when resolvable.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, status: { type: "string" }, assigned_agent: { type: "string" }, reviewer_agent: { type: "string" }, notes: { type: "string" }, meta: { type: "object" } },
      required: ["id"],
    },
    handler: (a) => {
      ensureAutonomyTables(db);
      const resolved = briefCoordination.resolveAutonomyTaskUpdateId(db, a.id);
      if (resolved.error) {
        return {
          error: resolved.error,
          id: a.id,
          candidates: resolved.candidates || [],
          hint: "Use autonomy_task.id or the linked agent_brief.id. This tool resolves direct task IDs, brief meta/content task references, source_id links, and meta brief_id links."
        };
      }
      const taskId = resolved.id;
      const current = db.prepare("SELECT meta_json FROM autonomy_task WHERE id=?").get(taskId);
      if (!current) return { error: "task not found", id: a.id, resolved_id: taskId };
      if (String(a.status || "").toLowerCase() === "blocked") {
        const metaBlocker = firstReasonObject(a.meta || {}, ["blocked_reason", "blocker", "blockers", "missing", "missing_blocks", "reason", "next_action"]);
        if (!compactReason(a.notes) && !metaBlocker) {
          return {
            error: "blocked update requires blocker reason",
            id: a.id,
            resolved_id: taskId,
            hint: "Set notes='blocked because ...' or meta.blocked_reason/meta.blockers so future blocked-review briefs include the reason."
          };
        }
      }
      const meta = a.meta ? JSON.stringify(deepMergePlain(parseMaybeJson(current.meta_json, {}) || {}, a.meta)) : current.meta_json;
      const doneExpr = a.status === "done" || a.status === "reviewed" || a.status === "approved" ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "done_at";
      const sql = "UPDATE autonomy_task SET status=COALESCE(?, status), assigned_agent=COALESCE(?, assigned_agent), reviewer_agent=COALESCE(?, reviewer_agent), notes=COALESCE(?, notes), meta_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), done_at=" + doneExpr + " WHERE id=?";
      const info = db.prepare(sql).run(a.status || null, a.assigned_agent || null, a.reviewer_agent || null, a.notes || null, meta, taskId);
      return { ok: info.changes > 0, id: taskId, input_id: a.id, resolved_from: resolved.resolved_from, status: a.status || "unchanged" };
    },
  },
  mem_project_rules_set: {
    description: "Store the non-negotiable build rules for one project: navigation, domains, auth crossover, languages, pricing, checkout, VAT, deploy gates, and design rules. Call before agents build or change a project surface.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        canonical_nav: { type: "object" },
        allowed_domains: { type: "array", items: { type: "string" } },
        auth_matrix: { type: "object" },
        language_matrix: { type: "object" },
        pricing_rules: { type: "object" },
        checkout_rules: { type: "object" },
        vat_rules: { type: "object" },
        deploy_rules: { type: "object" },
        design_rules: { type: "object" },
        required_gates: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        updated_by: { type: "string" },
      },
      required: ["project"],
    },
    handler: (a) => {
      ensureFirmOpsTables();
      const jsonKeys = ["canonical_nav","allowed_domains","auth_matrix","language_matrix","pricing_rules","checkout_rules","vat_rules","deploy_rules","design_rules","required_gates"];
      const fields = ["project"];
      const placeholders = ["?"];
      const values = [a.project];
      const updates = [];
      for (const k of jsonKeys) {
        if (a[k] !== undefined) {
          fields.push(k);
          placeholders.push("?");
          values.push(JSON.stringify(a[k]));
          updates.push(k + "=excluded." + k);
        }
      }
      for (const k of ["notes","updated_by"]) {
        if (a[k] !== undefined) {
          fields.push(k);
          placeholders.push("?");
          values.push(a[k]);
          updates.push(k + "=excluded." + k);
        }
      }
      updates.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      const sql = "INSERT INTO project_rules (" + fields.join(",") + ") VALUES (" + placeholders.join(",") + ") ON CONFLICT(project) DO UPDATE SET " + updates.join(", ");
      db.prepare(sql).run(...values);
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_rules_set', ?, 'done', ?, 'project_rules')")
          .run(a.updated_by || "unknown", a.project, JSON.stringify({ keys: Object.keys(a).filter(k => k !== "project") }));
      } catch {}
      return { ok: true, project: a.project };
    },
  },
  mem_project_rules_get: {
    description: "Read the canonical build rules for one project. Use at session start and before touching navigation, auth, language, pricing, checkout, VAT, design, or deploy behavior.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    handler: ({ project }) => {
      ensureFirmOpsTables();
      const row = db.prepare("SELECT * FROM project_rules WHERE project=?").get(project);
      if (!row) return { error: "not found", project, hint: "Create rules via mem_project_rules_set before letting agents build UI, auth, pricing, checkout, language, or deploy flows." };
      for (const k of ["canonical_nav","allowed_domains","auth_matrix","language_matrix","pricing_rules","checkout_rules","vat_rules","deploy_rules","design_rules","required_gates"]) {
        row[k] = parseMaybeJson(row[k], null);
      }
      row.top_directives = blunTopDirectives(project, row);
      return row;
    },
  },
  mem_auth_contract_get: {
    description: "Read the canonical login/SSO contract for one project from project_rules.auth_matrix and validate required fields.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    handler: ({ project }) => authContractReport(db, project, ensureFirmOpsTables)
  },
  mem_auth_contract_check: {
    description: "Hard gate for auth/login/SSO changes. Blocks when the canonical auth contract is missing, draft, or inconsistent across linked portals.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    handler: ({ project }) => authContractReport(db, project, ensureFirmOpsTables)
  },
  mem_ui_contract_get: {
    description: "Read the canonical UI contract for one project from project_rules.design_rules and canonical_nav. Validates blun.ai-driven header/button/theme requirements.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    handler: ({ project }) => uiContractReport(db, project, ensureFirmOpsTables)
  },
  mem_ui_contract_check: {
    description: "Hard gate for header/menu/button/theme/frontend changes. Blocks when the canonical UI contract is missing, draft, or inconsistent across linked portals.",
    inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
    handler: ({ project }) => uiContractReport(db, project, ensureFirmOpsTables)
  },
  mem_project_rules_list: {
    description: "List projects that already have canonical build rules.",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    handler: ({ limit }) => {
      ensureFirmOpsTables();
      const rows = db.prepare("SELECT project, updated_at, updated_by, notes FROM project_rules ORDER BY updated_at DESC LIMIT ?").all(Math.min(limit || 100, 500));
      return { count: rows.length, projects: rows };
    },
  },
  mem_project_rules_seed_defaults: {
    description: "Seed canonical project registry and project rules from MNEMO_FACTS_DIR/<scope>-project-rules.json. Use after install/update so projects have auth/pricing/VAT/checkout/design gates before agents work on them.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        projects: { type: "array", items: { type: "string" } },
        include_registry: { type: "boolean" },
        seed_findings: { type: "boolean" },
        dry_run: { type: "boolean" },
        updated_by: { type: "string" },
        agent_name: { type: "string" },
      },
    },
    handler: async (a) => {
      ensureFirmOpsTables();
      ensureProjectRegistryTable(db);
      const seed = loadProjectRuleDefaults(a.scope);
      if (seed.error) return seed;
      const wanted = Array.isArray(a.projects) && a.projects.length ? new Set(a.projects) : null;
      const updatedBy = a.updated_by || a.agent_name || "seed-defaults";
      const seeded = [];
      for (const project of seed.projects || []) {
        if (wanted && !wanted.has(project.name)) continue;
        const rules = deepMergePlain(seed.defaults || {}, project.rules || {});
        if (a.dry_run) {
          seeded.push({ project: project.name, dry_run: true, registry: Boolean(project.registry), rule_keys: Object.keys(rules) });
          continue;
        }
        let registry = null;
        if (a.include_registry !== false && project.registry) {
          registry = await tools.mem_project_registry_upsert.handler(Object.assign({}, project.registry, { name: project.name, updated_by: updatedBy }));
        }
        const ruleResult = await tools.mem_project_rules_set.handler(Object.assign({}, rules, { project: project.name, updated_by: updatedBy }));
        const findings = [];
        if (a.seed_findings !== false) {
          for (const f of project.findings || []) {
            const existing = db.prepare("SELECT id, status FROM quality_finding WHERE project=? AND title=? ORDER BY id DESC LIMIT 1").get(project.name, f.title);
            if (existing) {
              findings.push({ id: existing.id, status: existing.status, action: "kept" });
            } else {
              findings.push(await tools.mem_quality_finding_report.handler(Object.assign({}, f, { project: project.name, source_agent: f.source_agent || updatedBy })));
            }
          }
        }
        seeded.push({ project: project.name, registry: registry ? registry.ok === true : false, rules: ruleResult.ok === true, findings });
      }
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'project_rules_seed_defaults', ?, 'done', ?, 'project_rules')")
          .run(updatedBy, scopeName(a.scope), JSON.stringify({ count: seeded.length, projects: seeded.map(x => x.project) }));
      } catch {}
      return { ok: true, scope: scopeName(a.scope), count: seeded.length, seeded };
    },
  },
  mem_firm_readiness_board: {
    description: "Aggregate all known projects into a live-readiness board: registry, project rules, live gates, open findings, and active claims. Use for Mission Control and before deciding what goes live next.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        projects: { type: "array", items: { type: "string" } },
        include_seed: { type: "boolean" },
        include_smoke: { type: "boolean" },
        agent_name: { type: "string" },
      },
    },
    handler: (a) => {
      const board = buildFirmReadinessBoard(db, a || {});
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'firm_readiness_board', ?, 'done', ?, 'firm_readiness')")
          .run(a.agent_name || "unknown", scopeName(a.scope), JSON.stringify(board.summary));
      } catch {}
      return board;
    },
  },
  mem_quality_finding_report: {
    description: "Create a durable quality finding when an agent spots a broken page, wrong menu/header/footer, mismatched pricing, language gap, auth crossover issue, VAT gap, or deploy risk. Findings remain open until explicitly resolved.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        category: { type: "string", description: "brand | nav | auth | language | pricing | checkout | vat | legal | mobile | deploy | bug | content | other" },
        severity: { type: "string", enum: ["L","M","H","critical"] },
        title: { type: "string" },
        url: { type: "string" },
        expected: { type: "string" },
        actual: { type: "string" },
        source_agent: { type: "string" },
        evidence: { type: "object" },
      },
      required: ["project","category","title"],
    },
    handler: (a) => {
      ensureFirmOpsTables();
      const sev = ["L","M","H","critical"].includes(a.severity) ? a.severity : "M";
      const info = db.prepare("INSERT INTO quality_finding (project, category, severity, title, url, expected, actual, source_agent, evidence_json) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(a.project, a.category, sev, a.title, a.url || null, a.expected || null, a.actual || null, a.source_agent || null, a.evidence ? JSON.stringify(a.evidence) : null);
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'quality_finding_report', ?, 'open', ?, 'quality_finding')")
          .run(a.source_agent || "unknown", a.project, JSON.stringify({ id: info.lastInsertRowid, category: a.category, severity: sev, title: a.title }));
      } catch {}
      return { id: info.lastInsertRowid, project: a.project, status: "open", severity: sev };
    },
  },
  mem_quality_finding_list: {
    description: "List durable quality findings. Use this before planning and before deploy so open defects cannot disappear across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        status: { type: "string" },
        category: { type: "string" },
        severity: { type: "string" },
        limit: { type: "integer" },
      },
    },
    handler: (a) => {
      ensureFirmOpsTables();
      const where = [];
      const params = [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.category) { where.push("category=?"); params.push(a.category); }
      if (a.severity) { where.push("severity=?"); params.push(a.severity); }
      const sql = "SELECT id, project, category, severity, title, url, status, source_agent, created_at, updated_at FROM quality_finding" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'H' THEN 1 WHEN 'M' THEN 2 ELSE 3 END, created_at DESC LIMIT ?";
      params.push(Math.min(a.limit || 100, 500));
      const rows = db.prepare(sql).all(...params);
      if (rows.length) return { count: rows.length, findings: rows };
      let memoryCandidates = [];
      try {
        const q = a.project ? "%" + a.project + "%" : "%finding%";
        memoryCandidates = db.prepare(
          "SELECT id, kind, actor, topic, substr(text,1,360) AS snippet, occurred_at FROM memory " +
          "WHERE (lower(text) LIKE '%finding%' OR lower(topic) LIKE '%finding%' OR text LIKE '%#%') " +
          (a.project ? "AND (text LIKE ? OR topic LIKE ?) " : "") +
          "ORDER BY id DESC LIMIT ?"
        ).all(...(a.project ? [q, q, Math.min(a.limit || 25, 100)] : [Math.min(a.limit || 25, 100)]));
      } catch {}
      return {
        count: 0,
        findings: [],
        memory_candidates_count: memoryCandidates.length,
        memory_candidates: memoryCandidates,
        hint: memoryCandidates.length
          ? "No structured quality_finding rows matched, but memory rows mention findings. Backfill or report them with mem_quality_finding_report so list/update/resolve can track them structurally."
          : "No structured quality_finding rows matched."
      };
    },
  },
  mem_quality_finding_resolve: {
    description: "Close or update a quality finding only after the fix has been verified. Use status='resolved' by default; status can also be approved, hold, question, or duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string" },
        resolved_by: { type: "string" },
        fix_summary: { type: "string" },
      },
      required: ["id"],
    },
    handler: ({ id, status, resolved_by, fix_summary }) => {
      ensureFirmOpsTables();
      const info = db.prepare("UPDATE quality_finding SET status=?, resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by=?, fix_summary=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run(status || "resolved", resolved_by || null, fix_summary || null, id);
      return { id, updated: info.changes, status: status || "resolved" };
    },
  },
  mem_session_start: {
    description: "Mandatory session-start bundle for agents. Reads focus, today, active work, project lens, project rules, live gates, and open findings so the agent thinks before acting and starts from the shared source of truth.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        include_all_claims: { type: "boolean" },
      },
      required: ["agent_name"],
    },
    handler: async (a) => {
      ensureFirmOpsTables();
      const agent = a.agent_name;
      const project = a.project || null;
      const focus = await tools.mem_focus_get.handler({ agent_name: agent });
      const today = await tools.mem_today_view.handler({ agent_name: agent });
      const work = await tools.mem_work_active.handler({ project, agent_name: a.include_all_claims ? null : agent, limit: 50 });
      const status = await tools.mem_agent_status_set.handler({ agent_name: agent, current_task: a.task || null, meta: { session_start: true, project } });
      const lens = project ? await tools.mem_lens_view.handler({ project, limit: 10 }) : null;
      const rules = project ? await tools.mem_project_rules_get.handler({ project }) : null;
      const live = project ? await tools.mem_project_live_check.handler({ name: project, agent_name: agent }) : null;
      const findings = project ? await tools.mem_quality_finding_list.handler({ project, status: "open", limit: 25 }) : null;
      const team = await tools.mem_team_operating_model.handler({ agent_name: agent });
      const passport = await tools.mem_agent_pass_get.handler({ agent_name: agent });
      const statusBoard = project ? await tools.mem_status_board.handler({ projects: [project] }) : null;
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'session_start', ?, 'done', ?, 'session_lifecycle')")
          .run(agent, project || a.task || "session", JSON.stringify({ task: a.task || null, project, passport_lane: passport && passport.passport && passport.passport.lane || null }));
      } catch {}
      return {
        agent_name: agent,
        project,
        task: a.task || null,
        protocol: ["view memory first", "read project rules", "check active claims", "think/preflight before edits", "claim files", "verify end-to-end", "handoff before stop"].concat((rules && rules.top_directives) || []),
        memory_paths: project ? ["/memories/top.md", "/memories/today.md", "/memories/agents/" + agent + "/status.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/registry.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/rules.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/live-check.md", "/memories/projects/" + project.replace(/\s+/g, "_") + "/findings.md"] : ["/memories/top.md", "/memories/today.md", "/memories/agents/" + agent + "/status.md"],
        focus,
        status,
        today,
        active_work: work,
        project_lens: lens,
        project_rules: rules,
        live_check: live,
        open_findings: findings,
        team_operating_model: team,
        agent_passport: passport,
        status_board: statusBoard,
      };
    },
  },
  mem_agent_preflight: {
    description: "Mandatory think-before-action gate for code, deploy, and external changes. It checks project rules, high-severity findings, canonical facts, and work claims; optional auto_claim claims files after duplicate-work checks.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        task: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        urls: { type: "array", items: { type: "string" } },
        routes: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } },
        system_names: { type: "array", items: { type: "string" } },
        resources: { type: "array", items: { type: "object" } },
        environment: { type: "string" },
        action_type: { type: "string" },
        topics: { type: "array", items: { type: "string" } },
        scope: { type: "string" },
        summary: { type: "string" },
        require_project_rules: { type: "boolean" },
        block_on_high_findings: { type: "boolean" },
        auto_claim: { type: "boolean" },
        ttl_minutes: { type: "integer" },
        token_id: { type: "string" },
        capability_token_id: { type: "string" },
        work_order_id: { type: "integer" },
        tool_name: { type: "string" },
        approval_ids: { type: "array", items: { type: "string" } },
      },
      required: ["agent_name","task"],
    },
    handler: async (a) => {
      ensureFirmOpsTables();
      const project = a.project || null;
      const files = Array.isArray(a.files) ? a.files : [];
      const checks = [];
      const blockers = [];
      const capability = capabilityTokenCheck(db, {
        token_id: a.token_id || a.capability_token_id || null,
        work_order_id: a.work_order_id || null,
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        tool_name: a.tool_name || null,
        files,
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        resources: a.resources || [],
        approval_ids: a.approval_ids || [],
      });
      checks.push({
        name: "capability_token",
        result: capability.granted ? "ok" : "block",
        required: capability.required,
        reason: capability.reason,
        token_id: capability.token_id || null,
        work_order_id: capability.work_order_id || null,
        expires_at: capability.expires_at || null,
        audit_id: capability.audit_id || null,
        required_evidence: capability.required_evidence || [],
      });
      if (requiresCapabilityToken(a) && !capability.granted) blockers.push("capability token blocked: " + capability.reason);
      if (project) {
        const rules = await tools.mem_project_rules_get.handler({ project });
        checks.push({ name: "project_rules", result: rules.error ? "missing" : "ok" });
        if (rules.error && a.require_project_rules !== false) blockers.push("missing project rules for " + project);
        if (!rules.error) {
          const wizardGate = wizardTargetGate(a, rules);
          if (wizardGate.required) {
            checks.push({
              name: "explicit_wizard_target",
              result: wizardGate.status,
              target: wizardGate.target || null,
              reason: wizardGate.reason
            });
            if (wizardGate.status === "block") blockers.push("wizard target blocked: " + wizardGate.reason);
          }
        }
        if (authSensitiveTask(a)) {
          const authCheck = await tools.mem_auth_contract_check.handler({ project });
          checks.push({ name: "auth_contract", result: authCheck.status || (authCheck.ok ? "ok" : "block"), missing: authCheck.missing || [], mismatches: authCheck.mismatches || [] });
          if (authCheck.status === "block") blockers.push("canonical auth contract blocked: " + (authCheck.blockers || []).join("; "));
        }
        if (uiSensitiveTask(a)) {
          const uiCheck = await tools.mem_ui_contract_check.handler({ project });
          checks.push({ name: "ui_contract", result: uiCheck.status || (uiCheck.ok ? "ok" : "block"), missing: uiCheck.missing || [], mismatches: uiCheck.mismatches || [] });
          if (uiCheck.status === "block") blockers.push("canonical ui contract blocked: " + (uiCheck.blockers || []).join("; "));
        }
        const findings = await tools.mem_quality_finding_list.handler({ project, status: "open", limit: 50 });
        const high = (findings.findings || []).filter(f => f.severity === "H" || f.severity === "critical");
        checks.push({ name: "open_findings", open: findings.count, high: high.length });
        if (high.length && a.block_on_high_findings !== false) blockers.push("open high/critical findings exist");
      }
      if (a.action_type && Array.isArray(a.topics)) {
        const pre = await tools.mem_pre_action_check.handler({ action_type: a.action_type, topics: a.topics, scope: a.scope, agent_name: a.agent_name, summary: a.summary || a.task });
        checks.push({ name: "canonical_facts", result: pre.status, missing: pre.missing || [] });
        if (pre.status === "block") blockers.push("canonical facts missing: " + (pre.missing || []).join(", "));
      }
      const ownership = preflightDepartmentOwnership(db, a.agent_name, a.task, a.topics, files);
      checks.push({
        name: "team_operating_model",
        result: ownership.blockers.length ? "block" : "ok",
        agent_status: ownership.team.agent_status,
        active_agents: ownership.team.active_agents,
        target_departments: ownership.target_departments,
        coverage: ownership.team.department_coverage
      });
      blockers.push(...ownership.blockers);
      const writeGate = await tools.mem_write_gate_check.handler({
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        topics: a.topics || [],
        files,
        urls: a.urls || [],
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        environment: a.environment || null
      });
      checks.push({ name: "write_gate", result: writeGate.status, approval_class: writeGate.passport && writeGate.passport.approval_class || null, blockers: writeGate.blockers || [] });
      blockers.push(...(writeGate.blockers || []));
      const duplicate = await tools.mem_duplicate_work_check.handler({
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        topics: a.topics || [],
        files
      });
      checks.push({ name: "duplicate_work", result: duplicate.status, blockers: duplicate.blockers || [], warnings: duplicate.warnings || [] });
      blockers.push(...(duplicate.blockers || []));
      const impact = await tools.mem_impact_map.handler({
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        topics: a.topics || [],
        files,
        urls: a.urls || [],
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        environment: a.environment || null
      });
      checks.push({ name: "impact_map", result: "ok", summary: impact.summary || {} });
      const protectedScopes = protectedScopeCheck(db, {
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        topics: a.topics || [],
        files,
        urls: a.urls || [],
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        environment: a.environment || null,
        scope: a.scope || null
      });
      checks.push({
        name: "protected_scope",
        result: protectedScopes.status,
        matched_count: protectedScopes.matched_count,
        blockers: protectedScopes.blockers || [],
        warnings: protectedScopes.warnings || [],
        instructions: protectedScopes.instructions || []
      });
      blockers.push(...(protectedScopes.blockers || []));
      const resourceAccess = resourceAccessCheck(db, {
        agent_name: a.agent_name,
        project,
        task: a.task,
        summary: a.summary || a.task,
        action_type: a.action_type || null,
        files,
        urls: a.urls || [],
        routes: a.routes || [],
        domains: a.domains || [],
        system_names: a.system_names || [],
        resources: a.resources || [],
        scope: a.scope || null
      });
      checks.push({
        name: "resource_access",
        result: resourceAccess.status,
        resources_checked: resourceAccess.resources_checked,
        blockers: resourceAccess.blockers || [],
        warnings: resourceAccess.warnings || []
      });
      blockers.push(...(resourceAccess.blockers || []));
      const similar = [];
      const claims = [];
      for (const file of files) {
        const sim = await tools.mem_work_similar.handler({ file_path: file, project, limit: 10 });
        similar.push({ file_path: file, result: sim });
        const activeOther = (sim.similar || []).find(x => x.status === "active" && x.agent_name !== a.agent_name && x.file_path === file);
        if (activeOther) blockers.push("file already claimed by " + activeOther.agent_name + ": " + file);
        if (a.auto_claim && !activeOther) {
          claims.push(await tools.mem_work_claim.handler({ project: project || "unknown", file_path: file, agent_name: a.agent_name, summary: a.task, ttl_minutes: a.ttl_minutes || 240 }));
        }
      }
      checks.push({ name: "work_claims", files: files.length, claimed: claims.length });
      const status = blockers.length ? "block" : "ok";
      let preflightActionId = null;
      try {
        const actionInfo = db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, topic) VALUES (?, 'agent_preflight', ?, ?, ?, 'agent_preflight')")
          .run(a.agent_name, project || a.task, status, JSON.stringify({ task: a.task, files, blockers, checks }));
        preflightActionId = actionInfo.lastInsertRowid || null;
      } catch {}
      return {
        status,
        agent_name: a.agent_name,
        project,
        task: a.task,
        preflight_action_id: preflightActionId,
        blockers,
        checks,
        similar,
        claims,
        agent_loop: ["think through context", "state plan/risk", "make smallest safe change", "run verification", "store outcome"],
        hint: status === "block" ? "Resolve blockers before editing/deploying." : "Proceed, but keep claims active and hand off before stopping.",
      };
    },
  },
  mem_session_handoff: {
    description: "Mandatory session-stop handoff. Stores summary, changed files, tests, deploys, blockers, next actions, releases claimed files by default, and writes an outbound transcript row for later recall.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        project: { type: "string" },
        summary: { type: "string" },
        changed_files: { type: "array", items: { type: "string" } },
        tests: { type: "array" },
        deploys: { type: "array" },
        blockers: { type: "array" },
        next_actions: { type: "array" },
        completion_method: { type: "string" },
        rollback_plan: { type: "string" },
        release_claims: { type: "boolean" },
        completed_brief_ids: { type: "array", items: { type: "integer" } },
        completed_task_ids: { type: "array", items: { type: "integer" } },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              file_path: { type: "string" },
              server: { type: "string" },
              test_step: { type: "string" },
              result: { type: "string" },
              timestamp: { type: "string" },
              pm2: { type: "string" },
              nginx: { type: "string" },
              screenshot_path: { type: "string" },
              json_ref: { type: "string" },
              curl_ref: { type: "string" },
              browser_ref: { type: "string" },
              notes: { type: "string" }
            }
          }
        },
        meta: { type: "object" },
      },
      required: ["agent_name","summary"],
    },
    handler: async (a) => {
      ensureFirmOpsTables();
      const handoffMeta = (a.meta && typeof a.meta === "object") ? a.meta : {};
      const changed = Array.isArray(a.changed_files) ? a.changed_files : [];
      const evidence = Array.isArray(a.evidence) ? a.evidence.map((row) => Object.assign({}, row, { timestamp: row && row.timestamp || isoNow() })) : [];
      const evidenceRequired = handoffMeta.allow_legacy_no_evidence !== true;
      if (evidenceRequired && !evidence.length) {
        return { error: "evidence_required", hint: "Pass evidence=[{url|file_path|server, test_step, result, timestamp}] or set meta.allow_legacy_no_evidence=true for temporary compatibility." };
      }
      const badEvidence = evidence.find((row) => {
        const target = row && (row.url || row.file_path || row.server || row.pm2 || row.nginx || row.screenshot_path || row.json_ref || row.curl_ref || row.browser_ref);
        return !target || !row.test_step || !row.result;
      });
      if (badEvidence) {
        return { error: "invalid_evidence", hint: "Each evidence row needs one target field plus test_step and result.", sample: badEvidence };
      }
      const completionMethod = String(a.completion_method || handoffMeta.completion_method || handoffMeta.how_completed || "").trim();
      const rollbackPlan = String(a.rollback_plan || handoffMeta.rollback_plan || handoffMeta.repair_plan || "").trim();
      if (evidenceRequired && (!completionMethod || !rollbackPlan)) {
        return {
          error: "completion_protocol_required",
          hint: "Pass completion_method plus rollback_plan so later agents know exactly what changed and how to repair or revert it."
        };
      }
      const passport = await tools.mem_agent_pass_get.handler({ agent_name: a.agent_name });
      const released = [];
      if (a.release_claims !== false) {
        for (const f of changed) {
          const rel = await tools.mem_work_release.handler({ file_path: f, agent_name: a.agent_name, outcome: "handoff: " + String(a.summary).slice(0, 160) });
          if (!rel.error) released.push(rel);
        }
      }
      const storedMeta = Object.assign({}, handoffMeta, {
        identity_context: passport && passport.passport || null,
        evidence,
        evidence_count: evidence.length,
        completion_method: completionMethod || null,
        rollback_plan: rollbackPlan || null
      });
      const info = db.prepare("INSERT INTO session_handoff (agent_name, project, summary, changed_files, tests, deploys, blockers, next_actions, claims_released, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(a.agent_name, a.project || null, a.summary, JSON.stringify(changed), JSON.stringify(a.tests || []), JSON.stringify(a.deploys || []), JSON.stringify(a.blockers || []), JSON.stringify(a.next_actions || []), JSON.stringify(released), JSON.stringify(storedMeta));
      const transcript = await tools.mem_transcript_log.handler({ source: "memory-frontdoor", channel: "handoff", direction: "outbound", speaker: a.agent_name, content: a.summary, ref_kind: "session_handoff", ref_id: String(info.lastInsertRowid), meta: { project: a.project || null, changed_files: changed, tests: a.tests || [], deploys: a.deploys || [], blockers: a.blockers || [], next_actions: a.next_actions || [], evidence_count: evidence.length, completion_method: completionMethod || null, rollback_plan: rollbackPlan || null } });
      const completedBriefIds = uniqueIntegers([]
        .concat(Array.isArray(a.completed_brief_ids) ? a.completed_brief_ids : [])
        .concat(Array.isArray(handoffMeta.completed_brief_ids) ? handoffMeta.completed_brief_ids : [])
        .concat(handoffMeta.source_brief_id ? [handoffMeta.source_brief_id] : [])
        .concat(handoffMeta.brief_id ? [handoffMeta.brief_id] : []));
      const completedTaskIds = uniqueIntegers([]
        .concat(Array.isArray(a.completed_task_ids) ? a.completed_task_ids : [])
        .concat(Array.isArray(handoffMeta.completed_task_ids) ? handoffMeta.completed_task_ids : [])
        .concat(handoffMeta.autonomy_task_id ? [handoffMeta.autonomy_task_id] : []));
      const completedBriefs = [];
      for (const briefId of completedBriefIds) {
        const done = await tools.mem_brief_done.handler({
          id: briefId,
          status: "done",
          outcome: `Completed via session_handoff #${info.lastInsertRowid} by ${a.agent_name}: ${String(a.summary).slice(0, 240)}`
        }).catch(e => ({ id: briefId, error: String(e.message || e) }));
        completedBriefs.push(done);
      }
      const completedTasks = [];
      for (const taskId of completedTaskIds) {
        const done = await tools.mem_autonomy_task_update.handler({
          id: taskId,
          status: "done",
          assigned_agent: a.agent_name,
          notes: `Completed via session_handoff #${info.lastInsertRowid} by ${a.agent_name}: ${String(a.summary).slice(0, 240)}`
        }).catch(e => ({ id: taskId, error: String(e.message || e) }));
        completedTasks.push(done);
      }
      try {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, result_json, topic) VALUES (?, 'session_handoff', ?, 'done', ?, 'session_lifecycle')")
          .run(a.agent_name, a.project || "session", JSON.stringify({ handoff_id: info.lastInsertRowid, transcript_id: transcript.id || null, completed_brief_ids: completedBriefIds, completed_task_ids: completedTaskIds, evidence_count: evidence.length, identity_lane: passport && passport.passport && passport.passport.lane || null }));
      } catch {}
      return { ok: true, id: info.lastInsertRowid, transcript_id: transcript.id || null, claims_released: released, completed_briefs: completedBriefs, completed_tasks: completedTasks, agent_passport: passport, evidence_count: evidence.length };
    },
  },
  mem_work_report_feed: {
    description: "Unified report + completed-task area. Returns recent session handoffs and completed autonomy tasks in one chronological feed so agents must read what was already done before starting new work.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        agent_name: { type: "string" },
        limit: { type: "integer" },
        include_blocked: { type: "boolean" }
      }
    },
    handler: (a) => workReportFeedData(db, a || {})
  },
  mem_protected_scope_seed: {
    description: PROTECTED_SCOPE_TOOL_DEFS.mem_protected_scope_seed.description,
    inputSchema: PROTECTED_SCOPE_TOOL_DEFS.mem_protected_scope_seed.inputSchema,
    handler: (a = {}) => handleProtectedScopeTool(db, "mem_protected_scope_seed", a || {}).result,
  },
  mem_protected_scope_list: {
    description: PROTECTED_SCOPE_TOOL_DEFS.mem_protected_scope_list.description,
    inputSchema: PROTECTED_SCOPE_TOOL_DEFS.mem_protected_scope_list.inputSchema,
    handler: (a = {}) => handleProtectedScopeTool(db, "mem_protected_scope_list", a || {}).result,
  },
  mem_protected_scope_check: {
    description: PROTECTED_SCOPE_TOOL_DEFS.mem_protected_scope_check.description,
    inputSchema: PROTECTED_SCOPE_TOOL_DEFS.mem_protected_scope_check.inputSchema,
    handler: (a = {}) => handleProtectedScopeTool(db, "mem_protected_scope_check", a || {}).result,
  },
  mem_resource_upsert: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_upsert.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_upsert.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_resource_upsert", a || {}).result,
  },
  mem_resource_list: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_list.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_list.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_resource_list", a || {}).result,
  },
  mem_resource_acl_grant: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_acl_grant.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_acl_grant.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_resource_acl_grant", a || {}).result,
  },
  mem_resource_acl_list: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_acl_list.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_acl_list.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_resource_acl_list", a || {}).result,
  },
  mem_resource_access_check: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_access_check.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_access_check.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_resource_access_check", a || {}).result,
  },
  mem_approval_request: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_approval_request.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_approval_request.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_approval_request", a || {}).result,
  },
  mem_approval_decide: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_approval_decide.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_approval_decide.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_approval_decide", a || {}).result,
  },
  mem_approval_list: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_approval_list.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_approval_list.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_approval_list", a || {}).result,
  },
  mem_claim_request_access: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_request_access.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_request_access.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_claim_request_access", a || {}).result,
  },
  mem_claim_grant_access: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_grant_access.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_grant_access.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_claim_grant_access", a || {}).result,
  },
  mem_claim_deny_access: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_deny_access.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_deny_access.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_claim_deny_access", a || {}).result,
  },
  mem_claim_transfer: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_transfer.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_claim_transfer.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_claim_transfer", a || {}).result,
  },
  mem_resource_audit_list: {
    description: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_audit_list.description,
    inputSchema: RESOURCE_ACCESS_TOOL_DEFS.mem_resource_audit_list.inputSchema,
    handler: (a = {}) => handleResourceAccessTool(db, "mem_resource_audit_list", a || {}).result,
  },
  mem_work_claim: {
    description: "Claim a work scope with TTL and heartbeat. Supports file, route, domain, server, task, service, or generic scope claims. Stale claims can be recovered with allow_takeover=true.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        file_path: { type: "string" },
        claim_kind: { type: "string" },
        scope_value: { type: "string" },
        agent_name: { type: "string" },
        summary: { type: "string" },
        ttl_minutes: { type: "integer" },
        stale_after_sec: { type: "integer" },
        allow_takeover: { type: "boolean" },
        meta: { type: "object" }
      },
      required: ["project", "agent_name"]
    },
    handler: (a = {}) => handleWorkClaim(db, a || {}),
  },
  mem_work_heartbeat: {
    description: "Refresh the heartbeat for an active claim and optionally extend its TTL.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        project: { type: "string" },
        file_path: { type: "string" },
        claim_kind: { type: "string" },
        scope_value: { type: "string" },
        agent_name: { type: "string" },
        ttl_minutes: { type: "integer" }
      }
    },
    handler: (a = {}) => handleWorkHeartbeat(db, a || {}),
  },
  mem_work_heartbeat_batch: {
    description: "Refresh heartbeats for ALL active/stale claims held by an agent. Optionally filter by project and extend TTL. Use this instead of calling mem_work_heartbeat per-claim.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent whose claims to heartbeat" },
        project: { type: "string", description: "Optional project filter" },
        ttl_minutes: { type: "integer", description: "Optional new TTL to set on all claims" }
      },
      required: ["agent_name"]
    },
    handler: (a = {}) => handleWorkHeartbeatBatch(db, a || {}),
  },
  mem_work_release: {
    description: "Release a work claim by id or by scope lookup.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        project: { type: "string" },
        file_path: { type: "string" },
        claim_kind: { type: "string" },
        scope_value: { type: "string" },
        agent_name: { type: "string" },
        outcome: { type: "string" },
        status: { type: "string" }
      }
    },
    handler: (a = {}) => handleWorkRelease(db, a || {}),
  },
  mem_work_active: {
    description: "List active claims, optionally including stale ones, filtered by project, agent, kind, or exact scope.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, agent_name: { type: "string" }, claim_kind: { type: "string" }, scope_value: { type: "string" }, include_stale: { type: "boolean" }, limit: { type: "integer" } } },
    handler: (a = {}) => handleWorkActive(db, a || {}),
  },
  mem_work_similar: {
    description: "Find recent claims related to the scope you are about to claim. Supports file and non-file scope kinds.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, file_path: { type: "string" }, claim_kind: { type: "string" }, scope_value: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => handleWorkSimilar(db, a || {}),
  },
  mem_transcript_recent: {
    description: "Most recent transcripts, optionally filtered by speaker/source/channel/direction.",
    inputSchema: { type: "object", properties: { speaker: { type: "string" }, source: { type: "string" }, channel: { type: "string" }, direction: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const lim = Math.min(a.limit || 20, 200);
      const filters = [];
      const params = [];
      if (a.speaker) { filters.push("speaker = ?"); params.push(a.speaker); }
      if (a.source) { filters.push("source = ?"); params.push(a.source); }
      if (a.channel) { filters.push("channel = ?"); params.push(a.channel); }
      if (a.direction) { filters.push("direction = ?"); params.push(a.direction); }
      if (a.ref_kind) { filters.push("ref_kind = ?"); params.push(a.ref_kind); }
      if (a.ref_id) { filters.push("ref_id = ?"); params.push(String(a.ref_id)); }
      if (a.since) { filters.push("occurred_at >= ?"); params.push(String(a.since)); }
      const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
      params.push(lim);
      const rows = db.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript " + where + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, transcripts: rows };
    },
  },
  mem_capture_ingest: {
    description: "Idempotent universal-capture front door. Stores a raw receipt first, optionally promotes to transcript/memory, and writes an audit event on duplicate skips.",
    inputSchema: { type: "object", properties: { dedupe_key: { type: "string" }, source: { type: "string" }, channel: { type: "string" }, direction: { type: "string" }, actor: { type: "string" }, actor_id: { type: "string" }, speaker: { type: "string" }, event_kind: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" }, source_ref: { type: "string" }, thread_id: { type: "string" }, session_id: { type: "string" }, status: { type: "string" }, content: { type: "string" }, text: { type: "string" }, payload: { type: "object" }, meta: { type: "object" }, occurred_at: { type: "string" }, promote_transcript: { type: "boolean" }, promote_memory: { type: "boolean" }, remember: { type: "boolean" }, memory_kind: { type: "string" }, topic: { type: "string" }, importance: { type: "integer" } }, required: ["source"] },
    handler: (a) => captureIngest(a || {}),
  },
  mem_capture_ingest_batch: {
    description: "Batch version of mem_capture_ingest for historical imports. Each item remains idempotent and duplicate skips are audited.",
    inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object" } }, limit: { type: "integer" } }, required: ["items"] },
    handler: (a) => {
      const items = Array.isArray(a.items) ? a.items.slice(0, Math.min(a.limit || 500, 1000)) : [];
      if (!items.length) return { error: "items[] required" };
      const out = { count: items.length, captured: 0, duplicate: 0, errors: 0, results: [] };
      for (const item of items) {
        try {
          const r = captureIngest(item || {});
          if (r && r.duplicate) out.duplicate++;
          else if (r && r.ok) out.captured++;
          else out.errors++;
          if (out.results.length < 50) out.results.push(r);
        } catch (e) {
          out.errors++;
          if (out.results.length < 50) out.results.push({ ok: false, error: String(e.message || e) });
        }
      }
      return out;
    },
  },
  mem_capture_recent: {
    description: "List recent capture receipts from the idempotent universal-capture front door.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, channel: { type: "string" }, actor: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" }, thread_id: { type: "string" }, status: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const lim = Math.min(a.limit || 50, 500);
      const where = [];
      const params = [];
      if (a.source) { where.push("source=?"); params.push(a.source); }
      if (a.channel) { where.push("channel=?"); params.push(a.channel); }
      if (a.actor) { where.push("actor=?"); params.push(a.actor); }
      if (a.ref_kind) { where.push("ref_kind=?"); params.push(a.ref_kind); }
      if (a.ref_id) { where.push("ref_id=?"); params.push(String(a.ref_id)); }
      if (a.thread_id) { where.push("thread_id=?"); params.push(String(a.thread_id)); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      if (a.since) { where.push("occurred_at>=?"); params.push(String(a.since)); }
      params.push(lim);
      const rows = db.prepare("SELECT dedupe_key, source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, occurred_at, substr(content_preview,1,300) AS content_preview, event_id, transcript_id, memory_id, status, seen_count, last_seen_at FROM capture_receipt" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC, last_seen_at DESC LIMIT ?").all(...params);
      return { count: rows.length, receipts: rows };
    },
  },
  mem_media_capture: {
    description: "Capture a screenshot, image, document, HTML/text file, or attachment with chat/action context. Creates a canonical title/file name and optionally copies the local file into MNEMO_MEDIA_DIR.",
    inputSchema: {
      type: "object",
      properties: {
        media_path: { type: "string" },
        file_path: { type: "string" },
        file_name: { type: "string" },
        media_kind: { type: "string" },
        source: { type: "string", default: "manual" },
        channel: { type: "string", default: "chat" },
        actor: { type: "string" },
        speaker: { type: "string" },
        content: { type: "string", description: "The message/action text the media belongs to, e.g. 'Hier ein Screenshot vom Admin Design'." },
        title: { type: "string" },
        project: { type: "string" },
        page_url: { type: "string" },
        route: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        ref_kind: { type: "string" },
        ref_id: { type: "string" },
        thread_id: { type: "string" },
        occurred_at: { type: "string" },
        meta: { type: "object" }
      }
    },
    handler: (a = {}) => {
      if (!a.media_path && !a.file_path && !a.file_name) return { ok: false, error: "media_path, file_path, or file_name required" };
      return captureIngest(Object.assign({
        source: "manual",
        channel: "chat",
        event_kind: a.media_kind === "document" ? "document_capture" : "screenshot_capture",
        promote_memory: true,
        remember: true
      }, a, {
        media_path: a.media_path || a.file_path,
        content: a.content || a.text || a.notes || ""
      }));
    },
  },
  mem_media_recent: {
    description: "List recently captured screenshots, images, documents, and files with titles, labels, and source context.",
    inputSchema: { type: "object", properties: { project: { type: "string" }, media_kind: { type: "string" }, media_type: { type: "string" }, actor: { type: "string" }, channel: { type: "string" }, thread_id: { type: "string" }, limit: { type: "integer" } } },
    handler: (a = {}) => {
      ensureMediaAssetRuntimeSchema(db);
      const where = [];
      const params = [];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.media_kind) { where.push("media_kind=?"); params.push(a.media_kind); }
      if (a.media_type) { where.push("media_type=?"); params.push(a.media_type); }
      if (a.actor) { where.push("actor=?"); params.push(a.actor); }
      if (a.channel) { where.push("channel=?"); params.push(a.channel); }
      if (a.thread_id) { where.push("thread_id=?"); params.push(String(a.thread_id)); }
      params.push(Math.min(a.limit || 50, 500));
      const rows = db.prepare("SELECT id, title, media_kind, media_type, project, route, page_url, file_name, original_file_name, canonical_name, media_path, storage_path, content_ref, labels_json, actor, channel, thread_id, occurred_at, status FROM media_asset" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, media: rows.map(r => Object.assign({}, r, { labels: parseMaybeJson(r.labels_json, []) })) };
    },
  },
  mem_media_search: {
    description: "Search captured screenshots/documents/files by title, labels, file name, route, page URL, or project.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" }, media_kind: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
    handler: (a = {}) => {
      ensureMediaAssetRuntimeSchema(db);
      const q = "%" + String(a.query || "").trim() + "%";
      const where = ["(title LIKE ? OR file_name LIKE ? OR original_file_name LIKE ? OR canonical_name LIKE ? OR media_path LIKE ? OR storage_path LIKE ? OR content_ref LIKE ? OR page_url LIKE ? OR route LIKE ? OR labels_json LIKE ? OR notes LIKE ?)"];
      const params = [q, q, q, q, q, q, q, q, q, q, q];
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.media_kind) { where.push("media_kind=?"); params.push(a.media_kind); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = db.prepare("SELECT id, title, media_kind, media_type, project, route, page_url, file_name, original_file_name, canonical_name, media_path, storage_path, content_ref, labels_json, actor, channel, occurred_at, status FROM media_asset WHERE " + where.join(" AND ") + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, media: rows.map(r => Object.assign({}, r, { labels: parseMaybeJson(r.labels_json, []) })) };
    },
  },
  mem_media_get: {
    description: "Fetch one captured media asset with full metadata.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, dedupe_key: { type: "string" } } },
    handler: (a = {}) => {
      ensureMediaAssetRuntimeSchema(db);
      const row = a.id
        ? db.prepare("SELECT * FROM media_asset WHERE id=?").get(a.id)
        : (a.dedupe_key ? db.prepare("SELECT * FROM media_asset WHERE dedupe_key=?").get(String(a.dedupe_key)) : null);
      if (!row) return { error: "not found" };
      row.labels = parseMaybeJson(row.labels_json, []);
      row.meta = parseMaybeJson(row.meta_json, {});
      delete row.labels_json;
      delete row.meta_json;
      return row;
    },
  },
  mem_event_log: {
    description: "Append a raw event receipt to the universal Mnemo journal. Use for every small chat, tool, CLI, bridge, console, and handoff event that should not disappear.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, channel: { type: "string" }, direction: { type: "string" }, actor: { type: "string" }, actor_id: { type: "string" }, event_kind: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" }, thread_id: { type: "string" }, status: { type: "string" }, content: { type: "string" }, text: { type: "string" }, payload: { type: "object" }, meta: { type: "object" }, occurred_at: { type: "string" } }, required: ["event_kind"] },
    handler: (a) => {
      const result = journalEvent({
        source: a.source || "manual",
        channel: a.channel || null,
        direction: a.direction || "internal",
        actor: a.actor || a.agent_name || null,
        actor_id: a.actor_id || null,
        event_kind: a.event_kind,
        ref_kind: a.ref_kind || null,
        ref_id: a.ref_id || null,
        thread_id: a.thread_id || a.session_id || null,
        status: a.status || null,
        content: a.content || a.text || null,
        payload: a.payload || null,
        meta: a.meta || null,
        occurred_at: a.occurred_at || null
      });
      return result ? { ok: true, id: result.id } : { ok: false, error: "journal_insert_failed" };
    },
  },
  mem_event_recent: {
    description: "List raw universal journal events, filterable by source/channel/actor/kind/ref/thread.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, channel: { type: "string" }, actor: { type: "string" }, event_kind: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" }, thread_id: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const lim = Math.min(a.limit || 50, 500);
      const where = [];
      const params = [];
      if (a.source) { where.push("source=?"); params.push(a.source); }
      if (a.channel) { where.push("channel=?"); params.push(a.channel); }
      if (a.actor) { where.push("actor=?"); params.push(a.actor); }
      if (a.event_kind) { where.push("event_kind=?"); params.push(a.event_kind); }
      if (a.ref_kind) { where.push("ref_kind=?"); params.push(a.ref_kind); }
      if (a.ref_id) { where.push("ref_id=?"); params.push(String(a.ref_id)); }
      if (a.thread_id) { where.push("thread_id=?"); params.push(String(a.thread_id)); }
      if (a.since) { where.push("occurred_at>=?"); params.push(String(a.since)); }
      params.push(lim);
      const rows = db.prepare("SELECT id, source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, status, substr(content,1,500) AS content_preview, occurred_at FROM mnemo_event_journal" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY occurred_at DESC, id DESC LIMIT ?").all(...params);
      return { count: rows.length, events: rows };
    },
  },
  mem_source_coverage: {
    description: "Show which sources/channels wrote raw journal events recently, plus writer health. Use to detect gaps before claiming memory is complete.",
    inputSchema: { type: "object", properties: { since: { type: "string" } } },
    handler: (a) => {
      const since = a.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const sources = db.prepare("SELECT source, COALESCE(channel,'') AS channel, COUNT(*) AS events, MAX(occurred_at) AS last_event_at, SUM(CASE WHEN status IN ('error','exception','failed') THEN 1 ELSE 0 END) AS errors FROM mnemo_event_journal WHERE occurred_at >= ? GROUP BY source, COALESCE(channel,'') ORDER BY last_event_at DESC").all(since);
      const captures = db.prepare("SELECT source, COALESCE(channel,'') AS channel, COUNT(*) AS receipts, MAX(occurred_at) AS last_capture_at, SUM(CASE WHEN status='duplicate' THEN 1 ELSE 0 END) AS duplicates FROM capture_receipt WHERE occurred_at >= ? GROUP BY source, COALESCE(channel,'') ORDER BY last_capture_at DESC").all(since);
      const writers = db.prepare("SELECT writer, status, last_write_at, last_check_at, rows_written FROM writer_health ORDER BY writer").all();
      return { since, sources, captures, writers };
    },
  },
  mem_access_upsert: {
    description: "Create/update an access inventory entry: how to reach a server/admin/repo/API without storing raw secrets. Store secret_ref/env/key label only.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, access_kind: { type: "string" }, entrypoint: { type: "string" }, account_hint: { type: "string" }, secret_ref: { type: "string" }, allowed_agents: { type: "array", items: { type: "string" } }, status: { type: "string" }, last_verified_at: { type: "string" }, verification_method: { type: "string" }, notes: { type: "string" }, updated_by: { type: "string" }, agent_name: { type: "string" }, meta: { type: "object" } }, required: ["system_name","access_kind"] },
    handler: (a) => {
      const scope = scopeName(a.scope);
      const entrypoint = a.entrypoint || "";
      const allowed = Array.isArray(a.allowed_agents) ? JSON.stringify(a.allowed_agents) : (a.allowed_agents || null);
      const existing = db.prepare("SELECT id FROM access_inventory WHERE scope=? AND system_name=? AND access_kind=? AND COALESCE(entrypoint,'')=?").get(scope, a.system_name, a.access_kind, entrypoint);
      let id;
      if (existing) {
        id = existing.id;
        db.prepare("UPDATE access_inventory SET project=?, entrypoint=?, account_hint=?, secret_ref=?, allowed_agents=?, status=?, last_verified_at=COALESCE(?, last_verified_at), verification_method=COALESCE(?, verification_method), notes=COALESCE(?, notes), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(a.project || null, entrypoint, a.account_hint || null, a.secret_ref || null, allowed, a.status || "active", a.last_verified_at || null, a.verification_method || null, a.notes || null, a.updated_by || a.agent_name || DEFAULT_AGENT, id);
      } else {
        const info = db.prepare("INSERT INTO access_inventory (scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(scope, a.project || null, a.system_name, a.access_kind, entrypoint, a.account_hint || null, a.secret_ref || null, allowed, a.status || "active", a.last_verified_at || null, a.verification_method || null, a.notes || null, a.updated_by || a.agent_name || DEFAULT_AGENT);
        id = info.lastInsertRowid;
      }
      db.prepare("INSERT INTO access_event (access_id, event_kind, actor, status, notes, meta_json) VALUES (?,?,?,?,?,?)").run(id, existing ? "updated" : "created", a.updated_by || a.agent_name || DEFAULT_AGENT, a.status || "active", a.notes || null, a.meta ? JSON.stringify(a.meta) : null);
      return { ok: true, id, status: existing ? "updated" : "created", secret_stored: false, secret_ref: a.secret_ref || null };
    },
  },
  mem_access_list: {
    description: "List access inventory entries. This returns entrypoints and secret references, never raw secrets.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, access_kind: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const where = [];
      const params = [];
      if (a.scope) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(scopeName(a.scope)); }
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name LIKE ?"); params.push("%" + a.system_name + "%"); }
      if (a.access_kind) { where.push("access_kind=?"); params.push(a.access_kind); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 50, 200));
      const rows = db.prepare("SELECT id, scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at FROM access_inventory" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY COALESCE(last_verified_at, updated_at) DESC LIMIT ?").all(...params);
      return { count: rows.length, access: rows };
    },
  },
  mem_access_guide: {
    description: "Render the fixed access point for a project or system: where it lives, how to reach it, which host/domain/repo/process it uses, and which secret reference unlocks it. This is the front door humans and agents should read before asking how to get somewhere.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, system_name: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const where = [];
      const params = [];
      const sc = a.scope ? scopeName(a.scope) : null;
      if (sc) { where.push("LOWER(COALESCE(scope,''))=?"); params.push(sc); }
      if (a.project) { where.push("project=?"); params.push(a.project); }
      if (a.system_name) { where.push("system_name LIKE ?"); params.push("%" + a.system_name + "%"); }
      if (a.status) { where.push("status=?"); params.push(a.status); }
      params.push(Math.min(a.limit || 100, 300));
      const rows = db.prepare(
        "SELECT id, scope, project, system_name, access_kind, entrypoint, account_hint, secret_ref, allowed_agents, status, last_verified_at, verification_method, notes, updated_by, updated_at " +
        "FROM access_inventory" + (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY COALESCE(project,''), system_name, access_kind, COALESCE(last_verified_at, updated_at) DESC LIMIT ?"
      ).all(...params);
      const projectNames = Array.from(new Set(rows.map((row) => row.project).filter(Boolean)));
      const registry = {};
      if (a.project) {
        const row = db.prepare("SELECT name, domain, repo, server, pm2_processes, nginx_files, admin_url, auth_system, live_status, live_url, staging_url, updated_at, updated_by FROM project_registry WHERE name=?").get(a.project);
        if (row) {
          for (const key of ["pm2_processes", "nginx_files"]) {
            try { row[key] = row[key] ? JSON.parse(row[key]) : []; } catch { row[key] = []; }
          }
          registry[a.project] = row;
        }
      } else if (projectNames.length) {
        const placeholders = projectNames.map(() => "?").join(",");
        const regRows = db.prepare(
          "SELECT name, domain, repo, server, pm2_processes, nginx_files, admin_url, auth_system, live_status, live_url, staging_url, updated_at, updated_by FROM project_registry WHERE name IN (" + placeholders + ")"
        ).all(...projectNames);
        for (const row of regRows) {
          for (const key of ["pm2_processes", "nginx_files"]) {
            try { row[key] = row[key] ? JSON.parse(row[key]) : []; } catch { row[key] = []; }
          }
          registry[row.name] = row;
        }
      }
      const systems = [];
      const grouped = new Map();
      for (const row of rows) {
        const allowedAgents = (() => {
          try { return row.allowed_agents ? JSON.parse(row.allowed_agents) : []; } catch { return row.allowed_agents ? [row.allowed_agents] : []; }
        })();
        const key = `${row.project || "_"}::${row.system_name}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            project: row.project || null,
            system_name: row.system_name,
            status: row.status,
            last_verified_at: row.last_verified_at || null,
            notes: row.notes || null,
            routes: [],
          });
        }
        grouped.get(key).routes.push({
          access_id: row.id,
          access_kind: row.access_kind,
          entrypoint: row.entrypoint,
          account_hint: row.account_hint,
          secret_ref: row.secret_ref,
          allowed_agents: allowedAgents,
          status: row.status,
          last_verified_at: row.last_verified_at || null,
          verification_method: row.verification_method || null,
          notes: row.notes || null,
          updated_by: row.updated_by,
          updated_at: row.updated_at,
        });
      }
      systems.push(...grouped.values());
      const lines = [];
      lines.push("# Access Guide");
      if (a.project) lines.push(`Project: ${a.project}`);
      if (a.system_name) lines.push(`System search: ${a.system_name}`);
      if (a.status) lines.push(`Status filter: ${a.status}`);
      lines.push("");
      if (a.project && registry[a.project]) {
        const reg = registry[a.project];
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
            route.entrypoint ? `entrypoint=${route.entrypoint}` : null,
            route.account_hint ? `account=${route.account_hint}` : null,
            route.secret_ref ? `secret_ref=${route.secret_ref}` : null,
            route.verification_method ? `verify=${route.verification_method}` : null,
            route.allowed_agents && route.allowed_agents.length ? `agents=${route.allowed_agents.join(",")}` : null,
          ].filter(Boolean);
          lines.push(`- ${parts.join(" | ")}`);
        }
        lines.push("");
      }
      if (systems.length === 0) lines.push("_No access routes found. Add them with mem_access_upsert._");
      return {
        count: rows.length,
        systems,
        registry,
        guide_markdown: lines.join("\n"),
      };
    },
  },
  mem_access_event_log: {
    description: "Append a verification/use/failure/note event to an access inventory entry.",
    inputSchema: { type: "object", properties: { access_id: { type: "integer" }, system_name: { type: "string" }, access_kind: { type: "string" }, event_kind: { type: "string" }, actor: { type: "string" }, agent_name: { type: "string" }, status: { type: "string" }, notes: { type: "string" }, verification_method: { type: "string" }, meta: { type: "object" } } },
    handler: (a) => {
      let id = a.access_id || null;
      if (!id && a.system_name && a.access_kind) {
        const row = db.prepare("SELECT id FROM access_inventory WHERE system_name=? AND access_kind=? ORDER BY updated_at DESC LIMIT 1").get(a.system_name, a.access_kind);
        if (row) id = row.id;
      }
      if (!id) return { error: "access_id or system_name + access_kind required" };
      db.prepare("INSERT INTO access_event (access_id, event_kind, actor, status, notes, meta_json) VALUES (?,?,?,?,?,?)").run(id, a.event_kind || "note", a.actor || a.agent_name || DEFAULT_AGENT, a.status || null, a.notes || null, a.meta ? JSON.stringify(a.meta) : null);
      if (a.event_kind === "verified") {
        db.prepare("UPDATE access_inventory SET last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), verification_method=COALESCE(?, verification_method), status=COALESCE(?, status), updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(a.verification_method || null, a.status || "active", a.actor || a.agent_name || DEFAULT_AGENT, id);
      }
      return { ok: true, access_id: id };
    },
  },
};

// ---------------------------------------------------------------------------
// MCP stdio protocol — minimal JSON-RPC 2.0
// ---------------------------------------------------------------------------
for (const [name, def] of Object.entries(CODE_READ_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => handleCodeReadTool(name, args || {}),
  });
}

for (const [name, def] of Object.entries(CONTEXT_PREVIEW_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleContextPreviewTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown context preview tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(LOOP_DOCTOR_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleLoopDoctorTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown loop doctor tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(TIMELINE_REPORT_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleTimelineReportTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown timeline report tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(TEAM_QUALITY_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => callTeamQualityTool(name, args || {}),
  });
}

for (const [name, def] of Object.entries(AGENT_MAIL_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleAgentMailTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown agent mail tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(ACCESS_ROUTE_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleAccessRouteTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown access route tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(RUNTIME_GOVERNANCE_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const input = args || {};
      if (name === "mem_runtime_tool_receipt_start") {
        let preflight = null;
        if (input.preflight_required !== false) {
          preflight = await tools.mem_agent_preflight.handler({
            agent_name: input.agent_name,
            project: input.project || null,
            task: input.task || input.summary || `runtime toolrun ${input.tool_name || "tool"}`,
            summary: input.summary || input.task || `runtime toolrun ${input.tool_name || "tool"}`,
            action_type: input.action_type || null,
            files: input.files || [],
            urls: input.urls || [],
            routes: input.routes || [],
            domains: input.domains || [],
            system_names: input.system_names || [],
            resources: input.resources || [],
            scope: input.scope || null,
            topics: input.topics || [],
            environment: input.environment || null,
            token_id: input.token_id || null,
            capability_token_id: input.capability_token_id || null,
            work_order_id: input.work_order_id || null,
            tool_name: input.tool_name || null,
            approval_ids: input.approval_ids || [],
            require_project_rules: input.require_project_rules,
            block_on_high_findings: input.block_on_high_findings,
            auto_claim: input.auto_claim,
            ttl_minutes: input.ttl_minutes,
          });
        }
        return runtimeToolReceiptStart(db, input, { preflight });
      }
      const handled = handleRuntimeGovernanceTool(db, name, input);
      if (!handled.handled) throw new Error("unknown runtime governance tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(MEMORY_CONSOLIDATION_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleMemoryConsolidationTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown memory consolidation tool: " + name);
      return handled.result;
    },
  });
}

for (const [name, def] of Object.entries(AGENT_GOVERNANCE_TOOL_DEFS)) {
  tools[name] = Object.assign({}, def, {
    handler: async (args) => {
      const handled = handleAgentGovernanceTool(db, name, args || {});
      if (!handled.handled) throw new Error("unknown agent governance tool: " + name);
      return handled.result;
    },
  });
}

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function makeError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function listTools() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); }
  catch (e) { return sendMessage(makeError(null, -32700, "parse error")); }

  const { id, method, params } = req;
  let activeToolCall = null;
  try {
    if (method === "initialize") {
      return sendMessage(makeResult(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      }));
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      return sendMessage(makeResult(id, { tools: listTools() }));
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      if (!tools[name]) return sendMessage(makeError(id, -32601, "tool not found: " + name));
      const callStarted = new Date().toISOString();
      activeToolCall = { id, name, args: args || {}, callStarted };
      journalEvent({
        source: "mcp-tool",
        channel: name,
        direction: "inbound",
        actor: args && (args.agent_name || args.source_agent || args.actor) || null,
        event_kind: "tool_call",
        status: "started",
        content: args && (args.content || args.text || args.summary || args.question || args.target) || null,
        payload: args || {},
        meta: { request_id: id, routed: shouldUseHubPrimary(name) ? "hub-primary" : "local" },
        occurred_at: callStarted
      });
      if (shouldUseHubPrimary(name)) {
        try {
          const result = await callHub(name, args || {});
          const routed = result && typeof result === "object" && !Array.isArray(result)
            ? Object.assign({ _routed: "hub-primary" }, result)
            : { _routed: "hub-primary", result };
          journalEvent({
            source: "mcp-tool",
            channel: name,
            direction: "outbound",
            actor: args && (args.agent_name || args.source_agent || args.actor) || null,
            event_kind: "tool_result",
            status: routed && routed.error ? "error" : "ok",
            ref_kind: routed && routed.id ? name : null,
            ref_id: routed && routed.id ? routed.id : null,
            content: routed && (routed.content || routed.text || routed.summary || routed.outcome) || null,
            payload: routed,
            meta: { request_id: id, routed: "hub-primary", latency_ms: Date.now() - Date.parse(callStarted) }
          });
          return sendMessage(makeResult(id, {
            content: [{ type: "text", text: JSON.stringify(routed, null, 2) }],
          }));
        } catch (e) {
          journalEvent({
            source: "mcp-tool",
            channel: name,
            direction: "outbound",
            actor: args && (args.agent_name || args.source_agent || args.actor) || null,
            event_kind: "tool_result",
            status: "exception",
            content: String(e.message || e),
            meta: { request_id: id, routed: "hub-primary", latency_ms: Date.now() - Date.parse(callStarted) }
          });
          if (HUB_PRIMARY_STRICT) throw e;
        }
      }
      const result = await tools[name].handler(args || {});
      journalEvent({
        source: "mcp-tool",
        channel: name,
        direction: "outbound",
        actor: args && (args.agent_name || args.source_agent || args.actor) || null,
        event_kind: "tool_result",
        status: result && result.error ? "error" : "ok",
        ref_kind: result && result.id ? name : null,
        ref_id: result && result.id ? result.id : null,
        content: result && (result.content || result.text || result.summary || result.outcome) || null,
        payload: result,
        meta: { request_id: id, routed: "local", latency_ms: Date.now() - Date.parse(callStarted) }
      });
      return sendMessage(makeResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }));
    }
    return sendMessage(makeError(id, -32601, "method not found: " + method));
  } catch (e) {
    if (activeToolCall) {
      const { id: callId, name, args, callStarted } = activeToolCall;
      journalEvent({
        source: "mcp-tool",
        channel: name,
        direction: "outbound",
        actor: args && (args.agent_name || args.source_agent || args.actor) || null,
        event_kind: "tool_result",
        status: "exception",
        content: String(e.message || e),
        meta: { request_id: callId, routed: shouldUseHubPrimary(name) ? "hub-primary-or-local" : "local", latency_ms: Date.now() - Date.parse(callStarted) }
      });
    }
    return sendMessage(makeError(id, -32000, String(e.message || e)));
  }
});

function gracefulShutdown(signal) {
  console.error(`[mnemo-mcp] ${signal} received, shutting down…`);
  rl.close();
  try { db.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[mnemo-mcp] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[mnemo-mcp] uncaughtException:", err);
  gracefulShutdown("uncaughtException");
});
