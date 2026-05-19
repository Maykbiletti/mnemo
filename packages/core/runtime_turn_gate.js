"use strict";

const crypto = require("crypto");
const {
  boolFlag,
  cleanScope,
  compactContent,
  jsonSafe,
  normalizeAgentName,
  parseMaybeJson,
} = require("./shared_utils");
const { runtimePolicyCheck } = require("./runtime_governance");

const DEFAULT_SCOPE = "default";

function nowIso() {
  return new Date().toISOString();
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function normalizeRuntimeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "runtime";
}

function normalizePart(value, fallback = "*") {
  const raw = String(value == null ? "" : value).trim();
  if (!raw || raw === "*") return fallback;
  return raw.toLowerCase();
}

function intFlag(value, fallback, min = 0, max = 1000000) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function safeJson(value, fallback) {
  if (value === undefined) return JSON.stringify(fallback);
  return jsonSafe(value, 50000) || JSON.stringify(fallback);
}

function parseJson(value, fallback) {
  return parseMaybeJson(value, fallback);
}

function ensureRuntimeTurnSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS runtime_turn_state (
  scope TEXT NOT NULL DEFAULT 'default',
  turn_key TEXT NOT NULL,
  runtime_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  channel TEXT,
  project TEXT,
  board TEXT,
  thread_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  message_count_since_full_sync INTEGER NOT NULL DEFAULT 0,
  last_message_capture_at TEXT,
  last_recall_at TEXT,
  last_brief_pull_at TEXT,
  last_project_board_at TEXT,
  last_chat_sync_at TEXT,
  last_memory_update_at TEXT,
  last_full_sync_at TEXT,
  last_audit_id INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope, turn_key)
);
CREATE INDEX IF NOT EXISTS idx_runtime_turn_state_agent ON runtime_turn_state(agent_name, project, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_turn_state_runtime ON runtime_turn_state(runtime_name, channel, updated_at DESC);
`);
}

function inferBoard(input = {}) {
  const explicit = String(input.board || input.project_board || "").trim();
  if (explicit) return explicit;
  const project = String(input.project || "").toLowerCase();
  if (project.includes("wizard2")) return "wizard2-bridge";
  return "";
}

function inferThreadId(input = {}) {
  return String(
    input.thread_id ||
    input.session_id ||
    input.session_key ||
    input.conversation_id ||
    input.chat_id ||
    (input.meta && (input.meta.thread_id || input.meta.session_id || input.meta.chat_id)) ||
    "default"
  ).trim() || "default";
}

function buildTurnKey(input = {}) {
  const explicit = String(input.turn_key || input.runtime_turn_key || "").trim();
  if (explicit) return explicit.toLowerCase();
  const scope = scopeName(input.scope);
  const runtime = normalizeRuntimeName(input.runtime_name || input.runtime || input.adapter || "external");
  const agent = normalizeAgentName(input.agent_name || input.agent || "agent") || "agent";
  const channel = normalizePart(input.channel || "runtime");
  const project = normalizePart(input.project || "");
  const thread = inferThreadId(input);
  return sha([scope, runtime, agent, channel, project, thread].join("|")).slice(0, 32);
}

function stateFromRow(row) {
  if (!row) return null;
  return Object.assign({}, row, {
    message_count: Number(row.message_count || 0),
    message_count_since_full_sync: Number(row.message_count_since_full_sync || 0),
    meta: parseJson(row.meta_json, {}),
  });
}

function upsertTurnState(db, input = {}, updates = {}) {
  ensureRuntimeTurnSchema(db);
  const scope = scopeName(input.scope);
  const turnKey = buildTurnKey(input);
  const runtime = normalizeRuntimeName(input.runtime_name || input.runtime || input.adapter || "external");
  const agent = normalizeAgentName(input.agent_name || input.agent || "agent") || "agent";
  const channel = input.channel || "runtime";
  const project = input.project || null;
  const board = inferBoard(input) || null;
  const threadId = inferThreadId(input);
  const current = stateFromRow(db.prepare("SELECT * FROM runtime_turn_state WHERE scope=? AND turn_key=?").get(scope, turnKey));
  const meta = Object.assign({}, current && current.meta || {}, input.meta || {}, updates.meta || {});
  const next = {
    message_count: current ? current.message_count + (updates.increment === false ? 0 : 1) : (updates.increment === false ? 0 : 1),
    message_count_since_full_sync: current ? current.message_count_since_full_sync + (updates.increment === false ? 0 : 1) : (updates.increment === false ? 0 : 1),
    last_message_capture_at: updates.last_message_capture_at || (current && current.last_message_capture_at) || null,
    last_recall_at: updates.last_recall_at || (current && current.last_recall_at) || null,
    last_brief_pull_at: updates.last_brief_pull_at || (current && current.last_brief_pull_at) || null,
    last_project_board_at: updates.last_project_board_at || (current && current.last_project_board_at) || null,
    last_chat_sync_at: updates.last_chat_sync_at || (current && current.last_chat_sync_at) || null,
    last_memory_update_at: updates.last_memory_update_at || (current && current.last_memory_update_at) || null,
    last_full_sync_at: updates.last_full_sync_at || (current && current.last_full_sync_at) || null,
    last_audit_id: updates.last_audit_id || (current && current.last_audit_id) || null,
  };
  if (updates.reset_full_sync_counter) next.message_count_since_full_sync = 0;
  db.prepare(`
INSERT INTO runtime_turn_state
  (scope, turn_key, runtime_name, agent_name, channel, project, board, thread_id, message_count, message_count_since_full_sync, last_message_capture_at, last_recall_at, last_brief_pull_at, last_project_board_at, last_chat_sync_at, last_memory_update_at, last_full_sync_at, last_audit_id, meta_json)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(scope, turn_key) DO UPDATE SET
  runtime_name=excluded.runtime_name,
  agent_name=excluded.agent_name,
  channel=excluded.channel,
  project=excluded.project,
  board=COALESCE(excluded.board, runtime_turn_state.board),
  thread_id=excluded.thread_id,
  message_count=excluded.message_count,
  message_count_since_full_sync=excluded.message_count_since_full_sync,
  last_message_capture_at=COALESCE(excluded.last_message_capture_at, runtime_turn_state.last_message_capture_at),
  last_recall_at=COALESCE(excluded.last_recall_at, runtime_turn_state.last_recall_at),
  last_brief_pull_at=COALESCE(excluded.last_brief_pull_at, runtime_turn_state.last_brief_pull_at),
  last_project_board_at=COALESCE(excluded.last_project_board_at, runtime_turn_state.last_project_board_at),
  last_chat_sync_at=COALESCE(excluded.last_chat_sync_at, runtime_turn_state.last_chat_sync_at),
  last_memory_update_at=COALESCE(excluded.last_memory_update_at, runtime_turn_state.last_memory_update_at),
  last_full_sync_at=COALESCE(excluded.last_full_sync_at, runtime_turn_state.last_full_sync_at),
  last_audit_id=COALESCE(excluded.last_audit_id, runtime_turn_state.last_audit_id),
  meta_json=excluded.meta_json,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
`).run(
    scope,
    turnKey,
    runtime,
    agent,
    channel,
    project,
    board,
    threadId,
    next.message_count,
    next.message_count_since_full_sync,
    next.last_message_capture_at,
    next.last_recall_at,
    next.last_brief_pull_at,
    next.last_project_board_at,
    next.last_chat_sync_at,
    next.last_memory_update_at,
    next.last_full_sync_at,
    next.last_audit_id,
    safeJson(meta, {})
  );
  return stateFromRow(db.prepare("SELECT * FROM runtime_turn_state WHERE scope=? AND turn_key=?").get(scope, turnKey));
}

function checkInputFromState(input = {}, state = {}, extra = {}) {
  return {
    scope: input.scope,
    runtime_name: state.runtime_name || input.runtime_name || input.runtime || input.adapter || "external",
    agent_name: state.agent_name || input.agent_name || input.agent || "agent",
    channel: state.channel || input.channel || "runtime",
    project: state.project || input.project || null,
    board: state.board || inferBoard(input) || input.board || input.project_board || null,
    project_board: state.board || inferBoard(input) || input.board || input.project_board || null,
    message_count_since_full_sync: state.message_count_since_full_sync || 0,
    turn_number: state.message_count || 0,
    has_brief_pull: !!state.last_brief_pull_at,
    has_recall: !!state.last_recall_at || !!extra.recall_ok,
    has_project_board: !!state.last_project_board_at,
    has_chat_sync: !!state.last_chat_sync_at || !!extra.capture_ok,
    has_memory_update: !!state.last_memory_update_at || !!extra.capture_ok,
    has_message_capture: !!state.last_message_capture_at || !!extra.capture_ok,
    brief_pull_at: state.last_brief_pull_at,
    recall_at: state.last_recall_at,
    project_board_at: state.last_project_board_at,
    chat_sync_at: state.last_chat_sync_at,
    memory_update_at: state.last_memory_update_at,
    message_capture_at: state.last_message_capture_at,
    message_ref: input.message_ref || input.ref_id || input.message_id || null,
    session_key: input.session_key || input.session_id || input.thread_id || null,
    meta: Object.assign({}, input.meta || {}, { runtime_turn_key: state.turn_key }),
  };
}

function shouldUseTelegramEnvelope(input = {}) {
  if (input.ref_kind === "telegram_message" || input.telegram === true) return true;
  const meta = input.meta || {};
  return !!(input.chat_id || meta.chat_id);
}

function capturePayload(input = {}, state = {}) {
  const metaInput = input.meta || {};
  const telegram = shouldUseTelegramEnvelope(input);
  const messageId = input.message_id || metaInput.message_id || input.ref_id || null;
  const refId = input.ref_id || messageId || `${state.turn_key}:${state.message_count || 1}`;
  const source = input.source || `runtime:${state.runtime_name || normalizeRuntimeName(input.runtime_name || input.runtime || input.adapter || "external")}`;
  const content = compactContent(input.content !== undefined ? input.content : (input.text !== undefined ? input.text : input.message), input.max_content_chars || 12000) || "";
  const meta = Object.assign({}, metaInput, {
    runtime_name: state.runtime_name,
    agent_name: state.agent_name,
    project: state.project || input.project || null,
    board: state.board || inferBoard(input) || null,
    runtime_turn_key: state.turn_key,
    turn_number: state.message_count,
  });
  if (input.chat_id && !meta.chat_id) meta.chat_id = input.chat_id;
  if (messageId && !meta.message_id) meta.message_id = messageId;
  return {
    source,
    channel: state.channel || input.channel || "runtime",
    direction: input.direction || "inbound",
    actor: input.actor || input.speaker || input.user || input.user_name || "user",
    actor_id: input.actor_id || input.user_id || meta.actor_id || meta.user_id || null,
    event_kind: input.event_kind || "runtime_message",
    ref_kind: telegram ? "telegram_message" : (input.ref_kind || "runtime_message"),
    ref_id: String(refId),
    source_ref: input.source_ref || `${source}:${refId}`,
    thread_id: state.thread_id || inferThreadId(input),
    occurred_at: input.occurred_at || nowIso(),
    content,
    promote_transcript: input.promote_transcript !== false,
    promote_memory: input.promote_memory !== false,
    remember: input.remember !== false,
    importance: input.importance != null ? input.importance : 4,
    meta,
  };
}

function compactRows(rows, limit = 5) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit).map((row) => ({
    surface: row.surface || row.kind || null,
    ref_id: row.ref_id || row.id || null,
    actor: row.actor || row.agent_name || null,
    topic: row.topic || row.kind || null,
    occurred_at: row.occurred_at || null,
    preview: compactContent(row.preview || row.text || row.content || "", 240),
  }));
}

function makeContextBlock(result = {}) {
  const lines = [
    "[Mnemo Runtime Turn]",
    `status: ${result.status || (result.ok ? "ok" : "error")}`,
    `allowed: ${result.allowed ? "yes" : "no"}`,
    `runtime: ${result.runtime_name || ""}`,
    `agent: ${result.agent_name || ""}`,
    `project: ${result.project || ""}`,
    `turn_key: ${result.turn_key || ""}`,
    `message_captured: ${result.capture && result.capture.ok ? "yes" : "no"}`,
    `memory_checked: ${result.recall && result.recall.ok ? "yes" : "no"}`,
    `full_sync: ${result.full_sync_ran ? "yes" : "no"}`,
    `audit_id: ${result.audit_id || ""}`,
  ];
  if (result.warning_token) lines.push(`warning: ${result.warning_token}`);
  if (result.blockers && result.blockers.length) lines.push(`blockers: ${result.blockers.join("; ")}`);
  if (result.next_actions && result.next_actions.length) lines.push(`next_actions: ${result.next_actions.join("; ")}`);
  lines.push("[/Mnemo Runtime Turn]");
  return lines.join("\n");
}

function runtimeTurnBegin(db, input = {}, ops = {}) {
  ensureRuntimeTurnSchema(db);
  const content = compactContent(input.content !== undefined ? input.content : (input.text !== undefined ? input.text : input.message), input.max_content_chars || 12000) || "";
  if (!content && !boolFlag(input.has_media, false)) return { ok: false, allowed: false, status: "error", error: "content/text/message required" };

  let state = upsertTurnState(db, input, { meta: { last_input_ref: input.message_ref || input.ref_id || input.message_id || null } });
  const now = nowIso();

  let capture = { ok: false, error: "capture op missing" };
  if (typeof ops.capture === "function") {
    try { capture = ops.capture(capturePayload(input, state)); }
    catch (e) { capture = { ok: false, error: String(e.message || e) }; }
  }
  if (capture && capture.ok) {
    state = upsertTurnState(db, input, {
      increment: false,
      last_message_capture_at: now,
      last_chat_sync_at: now,
      last_memory_update_at: now,
      meta: { last_capture_status: capture.status || "ok", last_capture_id: capture.event_id || capture.memory_id || null },
    });
  }

  let recallRows = [];
  let recall = { ok: false, error: "recall op missing", count: 0, rows: [] };
  if (typeof ops.recall === "function") {
    try {
      recallRows = ops.recall({
        query: input.recall_query || content,
        limit: intFlag(input.recall_limit, 8, 1, 50),
        mode: input.recall_mode || "hybrid",
        include_journal: input.include_journal !== false,
        actor: input.recall_actor || null,
      }) || [];
      recall = { ok: true, count: Array.isArray(recallRows) ? recallRows.length : 0, rows: compactRows(recallRows, 6) };
    } catch (e) {
      recall = { ok: false, error: String(e.message || e), count: 0, rows: [] };
    }
  }
  if (recall.ok) {
    state = upsertTurnState(db, input, {
      increment: false,
      last_recall_at: now,
      meta: { last_recall_count: recall.count },
    });
  }

  const preliminary = runtimePolicyCheck(db, checkInputFromState(input, state, { capture_ok: capture && capture.ok, recall_ok: recall.ok }));
  const required = new Set(preliminary.required_actions || []);
  const missingRequirements = new Set((preliminary.missing_context || []).map((entry) => entry.requirement));
  const fullSyncDue = !!preliminary.full_sync_due || missingRequirements.has("full_sync_every_messages");
  const fullSync = { ran: false };
  const actionErrors = [];

  if (typeof ops.briefPull === "function" && (required.has("mem_brief_pull") || missingRequirements.has("mem_brief_pull") || fullSyncDue)) {
    try {
      fullSync.brief_pull = ops.briefPull({
        agent_name: state.agent_name,
        limit: intFlag(input.brief_limit, 20, 1, 100),
        peek: input.brief_peek !== false,
      });
      fullSync.ran = true;
      state = upsertTurnState(db, input, { increment: false, last_brief_pull_at: now });
    } catch (e) {
      actionErrors.push("brief_pull: " + String(e.message || e));
      fullSync.brief_pull = { ok: false, error: String(e.message || e) };
    }
  }

  if (typeof ops.projectBoard === "function" && (required.has("mem_project_board") || missingRequirements.has("mem_project_board") || fullSyncDue)) {
    try {
      fullSync.project_board = ops.projectBoard({
        project: state.project || input.project || "default",
        name: state.board || inferBoard(input) || undefined,
        include_done: false,
        include_ingested_briefs: true,
        limit: intFlag(input.board_limit, 20, 1, 100),
      });
      fullSync.ran = true;
      state = upsertTurnState(db, input, { increment: false, last_project_board_at: now });
    } catch (e) {
      actionErrors.push("project_board: " + String(e.message || e));
      fullSync.project_board = { ok: false, error: String(e.message || e) };
    }
  }

  if (typeof ops.eventLog === "function" && (fullSyncDue || fullSync.ran)) {
    try {
      const event = ops.eventLog({
        source: "runtime_turn_gate",
        channel: state.channel,
        direction: "internal",
        actor: state.agent_name,
        event_kind: fullSyncDue ? "runtime_full_sync" : "runtime_context_sync",
        ref_kind: "runtime_turn_state",
        ref_id: state.turn_key,
        thread_id: state.thread_id,
        status: actionErrors.length ? "error" : "ok",
        content: `runtime turn sync for ${state.agent_name} ${state.project || ""}`.trim(),
        payload: {
          message_count: state.message_count,
          message_count_since_full_sync: state.message_count_since_full_sync,
          capture_ok: !!(capture && capture.ok),
          recall_count: recall.count,
          brief_count: fullSync.brief_pull && fullSync.brief_pull.count,
        },
        meta: { errors: actionErrors, runtime_name: state.runtime_name, board: state.board },
      });
      fullSync.event_log = event;
      if (fullSyncDue && !actionErrors.length) {
        state = upsertTurnState(db, input, {
          increment: false,
          reset_full_sync_counter: true,
          last_full_sync_at: now,
          meta: { last_full_sync_event_id: event && event.id || null },
        });
      }
    } catch (e) {
      actionErrors.push("event_log: " + String(e.message || e));
      fullSync.event_log = { ok: false, error: String(e.message || e) };
    }
  }

  const finalCheck = runtimePolicyCheck(db, Object.assign(
    {},
    checkInputFromState(input, state, { capture_ok: capture && capture.ok, recall_ok: recall.ok }),
    { has_full_sync: fullSyncDue && fullSync.ran && !actionErrors.length }
  ));
  state = upsertTurnState(db, input, {
    increment: false,
    last_audit_id: finalCheck.audit_id || null,
    meta: { last_policy_status: finalCheck.status },
  });

  const result = {
    ok: finalCheck.allowed && actionErrors.length === 0,
    allowed: finalCheck.allowed && actionErrors.length === 0,
    response_allowed: finalCheck.response_allowed && actionErrors.length === 0,
    status: actionErrors.length ? "error" : finalCheck.status,
    runtime_name: state.runtime_name,
    agent_name: state.agent_name,
    channel: state.channel,
    project: state.project,
    board: state.board,
    turn_key: state.turn_key,
    thread_id: state.thread_id,
    message_count: state.message_count,
    message_count_since_full_sync: state.message_count_since_full_sync,
    audit_id: finalCheck.audit_id,
    warning_token: finalCheck.warning_token || null,
    blockers: actionErrors.concat((finalCheck.missing_context || []).map((entry) => entry.reason || entry.requirement)),
    next_actions: finalCheck.required_actions || [],
    capture,
    recall,
    full_sync_ran: !!(fullSync.ran || fullSyncDue),
    full_sync_due: fullSyncDue,
    full_sync: {
      brief_pull_count: fullSync.brief_pull && fullSync.brief_pull.count || 0,
      project_board_loaded: !!fullSync.project_board && !fullSync.project_board.error,
      event_log_id: fullSync.event_log && fullSync.event_log.id || null,
    },
    policy_check: finalCheck,
  };
  result.context_block = makeContextBlock(result);
  return result;
}

const RUNTIME_TURN_TOOL_DEFS = {
  mem_runtime_turn_begin: {
    description: "Runtime-neutral pre-answer gate for CodexLink, Claude/aigramm, and portal chat: capture the inbound message, recall memory, refresh briefs/project board as required, run the every-N-message full sync, and return an allow/block context block before the agent may answer.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        runtime_name: { type: "string" },
        runtime: { type: "string" },
        adapter: { type: "string" },
        agent_name: { type: "string" },
        agent: { type: "string" },
        channel: { type: "string" },
        project: { type: "string" },
        board: { type: "string" },
        project_board: { type: "string" },
        thread_id: { type: "string" },
        session_id: { type: "string" },
        session_key: { type: "string" },
        conversation_id: { type: "string" },
        chat_id: { type: "string" },
        message_id: { type: "string" },
        message_ref: { type: "string" },
        ref_kind: { type: "string" },
        ref_id: { type: "string" },
        source: { type: "string" },
        source_ref: { type: "string" },
        direction: { type: "string" },
        actor: { type: "string" },
        speaker: { type: "string" },
        user: { type: "string" },
        user_name: { type: "string" },
        actor_id: { type: "string" },
        user_id: { type: "string" },
        content: { type: "string" },
        text: { type: "string" },
        message: { type: "string" },
        recall_query: { type: "string" },
        recall_limit: { type: "integer" },
        brief_limit: { type: "integer" },
        board_limit: { type: "integer" },
        promote_memory: { type: "boolean" },
        promote_transcript: { type: "boolean" },
        remember: { type: "boolean" },
        telegram: { type: "boolean" },
        meta: { type: "object" },
      },
      required: ["agent_name"],
    },
  },
};

module.exports = {
  RUNTIME_TURN_TOOL_DEFS,
  ensureRuntimeTurnSchema,
  runtimeTurnBegin,
  buildTurnKey,
};
