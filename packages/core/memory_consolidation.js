"use strict";

const crypto = require("crypto");
const {
  cleanScope,
  compactContent,
  freshnessFromAgeDays,
  isoAgeDays,
  jsonSafe,
  normalizeAgentName,
  parseMaybeJson,
  uniqueStrings,
} = require("./shared_utils");

const DEFAULT_SCOPE = "default";
const PHASES = new Set(["light", "daily", "deep", "rem"]);
const DREAM_BUCKET_KEYS = ["wrong_made", "right_made", "praise_received", "called_out", "broke_things"];

function nowIso() {
  return new Date().toISOString();
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function scopeName(scope) {
  return cleanScope(scope || DEFAULT_SCOPE);
}

function normalizeDepartment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function textOrNull(value, max = 8000) {
  const compact = compactContent(value, max);
  return compact && compact.trim() ? compact : null;
}

function listInput(value) {
  if (Array.isArray(value)) return uniqueStrings(value);
  const parsed = parseMaybeJson(value, null);
  if (Array.isArray(parsed)) return uniqueStrings(parsed);
  return uniqueStrings(String(value || "").split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean));
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function tableExists(db, tableName) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(tableName);
  } catch {
    return false;
  }
}

function tableColumns(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name);
  } catch {
    return [];
  }
}

function hasColumn(db, tableName, columnName) {
  return tableColumns(db, tableName).includes(columnName);
}

function safeJson(value, fallback) {
  if (value === undefined) return JSON.stringify(fallback);
  return jsonSafe(value, 30000) || JSON.stringify(fallback);
}

function parseJson(value, fallback) {
  return parseMaybeJson(value, fallback);
}

function ensureMemoryLayerColumn(db) {
  if (!tableExists(db, "memory")) return false;
  const cols = tableColumns(db, "memory");
  if (!cols.includes("layer")) {
    try {
      db.exec("ALTER TABLE memory ADD COLUMN layer TEXT");
    } catch {}
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory(layer)");
    db.exec(`
      UPDATE memory SET layer = CASE
        WHEN kind IN ('tool_call','ssh_cmd','web_fetch','skill','skill_run') THEN 'procedural'
        WHEN kind IN ('memory_md','decision','scar','manual','dream','reflection','memory_consolidation','company_fact_set') THEN 'semantic'
        WHEN kind IN ('message','edit') THEN 'episodic'
        ELSE 'episodic'
      END
      WHERE layer IS NULL OR layer = ''
    `);
  } catch {}
  return hasColumn(db, "memory", "layer");
}

function ensureMemoryConsolidationSchema(db) {
  ensureMemoryLayerColumn(db);
  db.exec(`
CREATE TABLE IF NOT EXISTS daily_reflection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reflection_date TEXT NOT NULL UNIQUE,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  events_examined INTEGER NOT NULL DEFAULT 0,
  corrections INTEGER NOT NULL DEFAULT 0,
  praises INTEGER NOT NULL DEFAULT 0,
  trait_diffs_json TEXT,
  belief_diffs_json TEXT,
  summary TEXT,
  next_day_focus TEXT
);
CREATE INDEX IF NOT EXISTS idx_reflection_date ON daily_reflection(reflection_date);

CREATE TABLE IF NOT EXISTS cycle_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  inputs_count INTEGER NOT NULL DEFAULT 0,
  promoted_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  delta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycle_phase ON cycle_event(phase);
CREATE INDEX IF NOT EXISTS idx_cycle_ran ON cycle_event(ran_at);

CREATE TABLE IF NOT EXISTS memory_consolidation_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  agent_name TEXT,
  project TEXT,
  phase TEXT NOT NULL,
  source_window_start TEXT NOT NULL,
  source_window_end TEXT NOT NULL,
  source_counts_json TEXT,
  selected_refs_json TEXT,
  summary TEXT NOT NULL,
  promoted_memory_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  confidence TEXT NOT NULL DEFAULT 'derived',
  review_status TEXT NOT NULL DEFAULT 'draft',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_consolidation_phase ON memory_consolidation_run(phase, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_consolidation_project ON memory_consolidation_run(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_consolidation_agent ON memory_consolidation_run(agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS department_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  department_name TEXT NOT NULL,
  agent_name TEXT,
  project TEXT,
  journal_date TEXT NOT NULL,
  progress TEXT,
  blockers TEXT,
  risks TEXT,
  open_questions TEXT,
  dependencies_json TEXT,
  foreign_scope_requests_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_department_journal_dept ON department_journal(scope, department_name, journal_date DESC);
CREATE INDEX IF NOT EXISTS idx_department_journal_project ON department_journal(project, journal_date DESC);
CREATE INDEX IF NOT EXISTS idx_department_journal_agent ON department_journal(agent_name, journal_date DESC);

CREATE TABLE IF NOT EXISTS agent_sleep_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  agent_name TEXT NOT NULL,
  project TEXT,
  note_date TEXT NOT NULL,
  learned TEXT,
  uncertainty TEXT,
  recurring_errors TEXT,
  needed_context TEXT,
  improvement_idea TEXT,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_sleep_agent ON agent_sleep_note(scope, agent_name, note_date DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sleep_project ON agent_sleep_note(project, note_date DESC);

CREATE TABLE IF NOT EXISTS memory_promotion_proposal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  proposal_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  project TEXT,
  department_name TEXT,
  agent_name TEXT,
  source_kind TEXT,
  source_id TEXT,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  reviewer TEXT,
  review_notes TEXT,
  promoted_ref_kind TEXT,
  promoted_ref_id TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_promotion_status ON memory_promotion_proposal(scope, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_promotion_project ON memory_promotion_proposal(project, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_promotion_agent ON memory_promotion_proposal(agent_name, status, created_at DESC);

CREATE TABLE IF NOT EXISTS dreammode_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  agent_name TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  dream_date TEXT NOT NULL,
  source_window_start TEXT NOT NULL,
  source_window_end TEXT NOT NULL,
  messages_examined INTEGER NOT NULL DEFAULT 0,
  actions_examined INTEGER NOT NULL DEFAULT 0,
  events_examined INTEGER NOT NULL DEFAULT 0,
  wrong_made_json TEXT,
  right_made_json TEXT,
  praise_received_json TEXT,
  called_out_json TEXT,
  broke_things_json TEXT,
  lessons_json TEXT,
  rem_run_ids_json TEXT,
  summary TEXT NOT NULL,
  brief_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, agent_name, project, dream_date)
);
CREATE INDEX IF NOT EXISTS idx_dreammode_date ON dreammode_run(scope, dream_date DESC);
CREATE INDEX IF NOT EXISTS idx_dreammode_project ON dreammode_run(project, dream_date DESC);
CREATE INDEX IF NOT EXISTS idx_dreammode_agent ON dreammode_run(agent_name, dream_date DESC);
`);
  try {
    db.exec(`
CREATE TRIGGER IF NOT EXISTS mnemo_journal_memory_consolidation_ai AFTER INSERT ON memory_consolidation_run BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('memory_consolidation', NEW.project, 'internal', NEW.agent_name, 'memory_consolidation_insert', 'memory_consolidation_run', CAST(NEW.id AS TEXT), NEW.status, NEW.summary, NEW.selected_refs_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_department_journal_ai AFTER INSERT ON department_journal BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('department_journal', NEW.project, 'internal', NEW.agent_name, 'department_journal_insert', 'department_journal', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.progress, NEW.blockers, NEW.risks, ''), NEW.dependencies_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_agent_sleep_ai AFTER INSERT ON agent_sleep_note BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_sleep_note', NEW.project, 'internal', NEW.agent_name, 'agent_sleep_note_insert', 'agent_sleep_note', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.learned, NEW.uncertainty, NEW.recurring_errors, ''), NULL, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_memory_promotion_ai AFTER INSERT ON memory_promotion_proposal BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('memory_promotion_proposal', NEW.project, 'internal', NEW.agent_name, 'memory_promotion_proposal_insert', 'memory_promotion_proposal', CAST(NEW.id AS TEXT), NEW.status, NEW.title || CASE WHEN NEW.body IS NULL THEN '' ELSE ': ' || NEW.body END, NEW.evidence_json, NEW.meta_json, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS mnemo_journal_dreammode_ai AFTER INSERT ON dreammode_run BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('dreammode', NEW.project, 'internal', NEW.agent_name, 'dreammode_run_insert', 'dreammode_run', CAST(NEW.id AS TEXT), NEW.status, NEW.summary, NEW.lessons_json, NEW.meta_json, NEW.created_at);
END;
`);
  } catch {}
}

function whereProject(input, column = "topic") {
  const project = String(input.project || "").trim();
  if (!project) return { sql: "", params: [] };
  return { sql: ` AND (COALESCE(${column}, '') = ? OR COALESCE(meta_json, '') LIKE ?)`, params: [project, `%${project}%`] };
}

function countTable(db, tableName, whereSql = "", params = []) {
  if (!tableExists(db, tableName)) return 0;
  try {
    return db.prepare(`SELECT COUNT(*) c FROM ${tableName}${whereSql}`).get(...params).c || 0;
  } catch {
    return 0;
  }
}

function latestRow(db, tableName, orderCol, whereSql = "", params = []) {
  if (!tableExists(db, tableName)) return null;
  try {
    return db.prepare(`SELECT * FROM ${tableName}${whereSql} ORDER BY ${orderCol} DESC LIMIT 1`).get(...params) || null;
  } catch {
    return null;
  }
}

function memoryLayerCounts(db, input = {}) {
  if (!tableExists(db, "memory")) return [];
  ensureMemoryLayerColumn(db);
  const days = clampInt(input.days, 7, 1, 3650);
  const since = input.since || new Date(Date.now() - days * 86400000).toISOString();
  const project = whereProject(input, "topic");
  try {
    return db.prepare(`
      SELECT COALESCE(layer, 'episodic') AS layer, kind, COUNT(*) AS count, MAX(occurred_at) AS last_at
      FROM memory
      WHERE occurred_at >= ?${project.sql}
      GROUP BY COALESCE(layer, 'episodic'), kind
      ORDER BY layer, count DESC
    `).all(since, ...project.params);
  } catch {
    return [];
  }
}

