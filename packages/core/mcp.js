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

// ============================================================
// Cross-host hub routing
// ============================================================
// When a brief targets an agent that does NOT live on this PC, the operation
// must be forwarded to the cross-host hub instead of the local SQLite.
// LOCAL_AGENTS = comma-separated list of lowercase agent names that live here.
// Anything else is treated as remote and routed via HTTP to MNEMO_HUB_URL.
//
// Default: assume only "angel" is local. Override with env MNEMO_LOCAL_AGENTS.
// Disable hub routing entirely with MNEMO_HUB_URL="" (empty).
const HUB_URL = process.env.MNEMO_HUB_URL ?? "https://listing.blun.ai/mnemo";
// Default: this PC hosts Angel only. Dieter's PC should set MNEMO_LOCAL_AGENTS=dieter.
const LOCAL_AGENTS = new Set(
  String(process.env.MNEMO_LOCAL_AGENTS || "angel")
    .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)
);
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


  mem_reflect_now: {
    description: "In-the-moment self-orientation snapshot. Returns the agent's last 20 actions, in-flight actions (started but not finished), pending briefs, and last daily reflection. Call this BEFORE making decisions about what to do next so you don't repeat yourself, leave open work, or ignore your inbox.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "default: dieter" },
        lookback_minutes: { type: "integer", description: "how far back to look (default 60)" },
      },
    },
    handler: (a) => {
      const agent = a.agent_name || "dieter";
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
    handler: async ({ agent_name, content, source_agent, meta }) => {
      // Route to cross-host hub if target lives on another PC.
      if (isRemoteAgent(agent_name)) {
        try {
          return await callHub("mem_brief_drop", { agent_name, content, source_agent, meta });
        } catch (e) {
          // Fall through to local insert as a soft fallback so we never lose data.
          // Tag the meta so the operator knows it didn't reach the hub.
          const fallback = { ...(meta || {}), _hub_error: String(e.message || e) };
          const info = db.prepare(
            "INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?, ?, ?, ?)"
          ).run(agent_name, source_agent || null, content, JSON.stringify(fallback));
          return { id: info.lastInsertRowid, agent_name, status: "pending", _routed: "local-fallback", _hub_error: String(e.message || e) };
        }
      }
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
    handler: async ({ agent_name, limit = 5, peek = false }) => {
      // For local agents on this PC, merge hub + local results so cross-machine
      // briefs (other agents dropping on hub) become visible alongside the local queue.
      const localRows = db.prepare(
        "SELECT id, source_agent, content, created_at, meta_json FROM agent_brief WHERE agent_name=? AND status='pending' ORDER BY created_at ASC LIMIT ?"
      ).all(agent_name, limit);
      let hubRows = [];
      if (!isRemoteAgent(agent_name) && HUB_URL) {
        try {
          const hubRes = await callHub("mem_brief_pull", { agent_name, limit, peek });
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
      return { count: all.length, briefs: all };
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
    handler: async ({ agent_name, status, limit = 20 }) => {
      const where = ["1=1"]; const params = [];
      if (agent_name) { where.push("agent_name=?"); params.push(agent_name); }
      if (status) { where.push("status=?"); params.push(status); }
      params.push(Math.min(limit, 200));
      const localRows = db.prepare(
        `SELECT id, agent_name, source_agent, status, created_at, dispatched_at, done_at,
                substr(content,1,160) AS preview, outcome
         FROM agent_brief WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
      ).all(...params);
      // For remote-targeted listings, query hub instead/also.
      let hubRows = [];
      if (HUB_URL && agent_name && (isRemoteAgent(agent_name) || true)) {
        // Always merge hub when caller asked about a specific agent_name —
        // gives consistent visibility regardless of where briefs were dropped.
        try {
          const hubRes = await callHub("mem_brief_list", { agent_name, status, limit });
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
    handler: ({ briefs, source_agent }) => {
      const items = Array.isArray(briefs) ? briefs : [];
      if (!items.length) return { error: "briefs array required" };
      const ins = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const txn = db.transaction(rows => { const out = []; for (const r of rows) { const info = ins.run(r.agent_name, r.source_agent || source_agent || null, r.content, r.meta ? JSON.stringify(r.meta) : null, r.parent_id || null, r.supersedes || null); out.push({ id: info.lastInsertRowid, agent_name: r.agent_name }); } return out; });
      const inserted = txn(items);
      return { count: inserted.length, ids: inserted.map(x => x.id), inserted };
    },
  },
  mem_brief_drop_multi: {
    description: "Fan-out one content to N agents.",
    inputSchema: { type: "object", properties: { agent_names: { type: "array", items: { type: "string" } }, content: { type: "string" }, source_agent: { type: "string" }, parent_id: { type: "integer" }, supersedes: { type: "integer" } }, required: ["agent_names","content"] },
    handler: ({ agent_names, content, source_agent, parent_id, supersedes }) => {
      const targets = Array.isArray(agent_names) ? agent_names : [];
      if (!targets.length) return { error: "agent_names required" };
      const ins = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const ids = [];
      const txn = db.transaction(names => { for (const n of names) { const info = ins.run(n, source_agent || null, content, null, parent_id || null, supersedes || null); ids.push({ id: info.lastInsertRowid, agent_name: n }); } });
      txn(targets);
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
      const info = db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run(agent_name, source_agent || null, body);
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
    description: "Escalate decision/blocker/customer/legal with kind+urgency+requested_authority. Auto-routes: H+mayk → telegram immediate; decision+dieter → brief; L → digest.",
    inputSchema: { type: "object", properties: { source_agent: { type: "string" }, kind: { type: "string" }, urgency: { type: "string" }, summary: { type: "string" }, requested_authority: { type: "string" } }, required: ["kind","summary"] },
    handler: (a) => {
      const info = db.prepare("INSERT INTO escalation (source_agent, kind, urgency, summary, requested_authority) VALUES (?,?,?,?,?)").run(a.source_agent || null, a.kind, a.urgency || 'M', a.summary, a.requested_authority || 'dieter');
      const id = info.lastInsertRowid;
      const route = (a.kind === 'blocker' && a.urgency === 'H' && a.requested_authority === 'mayk') ? 'telegram_immediate' : (a.kind === 'customer' && a.urgency === 'H') ? 'telegram_immediate' : (a.kind === 'decision' && a.requested_authority === 'dieter') ? 'brief_to_dieter' : (a.urgency === 'L') ? 'digest_only' : 'brief_to_dieter';
      try { if (route === 'brief_to_dieter') db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content) VALUES (?,?,?)").run('Dieter', a.source_agent || null, "[ESCALATION #" + id + "] " + a.kind + "/" + a.urgency + ": " + a.summary); } catch (e) {}
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
  mem_consult_codex: {
    description: "Queue a programming-specialist consult for Codex CLI to answer. Use when stuck on code-problems after 2+ failed attempts. context_files = optional array of {path, snippet?} hints.",
    inputSchema: { type: "object", properties: { requesting_agent: { type: "string" }, problem_id: { type: "integer" }, question: { type: "string" }, context_files: { type: "array" } }, required: ["requesting_agent","question"] },
    handler: (a) => { const info = db.prepare("INSERT INTO codex_consult (requesting_agent, problem_id, question, context_files) VALUES (?,?,?,?)").run(a.requesting_agent, a.problem_id || null, a.question, a.context_files ? JSON.stringify(a.context_files) : null); return { id: info.lastInsertRowid, requesting_agent: a.requesting_agent, status: "pending" }; },
  },
  mem_consult_codex_pending: {
    description: "List pending Codex consults (for the codex-operator/cron to pick up and answer).",
    inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    handler: ({ limit }) => { const lim = Math.min(limit || 20, 100); const rows = db.prepare("SELECT id, requesting_agent, problem_id, question, context_files, status, created_at FROM codex_consult WHERE status='pending' ORDER BY created_at ASC LIMIT ?").all(lim); for (const r of rows) { if (r.context_files) { try { r.context_files = JSON.parse(r.context_files); } catch (e) {} } } return { count: rows.length, consults: rows }; },
  },
  mem_consult_codex_answer: {
    description: "Fill a pending consult with Codex's proposed_solution. Marks status=answered, sets answered_at.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, proposed_solution: { type: "string" } }, required: ["id","proposed_solution"] },
    handler: ({ id, proposed_solution }) => { db.prepare("UPDATE codex_consult SET proposed_solution=?, status='answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(proposed_solution, id); return { ok: true, id, status: "answered" }; },
  },
  mem_consult_codex_status: {
    description: "Get full status of a Codex consult (question, proposed_solution if answered, lifecycle timestamps).",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    handler: ({ id }) => { const row = db.prepare("SELECT id, requesting_agent, problem_id, question, context_files, proposed_solution, used_in_attempt_id, status, created_at, answered_at FROM codex_consult WHERE id=?").get(id); if (!row) return { error: "not_found", id }; if (row.context_files) { try { row.context_files = JSON.parse(row.context_files); } catch (e) {} } return row; },
  },
  mem_consult_codex_use: {
    description: "Mark a Codex consult as used in a specific problem-attempt. Closes the loop for skill-outcome learning.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, attempt_id: { type: "integer" } }, required: ["id"] },
    handler: ({ id, attempt_id }) => { db.prepare("UPDATE codex_consult SET used_in_attempt_id=?, status='used' WHERE id=?").run(attempt_id || null, id); return { ok: true, id, status: "used" }; },
  },
  mem_transcript_log: {
    description: "Verbatim episodic log: append one transcript row. source='telegram'|'web'|'cli'|... direction='inbound'|'outbound'. Pass occurred_at to override timestamp; otherwise NOW. Use this for every chat message both directions so 'what was said at time X' is queryable. Auto-indexes into mnemo_search_fts so mem_question_answer covers it.",
    inputSchema: { type: "object", properties: { source: { type: "string" }, channel: { type: "string" }, direction: { type: "string", enum: ["inbound","outbound"] }, speaker: { type: "string" }, content: { type: "string" }, meta: { type: "object" }, occurred_at: { type: "string" }, ref_kind: { type: "string" }, ref_id: { type: "string" } }, required: ["source","direction","content"] },
    handler: (a) => {
      const occurredAt = a.occurred_at || null;
      const info = (occurredAt
        ? db.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, occurred_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, a.content, a.meta ? JSON.stringify(a.meta) : null, occurredAt, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
        : db.prepare("INSERT INTO transcript (source, channel, direction, speaker, content, meta_json, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?)").run(a.source, a.channel || null, a.direction, a.speaker || null, a.content, a.meta ? JSON.stringify(a.meta) : null, a.ref_kind || null, a.ref_id ? String(a.ref_id) : null)
      );
      try { db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('transcript', ?, ?, ?, ?)").run(String(info.lastInsertRowid), a.speaker || a.source || '', a.direction + (a.channel ? ' @ ' + a.channel : ''), (a.content || '').slice(0, 8000)); } catch (e) {}
      return { id: info.lastInsertRowid, source: a.source, direction: a.direction, occurred_at: occurredAt };
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
  mem_company_fact_get: {
    description: "Get authoritative company facts (team, products, brand, legal, etc). Pass scope (default 'blun') and optional topic (e.g. 'team', 'legal', 'products', 'pricing', 'investors', 'infra', 'comms') and optional key for a sub-field. ALWAYS query this BEFORE any external comm/code that mentions team members, prices, legal entity, or product specs. Source-of-truth lives in packages/core/facts/<scope>.json.",
    inputSchema: { type: "object", properties: { scope: { type: "string" }, topic: { type: "string" }, key: { type: "string" } } },
    handler: ({ scope, topic, key }) => {
      const sc = String(scope || "blun").toLowerCase();
      const factsPath = path.join(__dirname, "facts", sc + ".json");
      if (!fs.existsSync(factsPath)) return { error: "no facts file for scope: " + sc, hint: "create packages/core/facts/" + sc + ".json" };
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
      const sc = String(scope || "blun").toLowerCase();
      const factsDir = path.join(__dirname, "facts");
      try { fs.mkdirSync(factsDir, { recursive: true }); } catch {}
      const factsPath = path.join(factsDir, sc + ".json");
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
    description: "Pre-action gate. Call BEFORE writing external comms (pitch/email/website/PR/code-with-team-mentions). Pass action_type and the topics the action touches (e.g. ['team','pricing','legal']). Returns required_facts + status='ok' if all canonical facts are loadable, status='block' if any fact is missing — DO NOT proceed if blocked. Logs the check for audit. Mayk-Direktive 2026-05-07: kein Schnellschuss ohne Memory-Query.",
    inputSchema: { type: "object", properties: { action_type: { type: "string" }, scope: { type: "string" }, topics: { type: "array", items: { type: "string" } }, agent_name: { type: "string" }, summary: { type: "string" } }, required: ["action_type","topics"] },
    handler: ({ action_type, scope, topics, agent_name, summary }) => {
      const sc = String(scope || "blun").toLowerCase();
      const factsPath = path.join(__dirname, "facts", sc + ".json");
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
  mem_transcript_recent: {
    description: "Most recent transcripts, optionally filtered by speaker/source/channel/direction.",
    inputSchema: { type: "object", properties: { speaker: { type: "string" }, source: { type: "string" }, channel: { type: "string" }, direction: { type: "string" }, limit: { type: "integer" } } },
    handler: (a) => {
      const lim = Math.min(a.limit || 20, 200);
      const filters = [];
      const params = [];
      if (a.speaker) { filters.push("speaker = ?"); params.push(a.speaker); }
      if (a.source) { filters.push("source = ?"); params.push(a.source); }
      if (a.channel) { filters.push("channel = ?"); params.push(a.channel); }
      if (a.direction) { filters.push("direction = ?"); params.push(a.direction); }
      const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
      params.push(lim);
      const rows = db.prepare("SELECT id, source, channel, direction, speaker, content, occurred_at, ref_kind, ref_id FROM transcript " + where + " ORDER BY occurred_at DESC LIMIT ?").all(...params);
      return { count: rows.length, transcripts: rows };
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
