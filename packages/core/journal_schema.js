/**
 * Shared journal schema DDL — single source of truth for tables, indexes,
 * and triggers used by ensureUniversalJournalSchema in daemon.js and mcp.js.
 *
 * Usage:  const { ensureUniversalJournalSchema } = require("./journal_schema");
 *         ensureUniversalJournalSchema(db);
 */

const { ensureTeamQualityTables } = require("./team_quality_ops");
const { ensureRuntimeGovernanceSchema } = require("./runtime_governance");

function ensureUniversalJournalSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  channel TEXT,
  direction TEXT NOT NULL,
  speaker TEXT,
  content TEXT NOT NULL,
  meta_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ref_kind TEXT,
  ref_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcript_occurred ON transcript(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_speaker ON transcript(speaker, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_source_channel ON transcript(source, channel, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mnemo_event_journal (
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
CREATE INDEX IF NOT EXISTS idx_event_journal_occurred ON mnemo_event_journal(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_source_channel ON mnemo_event_journal(source, channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_actor ON mnemo_event_journal(actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_kind ON mnemo_event_journal(event_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_ref ON mnemo_event_journal(ref_kind, ref_id);

CREATE TABLE IF NOT EXISTS capture_receipt (
  dedupe_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  channel TEXT,
  direction TEXT NOT NULL DEFAULT 'internal',
  actor TEXT,
  actor_id TEXT,
  event_kind TEXT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  thread_id TEXT,
  occurred_at TEXT NOT NULL,
  content_hash TEXT,
  content_preview TEXT,
  event_id INTEGER,
  transcript_id INTEGER,
  memory_id INTEGER,
  status TEXT NOT NULL DEFAULT 'captured',
  seen_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_source_channel ON capture_receipt(source, channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_ref ON capture_receipt(ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_capture_actor ON capture_receipt(actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_status ON capture_receipt(status, last_seen_at DESC);

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
);
CREATE INDEX IF NOT EXISTS idx_media_occurred ON media_asset(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_project ON media_asset(project, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media_asset(media_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_thread ON media_asset(thread_id, occurred_at DESC);

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

CREATE TABLE IF NOT EXISTS connector_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT NOT NULL,
  owner_agent TEXT,
  auth_type TEXT,
  secret_ref TEXT,
  rate_limit TEXT,
  allowed_agents_json TEXT,
  read_enabled INTEGER NOT NULL DEFAULT 1,
  write_enabled INTEGER NOT NULL DEFAULT 0,
  live_write_enabled INTEGER NOT NULL DEFAULT 0,
  lifecycle_status TEXT NOT NULL DEFAULT 'planned',
  approval_class TEXT NOT NULL DEFAULT 'normal_fix',
  endpoint TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_summary TEXT,
  last_health_at TEXT,
  last_verified_at TEXT,
  runbook_json TEXT,
  dependency_json TEXT,
  rollback_json TEXT,
  notes TEXT,
  meta_json TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, system_name)
);
CREATE INDEX IF NOT EXISTS idx_connector_project ON connector_registry(project, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_connector_owner ON connector_registry(owner_agent, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_connector_health ON connector_registry(health_status, last_health_at DESC);

CREATE TABLE IF NOT EXISTS agent_passport (
  agent_name TEXT PRIMARY KEY,
  display_name TEXT,
  department_name TEXT,
  lane TEXT,
  allowed_projects_json TEXT,
  allowed_systems_json TEXT,
  allowed_environments_json TEXT,
  capability_matrix_json TEXT,
  live_write INTEGER NOT NULL DEFAULT 0,
  review_required INTEGER NOT NULL DEFAULT 1,
  needs_handoff INTEGER NOT NULL DEFAULT 1,
  can_deploy INTEGER NOT NULL DEFAULT 0,
  can_touch_auth INTEGER NOT NULL DEFAULT 0,
  can_touch_billing INTEGER NOT NULL DEFAULT 0,
  can_manage_production INTEGER NOT NULL DEFAULT 0,
  approval_class TEXT NOT NULL DEFAULT 'read_only',
  source_kind TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  meta_json TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_passport_department ON agent_passport(department_name, status);
CREATE INDEX IF NOT EXISTS idx_passport_lane ON agent_passport(lane, status);

CREATE TABLE IF NOT EXISTS drift_check_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT,
  drift_kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'open',
  freshness_status TEXT NOT NULL DEFAULT 'fresh',
  expected TEXT,
  actual TEXT,
  details_json TEXT,
  source_ref TEXT,
  checked_by TEXT,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_drift_project_status ON drift_check_result(project, status, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_system_status ON drift_check_result(system_name, status, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_kind_status ON drift_check_result(drift_kind, status, checked_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_window (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT,
  title TEXT NOT NULL,
  window_kind TEXT NOT NULL DEFAULT 'maintenance',
  risk_class TEXT NOT NULL DEFAULT 'normal_fix',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  notes TEXT,
  approved_by TEXT,
  updated_by TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_scope_time ON maintenance_window(scope, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_project_status ON maintenance_window(project, status, starts_at DESC);

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

CREATE TABLE IF NOT EXISTS artifact_lock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT,
  artifact_kind TEXT NOT NULL DEFAULT 'url',
  artifact_key TEXT NOT NULL,
  artifact_label TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  locked_by TEXT,
  approved_by TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  notes TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_artifact_lock_scope_status ON artifact_lock(scope, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_lock_project_status ON artifact_lock(project, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_lock_key_status ON artifact_lock(artifact_kind, artifact_key, status);

CREATE TABLE IF NOT EXISTS secret_rotation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  system_name TEXT NOT NULL,
  secret_ref TEXT,
  project TEXT,
  rotated_by TEXT,
  verified_by TEXT,
  rotation_kind TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'rotated',
  rotated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  verified_at TEXT,
  notes TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_secret_rotation_system ON secret_rotation_log(system_name, rotated_at DESC);
CREATE INDEX IF NOT EXISTS idx_secret_rotation_secret_ref ON secret_rotation_log(secret_ref, rotated_at DESC);

CREATE TABLE IF NOT EXISTS dependency_freeze (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT,
  freeze_kind TEXT NOT NULL DEFAULT 'dependency_freeze',
  reason TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  approved_by TEXT,
  updated_by TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dependency_freeze_scope_status ON dependency_freeze(scope, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dependency_freeze_project ON dependency_freeze(project, status);

CREATE TABLE IF NOT EXISTS ops_incident (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'default',
  project TEXT,
  system_name TEXT,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'open',
  cause TEXT,
  fix_summary TEXT,
  prevention TEXT,
  source_agent TEXT,
  decision_id INTEGER,
  quality_finding_id INTEGER,
  scar_pattern_id INTEGER,
  evidence_json TEXT,
  meta_json TEXT,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_incident_project_status ON ops_incident(project, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_incident_system_status ON ops_incident(system_name, status, opened_at DESC);

CREATE TRIGGER IF NOT EXISTS mnemo_journal_access_ai AFTER INSERT ON access_inventory BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('access_inventory', NEW.project, 'internal', NEW.updated_by, 'access_inventory_insert', 'access_inventory', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.system_name, '') || ' ' || COALESCE(NEW.access_kind, '') || ' ' || COALESCE(NEW.entrypoint, ''), NULL, json_object('scope', NEW.scope, 'secret_ref', NEW.secret_ref, 'allowed_agents', NEW.allowed_agents), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_access_au AFTER UPDATE ON access_inventory BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('access_inventory', NEW.project, 'internal', NEW.updated_by, 'access_inventory_update', 'access_inventory', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.system_name, '') || ' ' || COALESCE(NEW.access_kind, '') || ' ' || COALESCE(NEW.entrypoint, ''), NULL, json_object('scope', NEW.scope, 'secret_ref', NEW.secret_ref, 'allowed_agents', NEW.allowed_agents), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_access_event_ai AFTER INSERT ON access_event BEGIN
  INSERT INTO mnemo_event_journal
    (source, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('access_event', 'internal', NEW.actor, 'access_event_insert', 'access_event', CAST(NEW.id AS TEXT), NEW.status, NEW.notes, NULL, NEW.meta_json, COALESCE(NEW.occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_connector_ai AFTER INSERT ON connector_registry BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('connector_registry', NEW.project, 'internal', NEW.updated_by, 'connector_insert', 'connector_registry', CAST(NEW.id AS TEXT), NEW.lifecycle_status, COALESCE(NEW.system_name, ''), NULL, json_object('scope', NEW.scope, 'approval_class', NEW.approval_class, 'owner_agent', NEW.owner_agent, 'health_status', NEW.health_status), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_connector_au AFTER UPDATE ON connector_registry BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('connector_registry', NEW.project, 'internal', NEW.updated_by, 'connector_update', 'connector_registry', CAST(NEW.id AS TEXT), NEW.lifecycle_status, COALESCE(NEW.system_name, ''), NULL, json_object('scope', NEW.scope, 'approval_class', NEW.approval_class, 'owner_agent', NEW.owner_agent, 'health_status', NEW.health_status), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_passport_ai AFTER INSERT ON agent_passport BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_passport', NEW.department_name, 'internal', NEW.updated_by, 'agent_passport_insert', 'agent_passport', NEW.agent_name, NEW.status, COALESCE(NEW.lane, ''), NULL, json_object('approval_class', NEW.approval_class, 'live_write', NEW.live_write, 'can_deploy', NEW.can_deploy), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_passport_au AFTER UPDATE ON agent_passport BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_passport', NEW.department_name, 'internal', NEW.updated_by, 'agent_passport_update', 'agent_passport', NEW.agent_name, NEW.status, COALESCE(NEW.lane, ''), NULL, json_object('approval_class', NEW.approval_class, 'live_write', NEW.live_write, 'can_deploy', NEW.can_deploy), NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_drift_ai AFTER INSERT ON drift_check_result BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('drift_check', NEW.project, 'internal', NEW.checked_by, 'drift_check_insert', 'drift_check_result', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.drift_kind, '') || CASE WHEN NEW.system_name IS NULL THEN '' ELSE ' ' || NEW.system_name END, NULL, json_object('scope', NEW.scope, 'severity', NEW.severity, 'freshness_status', NEW.freshness_status), NEW.checked_at);
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    (COALESCE(NEW.source, 'memory'), NULL, 'internal', NEW.actor, NEW.actor_id, 'memory_insert', 'memory', CAST(NEW.id AS TEXT), NEW.source_ref, 'inserted', NEW.text, NULL, NEW.meta_json, COALESCE(NEW.occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_transcript_ai AFTER INSERT ON transcript BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    (COALESCE(NEW.source, 'transcript'), NEW.channel, COALESCE(NEW.direction, 'internal'), NEW.speaker, 'transcript_insert', 'transcript', CAST(NEW.id AS TEXT), NEW.ref_id, 'inserted', NEW.content, NULL, NEW.meta_json, COALESCE(NEW.occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_brief_ai AFTER INSERT ON agent_brief BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_brief', NEW.channel, 'internal', NEW.source_agent, 'brief_insert', 'agent_brief', CAST(NEW.id AS TEXT), NEW.status, NEW.content, NULL, NEW.meta_json, COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_brief_au AFTER UPDATE ON agent_brief BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_brief', NEW.channel, 'internal', NEW.source_agent, 'brief_update', 'agent_brief', CAST(NEW.id AS TEXT), NEW.status, COALESCE(NEW.outcome, 'status=' || COALESCE(NEW.status, 'unknown')), NULL, NEW.meta_json, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_action_ai AFTER INSERT ON agent_action BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_action', NEW.topic, 'internal', NEW.agent_name, 'action_insert', 'agent_action', CAST(NEW.id AS TEXT), NEW.session_id, NEW.status, COALESCE(NEW.action_kind, '') || CASE WHEN NEW.target IS NULL THEN '' ELSE ' ' || NEW.target END, NEW.payload_json, NEW.meta_json, COALESCE(NEW.started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;

CREATE TRIGGER IF NOT EXISTS mnemo_journal_action_au AFTER UPDATE ON agent_action BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    ('agent_action', NEW.topic, 'internal', NEW.agent_name, 'action_update', 'agent_action', CAST(NEW.id AS TEXT), NEW.session_id, NEW.status, COALESCE(NEW.action_kind, '') || CASE WHEN NEW.target IS NULL THEN '' ELSE ' ' || NEW.target END, NEW.result_json, NEW.meta_json, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
  `);
}

function ensureProjectRegistryTable(db) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS project_registry (name TEXT PRIMARY KEY, domain TEXT, repo TEXT, server TEXT, pm2_processes TEXT, nginx_files TEXT, admin_url TEXT, auth_system TEXT, stripe_account TEXT, stripe_product_ids TEXT, vat_status TEXT, vat_id TEXT, langs TEXT, live_status TEXT, live_url TEXT, staging_url TEXT, last_deploy_at TEXT, missing_blocks TEXT, health_checklist TEXT, notes TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_by TEXT)");
  } catch {}
}

function ensureFirmOpsTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS project_rules (
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS quality_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  title TEXT NOT NULL,
  url TEXT,
  expected TEXT,
  actual TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_agent TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolved_by TEXT,
  fix_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_quality_project_status ON quality_finding(project, status, severity);
CREATE INDEX IF NOT EXISTS idx_quality_category ON quality_finding(category, status);
CREATE TABLE IF NOT EXISTS session_handoff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  project TEXT,
  summary TEXT NOT NULL,
  changed_files TEXT,
  tests TEXT,
  deploys TEXT,
  blockers TEXT,
  next_actions TEXT,
  claims_released TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_handoff_agent_project ON session_handoff(agent_name, project, created_at DESC);
`);
  try {
    const accessCols = db.prepare("PRAGMA table_info(access_inventory)").all().map((c) => c.name);
    const accessAdds = [
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
    for (const [name, ddl] of accessAdds) {
      if (!accessCols.includes(name)) db.exec(`ALTER TABLE access_inventory ADD COLUMN ${name} ${ddl}`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_access_route_kind ON access_inventory(route_kind, direct_allowed, status)");
  } catch {}
  try {
    const mediaCols = db.prepare("PRAGMA table_info(media_asset)").all().map((c) => c.name);
    if (!mediaCols.includes("original_file_name")) db.exec("ALTER TABLE media_asset ADD COLUMN original_file_name TEXT");
    if (!mediaCols.includes("canonical_name")) db.exec("ALTER TABLE media_asset ADD COLUMN canonical_name TEXT");
    if (!mediaCols.includes("storage_path")) db.exec("ALTER TABLE media_asset ADD COLUMN storage_path TEXT");
    if (!mediaCols.includes("content_ref")) db.exec("ALTER TABLE media_asset ADD COLUMN content_ref TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_media_canonical ON media_asset(canonical_name)");
  } catch {}
  ensureTeamQualityTables(db);
  ensureRuntimeGovernanceSchema(db);
}

module.exports = { ensureUniversalJournalSchema, ensureProjectRegistryTable, ensureFirmOpsTables };