function sourceCounts(db, input = {}) {
  const days = clampInt(input.days, 7, 1, 3650);
  const since = input.since || new Date(Date.now() - days * 86400000).toISOString();
  const counts = {
    since,
    memory: 0,
    transcript: 0,
    capture_receipt: 0,
    mnemo_event_journal: 0,
    agent_action: 0,
    session_handoff: 0,
    decision_log: 0,
    quality_finding: 0,
    daily_reflection: 0,
    cycle_event: 0,
    runtime_tool_receipt: 0,
    department_journal: 0,
    agent_sleep_note: 0,
    memory_promotion_proposal: 0,
  };
  if (tableExists(db, "memory")) {
    const p = whereProject(input, "topic");
    counts.memory = countTable(db, "memory", ` WHERE occurred_at >= ?${p.sql}`, [since, ...p.params]);
  }
  if (tableExists(db, "transcript")) counts.transcript = countTable(db, "transcript", " WHERE occurred_at >= ?", [since]);
  if (tableExists(db, "capture_receipt")) counts.capture_receipt = countTable(db, "capture_receipt", " WHERE last_seen_at >= ?", [since]);
  if (tableExists(db, "mnemo_event_journal")) counts.mnemo_event_journal = countTable(db, "mnemo_event_journal", " WHERE occurred_at >= ?", [since]);
  if (tableExists(db, "agent_action")) counts.agent_action = countTable(db, "agent_action", " WHERE started_at >= ?", [since]);
  if (tableExists(db, "session_handoff")) counts.session_handoff = countTable(db, "session_handoff", " WHERE created_at >= ?", [since]);
  if (tableExists(db, "decision_log")) counts.decision_log = countTable(db, "decision_log", " WHERE decided_at >= ?", [since]);
  if (tableExists(db, "quality_finding")) counts.quality_finding = countTable(db, "quality_finding", " WHERE created_at >= ?", [since]);
  if (tableExists(db, "daily_reflection")) counts.daily_reflection = countTable(db, "daily_reflection", " WHERE generated_at >= ?", [since]);
  if (tableExists(db, "cycle_event")) counts.cycle_event = countTable(db, "cycle_event", " WHERE ran_at >= ?", [since]);
  if (tableExists(db, "runtime_tool_receipt")) counts.runtime_tool_receipt = countTable(db, "runtime_tool_receipt", " WHERE started_at >= ?", [since]);
  if (tableExists(db, "department_journal")) counts.department_journal = countTable(db, "department_journal", " WHERE created_at >= ?", [since]);
  if (tableExists(db, "agent_sleep_note")) counts.agent_sleep_note = countTable(db, "agent_sleep_note", " WHERE created_at >= ?", [since]);
  if (tableExists(db, "memory_promotion_proposal")) counts.memory_promotion_proposal = countTable(db, "memory_promotion_proposal", " WHERE created_at >= ?", [since]);
  return counts;
}

function canonicalMemoryModel() {
  return {
    authority: "mnemo",
    rule: "External runtimes may collect or execute, but Mnemo owns durable truth, identity, claims, approvals, evidence, and memory promotion.",
    layers: [
      { name: "company_ledger", mnemo_sources: ["decision_log", "work_claim", "approval_request", "runtime_tool_receipt", "session_handoff", "quality_finding", "project_rules"], purpose: "official company truth and audit trail" },
      { name: "department_journal", mnemo_sources: ["department_journal"], purpose: "department-level diary; explains work history but is not official truth until promoted" },
      { name: "agent_sleep_notes", mnemo_sources: ["agent_sleep_note"], purpose: "personal agent REM notes; never official truth until reviewed" },
      { name: "session", mnemo_sources: ["transcript", "capture_receipt", "agent_action", "memory:episodic"], purpose: "current conversation, tool steps, raw events" },
      { name: "daily", mnemo_sources: ["daily_reflection", "memory_consolidation_run:daily"], purpose: "day-level journal and correction/praise signal" },
      { name: "long_term", mnemo_sources: ["memory:semantic", "decision_log", "scar_event", "company facts"], purpose: "stable rules, decisions, scars, project facts" },
      { name: "recall", mnemo_sources: ["mem_recall", "mem_recall_layered", "memory_fts", "mnemo_search_fts"], purpose: "searchable retrieval, not a second store" },
      { name: "rem", mnemo_sources: ["cycle_event", "memory_consolidation_run:rem"], purpose: "background consolidation and pattern extraction" },
    ],
  };
}

function latestDailyReflection(db) {
  if (!tableExists(db, "daily_reflection")) return null;
  const cols = tableColumns(db, "daily_reflection");
  const dateCol = cols.includes("reflection_date") ? "reflection_date" : (cols.includes("date") ? "date" : null);
  if (!dateCol) return null;
  try {
    return db.prepare(`SELECT * FROM daily_reflection ORDER BY ${dateCol} DESC, generated_at DESC LIMIT 1`).get() || null;
  } catch {
    return null;
  }
}

function latestConsolidationByPhase(db) {
  const out = {};
  if (!tableExists(db, "memory_consolidation_run")) return out;
  for (const phase of PHASES) {
    out[phase] = latestRow(db, "memory_consolidation_run", "created_at", " WHERE phase=?", [phase]);
  }
  return out;
}

function latestCycleByPhase(db) {
  const out = {};
  if (!tableExists(db, "cycle_event")) return out;
  for (const phase of ["pulse", "settle", "arc"]) {
    out[phase] = latestRow(db, "cycle_event", "ran_at", " WHERE phase=?", [phase]);
  }
  return out;
}

function memoryLayerStatus(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const days = clampInt(input.days, 7, 1, 3650);
  const counts = sourceCounts(db, input);
  const layers = memoryLayerCounts(db, input);
  const latestDaily = latestDailyReflection(db);
  const consolidation = latestConsolidationByPhase(db);
  const cycles = latestCycleByPhase(db);
  const latestRem = consolidation.rem || cycles.arc || null;
  const warnings = [];
  if (!counts.memory && !counts.transcript && !counts.mnemo_event_journal) warnings.push("no recent raw memory/session events in selected window");
  if (!latestDaily) warnings.push("no daily_reflection row found yet");
  if (!latestRem) warnings.push("no REM/arc consolidation found yet");
  return {
    ok: true,
    checked_at: nowIso(),
    scope: scopeName(input.scope),
    agent_name: input.agent_name ? normalizeAgentName(input.agent_name) : null,
    project: input.project || null,
    days,
    canonical_model: canonicalMemoryModel(),
    source_counts: counts,
    memory_layers: layers,
    latest: {
      daily_reflection: latestDaily,
      consolidation,
      cycle_event: cycles,
    },
    freshness: {
      daily_reflection: freshnessFromAgeDays(isoAgeDays(latestDaily && (latestDaily.generated_at || latestDaily.reflection_date)), 2, 7),
      rem: freshnessFromAgeDays(isoAgeDays(latestRem && (latestRem.created_at || latestRem.ran_at)), 7, 21),
    },
    warnings,
  };
}

function phaseWindowDays(phase, inputDays) {
  if (inputDays) return clampInt(inputDays, 1, 1, 3650);
  if (phase === "light") return 1;
  if (phase === "daily") return 1;
  if (phase === "deep") return 3;
  return 7;
}

