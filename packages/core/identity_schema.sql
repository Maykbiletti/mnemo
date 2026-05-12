-- Mnemo Identity-Layer — evolving personality, anchored values, mutable beliefs
-- Append to mnemo.db on top of base schema.

-- =========================================================================
-- Traits — weighted personality dimensions, updated by feedback
-- =========================================================================
CREATE TABLE IF NOT EXISTS personality_trait (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,             -- "telegram_reflex", "over_explaining", "ssh_caution", etc.
  dimension       TEXT NOT NULL,                    -- "communication" | "execution" | "memory" | "judgment" | "social"
  description     TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 0.5,        -- 0.0 = absent, 1.0 = dominant
  evidence_count  INTEGER NOT NULL DEFAULT 0,       -- how many memories backed this trait
  last_updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  origin_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,  -- first time observed
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_trait_dimension ON personality_trait(dimension);
CREATE INDEX IF NOT EXISTS idx_trait_weight ON personality_trait(weight);

-- =========================================================================
-- Values - non-negotiable principles. Should rarely change. Adding requires owner confirmation.
-- =========================================================================
CREATE TABLE IF NOT EXISTS core_value (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,             -- "telegram_only_reply", "no_emojis", "never_bot_voice"
  statement       TEXT NOT NULL,                    -- canonical wording
  set_by          TEXT NOT NULL DEFAULT 'owner',
  set_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scope           TEXT,                             -- where it applies ("telegram", "code", "all")
  rationale       TEXT,                             -- why
  origin_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1
);

-- =========================================================================
-- Beliefs — assumptions about world/people/tools that can evolve with evidence
-- =========================================================================
CREATE TABLE IF NOT EXISTS belief (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  statement       TEXT NOT NULL UNIQUE,             -- "local runtime2 reliably handles polish iterations"
  topic           TEXT,                             -- "agent", "project", "stripe", etc.
  confidence      REAL NOT NULL DEFAULT 0.5,        -- 0..1
  evidence_for    INTEGER NOT NULL DEFAULT 0,
  evidence_against INTEGER NOT NULL DEFAULT 0,
  formed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  origin_memory_id INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active'    -- active | falsified | superseded
);

CREATE INDEX IF NOT EXISTS idx_belief_topic ON belief(topic);
CREATE INDEX IF NOT EXISTS idx_belief_confidence ON belief(confidence);
CREATE INDEX IF NOT EXISTS idx_belief_status ON belief(status);

-- =========================================================================
-- Trait-evidence links — which memories changed which trait, how, why
-- =========================================================================
CREATE TABLE IF NOT EXISTS trait_event (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trait_id        INTEGER NOT NULL REFERENCES personality_trait(id) ON DELETE CASCADE,
  memory_id       INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  occurred_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delta           REAL NOT NULL,                    -- weight change applied (e.g. +0.05, -0.10)
  reason          TEXT,                             -- "owner corrected over-explaining at message_id 44179"
  classifier      TEXT                              -- "correction" | "praise" | "request" | "rule_set" | "self_observation"
);

CREATE INDEX IF NOT EXISTS idx_trait_event_trait ON trait_event(trait_id);
CREATE INDEX IF NOT EXISTS idx_trait_event_occurred ON trait_event(occurred_at);

-- =========================================================================
-- Daily reflection — synthesis of personality drift over a day
-- =========================================================================
CREATE TABLE IF NOT EXISTS daily_reflection (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reflection_date TEXT NOT NULL UNIQUE,             -- YYYY-MM-DD
  generated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  events_examined INTEGER NOT NULL DEFAULT 0,
  corrections     INTEGER NOT NULL DEFAULT 0,
  praises         INTEGER NOT NULL DEFAULT 0,
  trait_diffs_json TEXT,                            -- JSON: {trait_name: delta}
  belief_diffs_json TEXT,
  summary         TEXT,                             -- prose narrative for the day
  next_day_focus  TEXT                              -- what I should be especially aware of tomorrow
);

CREATE INDEX IF NOT EXISTS idx_reflection_date ON daily_reflection(reflection_date);

-- =========================================================================
-- Self-snapshot — historical "who I was on date X" for replay/comparison
-- =========================================================================
CREATE TABLE IF NOT EXISTS self_snapshot (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date   TEXT NOT NULL UNIQUE,             -- YYYY-MM-DD
  traits_json     TEXT NOT NULL,                    -- JSON-frozen trait map
  values_json     TEXT NOT NULL,
  beliefs_json    TEXT NOT NULL,
  taken_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- =========================================================================
-- Auto-scar scanner — records each correction-pattern hit, with dedup cursor
-- Consumed by daemon.js autoScarSweep() (runs every 30s).
-- =========================================================================
CREATE TABLE IF NOT EXISTS correction_pattern (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern         TEXT NOT NULL UNIQUE,
  classifier      TEXT NOT NULL,
  actor_scope     TEXT,
  trait_to_adjust TEXT,
  delta           REAL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  last_hit_at     TEXT
);

CREATE TABLE IF NOT EXISTS scar_event (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  scar_slug             TEXT NOT NULL,
  triggering_memory_id  INTEGER REFERENCES memory(id) ON DELETE SET NULL,
  pattern_id            INTEGER REFERENCES correction_pattern(id) ON DELETE SET NULL,
  trait_delta_applied   REAL NOT NULL DEFAULT 0,
  notes                 TEXT,
  occurred_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scar_event_pattern ON scar_event(pattern_id);
CREATE INDEX IF NOT EXISTS idx_scar_event_occurred ON scar_event(occurred_at);

CREATE TABLE IF NOT EXISTS scar_high_water (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);

-- Note: this schema ships with NO seeded values or traits. The owner of this
-- Mnemo instance defines them via the bootstrap wizard or by loading a
-- "personality pack" (for example @mnemo/pack-helper or a private owner pack).
-- See packages/core/bootstrap.js or `mnemo init`.
