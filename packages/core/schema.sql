-- Mnemo - Persistent Memory MCP
-- SQLite schema with FTS5 + sqlite-vec for embeddings
-- All write paths converge here. Single source of truth.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- =========================================================================
-- Core: every piece of memory is a "memory" row, polymorphic by `kind`.
-- =========================================================================
CREATE TABLE IF NOT EXISTS memory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,                -- message | edit | tool_call | scar | decision | dream | memory_md | web_fetch | ssh_cmd | manual
  source          TEXT NOT NULL,                -- telegram | terminal | session_jsonl | hook | manual | hermes | scraper
  source_ref      TEXT,                         -- session_id, telegram message_id, file path, etc.
  occurred_at     TEXT NOT NULL,                -- ISO8601 UTC timestamp
  ingested_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor           TEXT,                         -- "owner" | "agent" | "system" | tool name | agent name
  actor_id        TEXT,                         -- telegram user_id, session id, etc.
  topic           TEXT,                         -- optional clustering key (e.g. "project-a", "billing")
  importance      INTEGER NOT NULL DEFAULT 5,   -- 0=ephemeral 5=normal 9=must-remember 10=foundational
  text            TEXT NOT NULL,                -- canonical content (markdown/plain)
  meta_json       TEXT,                         -- arbitrary JSON: original payload, file path, diff hash, etc.
  hash            TEXT,                         -- sha256 of (kind|source_ref|occurred_at|text) for dedup
  embedding_id    INTEGER,                      -- foreign key into memory_embedding when computed
  UNIQUE(hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory(source);
CREATE INDEX IF NOT EXISTS idx_memory_occurred ON memory(occurred_at);
CREATE INDEX IF NOT EXISTS idx_memory_actor ON memory(actor);
CREATE INDEX IF NOT EXISTS idx_memory_topic ON memory(topic);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance);

-- =========================================================================
-- FTS5 virtual table for full-text search (BM25 ranking)
-- =========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text,
  topic,
  actor,
  kind UNINDEXED,
  content='memory',
  content_rowid='id',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, text, topic, actor, kind)
  VALUES (new.id, new.text, COALESCE(new.topic,''), COALESCE(new.actor,''), new.kind);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text, topic, actor, kind)
  VALUES('delete', old.id, old.text, COALESCE(old.topic,''), COALESCE(old.actor,''), old.kind);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text, topic, actor, kind)
  VALUES('delete', old.id, old.text, COALESCE(old.topic,''), COALESCE(old.actor,''), old.kind);
  INSERT INTO memory_fts(rowid, text, topic, actor, kind)
  VALUES (new.id, new.text, COALESCE(new.topic,''), COALESCE(new.actor,''), new.kind);
END;