function memoryRemPlan(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const status = memoryLayerStatus(db, input);
  const today = (input.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const latest = status.latest.consolidation || {};
  const counts = status.source_counts || {};
  const phases = [];
  const add = (phase, due, reason, run_hint) => phases.push({ phase, due, reason, run_hint });
  const lightAge = isoAgeDays(latest.light && latest.light.created_at);
  const dailyExists = tableExists(db, "daily_reflection")
    ? !!db.prepare("SELECT 1 FROM daily_reflection WHERE reflection_date=?").get(today)
    : false;
  const deepAge = isoAgeDays(latest.deep && latest.deep.created_at);
  const remAge = isoAgeDays((latest.rem && latest.rem.created_at) || (status.latest.cycle_event.arc && status.latest.cycle_event.arc.ran_at));

  add("light", (counts.transcript + counts.agent_action + counts.capture_receipt + counts.mnemo_event_journal) > 0 && (lightAge == null || lightAge >= 1),
    "Collect the current working/session layer into a short reviewable summary.",
    { tool: "mem_memory_rem_run", args: { phase: "light", days: 1, agent_name: input.agent_name || undefined, project: input.project || undefined } });
  add("daily", !dailyExists,
    `Create or refresh daily reflection for ${today}.`,
    { tool: "mem_memory_rem_run", args: { phase: "daily", date: today, agent_name: input.agent_name || undefined, project: input.project || undefined } });
  add("deep", (counts.memory + counts.session_handoff + counts.decision_log + counts.quality_finding) > 0 && (deepAge == null || deepAge >= 1),
    "Promote durable decisions, handoffs, scars, and high-signal facts into semantic memory.",
    { tool: "mem_memory_rem_run", args: { phase: "deep", days: 3, agent_name: input.agent_name || undefined, project: input.project || undefined } });
  add("rem", remAge == null || remAge >= 7,
    "Weekly REM pass: extract cross-day patterns without deleting or overwriting old facts.",
    { tool: "mem_memory_rem_run", args: { phase: "rem", days: 7, agent_name: input.agent_name || undefined, project: input.project || undefined } });

  return {
    ok: true,
    generated_at: nowIso(),
    scope: scopeName(input.scope),
    project: input.project || null,
    agent_name: input.agent_name ? normalizeAgentName(input.agent_name) : null,
    canonical_model: canonicalMemoryModel(),
    phases,
    next_due: phases.filter((p) => p.due),
    status,
    rule: "Run phases via Mnemo tools only. Runtimes may feed raw events, but promotion and long-term truth stay in Mnemo.",
  };
}

function getRows(db, tableName, sql, params = []) {
  if (!tableExists(db, tableName)) return [];
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function selectMemoryRows(db, input, since, limit) {
  if (!tableExists(db, "memory")) return [];
  const p = whereProject(input, "topic");
  const agent = input.agent_name ? normalizeAgentName(input.agent_name) : "";
  const where = [`occurred_at >= ?${p.sql}`];
  const params = [since, ...p.params];
  if (agent) {
    where.push("(LOWER(COALESCE(actor,''))=? OR COALESCE(meta_json,'') LIKE ?)");
    params.push(agent, `%${agent}%`);
  }
  params.push(limit);
  return getRows(db, "memory", `
    SELECT 'memory' AS ref_kind, CAST(id AS TEXT) AS ref_id, kind AS subtype, actor, topic, occurred_at AS at,
           importance, substr(text,1,700) AS preview
    FROM memory
    WHERE ${where.join(" AND ")}
    ORDER BY importance DESC, occurred_at DESC
    LIMIT ?
  `, params);
}

function selectHandoffRows(db, input, since, limit) {
  if (!tableExists(db, "session_handoff")) return [];
  const where = ["created_at >= ?"];
  const params = [since];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  params.push(limit);
  return getRows(db, "session_handoff", `
    SELECT 'session_handoff' AS ref_kind, CAST(id AS TEXT) AS ref_id, 'handoff' AS subtype, agent_name AS actor,
           project AS topic, created_at AS at, 8 AS importance, substr(summary,1,700) AS preview
    FROM session_handoff
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `, params);
}

function selectDecisionRows(db, input, since, limit) {
  if (!tableExists(db, "decision_log")) return [];
  const where = ["decided_at >= ?"];
  const params = [since];
  if (input.scope) { where.push("scope=?"); params.push(scopeName(input.scope)); }
  if (input.project) { where.push("(body LIKE ? OR title LIKE ? OR files_affected LIKE ? OR entities_affected LIKE ?)"); params.push(`%${input.project}%`, `%${input.project}%`, `%${input.project}%`, `%${input.project}%`); }
  params.push(limit);
  return getRows(db, "decision_log", `
    SELECT 'decision_log' AS ref_kind, CAST(id AS TEXT) AS ref_id, 'decision' AS subtype, decided_by AS actor,
           scope AS topic, decided_at AS at, 9 AS importance, substr(title || ': ' || COALESCE(body,''),1,700) AS preview
    FROM decision_log
    WHERE ${where.join(" AND ")}
    ORDER BY decided_at DESC
    LIMIT ?
  `, params);
}

function selectFindingRows(db, input, since, limit) {
  if (!tableExists(db, "quality_finding")) return [];
  const where = ["created_at >= ?"];
  const params = [since];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  params.push(limit);
  return getRows(db, "quality_finding", `
    SELECT 'quality_finding' AS ref_kind, CAST(id AS TEXT) AS ref_id, category AS subtype, source_agent AS actor,
           project AS topic, created_at AS at,
           CASE severity WHEN 'H' THEN 9 WHEN 'M' THEN 7 ELSE 5 END AS importance,
           substr(title || CASE WHEN actual IS NULL THEN '' ELSE ' actual=' || actual END,1,700) AS preview
    FROM quality_finding
    WHERE ${where.join(" AND ")}
    ORDER BY CASE severity WHEN 'H' THEN 3 WHEN 'M' THEN 2 ELSE 1 END DESC, created_at DESC
    LIMIT ?
  `, params);
}

function selectActionRows(db, input, since, limit) {
  if (!tableExists(db, "agent_action")) return [];
  const where = ["started_at >= ?"];
  const params = [since];
  if (input.project) { where.push("topic=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  params.push(limit);
  return getRows(db, "agent_action", `
    SELECT 'agent_action' AS ref_kind, CAST(id AS TEXT) AS ref_id, COALESCE(action_kind,'action') AS subtype, agent_name AS actor,
           topic, started_at AS at, 5 AS importance,
           substr(COALESCE(action_kind,'action') || ' ' || COALESCE(target,'') || ' status=' || COALESCE(status,''),1,700) AS preview
    FROM agent_action
    WHERE ${where.join(" AND ")}
    ORDER BY started_at DESC
    LIMIT ?
  `, params);
}

function selectJournalRows(db, input, since, limit) {
  if (!tableExists(db, "mnemo_event_journal")) return [];
  const where = ["occurred_at >= ?"];
  const params = [since];
  if (input.project) { where.push("(channel=? OR content LIKE ? OR payload_json LIKE ? OR meta_json LIKE ?)"); params.push(input.project, `%${input.project}%`, `%${input.project}%`, `%${input.project}%`); }
  if (input.agent_name) { where.push("LOWER(COALESCE(actor,''))=?"); params.push(normalizeAgentName(input.agent_name)); }
  params.push(limit);
  return getRows(db, "mnemo_event_journal", `
    SELECT 'mnemo_event_journal' AS ref_kind, CAST(id AS TEXT) AS ref_id, event_kind AS subtype, actor,
           channel AS topic, occurred_at AS at, 4 AS importance, substr(COALESCE(content,''),1,700) AS preview
    FROM mnemo_event_journal
    WHERE ${where.join(" AND ")}
    ORDER BY occurred_at DESC
    LIMIT ?
  `, params);
}

function selectDailyReflection(db, input, since, limit) {
  if (!tableExists(db, "daily_reflection")) return [];
  const cols = tableColumns(db, "daily_reflection");
  const dateCol = cols.includes("reflection_date") ? "reflection_date" : (cols.includes("date") ? "date" : null);
  if (!dateCol) return [];
  return getRows(db, "daily_reflection", `
    SELECT 'daily_reflection' AS ref_kind, CAST(id AS TEXT) AS ref_id, 'daily' AS subtype, 'mnemo' AS actor,
           ${dateCol} AS topic, generated_at AS at, 7 AS importance, substr(COALESCE(summary,''),1,700) AS preview
    FROM daily_reflection
    WHERE generated_at >= ?
    ORDER BY ${dateCol} DESC
    LIMIT ?
  `, [since, limit]);
}

function selectDepartmentJournalRows(db, input, since, limit) {
  if (!tableExists(db, "department_journal")) return [];
  const where = ["created_at >= ?"];
  const params = [since];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.department_name) { where.push("department_name=?"); params.push(normalizeDepartment(input.department_name)); }
  params.push(limit);
  return getRows(db, "department_journal", `
    SELECT 'department_journal' AS ref_kind, CAST(id AS TEXT) AS ref_id, department_name AS subtype, agent_name AS actor,
           project AS topic, created_at AS at, 7 AS importance,
           substr('progress=' || COALESCE(progress,'') || ' blockers=' || COALESCE(blockers,'') || ' risks=' || COALESCE(risks,''),1,700) AS preview
    FROM department_journal
    WHERE ${where.join(" AND ")}
    ORDER BY journal_date DESC, created_at DESC
    LIMIT ?
  `, params);
}

function selectAgentSleepRows(db, input, since, limit) {
  if (!tableExists(db, "agent_sleep_note")) return [];
  const where = ["created_at >= ?"];
  const params = [since];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  params.push(limit);
  return getRows(db, "agent_sleep_note", `
    SELECT 'agent_sleep_note' AS ref_kind, CAST(id AS TEXT) AS ref_id, status AS subtype, agent_name AS actor,
           project AS topic, created_at AS at, 6 AS importance,
           substr('learned=' || COALESCE(learned,'') || ' uncertainty=' || COALESCE(uncertainty,'') || ' recurring=' || COALESCE(recurring_errors,''),1,700) AS preview
    FROM agent_sleep_note
    WHERE ${where.join(" AND ")}
    ORDER BY note_date DESC, created_at DESC
    LIMIT ?
  `, params);
}

function selectPromotionRows(db, input, since, limit) {
  if (!tableExists(db, "memory_promotion_proposal")) return [];
  const where = ["created_at >= ?"];
  const params = [since];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.department_name) { where.push("department_name=?"); params.push(normalizeDepartment(input.department_name)); }
  params.push(limit);
  return getRows(db, "memory_promotion_proposal", `
    SELECT 'memory_promotion_proposal' AS ref_kind, CAST(id AS TEXT) AS ref_id, proposal_kind AS subtype, agent_name AS actor,
           project AS topic, created_at AS at, CASE status WHEN 'proposed' THEN 8 ELSE 6 END AS importance,
           substr(status || ' ' || title || CASE WHEN body IS NULL THEN '' ELSE ': ' || body END,1,700) AS preview
    FROM memory_promotion_proposal
    WHERE ${where.join(" AND ")}
    ORDER BY CASE status WHEN 'proposed' THEN 2 ELSE 1 END DESC, created_at DESC
    LIMIT ?
  `, params);
}

function selectRowsForPhase(db, phase, input = {}) {
  const days = phaseWindowDays(phase, input.days);
  const since = input.since || new Date(Date.now() - days * 86400000).toISOString();
  const limit = clampInt(input.limit, 60, 5, 300);
  let rows = [];
  if (phase === "light") {
    rows = rows.concat(selectActionRows(db, input, since, Math.ceil(limit / 3)));
    rows = rows.concat(selectJournalRows(db, input, since, Math.ceil(limit / 3)));
    rows = rows.concat(selectMemoryRows(db, input, since, Math.ceil(limit / 3)));
  } else if (phase === "daily") {
    rows = rows.concat(selectMemoryRows(db, input, since, Math.ceil(limit / 2)));
    rows = rows.concat(selectHandoffRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectFindingRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectDepartmentJournalRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectAgentSleepRows(db, input, since, Math.ceil(limit / 4)));
  } else if (phase === "deep") {
    rows = rows.concat(selectDecisionRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectHandoffRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectFindingRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectMemoryRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectPromotionRows(db, input, since, Math.ceil(limit / 4)));
  } else {
    rows = rows.concat(selectDailyReflection(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectDepartmentJournalRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectAgentSleepRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectPromotionRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectDecisionRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectHandoffRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectFindingRows(db, input, since, Math.ceil(limit / 4)));
    rows = rows.concat(selectMemoryRows(db, input, since, Math.ceil(limit / 4)));
  }
  const dedup = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.ref_kind}:${row.ref_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(row);
  }
  dedup.sort((a, b) => (b.importance - a.importance) || String(b.at || "").localeCompare(String(a.at || "")));
  return { since, until: nowIso(), rows: dedup.slice(0, limit) };
}

function groupRows(rows) {
  const groups = {
    decisions: [],
    handoffs: [],
    findings: [],
    actions: [],
    memories: [],
    reflections: [],
    department_journals: [],
    sleep_notes: [],
    promotions: [],
    events: [],
  };
  for (const row of rows) {
    if (row.ref_kind === "decision_log" || row.subtype === "decision") groups.decisions.push(row);
    else if (row.ref_kind === "session_handoff") groups.handoffs.push(row);
    else if (row.ref_kind === "quality_finding") groups.findings.push(row);
    else if (row.ref_kind === "agent_action") groups.actions.push(row);
    else if (row.ref_kind === "daily_reflection") groups.reflections.push(row);
    else if (row.ref_kind === "department_journal") groups.department_journals.push(row);
    else if (row.ref_kind === "agent_sleep_note") groups.sleep_notes.push(row);
    else if (row.ref_kind === "memory_promotion_proposal") groups.promotions.push(row);
    else if (row.ref_kind === "mnemo_event_journal") groups.events.push(row);
    else groups.memories.push(row);
  }
  return groups;
}

function bulletRows(rows, maxRows) {
  return rows.slice(0, maxRows).map((row) => {
    const who = row.actor ? ` ${row.actor}` : "";
    const topic = row.topic ? ` [${row.topic}]` : "";
    return `- ${row.ref_kind}:${row.ref_id}${topic}${who}: ${compactContent(row.preview, 240) || "(empty)"}`;
  });
}

function buildSummary(phase, input, selection, counts) {
  const rows = selection.rows || [];
  const groups = groupRows(rows);
  const lines = [];
  lines.push(`# Memory consolidation: ${phase}`);
  lines.push("");
  lines.push(`Scope: ${scopeName(input.scope)}${input.project ? ` | project: ${input.project}` : ""}${input.agent_name ? ` | agent: ${normalizeAgentName(input.agent_name)}` : ""}`);
  lines.push(`Window: ${selection.since} -> ${selection.until}`);
  lines.push(`Sources examined: memory=${counts.memory || 0}, transcript=${counts.transcript || 0}, actions=${counts.agent_action || 0}, handoffs=${counts.session_handoff || 0}, findings=${counts.quality_finding || 0}, events=${counts.mnemo_event_journal || 0}`);
  lines.push("");
  if (phase === "light") lines.push("Purpose: compress recent working/session events into a reviewable note. This is not canonical truth by itself.");
  if (phase === "daily") lines.push("Purpose: create the day journal layer and surface corrections, blockers, handoffs, and durable decisions.");
  if (phase === "deep") lines.push("Purpose: promote high-signal operational facts into semantic long-term memory candidates.");
  if (phase === "rem") lines.push("Purpose: weekly REM pass over daily/deep material to reveal recurring patterns and weak governance rules.");
  lines.push("");
  const sections = [
    ["Decisions", groups.decisions, 6],
    ["Handoffs", groups.handoffs, 6],
    ["Findings", groups.findings, 6],
    ["Department journals", groups.department_journals, 6],
    ["Agent sleep notes", groups.sleep_notes, 6],
    ["Promotion proposals", groups.promotions, 8],
    ["Reflections", groups.reflections, 4],
    ["Actions", groups.actions, 6],
    ["Memory/events", groups.memories.concat(groups.events), 10],
  ];
  for (const [title, values, maxRows] of sections) {
    if (!values.length) continue;
    lines.push(`## ${title}`);
    lines.push(...bulletRows(values, maxRows));
    lines.push("");
  }
  if (rows.length === 0) {
    lines.push("No source rows matched this consolidation window.");
    lines.push("");
  }
  lines.push("Review status: draft. A human or assigned agent may promote concrete lines into project truth, rules, scars, or runbooks.");
  return compactContent(lines.join("\n"), 12000);
}

function runDailyReflection(db, input = {}, selection) {
  const date = (input.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const fromTs = date + "T00:00:00Z";
  const toTs = date + "T23:59:59Z";
  const events = tableExists(db, "memory")
    ? db.prepare("SELECT actor, text FROM memory WHERE kind='message' AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at ASC").all(fromTs, toTs)
    : [];
  let corrections = 0;
  let praises = 0;
  const correctionPatterns = /\b(nicht so|nein|stop|hor auf|hoer auf|falsch|kein|fantasi|verarscht|kacke|scheisse|scheisse|kaputt|broken)\b/i;
  const praisePatterns = /\b(geil|super|perfekt|top|stark|hammer|well done|great)\b/i;
  const owner = String(process.env.MNEMO_OWNER_NAME || "owner").toLowerCase();
  for (const event of events) {
    const actor = String(event.actor || "").toLowerCase();
    if (actor && actor !== owner && actor !== "mayk") continue;
    if (correctionPatterns.test(event.text || "")) corrections++;
    if (praisePatterns.test(event.text || "")) praises++;
  }
  const summary = `${events.length} message rows, ${corrections} corrections, ${praises} praises on ${date}. Consolidation selected ${selection.rows.length} durable source rows.`;
  db.prepare(`
    INSERT INTO daily_reflection (reflection_date, events_examined, corrections, praises, summary, trait_diffs_json, belief_diffs_json)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(reflection_date) DO UPDATE SET
      events_examined=excluded.events_examined,
      corrections=excluded.corrections,
      praises=excluded.praises,
      summary=excluded.summary,
      generated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(date, events.length, corrections, praises, summary, "{}", "{}");
  return { date, events_examined: events.length, corrections, praises, summary };
}

function foldSignalText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00df/g, "ss");
}

function dreamDateWindow(input = {}) {
  const date = (input.dream_date || input.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const since = input.since || `${date}T00:00:00Z`;
  const until = input.until || `${date}T23:59:59Z`;
  return { date, since, until };
}

function selectDreamRows(db, input = {}) {
  const win = dreamDateWindow(input);
  const limit = clampInt(input.limit, 800, 20, 5000);
  const project = String(input.project || "").trim();
  const agent = input.agent_name ? normalizeAgentName(input.agent_name) : "";
  const feedbackActors = uniqueStrings(["mayk", "filedatabase", process.env.MNEMO_OWNER_NAME || "owner"]).map(normalizeAgentName);
  const rows = [];
  const pushRows = (values) => {
    for (const row of values || []) {
      rows.push(Object.assign({ status: null }, row));
      if (rows.length >= limit * 2) break;
    }
  };

  if (tableExists(db, "memory")) {
    const where = ["occurred_at BETWEEN ? AND ?"];
    const params = [win.since, win.until];
    if (project) {
      where.push("(COALESCE(topic,'')=? OR COALESCE(text,'') LIKE ? OR COALESCE(meta_json,'') LIKE ?)");
      params.push(project, `%${project}%`, `%${project}%`);
    }
    if (agent) {
      const ownerPlaceholders = feedbackActors.map(() => "?").join(",");
      where.push(`(LOWER(COALESCE(actor,''))=? OR LOWER(COALESCE(actor,'')) IN (${ownerPlaceholders}) OR COALESCE(meta_json,'') LIKE ?)`);
      params.push(agent, ...feedbackActors, `%${agent}%`);
    }
    params.push(limit);
    pushRows(getRows(db, "memory", `
      SELECT 'memory' AS ref_kind, CAST(id AS TEXT) AS ref_id, kind AS subtype, actor,
             topic, occurred_at AS at, NULL AS status, importance,
             substr(COALESCE(text,''),1,1200) AS preview
      FROM memory
      WHERE ${where.join(" AND ")}
      ORDER BY occurred_at ASC
      LIMIT ?
    `, params));
  }

  if (tableExists(db, "mnemo_event_journal")) {
    const where = ["occurred_at BETWEEN ? AND ?"];
    const params = [win.since, win.until];
    if (project) {
      where.push("(COALESCE(channel,'')=? OR COALESCE(content,'') LIKE ? OR COALESCE(payload_json,'') LIKE ? OR COALESCE(meta_json,'') LIKE ?)");
      params.push(project, `%${project}%`, `%${project}%`, `%${project}%`);
    }
    if (agent) {
      const ownerPlaceholders = feedbackActors.map(() => "?").join(",");
      where.push(`(LOWER(COALESCE(actor,''))=? OR LOWER(COALESCE(actor,'')) IN (${ownerPlaceholders}) OR COALESCE(meta_json,'') LIKE ?)`);
      params.push(agent, ...feedbackActors, `%${agent}%`);
    }
    params.push(limit);
    pushRows(getRows(db, "mnemo_event_journal", `
      SELECT 'mnemo_event_journal' AS ref_kind, CAST(id AS TEXT) AS ref_id, event_kind AS subtype, actor,
             channel AS topic, occurred_at AS at, status, 4 AS importance,
             substr(COALESCE(content,'') || ' ' || COALESCE(payload_json,'') || ' ' || COALESCE(meta_json,''),1,1200) AS preview
      FROM mnemo_event_journal
      WHERE ${where.join(" AND ")}
      ORDER BY occurred_at ASC
      LIMIT ?
    `, params));
  }

  if (tableExists(db, "agent_action")) {
    const where = ["started_at BETWEEN ? AND ?"];
    const params = [win.since, win.until];
    if (project) {
      where.push("(COALESCE(topic,'')=? OR COALESCE(payload_json,'') LIKE ? OR COALESCE(meta_json,'') LIKE ?)");
      params.push(project, `%${project}%`, `%${project}%`);
    }
    if (agent) {
      where.push("LOWER(COALESCE(agent_name,''))=?");
      params.push(agent);
    }
    params.push(limit);
    pushRows(getRows(db, "agent_action", `
      SELECT 'agent_action' AS ref_kind, CAST(id AS TEXT) AS ref_id, action_kind AS subtype, agent_name AS actor,
             topic, started_at AS at, status, 5 AS importance,
             substr(COALESCE(action_kind,'') || ' ' || COALESCE(target,'') || ' status=' || COALESCE(status,'') || ' ' || COALESCE(result_json,'') || ' ' || COALESCE(payload_json,''),1,1200) AS preview
      FROM agent_action
      WHERE ${where.join(" AND ")}
      ORDER BY started_at ASC
      LIMIT ?
    `, params));
  }

  if (tableExists(db, "quality_finding")) {
    const where = ["created_at BETWEEN ? AND ?"];
    const params = [win.since, win.until];
    const qcols = tableColumns(db, "quality_finding");
    const hasAssigned = qcols.includes("assigned_agent");
    if (project) { where.push("project=?"); params.push(project); }
    if (agent) {
      where.push(hasAssigned ? "(LOWER(COALESCE(source_agent,''))=? OR LOWER(COALESCE(assigned_agent,''))=?)" : "LOWER(COALESCE(source_agent,''))=?");
      params.push(agent);
      if (hasAssigned) params.push(agent);
    }
    params.push(limit);
    const actorExpr = hasAssigned ? "COALESCE(source_agent, assigned_agent)" : "source_agent";
    pushRows(getRows(db, "quality_finding", `
      SELECT 'quality_finding' AS ref_kind, CAST(id AS TEXT) AS ref_id, category AS subtype, ${actorExpr} AS actor,
             project AS topic, created_at AS at, COALESCE(status,'open') AS status, 8 AS importance,
             substr(COALESCE(severity,'') || ' ' || COALESCE(title,'') || ' ' || COALESCE(actual,'') || ' ' || COALESCE(expected,''),1,1200) AS preview
      FROM quality_finding
      WHERE ${where.join(" AND ")}
      ORDER BY created_at ASC
      LIMIT ?
    `, params));
  }

  const dedup = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.ref_kind}:${row.ref_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(row);
  }
  dedup.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return Object.assign(win, { rows: dedup.slice(0, limit) });
}

function emptyDreamBuckets() {
  const out = {};
  for (const key of DREAM_BUCKET_KEYS) out[key] = { count: 0, examples: [] };
  return out;
}

function dreamBucketMatches(row) {
  const text = foldSignalText([row.preview, row.subtype, row.status, row.topic].filter(Boolean).join(" "));
  const matches = [];
  const add = (key, reason) => matches.push({ key, reason });

  if (/\b(super|perfekt|top|stark|danke|geil|sauber|besser|bestaetigt|bestatigt|demo-bereit|b[aehm]*hm|well done|great)\b/.test(text)) {
    add("praise_received", "human/peer praise or green feedback");
  }
  if (/\b(ok|done|passed|pass|green|grun|gruen|verified|verifiziert|bestaetigt|bestatigt|gefixt|live|closed|acceptance|funktioniert wieder|passt jetzt|smoke grun|tests? grun|0 failed|70 passed)\b/.test(text)) {
    add("right_made", "verified success or completed action");
  }
  if (/\b(falsch|fehler|bug|blocker|regression|nicht live|nichts geaendert|nichts geandert|geht nicht|funktioniert nicht|ignoriert|vermischt|fallback|404|502|broken|fail|failed|error|rot|kaputt)\b/.test(text)) {
    add("wrong_made", "failure, bug, or red verification");
  }
  if (/\b(stop|hoer auf|hor auf|verdammt|nervt|spam|pennt|lump|kacke|scheiss|scheisse|was machst|du hast|nicht in die gruppe|konsole|heimlich)\b/.test(text)) {
    add("called_out", "direct correction or frustration signal");
  }
  if (/\b(kaputt gemacht|abgeschossen|weg gefegt|weggefegt|server down|production-down|prod down|502|crash|crashed|kill|killed|orphan|stopped|telegram kaputt|deploy.*kaputt|service.*down)\b/.test(text)) {
    add("broke_things", "incident or caused damage");
  }

  if (/^(done|ok|success|passed)$/i.test(String(row.status || ""))) {
    add("right_made", "status indicates completed work");
  } else if (/^(error|failed|fail|blocked)$/i.test(String(row.status || ""))) {
    add("wrong_made", "status indicates failure/blocker");
  }
  return matches;
}

function addDreamExample(bucket, row, reason) {
  bucket.count++;
  if (bucket.examples.length >= 20) return;
  bucket.examples.push({
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    actor: row.actor || null,
    topic: row.topic || null,
    at: row.at || null,
    reason,
    preview: compactContent(row.preview, 360),
  });
}

function classifyDreamRows(rows) {
  const buckets = emptyDreamBuckets();
  for (const row of rows) {
    for (const match of dreamBucketMatches(row)) {
      addDreamExample(buckets[match.key], row, match.reason);
    }
  }
  return buckets;
}

function dreamLessons(buckets) {
  const lessons = [];
  const firstRef = (key) => {
    const ex = buckets[key] && buckets[key].examples && buckets[key].examples[0];
    return ex ? `${ex.ref_kind}:${ex.ref_id}` : null;
  };
  if (buckets.broke_things.count > 0) {
    lessons.push({ type: "stop_doing", text: "Production, Telegram, and deploy incidents need a gate, receipt, and rollback path before more changes.", evidence_ref: firstRef("broke_things") });
  }
  if (buckets.called_out.count > 0) {
    lessons.push({ type: "behavior_adjustment", text: "User frustration is a hard signal: reduce spam, write in the requested channel, and keep status updates short.", evidence_ref: firstRef("called_out") });
  }
  if (buckets.wrong_made.count > 0) {
    lessons.push({ type: "fix_next", text: "Red verifications and repeated bugs become next-day tasks until explicitly closed with evidence.", evidence_ref: firstRef("wrong_made") });
  }
  if (buckets.right_made.count > 0) {
    lessons.push({ type: "keep_doing", text: "Keep the workflows that produced green verification: concrete checks, URLs, exit codes, and direct acceptance evidence.", evidence_ref: firstRef("right_made") });
  }
  if (buckets.praise_received.count > 0) {
    lessons.push({ type: "positive_reinforcement", text: "Praise marks a useful pattern; preserve the exact behavior that led to it.", evidence_ref: firstRef("praise_received") });
  }
  if (!lessons.length) {
    lessons.push({ type: "low_signal", text: "No strong praise/correction/failure signal was detected; keep collecting raw messages and evidence." });
  }
  return lessons;
}

function dreamSummary(input, source, buckets, lessons, remRuns) {
  const labels = {
    wrong_made: "Falsch gemacht",
    right_made: "Richtig gemacht",
    praise_received: "Lob bekommen",
    called_out: "Angemacht/korrigiert",
    broke_things: "Scheisse gebaut",
  };
  const lines = [];
  lines.push(`# Dreammode Review: ${source.date}`);
  lines.push("");
  lines.push(`Scope: ${scopeName(input.scope)}${input.project ? ` | project: ${input.project}` : ""}${input.agent_name ? ` | agent: ${normalizeAgentName(input.agent_name)}` : ""}`);
  lines.push(`Window: ${source.since} -> ${source.until}`);
  lines.push(`Sources examined: ${source.rows.length} rows. REM phases: ${remRuns.map((r) => r.phase + "#" + r.run_id).join(", ") || "none"}.`);
  lines.push("");
  for (const key of DREAM_BUCKET_KEYS) {
    const bucket = buckets[key];
    lines.push(`## ${labels[key]} (${bucket.count})`);
    if (!bucket.examples.length) {
      lines.push("- none detected");
    } else {
      for (const ex of bucket.examples.slice(0, 8)) {
        const who = ex.actor ? ` ${ex.actor}` : "";
        const topic = ex.topic ? ` [${ex.topic}]` : "";
        lines.push(`- ${ex.ref_kind}:${ex.ref_id}${topic}${who}: ${compactContent(ex.preview, 220)}`);
      }
    }
    lines.push("");
  }
  lines.push("## Daraus lernen");
  for (const lesson of lessons) {
    lines.push(`- ${lesson.type}: ${lesson.text}${lesson.evidence_ref ? ` (${lesson.evidence_ref})` : ""}`);
  }
  lines.push("");
  lines.push("Rule: Dreammode is draft processing. It may propose lessons, but official truth/rules still need explicit promotion or task updates.");
  return compactContent(lines.join("\n"), 16000);
}

function rowToDreammodeRun(row) {
  return row ? Object.assign({}, row, {
    wrong_made: parseJson(row.wrong_made_json, { count: 0, examples: [] }),
    right_made: parseJson(row.right_made_json, { count: 0, examples: [] }),
    praise_received: parseJson(row.praise_received_json, { count: 0, examples: [] }),
    called_out: parseJson(row.called_out_json, { count: 0, examples: [] }),
    broke_things: parseJson(row.broke_things_json, { count: 0, examples: [] }),
    lessons: parseJson(row.lessons_json, []),
    rem_run_ids: parseJson(row.rem_run_ids_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function dreammodeRun(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const agent = input.agent_name ? normalizeAgentName(input.agent_name) : "";
  const project = String(input.project || "").trim();
  const scope = scopeName(input.scope);
  const source = selectDreamRows(db, input);
  const existing = db.prepare("SELECT * FROM dreammode_run WHERE scope=? AND agent_name=? AND project=? AND dream_date=?")
    .get(scope, agent, project, source.date);
  if (existing && input.force !== true) {
    return { ok: true, skipped: true, reason: "dreammode already ran for this agent/project/date", run: rowToDreammodeRun(existing) };
  }

  const remRuns = [];
  if (input.run_rem_phases !== false) {
    const phases = input.phases && Array.isArray(input.phases) ? input.phases : ["light", "daily", "deep", "rem"];
    for (const phase of phases) {
      const normalized = String(phase || "").toLowerCase();
      if (!PHASES.has(normalized)) continue;
      const result = memoryRemRun(db, {
        scope,
        agent_name: agent || undefined,
        project: project || undefined,
        phase: normalized,
        date: source.date,
        days: normalized === "rem" ? clampInt(input.rem_days, 7, 1, 3650) : undefined,
        meta: Object.assign({}, input.meta || {}, { dreammode: true, dream_date: source.date }),
      });
      if (result && result.ok) remRuns.push({ phase: normalized, run_id: result.run_id, promoted_memory_id: result.promoted_memory_id || null });
    }
  }

  const buckets = classifyDreamRows(source.rows);
  const lessons = dreamLessons(buckets);
  const summary = dreamSummary(input, source, buckets, lessons, remRuns);
  let briefId = null;
  const writeBrief = input.write_brief !== false;
  if (writeBrief && tableExists(db, "agent_brief")) {
    const coordinator = normalizeAgentName(input.coordinator_agent || input.agent_name || "dieter");
    const info = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
      .run(coordinator || "dieter", normalizeAgentName(input.source_agent || "mnemo-dreammode"), summary, safeJson({ kind: "dreammode_review", project: project || null, agent_name: agent || null, dream_date: source.date }, {}));
    briefId = info.lastInsertRowid;
  }

  const insertArgs = [
    scope,
    agent,
    project,
    source.date,
    source.since,
    source.until,
    source.rows.filter((row) => row.ref_kind === "memory").length,
    source.rows.filter((row) => row.ref_kind === "agent_action").length,
    source.rows.filter((row) => row.ref_kind === "mnemo_event_journal").length,
    safeJson(buckets.wrong_made, {}),
    safeJson(buckets.right_made, {}),
    safeJson(buckets.praise_received, {}),
    safeJson(buckets.called_out, {}),
    safeJson(buckets.broke_things, {}),
    safeJson(lessons, []),
    safeJson(remRuns, []),
    summary,
    briefId,
    input.status || "draft",
    safeJson(Object.assign({}, input.meta || {}, { no_destructive_migration: true, human_style_review: true }), {}),
  ];
  const info = db.prepare(`
    INSERT INTO dreammode_run
      (scope, agent_name, project, dream_date, source_window_start, source_window_end, messages_examined, actions_examined, events_examined,
       wrong_made_json, right_made_json, praise_received_json, called_out_json, broke_things_json, lessons_json, rem_run_ids_json, summary, brief_id, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scope, agent_name, project, dream_date) DO UPDATE SET
      source_window_start=excluded.source_window_start,
      source_window_end=excluded.source_window_end,
      messages_examined=excluded.messages_examined,
      actions_examined=excluded.actions_examined,
      events_examined=excluded.events_examined,
      wrong_made_json=excluded.wrong_made_json,
      right_made_json=excluded.right_made_json,
      praise_received_json=excluded.praise_received_json,
      called_out_json=excluded.called_out_json,
      broke_things_json=excluded.broke_things_json,
      lessons_json=excluded.lessons_json,
      rem_run_ids_json=excluded.rem_run_ids_json,
      summary=excluded.summary,
      brief_id=excluded.brief_id,
      status=excluded.status,
      meta_json=excluded.meta_json,
      created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(...insertArgs);
  const row = db.prepare("SELECT * FROM dreammode_run WHERE scope=? AND agent_name=? AND project=? AND dream_date=?").get(scope, agent, project, source.date);
  return {
    ok: true,
    skipped: false,
    run_id: row ? row.id : info.lastInsertRowid,
    dream_date: source.date,
    source_count: source.rows.length,
    brief_id: briefId,
    rem_runs: remRuns,
    buckets,
    lessons,
    summary,
    run: rowToDreammodeRun(row),
  };
}

function dreammodeStatus(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.project !== undefined) { where.push("project=?"); params.push(String(input.project || "").trim()); }
  if (input.date || input.dream_date) { where.push("dream_date=?"); params.push(String(input.date || input.dream_date).slice(0, 10)); }
  params.push(clampInt(input.limit, 20, 1, 200));
  const rows = db.prepare(`
    SELECT * FROM dreammode_run
    WHERE ${where.join(" AND ")}
    ORDER BY dream_date DESC, created_at DESC
    LIMIT ?
  `).all(...params).map(rowToDreammodeRun);
  return { ok: true, count: rows.length, runs: rows };
}

function insertPromotedMemory(db, phase, input, runId, summary, selectedRefs) {
  if (!tableExists(db, "memory")) return null;
  const occurred = nowIso();
  const sourceRef = `memory_consolidation_run:${runId}`;
  const kind = "memory_consolidation";
  const actor = normalizeAgentName(input.agent_name || "mnemo");
  const topic = input.project || "memory_consolidation";
  const meta = {
    phase,
    source_ref: sourceRef,
    confidence: "derived",
    review_status: "draft",
    selected_refs: selectedRefs,
    canonical_model: canonicalMemoryModel(),
  };
  const hash = sha([kind, sourceRef, occurred, summary].join("|"));
  const hasLayer = ensureMemoryLayerColumn(db);
  const sql = hasLayer
    ? "INSERT OR IGNORE INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, layer, text, meta_json, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    : "INSERT OR IGNORE INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json, hash) VALUES (?,?,?,?,?,?,?,?,?,?)";
  const args = hasLayer
    ? [kind, "mnemo:rem", sourceRef, occurred, actor, topic, phase === "rem" ? 8 : 7, "semantic", summary, safeJson(meta, {}), hash]
    : [kind, "mnemo:rem", sourceRef, occurred, actor, topic, phase === "rem" ? 8 : 7, summary, safeJson(meta, {}), hash];
  const info = db.prepare(sql).run(...args);
  if (info.changes > 0) return info.lastInsertRowid;
  const row = db.prepare("SELECT id FROM memory WHERE hash=?").get(hash);
  return row ? row.id : null;
}

function memoryRemRun(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const phase = String(input.phase || "light").toLowerCase();
  if (!PHASES.has(phase)) return { error: "phase must be light|daily|deep|rem" };
  const days = phaseWindowDays(phase, input.days);
  const selection = selectRowsForPhase(db, phase, Object.assign({}, input, { days }));
  const counts = sourceCounts(db, Object.assign({}, input, { since: selection.since, days }));
  const dailyReflection = phase === "daily" ? runDailyReflection(db, input, selection) : null;
  const selectedRefs = selection.rows.map((row) => ({
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    subtype: row.subtype || null,
    at: row.at || null,
    importance: row.importance || null,
  }));
  const summary = buildSummary(phase, input, selection, counts);
  const info = db.prepare(`
    INSERT INTO memory_consolidation_run
      (scope, agent_name, project, phase, source_window_start, source_window_end, source_counts_json, selected_refs_json, summary, status, confidence, review_status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scopeName(input.scope),
    input.agent_name ? normalizeAgentName(input.agent_name) : null,
    input.project || null,
    phase,
    selection.since,
    selection.until,
    safeJson(counts, {}),
    safeJson(selectedRefs, []),
    summary,
    input.status || "draft",
    input.confidence || "derived",
    input.review_status || "draft",
    safeJson(Object.assign({}, input.meta || {}, { daily_reflection: dailyReflection, no_destructive_migration: true }), {})
  );
  const runId = info.lastInsertRowid;
  const promotedMemoryId = input.promote_to_memory === false ? null : insertPromotedMemory(db, phase, input, runId, summary, selectedRefs);
  if (promotedMemoryId) {
    db.prepare("UPDATE memory_consolidation_run SET promoted_memory_id=? WHERE id=?").run(promotedMemoryId, runId);
  }
  return {
    ok: true,
    run_id: runId,
    phase,
    status: input.status || "draft",
    confidence: input.confidence || "derived",
    review_status: input.review_status || "draft",
    selected_count: selectedRefs.length,
    source_counts: counts,
    promoted_memory_id: promotedMemoryId,
    daily_reflection: dailyReflection,
    summary,
    rule: "Draft consolidation only. Promote concrete facts through the proper Mnemo truth/rules/scar tools.",
  };
}

function rowToConsolidation(row) {
  if (!row) return null;
  return Object.assign({}, row, {
    source_counts: parseJson(row.source_counts_json, {}),
    selected_refs: parseJson(row.selected_refs_json, []),
    meta: parseJson(row.meta_json, {}),
  });
}

function memoryConsolidationList(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.phase) { where.push("phase=?"); params.push(String(input.phase).toLowerCase()); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  params.push(clampInt(input.limit, 50, 1, 500));
  const rows = db.prepare(`
    SELECT * FROM memory_consolidation_run
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params).map(rowToConsolidation);
  return { ok: true, count: rows.length, runs: rows };
}

function rowToDepartmentJournal(row) {
  if (!row) return null;
  return Object.assign({}, row, {
    dependencies: parseJson(row.dependencies_json, []),
    foreign_scope_requests: parseJson(row.foreign_scope_requests_json, []),
    meta: parseJson(row.meta_json, {}),
  });
}

function departmentJournalAdd(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const department = normalizeDepartment(input.department_name || input.department);
  const date = (input.journal_date || input.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const agent = input.agent_name ? normalizeAgentName(input.agent_name) : null;
  const info = db.prepare(`
    INSERT INTO department_journal
      (scope, department_name, agent_name, project, journal_date, progress, blockers, risks, open_questions, dependencies_json, foreign_scope_requests_json, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scopeName(input.scope),
    department,
    agent,
    input.project || null,
    date,
    textOrNull(input.progress || input.summary),
    textOrNull(input.blockers),
    textOrNull(input.risks),
    textOrNull(input.open_questions),
    safeJson(listInput(input.dependencies), []),
    safeJson(listInput(input.foreign_scope_requests || input.access_requests), []),
    input.status || "open",
    safeJson(input.meta || {}, {})
  );
  return { ok: true, id: info.lastInsertRowid, department_name: department, journal_date: date };
}

function departmentJournalList(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.department_name || input.department) { where.push("department_name=?"); params.push(normalizeDepartment(input.department_name || input.department)); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  if (input.since) { where.push("created_at>=?"); params.push(input.since); }
  params.push(clampInt(input.limit, 50, 1, 500));
  const rows = db.prepare(`
    SELECT * FROM department_journal
    WHERE ${where.join(" AND ")}
    ORDER BY journal_date DESC, created_at DESC
    LIMIT ?
  `).all(...params).map(rowToDepartmentJournal);
  return { ok: true, count: rows.length, journals: rows };
}

function rowToSleepNote(row) {
  return row ? Object.assign({}, row, { meta: parseJson(row.meta_json, {}) }) : null;
}

function agentSleepNoteAdd(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const agent = normalizeAgentName(input.agent_name);
  if (!agent) return { error: "agent_name required" };
  const date = (input.note_date || input.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const info = db.prepare(`
    INSERT INTO agent_sleep_note
      (scope, agent_name, project, note_date, learned, uncertainty, recurring_errors, needed_context, improvement_idea, source_ref, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scopeName(input.scope),
    agent,
    input.project || null,
    date,
    textOrNull(input.learned),
    textOrNull(input.uncertainty),
    textOrNull(input.recurring_errors),
    textOrNull(input.needed_context),
    textOrNull(input.improvement_idea),
    input.source_ref || null,
    input.status || "draft",
    safeJson(input.meta || {}, {})
  );
  return { ok: true, id: info.lastInsertRowid, agent_name: agent, note_date: date };
}

function agentSleepNoteList(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  if (input.since) { where.push("created_at>=?"); params.push(input.since); }
  params.push(clampInt(input.limit, 50, 1, 500));
  const rows = db.prepare(`
    SELECT * FROM agent_sleep_note
    WHERE ${where.join(" AND ")}
    ORDER BY note_date DESC, created_at DESC
    LIMIT ?
  `).all(...params).map(rowToSleepNote);
  return { ok: true, count: rows.length, notes: rows };
}

function normalizeProposalKind(value) {
  const kind = String(value || "project_memory").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const allowed = new Set(["decision", "rule", "project_memory", "risk", "owner_question", "scar", "runbook"]);
  return allowed.has(kind) ? kind : "project_memory";
}

function proposalTitle(input = {}) {
  const explicit = String(input.title || "").trim();
  if (explicit) return explicit.slice(0, 220);
  const body = String(input.body || input.summary || input.question || "").replace(/\s+/g, " ").trim();
  return (body ? body.slice(0, 180) : "Memory promotion proposal");
}

function rowToPromotion(row) {
  return row ? Object.assign({}, row, {
    evidence: parseJson(row.evidence_json, []),
    meta: parseJson(row.meta_json, {}),
  }) : null;
}

function memoryPromotionPropose(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const kind = normalizeProposalKind(input.proposal_kind || input.kind);
  const title = proposalTitle(input);
  const agent = input.agent_name ? normalizeAgentName(input.agent_name) : null;
  const info = db.prepare(`
    INSERT INTO memory_promotion_proposal
      (scope, proposal_kind, title, body, project, department_name, agent_name, source_kind, source_id, evidence_json, status, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    scopeName(input.scope),
    kind,
    title,
    textOrNull(input.body || input.summary || input.question),
    input.project || null,
    input.department_name ? normalizeDepartment(input.department_name) : null,
    agent,
    input.source_kind || null,
    input.source_id != null ? String(input.source_id) : null,
    safeJson(Array.isArray(input.evidence) ? input.evidence : [], []),
    input.status || "proposed",
    safeJson(input.meta || {}, {})
  );
  return { ok: true, id: info.lastInsertRowid, status: input.status || "proposed", proposal_kind: kind, title };
}

function insertPromotionMemory(db, proposal, decidedBy) {
  if (!tableExists(db, "memory")) return null;
  const kind = proposal.proposal_kind === "decision" ? "decision" : "manual";
  const occurred = nowIso();
  const sourceRef = `memory_promotion_proposal:${proposal.id}`;
  const text = [
    `Promotion kind: ${proposal.proposal_kind}`,
    `Title: ${proposal.title}`,
    proposal.body ? `Body: ${proposal.body}` : null,
    `Approved by: ${decidedBy || proposal.reviewer || "unknown"}`,
  ].filter(Boolean).join("\n");
  const meta = {
    proposal_id: proposal.id,
    proposal_kind: proposal.proposal_kind,
    confidence: "confirmed",
    review_status: "approved",
    source_kind: proposal.source_kind,
    source_id: proposal.source_id,
  };
  const hash = sha([kind, sourceRef, occurred, text].join("|"));
  const hasLayer = ensureMemoryLayerColumn(db);
  const sql = hasLayer
    ? "INSERT OR IGNORE INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, layer, text, meta_json, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    : "INSERT OR IGNORE INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json, hash) VALUES (?,?,?,?,?,?,?,?,?,?)";
  const args = hasLayer
    ? [kind, "mnemo:promotion", sourceRef, occurred, decidedBy || proposal.agent_name || "mnemo", proposal.project || "memory_promotion", 9, "semantic", text, safeJson(meta, {}), hash]
    : [kind, "mnemo:promotion", sourceRef, occurred, decidedBy || proposal.agent_name || "mnemo", proposal.project || "memory_promotion", 9, text, safeJson(meta, {}), hash];
  const info = db.prepare(sql).run(...args);
  return info.changes > 0 ? info.lastInsertRowid : ((db.prepare("SELECT id FROM memory WHERE hash=?").get(hash) || {}).id || null);
}

function insertPromotionDecision(db, proposal, decidedBy) {
  if (!tableExists(db, "decision_log")) return null;
  try {
    const info = db.prepare("INSERT INTO decision_log (scope, title, body, decided_by, agents_involved, entities_affected) VALUES (?,?,?,?,?,?)")
      .run(proposal.scope || DEFAULT_SCOPE, proposal.title, proposal.body || "", decidedBy || proposal.reviewer || "mnemo", proposal.agent_name || null, proposal.project || null);
    return info.lastInsertRowid;
  } catch {
    return null;
  }
}

function memoryPromotionDecide(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const id = parseInt(input.id || input.proposal_id, 10);
  const status = String(input.status || input.decision || "").toLowerCase();
  const reviewer = normalizeAgentName(input.reviewer || input.decided_by || input.approved_by);
  if (!id || !reviewer || !["approved", "rejected", "promoted"].includes(status)) {
    return { error: "id + reviewer + status(approved|rejected|promoted) required" };
  }
  const row = db.prepare("SELECT * FROM memory_promotion_proposal WHERE id=?").get(id);
  if (!row) return { error: "proposal_not_found", id };
  const proposal = rowToPromotion(row);
  let promotedRef = { kind: null, id: null };
  if (status === "promoted" || (status === "approved" && input.promote === true)) {
    if (proposal.proposal_kind === "decision") {
      const decisionId = insertPromotionDecision(db, proposal, reviewer);
      if (decisionId) promotedRef = { kind: "decision_log", id: String(decisionId) };
    }
    if (!promotedRef.id) {
      const memoryId = insertPromotionMemory(db, proposal, reviewer);
      if (memoryId) promotedRef = { kind: "memory", id: String(memoryId) };
    }
  }
  db.prepare(`
    UPDATE memory_promotion_proposal
    SET status=?, reviewer=?, review_notes=?, promoted_ref_kind=?, promoted_ref_id=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=COALESCE(?, meta_json)
    WHERE id=?
  `).run(
    status,
    reviewer,
    input.review_notes || input.reason || null,
    promotedRef.kind,
    promotedRef.id,
    input.meta ? safeJson(input.meta, {}) : null,
    id
  );
  return { ok: true, id, status, reviewer, promoted_ref: promotedRef };
}

function memoryPromotionList(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const where = ["scope=?"];
  const params = [scopeName(input.scope)];
  if (input.status) { where.push("status=?"); params.push(input.status); }
  if (input.proposal_kind || input.kind) { where.push("proposal_kind=?"); params.push(normalizeProposalKind(input.proposal_kind || input.kind)); }
  if (input.project) { where.push("project=?"); params.push(input.project); }
  if (input.department_name) { where.push("department_name=?"); params.push(normalizeDepartment(input.department_name)); }
  if (input.agent_name) { where.push("agent_name=?"); params.push(normalizeAgentName(input.agent_name)); }
  params.push(clampInt(input.limit, 50, 1, 500));
  const rows = db.prepare(`
    SELECT * FROM memory_promotion_proposal
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params).map(rowToPromotion);
  return { ok: true, count: rows.length, proposals: rows };
}

function activeClaims(db, input = {}, limit = 20) {
  if (!tableExists(db, "work_claim")) return [];
  const where = ["status IN ('active','stale')"];
  const params = [];
  if (input.project) { where.push("project=?"); params.push(input.project); }
  params.push(limit);
  return getRows(db, "work_claim", `
    SELECT id, project, agent_name, claim_kind, scope_value, scope_key, summary, claimed_at, heartbeat_at, expires_at, status
    FROM work_claim
    WHERE ${where.join(" AND ")}
    ORDER BY CASE status WHEN 'stale' THEN 2 ELSE 1 END DESC, expires_at ASC
    LIMIT ?
  `, params);
}

function pendingApprovals(db, input = {}, limit = 20) {
  if (!tableExists(db, "approval_request")) return [];
  const where = ["status='pending'"];
  const params = [];
  if (input.project) { where.push("(project=? OR project IS NULL)"); params.push(input.project); }
  params.push(limit);
  return getRows(db, "approval_request", `
    SELECT id, project, request_kind, resource_kind, resource_key, permission, requester_agent, owner_agent, reason, requested_at, expires_at, status
    FROM approval_request
    WHERE ${where.join(" AND ")}
    ORDER BY requested_at DESC
    LIMIT ?
  `, params);
}

function companyRemBrief(db, input = {}) {
  ensureMemoryConsolidationSchema(db);
  const days = clampInt(input.days, 1, 1, 30);
  const since = input.since || new Date(Date.now() - days * 86400000).toISOString();
  const journals = departmentJournalList(db, Object.assign({}, input, { since, limit: 30 })).journals || [];
  const sleepNotes = agentSleepNoteList(db, Object.assign({}, input, { since, limit: 30 })).notes || [];
  const proposals = memoryPromotionList(db, Object.assign({}, input, { status: "proposed", limit: 50 })).proposals || [];
  const claims = activeClaims(db, input, 30);
  const approvals = pendingApprovals(db, input, 30);
  const status = memoryLayerStatus(db, Object.assign({}, input, { since, days }));
  const remRuns = memoryConsolidationList(db, Object.assign({}, input, { phase: "rem", limit: 5 })).runs || [];

  const lines = [];
  lines.push("# Coordinator REM Brief");
  lines.push("");
  lines.push(`Window: ${since} -> ${nowIso()}`);
  if (input.project) lines.push(`Project: ${input.project}`);
  lines.push("");
  lines.push("## Situation");
  lines.push(`- Department journal entries: ${journals.length}`);
  lines.push(`- Agent sleep notes: ${sleepNotes.length}`);
  lines.push(`- Promotion proposals needing review: ${proposals.length}`);
  lines.push(`- Active/stale claims: ${claims.length}`);
  lines.push(`- Pending approvals: ${approvals.length}`);
  lines.push(`- Recent REM runs: ${remRuns.length}`);
  lines.push("");

  const pushRows = (title, rows, formatter, max = 10) => {
    lines.push(`## ${title}`);
    if (!rows.length) lines.push("- none");
    for (const row of rows.slice(0, max)) lines.push(formatter(row));
    lines.push("");
  };
  pushRows("Open Promotion Proposals", proposals, (p) => `- #${p.id} ${p.proposal_kind} ${p.project || ""} ${p.title}`.trim(), 12);
  pushRows("Pending Approvals", approvals, (a) => `- #${a.id} ${a.requester_agent} requests ${a.permission} on ${a.resource_kind}:${a.resource_key}${a.owner_agent ? ` from ${a.owner_agent}` : ""}`, 12);
  pushRows("Claims", claims, (c) => `- #${c.id} ${c.status} ${c.agent_name} ${c.claim_kind || "scope"}:${c.scope_value || c.scope_key || c.file_path || ""} until ${c.expires_at || "unknown"}`, 12);
  pushRows("Department Journals", journals, (j) => `- #${j.id} ${j.department_name}${j.project ? `/${j.project}` : ""}: ${compactContent(j.progress || j.blockers || j.risks || "", 180) || "(empty)"}`, 8);
  pushRows("Agent Sleep Notes", sleepNotes, (n) => `- #${n.id} ${n.agent_name}${n.project ? `/${n.project}` : ""}: ${compactContent(n.learned || n.uncertainty || n.recurring_errors || "", 180) || "(empty)"}`, 8);
  lines.push("## Required Coordinator Decisions");
  if (proposals.length) lines.push("- Review proposed promotions and decide approved/rejected/promoted.");
  if (approvals.length) lines.push("- Decide pending approvals or route to owners.");
  if (claims.some((c) => c.status === "stale")) lines.push("- Recover or transfer stale claims.");
  if (!proposals.length && !approvals.length && !claims.some((c) => c.status === "stale")) lines.push("- none");
  lines.push("");
  lines.push("Rule: this brief is management input. It does not promote truth by itself.");

  const markdown = lines.join("\n");
  let briefId = null;
  if (input.write_brief === true && tableExists(db, "agent_brief")) {
    const coordinator = normalizeAgentName(input.coordinator_agent || "dieter");
    const info = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
      .run(coordinator, normalizeAgentName(input.source_agent || "mnemo-rem"), markdown, safeJson({ kind: "company_rem_brief", project: input.project || null, source_counts: status.source_counts }, {}));
    briefId = info.lastInsertRowid;
  }
  return {
    ok: true,
    generated_at: nowIso(),
    scope: scopeName(input.scope),
    project: input.project || null,
    markdown,
    brief_id: briefId,
    counts: {
      journals: journals.length,
      sleep_notes: sleepNotes.length,
      proposals: proposals.length,
      claims: claims.length,
      approvals: approvals.length,
      rem_runs: remRuns.length,
    },
    proposals,
    pending_approvals: approvals,
    active_claims: claims,
    status,
  };
}

const MEMORY_CONSOLIDATION_TOOL_DEFS = {
  mem_memory_layer_status: {
    description: "Show Mnemo's canonical memory layers: session, daily, long_term, recall, and REM. Use this before adding any OpenClaw-like memory path.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, days: { type: "integer", default: 7 }, since: { type: "string" } } },
  },
  mem_memory_rem_plan: {
    description: "Return the next safe Memory/REM consolidation phases and exact Mnemo tool calls. Does not write.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, days: { type: "integer" }, date: { type: "string" } } },
  },
  mem_memory_rem_run: {
    description: "Run a deterministic Mnemo memory consolidation pass: light, daily, deep, or rem. Writes a draft run and a semantic memory_consolidation row; never deletes or rewrites old facts.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        agent_name: { type: "string" },
        project: { type: "string" },
        phase: { type: "string", enum: ["light", "daily", "deep", "rem"], default: "light" },
        days: { type: "integer" },
        date: { type: "string" },
        limit: { type: "integer" },
        status: { type: "string" },
        confidence: { type: "string" },
        review_status: { type: "string" },
        promote_to_memory: { type: "boolean", default: true },
        meta: { type: "object" },
      },
    },
  },
  mem_memory_consolidation_list: {
    description: "List memory consolidation runs with selected source refs, source counts, status, confidence, and promoted memory id.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, phase: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } },
  },
  mem_department_journal_add: {
    description: "Append a department diary entry: progress, blockers, risks, open questions, dependencies, and foreign-scope requests. Not official truth until promoted.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        department_name: { type: "string" },
        department: { type: "string" },
        agent_name: { type: "string" },
        project: { type: "string" },
        journal_date: { type: "string" },
        date: { type: "string" },
        progress: { type: "string" },
        summary: { type: "string" },
        blockers: { type: "string" },
        risks: { type: "string" },
        open_questions: { type: "string" },
        dependencies: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        foreign_scope_requests: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        access_requests: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
        status: { type: "string" },
        meta: { type: "object" },
      },
      required: ["department_name"],
    },
  },
  mem_department_journal_list: {
    description: "List department diary entries for REM, handoff, and coordinator review.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, department_name: { type: "string" }, department: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, status: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
  },
  mem_agent_sleep_note_add: {
    description: "Append personal agent REM notes: learned, uncertainty, recurring errors, needed context, and improvement ideas. Not official truth until promoted.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        agent_name: { type: "string" },
        project: { type: "string" },
        note_date: { type: "string" },
        date: { type: "string" },
        learned: { type: "string" },
        uncertainty: { type: "string" },
        recurring_errors: { type: "string" },
        needed_context: { type: "string" },
        improvement_idea: { type: "string" },
        source_ref: { type: "string" },
        status: { type: "string" },
        meta: { type: "object" },
      },
      required: ["agent_name"],
    },
  },
  mem_agent_sleep_note_list: {
    description: "List personal agent REM notes.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, status: { type: "string" }, since: { type: "string" }, limit: { type: "integer" } } },
  },
  mem_memory_promotion_propose: {
    description: "Propose a REM finding for official promotion. Creates a review item only; it does not change company truth.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        proposal_kind: { type: "string", enum: ["decision", "rule", "project_memory", "risk", "owner_question", "scar", "runbook"] },
        kind: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        summary: { type: "string" },
        question: { type: "string" },
        project: { type: "string" },
        department_name: { type: "string" },
        agent_name: { type: "string" },
        source_kind: { type: "string" },
        source_id: { type: "string" },
        evidence: { type: "array", items: { type: "object" } },
        status: { type: "string" },
        meta: { type: "object" },
      },
    },
  },
  mem_memory_promotion_list: {
    description: "List REM promotion proposals waiting for coordinator/owner review.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, status: { type: "string" }, proposal_kind: { type: "string" }, kind: { type: "string" }, project: { type: "string" }, department_name: { type: "string" }, agent_name: { type: "string" }, limit: { type: "integer" } } },
  },
  mem_memory_promotion_decide: {
    description: "Approve, reject, or promote a REM promotion proposal. Promotion is an explicit Mnemo API action with reviewer attribution.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        proposal_id: { type: "integer" },
        status: { type: "string", enum: ["approved", "rejected", "promoted"] },
        decision: { type: "string" },
        reviewer: { type: "string" },
        decided_by: { type: "string" },
        approved_by: { type: "string" },
        review_notes: { type: "string" },
        reason: { type: "string" },
        promote: { type: "boolean" },
        meta: { type: "object" },
      },
      required: ["id", "reviewer", "status"],
    },
  },
  mem_company_rem_brief: {
    description: "Generate a coordinator morning brief from department journals, sleep notes, promotion proposals, active claims, pending approvals, and REM state. Optionally writes an agent_brief.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, project: { type: "string" }, days: { type: "integer", default: 1 }, since: { type: "string" }, write_brief: { type: "boolean" }, coordinator_agent: { type: "string" }, source_agent: { type: "string" } } },
  },
  mem_dreammode_run: {
    description: "Run the nightly human-style Dreammode: classify the day into wrong made, right made, praise received, called out, broke things, and lessons. Also runs REM phases by default. Draft only; no automatic truth promotion.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        agent_name: { type: "string" },
        project: { type: "string" },
        dream_date: { type: "string" },
        date: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "integer" },
        force: { type: "boolean" },
        write_brief: { type: "boolean", default: true },
        coordinator_agent: { type: "string" },
        run_rem_phases: { type: "boolean", default: true },
        phases: { type: "array", items: { type: "string", enum: ["light", "daily", "deep", "rem"] } },
        rem_days: { type: "integer", default: 7 },
        status: { type: "string" },
        meta: { type: "object" },
      },
    },
  },
  mem_dreammode_status: {
    description: "List recent Dreammode runs with human-style buckets and lessons.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, agent_name: { type: "string" }, project: { type: "string" }, dream_date: { type: "string" }, date: { type: "string" }, limit: { type: "integer" } } },
  },
};

