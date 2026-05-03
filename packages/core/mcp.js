#!/usr/bin/env node
/**
 * Mnemo MCP Server — Dieter's persistent memory exposed as MCP tools.
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
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const SERVER_NAME = "mnemo";
const SERVER_VERSION = "0.2.0";

const db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

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


// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
const tools = {
  mem_recall: {
    description: "Search over all memories. Default mode 'hybrid' blends FTS5 (BM25) + semantic (cosine via sqlite-vec). Set mode='fts' for exact-keyword only, or 'semantic' for vector-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Query text. For FTS: supports OR/AND/NEAR/prefix*. For semantic: any natural-language phrase." },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 200 },
        mode: { type: "string", enum: ["fts", "semantic", "hybrid"], default: "hybrid" },
        since: { type: "string", description: "ISO date filter (e.g. 2026-04-15)." },
        kind: { type: "string", description: "Filter by kind: message|scar|dream|memory_md|edit|tool_call|decision|belief|reflection." },
        actor: { type: "string", description: "Filter by actor (Mayk|Dieter|...)." },
      },
      required: ["query"],
    },
    handler: async ({ query, limit = 20, mode = "hybrid", since, kind, actor }) => {
      const lim = Math.min(limit, 200);

      // FTS branch
      const ftsRows = (() => {
        try {
          const where = ["memory_fts MATCH ?"];
          const params = [query];
          if (since) { where.push("m.occurred_at >= ?"); params.push(since); }
          if (kind) { where.push("m.kind = ?"); params.push(kind); }
          if (actor) { where.push("m.actor = ?"); params.push(actor); }
          const sql = `
            SELECT m.id, m.kind, m.actor, m.occurred_at, m.topic, m.importance,
                   substr(m.text, 1, 400) AS preview,
                   bm25(memory_fts) AS bm25
            FROM memory_fts
            JOIN memory m ON m.id = memory_fts.rowid
            WHERE ${where.join(" AND ")}
            ORDER BY bm25 ASC, m.occurred_at DESC
            LIMIT ?
          `;
          params.push(lim * 2);
          return db.prepare(sql).all(...params);
        } catch (e) { return []; }
      })();

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
          semRows = db.prepare(sql).all(...params);
        } catch (e) { semRows = []; }
      }

      if (mode === "fts") return ftsRows.slice(0, lim);
      if (mode === "semantic") return semRows.slice(0, lim);

      // Hybrid: rank-fuse with reciprocal rank fusion
      const RRF_K = 60;
      const score = new Map();
      const meta = new Map();
      ftsRows.forEach((r, i) => {
        score.set(r.id, (score.get(r.id) || 0) + 1 / (RRF_K + i + 1));
        meta.set(r.id, r);
      });
      semRows.forEach((r, i) => {
        score.set(r.id, (score.get(r.id) || 0) + 1 / (RRF_K + i + 1));
        if (!meta.has(r.id)) meta.set(r.id, r);
      });
      const fused = Array.from(score.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, lim)
        .map(([id, s]) => ({ ...meta.get(id), fused_score: Math.round(s * 10000) / 10000 }));
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
      const occurred = new Date().toISOString();
      const hash = crypto.createHash("sha256")
        .update([kind, "manual", occurred, text].join("|"))
        .digest("hex");
      const r = db.prepare(`
        INSERT INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json, hash)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(kind, source, "manual:" + Date.now(), occurred, actor || null, topic || null, importance, text, meta ? JSON.stringify(meta) : null, hash);
      return { id: r.lastInsertRowid, hash, occurred_at: occurred };
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
    description: "Token-frugal recall: returns only id + kind + score + 80-char snippet per hit. Pair with mem_get / mem_timeline / mem_neighbors to fetch full payloads on the IDs you actually want. Same FTS+semantic surface as mem_recall, just stripped down so an agent can scan a wide candidate set without burning tokens.",
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
        id: r.id,
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
    description: "Get core values (Mayk-set rules). Optional name filter.",
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
        agent_name: { type: "string", description: "who did it (default: dieter)" },
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
          a.agent_name || "dieter",
          a.action_kind,
          a.target || null,
          a.status || "started",
          a.payload ? JSON.stringify(a.payload) : null,
          a.started_at || new Date().toISOString(),
          a.session_id || null,
          a.topic || null,
          a.meta ? JSON.stringify(a.meta) : null
        );
      return { id: r.lastInsertRowid, agent_name: a.agent_name || "dieter", action_kind: a.action_kind };
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

  mem_skill_search: {
    description: "Search the local skills/ folder by trigger-phrase or name. Returns matching SKILL.md descriptors. Use BEFORE attempting any new task — if a recipe exists, follow it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "phrase from Mayks request, e.g. 'buch mir nen flug'" },
      },
      required: ["query"],
    },
    handler: ({ query }) => {
      const SKILLS_DIR = process.env.MNEMO_SKILLS || path.join(__dirname, "skills");
      const fs = require("fs");
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
      const fs = require("fs");
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
    description: "Returns currently-open promises Dieter has made (from Dieter messages, not yet fulfilled). Use during CTO self-checks.",
    inputSchema: { type: "object", properties: { actor: { type: "string", default: "Dieter" } } },
    handler: ({ actor = "Dieter" }) => {
      // Heuristic: search Dieter outbound messages for commit-phrases since last 7 days
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
      // For each, compute completion-likelihood by checking whether Dieter wrote a status update mentioning the same topic afterward.
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
      const ownerName = process.env.MNEMO_OWNER_NAME || "Mayk";
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
        display_name: { type: "string", description: "how it signs ('Dieter', 'Felix', 'Ops Bot')" },
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
    description: "Drop a brief into a named agent's inbox. Used by orchestrator agents (e.g. Dieter -> Otto/Frida) to hand off work asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "target agent name, e.g. 'Otto', 'Frida', 'Angel'" },
        content: { type: "string", description: "the brief markdown body" },
        source_agent: { type: "string", description: "who is dropping the brief" },
        meta: { type: "object", description: "optional structured meta" },
      },
      required: ["agent_name", "content"],
    },
    handler: ({ agent_name, content, source_agent, meta }) => {
      const info = db.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?, ?, ?, ?)"
      ).run(agent_name, source_agent || null, content, meta ? JSON.stringify(meta) : null);
      return { id: info.lastInsertRowid, agent_name, status: "pending" };
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
      },
      required: ["agent_name"],
    },
    handler: ({ agent_name, limit = 5, peek = false }) => {
      const rows = db.prepare(
        "SELECT id, source_agent, content, created_at, meta_json FROM agent_brief WHERE agent_name=? AND status='pending' ORDER BY created_at ASC LIMIT ?"
      ).all(agent_name, limit);
      if (!peek && rows.length) {
        const now = new Date().toISOString();
        const upd = db.prepare("UPDATE agent_brief SET status='dispatched', dispatched_at=? WHERE id=?");
        for (const r of rows) upd.run(now, r.id);
      }
      return { count: rows.length, briefs: rows };
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
      db.prepare("UPDATE agent_brief SET status=?, done_at=?, outcome=? WHERE id=?")
        .run(status, new Date().toISOString(), outcome || null, id);
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
      },
    },
    handler: ({ agent_name, status, limit = 20 }) => {
      const where = ["1=1"]; const params = [];
      if (agent_name) { where.push("agent_name=?"); params.push(agent_name); }
      if (status) { where.push("status=?"); params.push(status); }
      params.push(Math.min(limit, 200));
      const rows = db.prepare(
        `SELECT id, agent_name, source_agent, status, created_at, dispatched_at, done_at,
                substr(content,1,160) AS preview, outcome
         FROM agent_brief WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
      ).all(...params);
      return { count: rows.length, briefs: rows };
    },
  },

  mem_connect_register: {
    description: "Mnemo Connect: register or refresh an agent in the cross-machine registry. Each running agent (CLI / daemon / bot) calls this on startup, then mem_connect_heartbeat periodically. Distinct from mem_agent_register (which manages the Mnemo-internal agent_identity / delegation table).",
    inputSchema: {
      type: "object",
      properties: {
        agent_name:   { type: "string", description: "stable id, e.g. 'otto-pc3'" },
        display_name: { type: "string" },
        host:         { type: "string", description: "machine hostname" },
        pid:          { type: "integer" },
        skills:       { type: "array", items: { type: "string" }, description: "e.g. ['scraper','postal','deploy']" },
        meta:         { type: "object" },
      },
      required: ["agent_name"],
    },
    handler: ({ agent_name, display_name, host, pid, skills, meta }) => {
      db.prepare(
        "INSERT INTO agent_registry (agent_name, display_name, host, pid, skills_json, status, registered_at, last_seen_at, meta_json) " +
        "VALUES (?,?,?,?,?, 'online', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?) " +
        "ON CONFLICT(agent_name) DO UPDATE SET " +
        "display_name=excluded.display_name, host=excluded.host, pid=excluded.pid, " +
        "skills_json=excluded.skills_json, status='online', " +
        "last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=excluded.meta_json"
      ).run(
        agent_name, display_name || agent_name, host || null, pid || null,
        JSON.stringify(skills || []), meta ? JSON.stringify(meta) : null
      );
      return { agent_name, status: "online" };
    },
  },

  mem_connect_heartbeat: {
    description: "Mnemo Connect heartbeat. Bumps last_seen_at. Agents not seen in 5 minutes are auto-marked offline on next mem_connect_list read.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        status: { type: "string", enum: ["online","busy","idle","offline"] },
      },
      required: ["agent_name"],
    },
    handler: ({ agent_name, status }) => {
      const r = db.prepare(
        "UPDATE agent_registry SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=COALESCE(?, status) WHERE agent_name=?"
      ).run(status || null, agent_name);
      return { agent_name, updated: r.changes > 0 };
    },
  },

  mem_connect_list: {
    description: "List agents registered with Mnemo Connect. Stale agents (>5min) auto-marked offline.",
    inputSchema: { type: "object", properties: { only_online: { type: "boolean" } } },
    handler: (args) => {
      const only_online = !!(args && args.only_online);
      db.prepare(
        "UPDATE agent_registry SET status='offline' " +
        "WHERE status<>'offline' AND (julianday('now') - julianday(last_seen_at)) * 86400 > 300"
      ).run();
      const where = only_online ? "WHERE status='online'" : "";
      const rows = db.prepare(
        "SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json " +
        "FROM agent_registry " + where + " ORDER BY last_seen_at DESC"
      ).all();
      return {
        count: rows.length,
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
        name: { type: "string", description: "e.g. 'listings', 'frederik-pitch'" },
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
        const info = ins.run(s.agent_name, source_agent || null, content, channel,
                             meta ? JSON.stringify(meta) : null);
        ids.push(info.lastInsertRowid);
      }
      return { channel, fanout: subs.length, brief_ids: ids };
    },
  },

  mem_connect_channel_list: {
    description: "List Mnemo Connect channels with subscriber counts.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const rows = db.prepare(
        "SELECT c.name, c.description, c.created_at, " +
        "(SELECT COUNT(*) FROM channel_subscription s WHERE s.channel_name = c.name) AS subscribers " +
        "FROM channel c ORDER BY c.created_at ASC"
      ).all();
      return { count: rows.length, channels: rows };
    },
  },
};

// ---------------------------------------------------------------------------
// MCP stdio protocol — minimal JSON-RPC 2.0
// ---------------------------------------------------------------------------
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
      const result = await tools[name].handler(args || {});
      return sendMessage(makeResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }));
    }
    return sendMessage(makeError(id, -32601, "method not found: " + method));
  } catch (e) {
    return sendMessage(makeError(id, -32000, String(e.message || e)));
  }
});

process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT", () => { db.close(); process.exit(0); });
