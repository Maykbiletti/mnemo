-- Mnemo — Dieter's Persistent Memory MCP
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
  actor           TEXT,                         -- "Mayk" | "Dieter" | "system" | tool name | agent name
  actor_id        TEXT,                         -- telegram user_id, session id, etc.
  topic           TEXT,                         -- optional clustering key (e.g. "autoflashershop", "blun-code")
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
-- Session log (Claude Code sessions, threads, agents)
-- =========================================================================
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,               -- session uuid
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  jsonl_path    TEXT,
  agent         TEXT,                           -- "dieter" | "felix" | "rille" | "codex2" | etc.
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