function handleMemoryConsolidationTool(db, name, input = {}) {
  if (name === "mem_memory_layer_status") return { handled: true, result: memoryLayerStatus(db, input || {}) };
  if (name === "mem_memory_rem_plan") return { handled: true, result: memoryRemPlan(db, input || {}) };
  if (name === "mem_memory_rem_run") return { handled: true, result: memoryRemRun(db, input || {}) };
  if (name === "mem_memory_consolidation_list") return { handled: true, result: memoryConsolidationList(db, input || {}) };
  if (name === "mem_department_journal_add") return { handled: true, result: departmentJournalAdd(db, input || {}) };
  if (name === "mem_department_journal_list") return { handled: true, result: departmentJournalList(db, input || {}) };
  if (name === "mem_agent_sleep_note_add") return { handled: true, result: agentSleepNoteAdd(db, input || {}) };
  if (name === "mem_agent_sleep_note_list") return { handled: true, result: agentSleepNoteList(db, input || {}) };
  if (name === "mem_memory_promotion_propose") return { handled: true, result: memoryPromotionPropose(db, input || {}) };
  if (name === "mem_memory_promotion_list") return { handled: true, result: memoryPromotionList(db, input || {}) };
  if (name === "mem_memory_promotion_decide") return { handled: true, result: memoryPromotionDecide(db, input || {}) };
  if (name === "mem_company_rem_brief") return { handled: true, result: companyRemBrief(db, input || {}) };
  if (name === "mem_dreammode_run") return { handled: true, result: dreammodeRun(db, input || {}) };
  if (name === "mem_dreammode_status") return { handled: true, result: dreammodeStatus(db, input || {}) };
  return { handled: false };
}

module.exports = {
  MEMORY_CONSOLIDATION_TOOL_DEFS,
  ensureMemoryConsolidationSchema,
  handleMemoryConsolidationTool,
  memoryLayerStatus,
  memoryRemPlan,
  memoryRemRun,
  memoryConsolidationList,
  departmentJournalAdd,
  departmentJournalList,
  agentSleepNoteAdd,
  agentSleepNoteList,
  memoryPromotionPropose,
  memoryPromotionList,
  memoryPromotionDecide,
  companyRemBrief,
  dreammodeRun,
  dreammodeStatus,
};