-- =========================================================================
-- Embeddings (vector similarity). Loaded lazily — not all memory rows
-- need embeddings. Use sqlite-vec extension at runtime.
-- =========================================================================
CREATE TABLE IF NOT EXISTS memory_embedding (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,                    -- e.g. "all-MiniLM-L6-v2", "text-embedding-3-small"
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,                    -- packed float32 vector
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_emb_memory ON memory_embedding(memory_id);
CREATE INDEX IF NOT EXISTS idx_emb_model ON memory_embedding(model);

-- =========================================================================
-- Knowledge graph: typed edges between memory rows
-- =========================================================================
CREATE TABLE IF NOT EXISTS memory_link (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- replies_to | references | corrects | resolves | partOf | causedBy | similar
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_link_from ON memory_link(from_id);
CREATE INDEX IF NOT EXISTS idx_link_to ON memory_link(to_id);

-- =========================================================================
-- Health-monitor: which writers are alive?
-- =========================================================================
CREATE TABLE IF NOT EXISTS writer_health (
  writer        TEXT PRIMARY KEY,               -- "telegram-poller" | "session-jsonl-tail" | "memory-md-watcher" | etc.
  last_write_at TEXT,                           -- last successful insert from this source
  last_check_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rows_written  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'unknown',-- alive | stale | dead
  notes         TEXT
);

-- =========================================================================
-- Universal event journal: the append-only receipt layer.
-- This is intentionally lower-level than memory/transcript/action. Every
-- bridge, tool call, brief transition, action update, and raw channel event can
-- leave a receipt here, even when it is too noisy to promote to semantic memory.
-- =========================================================================
CREATE TABLE IF NOT EXISTS mnemo_event_journal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,                 -- http-tool | mcp-tool | telegram | trigger:agent_action | ...
  channel         TEXT,
  direction       TEXT NOT NULL DEFAULT 'internal', -- inbound | outbound | internal
  actor           TEXT,
  actor_id        TEXT,
  event_kind      TEXT NOT NULL,                 -- tool_call | tool_result | brief_insert | message | ...
  ref_kind        TEXT,
  ref_id          TEXT,
  thread_id       TEXT,
  status          TEXT,
  content         TEXT,
  payload_json    TEXT,
  meta_json       TEXT,
  occurred_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ingested_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_event_journal_occurred ON mnemo_event_journal(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_source_channel ON mnemo_event_journal(source, channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_actor ON mnemo_event_journal(actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_kind ON mnemo_event_journal(event_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_journal_ref ON mnemo_event_journal(ref_kind, ref_id);

-- =========================================================================
-- Capture receipt ledger: idempotent front door for channel/session imports.
-- Every source message gets a stable dedupe key. If a later importer sees the
-- same source message again, transcript/memory promotion is skipped but the
-- duplicate decision remains auditable in mnemo_event_journal.
-- =========================================================================
CREATE TABLE IF NOT EXISTS capture_receipt (
  dedupe_key      TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  channel         TEXT,
  direction       TEXT NOT NULL DEFAULT 'internal',
  actor           TEXT,
  actor_id        TEXT,
  event_kind      TEXT NOT NULL,
  ref_kind        TEXT,
  ref_id          TEXT,
  thread_id       TEXT,
  occurred_at     TEXT NOT NULL,
  content_hash    TEXT,
  content_preview TEXT,
  event_id        INTEGER,
  transcript_id   INTEGER,
  memory_id       INTEGER,
  status          TEXT NOT NULL DEFAULT 'captured',
  seen_count      INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_source_channel ON capture_receipt(source, channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_ref ON capture_receipt(ref_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_capture_actor ON capture_receipt(actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_status ON capture_receipt(status, last_seen_at DESC);

-- =========================================================================
-- Access inventory: how to reach systems without storing raw secrets.
-- Store secret_ref/path/owner hints, not passwords or private keys.
-- =========================================================================
CREATE TABLE IF NOT EXISTS access_inventory (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  scope               TEXT NOT NULL DEFAULT 'default',
  project             TEXT,
  system_name         TEXT NOT NULL,
  access_kind         TEXT NOT NULL,             -- ssh | admin | dashboard | repo | api | db | provider | other
  entrypoint          TEXT,                      -- host/url/path/command hint
  account_hint        TEXT,
  secret_ref          TEXT,                      -- env name, vault path, key filename, password-manager label
  allowed_agents      TEXT,                      -- JSON array or comma list
  status              TEXT NOT NULL DEFAULT 'active',
  route_kind          TEXT NOT NULL DEFAULT 'direct', -- direct | jump | proxy | vpn | tunnel | manual
  direct_allowed      INTEGER NOT NULL DEFAULT 1,
  jump_host           TEXT,
  jump_user           TEXT,
  jump_secret_ref     TEXT,
  proxy_command       TEXT,
  canonical_command   TEXT,
  route_steps_json    TEXT,
  preflight_required  INTEGER NOT NULL DEFAULT 1,
  last_route_check_at TEXT,
  last_verified_at    TEXT,
  verification_method TEXT,
  notes               TEXT,
  updated_by          TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope, system_name, access_kind, entrypoint)
);

CREATE INDEX IF NOT EXISTS idx_access_project ON access_inventory(project, status);
CREATE INDEX IF NOT EXISTS idx_access_system ON access_inventory(system_name, access_kind);
CREATE INDEX IF NOT EXISTS idx_access_status ON access_inventory(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS access_event (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  access_id       INTEGER REFERENCES access_inventory(id) ON DELETE SET NULL,
  event_kind      TEXT NOT NULL,                 -- created | updated | verified | failed | used | note
  actor           TEXT,
  status          TEXT,
  notes           TEXT,
  meta_json       TEXT,
  occurred_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_access_event_access ON access_event(access_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_event_actor ON access_event(actor, occurred_at DESC);

-- =========================================================================
-- Agent mail: fixed BLUN employee mailboxes for agents.
-- Secrets are stored as references (env:/file:), not raw passwords.
-- =========================================================================
CREATE TABLE IF NOT EXISTS agent_mail_account (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name          TEXT NOT NULL,
  employee_name       TEXT,
  company_name        TEXT NOT NULL DEFAULT 'BLUN',
  employee_status     TEXT NOT NULL DEFAULT 'active',
  department          TEXT,
  role_title          TEXT,
  email_address       TEXT NOT NULL UNIQUE,
  inbound_enabled     INTEGER NOT NULL DEFAULT 1,
  outbound_enabled    INTEGER NOT NULL DEFAULT 1,
  imap_host           TEXT,
  imap_port           INTEGER,
  imap_secure         INTEGER NOT NULL DEFAULT 1,
  imap_user_ref       TEXT,
  imap_pass_ref       TEXT,
  imap_mailbox        TEXT NOT NULL DEFAULT 'INBOX',
  smtp_host           TEXT,
  smtp_port           INTEGER,
  smtp_secure         INTEGER NOT NULL DEFAULT 1,
  smtp_user_ref       TEXT,
  smtp_pass_ref       TEXT,
  signature_text      TEXT,
  handling_policy     TEXT,
  send_policy         TEXT NOT NULL DEFAULT 'agent_queue',
  status              TEXT NOT NULL DEFAULT 'active',
  last_fetch_at       TEXT,
  last_fetch_status   TEXT,
  last_send_at        TEXT,
  last_error          TEXT,
  meta_json           TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_mail_account_agent ON agent_mail_account(agent_name, status);
CREATE INDEX IF NOT EXISTS idx_agent_mail_account_email ON agent_mail_account(email_address);

CREATE TABLE IF NOT EXISTS agent_mail_message (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES agent_mail_account(id) ON DELETE CASCADE,
  agent_name          TEXT NOT NULL,
  direction           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new',
  provider_message_id TEXT,
  thread_key          TEXT,
  from_addr           TEXT,
  to_addr             TEXT,
  cc_addr             TEXT,
  bcc_addr            TEXT,
  reply_to            TEXT,
  subject             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  body_preview        TEXT,
  received_at         TEXT,
  queued_at           TEXT,
  sent_at             TEXT,
  processed_at        TEXT,
  brief_id            INTEGER,
  error               TEXT,
  meta_json           TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(account_id, direction, provider_message_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_mail_message_agent ON agent_mail_message(agent_name, direction, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_mail_message_account ON agent_mail_message(account_id, direction, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_mail_message_brief ON agent_mail_message(brief_id);

-- Future-dated owner requests, appointments, and follow-up reminders.
CREATE TABLE IF NOT EXISTS reminder (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_name    TEXT NOT NULL DEFAULT 'owner',
  agent_name    TEXT,
  scope         TEXT,
  title         TEXT NOT NULL,
  details       TEXT,
  due_at        TEXT,
  due_text      TEXT,
  due_precision TEXT,
  timezone      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  source        TEXT,
  source_ref    TEXT,
  channel       TEXT,
  actor         TEXT,
  actor_id      TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  TEXT,
  notified_at   TEXT,
  notify_count  INTEGER NOT NULL DEFAULT 0,
  dedupe_key    TEXT UNIQUE,
  meta_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminder_status_due ON reminder(status, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_owner_due ON reminder(owner_name, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_agent_due ON reminder(agent_name, due_at);
CREATE INDEX IF NOT EXISTS idx_reminder_source_ref ON reminder(source, source_ref);

-- Universal journal receipts for the base schema. Runtime services add the
-- companion triggers for transcript, brief, and agent action tables.
CREATE TRIGGER IF NOT EXISTS mnemo_journal_memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO mnemo_event_journal
    (source, channel, direction, actor, actor_id, event_kind, ref_kind, ref_id, thread_id, status, content, payload_json, meta_json, occurred_at)
  VALUES
    (COALESCE(NEW.source, 'memory'), NULL, 'internal', NEW.actor, NEW.actor_id, 'memory_insert', 'memory', CAST(NEW.id AS TEXT), NEW.source_ref, 'inserted', NEW.text, NULL, NEW.meta_json, COALESCE(NEW.occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')));
END;

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

-- =========================================================================
-- Session log (agent sessions, threads, agents)
-- =========================================================================
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,               -- session uuid
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  jsonl_path    TEXT,
  agent         TEXT,                           -- "agent" | "ops_bot" | "coder" | etc.
  message_count INTEGER NOT NULL DEFAULT 0,
  meta_json     TEXT
);

-- =========================================================================
-- Backfill ledger (so we never re-import same source twice)
-- =========================================================================
CREATE TABLE IF NOT EXISTS backfill_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_kind TEXT NOT NULL,                    -- chat_json | stream_jsonl | session_jsonl | memory_md | telegram_export
  rows_added  INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
  error       TEXT,
  UNIQUE(source_path, source_kind)
);
