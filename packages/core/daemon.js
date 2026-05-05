#!/usr/bin/env node
/**
 * Mnemo Daemon — always-on PM2 service that:
 *   1. Polls Telegram Bot API directly (independent of Claude Code hooks)
 *   2. Exposes HTTP /ingest endpoint so any agent on any server can POST events
 *   3. Runs daily reflection cycle at 23:00 local
 *   4. Health-check every 5 min — updates writer_health table
 *   5. Watches /root/mnemo/sources/ for new files (e.g. dropped session jsonl)
 *
 * Listens on localhost:7117 by default. Tailscale-IP for cross-server agents.
 *
 * Env:
 *   MNEMO_DB             default /root/mnemo/mnemo.db
 *   MNEMO_HTTP_PORT      default 7117
 *   MNEMO_HTTP_HOST      default 0.0.0.0
 *   TELEGRAM_BOT_TOKEN   required for Telegram poller
 *   OWNER_CHAT_ID         optional, restrict ingest to this chat
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const Database = require("better-sqlite3");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const PORT = parseInt(process.env.MNEMO_HTTP_PORT || "7117", 10);
const HOST = process.env.MNEMO_HTTP_HOST || "127.0.0.1";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const OWNER_CHAT_ID = process.env.MNEMO_OWNER_CHAT_ID || process.env.OWNER_CHAT_ID || null;
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";
const TG_OFFSET_FILE = process.env.MNEMO_TG_OFFSET_FILE || path.join(__dirname, ".tg_offset");
const TZ_OFFSET_HOURS = parseInt(process.env.MNEMO_TZ_OFFSET_HOURS || "0", 10);
const QUIET_START = parseInt(process.env.MNEMO_QUIET_START || "23", 10);
const QUIET_END = parseInt(process.env.MNEMO_QUIET_END || "7", 10);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
// Mnemo Connect schema bootstrap (idempotent)
db.exec(`
CREATE TABLE IF NOT EXISTS agent_brief (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_name TEXT NOT NULL, source_agent TEXT,
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at TEXT, done_at TEXT, outcome TEXT, meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_brief_agent_status ON agent_brief(agent_name, status);
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

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_name TEXT PRIMARY KEY, display_name TEXT, host TEXT, pid INTEGER, skills_json TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json TEXT
);
CREATE TABLE IF NOT EXISTS channel (
  name TEXT PRIMARY KEY, description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS channel_subscription (
  channel_name TEXT NOT NULL REFERENCES channel(name) ON DELETE CASCADE,
  agent_name TEXT NOT NULL REFERENCES agent_registry(agent_name) ON DELETE CASCADE,
  subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_name, agent_name)
);
`);
try {
  const cols = db.prepare("PRAGMA table_info(agent_brief)").all().map(c => c.name);
  if (!cols.includes("channel")) db.exec("ALTER TABLE agent_brief ADD COLUMN channel TEXT");
  if (!cols.includes("parent_id")) db.exec("ALTER TABLE agent_brief ADD COLUMN parent_id INTEGER");
  if (!cols.includes("supersedes_id")) db.exec("ALTER TABLE agent_brief ADD COLUMN supersedes_id INTEGER");
  if (!cols.includes("superseded_by_id")) db.exec("ALTER TABLE agent_brief ADD COLUMN superseded_by_id INTEGER");
  const rcols = db.prepare("PRAGMA table_info(agent_registry)").all().map(c => c.name);
  if (!rcols.includes("notify_webhook")) db.exec("ALTER TABLE agent_registry ADD COLUMN notify_webhook TEXT");
  if (!rcols.includes("notify_telegram_chat")) db.exec("ALTER TABLE agent_registry ADD COLUMN notify_telegram_chat TEXT");
  db.exec("CREATE TABLE IF NOT EXISTS agent_brief_reaction (id INTEGER PRIMARY KEY AUTOINCREMENT, brief_id INTEGER NOT NULL, agent_name TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_reaction_brief ON agent_brief_reaction(brief_id)");
  // FTS5 virtual table for cross-source search (briefs + actions + memory)
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS mnemo_search_fts USING fts5(scope, ref_id UNINDEXED, agent_name, summary, content, tokenize='porter unicode61')");
  // Backfill briefs into FTS if empty
  try {
    const fts_count = db.prepare("SELECT COUNT(*) c FROM mnemo_search_fts").get().c;
    if (fts_count === 0) {
      const briefs = db.prepare("SELECT id, agent_name, source_agent, content FROM agent_brief").all();
      const ins = db.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES ('brief', ?, ?, ?, ?)");
      const t = db.transaction(rows => { for (const r of rows) ins.run(String(r.id), r.agent_name || '', r.source_agent || '', (r.content || '').slice(0, 8000)); });
      t(briefs);
      console.log("[migrate] FTS5 backfilled with " + briefs.length + " briefs");
    }
  } catch (e) { console.error("[migrate-fts-backfill]", e.message); }
  // Brief templates
  db.exec("CREATE TABLE IF NOT EXISTS brief_template (name TEXT PRIMARY KEY, body_template TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  // Seed default templates if empty
  try {
    if (db.prepare("SELECT COUNT(*) c FROM brief_template").get().c === 0) {
      const seed = db.prepare("INSERT INTO brief_template (name, body_template, description) VALUES (?,?,?)");
      seed.run("patch-delta", "# Brief PATCH-DELTA — {{file}}\n\n{{diffs}}\n\n## Test-Hinweis\n{{test_hint}}\n", "diff-style file patch with test hint");
      seed.run("file-drop", "# Brief — {{title}}\n\n=== FILE: {{path}} ===\n{{content}}\n=== END FILE ===\n", "single file drop wrapper");
      seed.run("status-update", "# {{topic}} — {{date}}\n\nStatus: {{status}}\n\n{{notes}}\n", "lightweight status report");
      seed.run("question", "# Frage an {{recipient}}\n\n{{question}}\n\nKontext: {{context}}\n", "structured question");
    }
  } catch (e) { console.error("[migrate-template-seed]", e.message); }
  db.exec("CREATE TABLE IF NOT EXISTS skill_registry (name TEXT PRIMARY KEY, description TEXT, trigger_phrases TEXT, sandbox TEXT DEFAULT 'none', requires_confirmation INTEGER DEFAULT 0, sensitive_data TEXT, body TEXT, source_path TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  db.exec("CREATE TABLE IF NOT EXISTS skill_invocation (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_name TEXT NOT NULL, agent_name TEXT, input TEXT, output TEXT, exit_code INTEGER, duration_ms INTEGER, started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT, status TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_invoc_skill ON skill_invocation(skill_name, started_at DESC)");
} catch (e) { console.error("[migrate]", e.message); }

// Auto-load skills from /root/mnemo/packages/core/skills/*/SKILL.md on startup
try {
  const skillsDir = path.join(__dirname, "skills");
  if (fs.existsSync(skillsDir)) {
    const dirs = fs.readdirSync(skillsDir).filter(d => {
      try { return fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, "SKILL.md")); } catch { return false; }
    });
    const upsert = db.prepare("INSERT INTO skill_registry (name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, body, source_path, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET description=excluded.description, trigger_phrases=excluded.trigger_phrases, sandbox=excluded.sandbox, requires_confirmation=excluded.requires_confirmation, sensitive_data=excluded.sensitive_data, body=excluded.body, source_path=excluded.source_path, status=excluded.status, updated_at=excluded.updated_at");
    for (const dname of dirs) {
      try {
        const fp = path.join(skillsDir, dname, "SKILL.md");
        const text = fs.readFileSync(fp, "utf8");
        const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
        if (!fm) continue;
        const meta = {};
        for (const raw of fm[1].split(/\n/)) {
          const line = raw.trim(); if (!line || line.startsWith("#")) continue;
          const idx = line.indexOf(":"); if (idx < 0) continue;
          const k = line.slice(0,idx).trim(); let v = line.slice(idx+1).trim();
          if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1,-1).split(",").map(x=>x.trim().replace(/^['"]|['"]$/g,"")).filter(Boolean);
          else if (v === "true") v = true; else if (v === "false") v = false;
          else if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1,-1);
          meta[k] = v;
        }
        const body = fm[2];
        const triggers = Array.isArray(meta.trigger_phrases) ? meta.trigger_phrases : [];
        // Also handle YAML list block: lines starting with -
        if (!triggers.length) {
          const tpMatch = fm[1].match(/trigger_phrases:\s*\n((?:\s*-\s+.+\n?)+)/);
          if (tpMatch) for (const ln of tpMatch[1].split(/\n/)) {
            const m = ln.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/); if (m) triggers.push(m[1]);
          }
        }
        const sensitive = Array.isArray(meta.sensitive_data) ? meta.sensitive_data : [];
        upsert.run(meta.name || dname, meta.description || "", JSON.stringify(triggers), meta.sandbox || "none", meta.requires_confirmation ? 1 : 0, JSON.stringify(sensitive), body, fp, meta.status || "active");
      } catch (e) { console.error("[skill-load]", dname, e.message); }
    }
    const cnt = db.prepare("SELECT COUNT(*) c FROM skill_registry").get().c;
    console.log("[skills] " + cnt + " skills in registry");
  }
} catch (e) { console.error("[skills-init]", e.message); }
db.pragma("synchronous = NORMAL");

// ---------- Multi-tenant pool ----------
// Each tenant gets its own SQLite file at TENANT_ROOT/<id>/mnemo.db
// Pool keeps DB handles open; falls back to host db when no tenant header.
const TENANT_ROOT = process.env.MNEMO_TENANT_ROOT || path.join(__dirname, "tenants");
if (!fs.existsSync(TENANT_ROOT)) fs.mkdirSync(TENANT_ROOT, { recursive: true });
const tenantPool = new Map();
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64); }
function tenantDb(id) {
  const safe = safeId(id);
  if (!safe) return null;
  if (tenantPool.has(safe)) return tenantPool.get(safe);
  const dir = path.join(TENANT_ROOT, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, "mnemo.db");
  const tdb = new Database(dbFile);
  tdb.pragma("journal_mode = WAL");
  tdb.pragma("synchronous = NORMAL");
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    if (fs.existsSync(schemaPath)) tdb.exec(fs.readFileSync(schemaPath, "utf8"));
  } catch (e) { console.error("[tenant-bootstrap]", safe, e.message); }
  tenantPool.set(safe, tdb);
  return tdb;
}
function dbForRequest(req) {
  const tid = req.headers["x-tenant-id"];
  if (!tid) return db;
  const t = tenantDb(tid);
  return t || db;
}

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const upsertWriter = db.prepare(`
  INSERT INTO writer_health (writer, last_write_at, rows_written, status, last_check_at)
  VALUES (?,?,?,?,?)
  ON CONFLICT(writer) DO UPDATE SET
    last_write_at=excluded.last_write_at,
    rows_written=writer_health.rows_written + excluded.rows_written,
    status=excluded.status,
    last_check_at=excluded.last_check_at
`);

function recordWrite(writer, rowsAdded, status = "alive") {
  upsertWriter.run(writer, rowsAdded > 0 ? now() : null, rowsAdded, status, now());
}

function ingestEvent(target, { kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta }) {
  if (!kind || !text || typeof text !== "string") return { ok: false, error: "missing kind or text" };
  const occurred = occurred_at || now();
  const hash = sha([kind, source_ref || "", occurred, text].join("|"));
  const stmt = target.prepare(`
    INSERT OR IGNORE INTO memory
      (kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta_json, hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  const r = stmt.run(
    kind, source || "http", source_ref || null, occurred,
    actor || null, actor_id || null, topic || null,
    importance ?? 5, text, meta ? JSON.stringify(meta) : null, hash
  );
  return { ok: true, inserted: r.changes > 0, hash };
}

// ---------- HTTP server ----------

function sanitizeFtsQuery(q) {
  // Quote each whitespace-separated token to avoid FTS5 operator interpretation
  // (hyphen parses as NOT, colon as column-restrict). Already-quoted phrase passed through.
  if (!q) return q;
  if (/^".*"$/.test(q.trim())) return q;
  return q.split(/\s+/).filter(Boolean).map(t => {
    if (/^[A-Za-z0-9_]+$/.test(t)) return t;
    return '"' + t.replace(/"/g, '""') + '"';
  }).join(' ');
}

function sendJson(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const ae = String((req && req.headers && req.headers["accept-encoding"]) || "");
  if (body.length > 4096 && /gzip/.test(ae)) {
    const gz = zlib.gzipSync(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": gz.length });
    return res.end(gz);
  }
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
  return res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tdb = dbForRequest(req);
  const tenantId = req.headers["x-tenant-id"] || null;
  if (req.method === "GET" && url.pathname === "/health") {
    const stats = {
      tenant: tenantId,
      memory_rows: tdb.prepare("SELECT COUNT(*) c FROM memory").get().c,
      writers: tdb.prepare("SELECT writer, status, last_write_at, rows_written FROM writer_health").all(),
      uptime_sec: Math.round(process.uptime()),
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats, null, 2));
  }
  if (req.method === "POST" && url.pathname === "/ingest") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const events = Array.isArray(payload) ? payload : [payload];
        const results = events.map(e => ingestEvent(tdb, e));
        const added = results.filter(r => r.inserted).length;
        if (!tenantId) recordWrite("http_ingest", added);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ tenant: tenantId, accepted: events.length, inserted: added, results }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: String(e.message) }));
      }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/recall") {
    const q = url.searchParams.get("q");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
    if (!q) {
      res.writeHead(400); return res.end(JSON.stringify({ error: "q required" }));
    }
    try {
      const rows = tdb.prepare(`
        SELECT m.id, m.kind, m.actor, m.occurred_at, substr(m.text,1,300) preview, bm25(memory_fts) rank
        FROM memory_fts JOIN memory m ON m.id=memory_fts.rowid
        WHERE memory_fts MATCH ?
        ORDER BY rank ASC LIMIT ?
      `).all(sanitizeFtsQuery(q), limit);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(rows));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: String(e.message) }));
    }
  }
  if (req.method === "POST" && url.pathname.startsWith("/tool/")) {
    const tool = url.pathname.slice("/tool/".length);
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      let args = {};
      try { args = body ? JSON.parse(body) : {}; }
      catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid JSON: " + e.message }));
      }
      try {
        const result = handleTool(tdb, tool, args);
        return sendJson(req, res, 200, { tool, result });
      } catch (e) {
        return sendJson(req, res, 500, { error: String(e.message), tool });
      }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

// ---------- Push hook: fires telegram/webhook on brief insert/reaction ----------
function fireBriefHook(tdb, briefId, eventType, ctx) {

  try {
    const brief = tdb.prepare("SELECT id, agent_name, source_agent, channel, substr(content,1,500) AS preview FROM agent_brief WHERE id=?").get(briefId);
    if (!brief) return;
    const agent = tdb.prepare("SELECT notify_webhook, notify_telegram_chat FROM agent_registry WHERE agent_name=?").get(brief.agent_name);
    if (!agent) return;
    const payload = { event: eventType, brief_id: briefId, agent_name: brief.agent_name, source_agent: brief.source_agent, channel: brief.channel, preview: brief.preview, ctx: ctx || null, ts: new Date().toISOString() };
    if (agent.notify_webhook) {
      try {
        const url = new URL(agent.notify_webhook);
        const lib = url.protocol === "https:" ? require("https") : require("http");
        const body = Buffer.from(JSON.stringify(payload));
        const req = lib.request({ method: "POST", hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { "Content-Type": "application/json", "Content-Length": body.length } }, (rs) => { rs.resume(); });
        req.on("error", () => {}); req.write(body); req.end();
      } catch (e) {}
    }
    if (agent.notify_telegram_chat) {
      try {
        const tokenFile = process.env.TELEGRAM_BOT_TOKEN_FILE || "/root/.dieter/telegram_bot_token";
        let token = process.env.TELEGRAM_BOT_TOKEN || "";
        if (!token && require("fs").existsSync(tokenFile)) token = require("fs").readFileSync(tokenFile,"utf8").trim();
        if (token) {
          const text = "[mnemo " + eventType + "] #" + briefId + " -> " + brief.agent_name + "\nfrom: " + (brief.source_agent || "?") + "\nchannel: " + (brief.channel || "-") + "\n\n" + ((brief.preview || "").slice(0,200));
          const https = require("https");
          const data = JSON.stringify({ chat_id: agent.notify_telegram_chat, text, disable_notification: false });
          const req = https.request({ method: "POST", hostname: "api.telegram.org", path: "/bot" + token + "/sendMessage", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (rs) => { rs.resume(); });
          req.on("error", () => {}); req.write(data); req.end();
        }
      } catch (e) {}
    }
  } catch (e) { /* hook never throws */ }
}

function matchSkillsForText(tdb, text) {
  if (!text) return [];

  const skills = tdb.prepare("SELECT name, description, trigger_phrases FROM skill_registry WHERE status IN ('active','stub')").all();
  const matches = [];
  for (const sk of skills) {
    let triggers = [];
    try { triggers = JSON.parse(sk.trigger_phrases || "[]"); } catch {}
    for (const tp of triggers) {
      try {
        const re = new RegExp(tp, "i");
        if (re.test(text)) { matches.push({ name: sk.name, description: sk.description, matched: tp }); break; }
      } catch {}
    }
  }
  return matches;
}

function ftsIndex(tdb, scope, refId, agentName, summary, content) {
  try {
    tdb.prepare("INSERT INTO mnemo_search_fts (scope, ref_id, agent_name, summary, content) VALUES (?,?,?,?,?)")
       .run(scope, String(refId), agentName || '', (summary || '').slice(0, 200), (content || '').slice(0, 8000));
  } catch (e) { /* silent */ }
}

// ---------- Connect / Brief tool dispatch (HTTP-callable subset) ----------
function handleTool(tdb, name, a) {
  switch (name) {
    case "mem_connect_register": {
      tdb.prepare(
        "INSERT INTO agent_registry (agent_name, display_name, host, pid, skills_json, status, registered_at, last_seen_at, meta_json) " +
        "VALUES (?,?,?,?,?, 'online', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?) " +
        "ON CONFLICT(agent_name) DO UPDATE SET " +
        "display_name=excluded.display_name, host=excluded.host, pid=excluded.pid, " +
        "skills_json=excluded.skills_json, status='online', " +
        "last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), meta_json=excluded.meta_json"
      ).run(
        a.agent_name, a.display_name || a.agent_name, a.host || null, a.pid || null,
        JSON.stringify(a.skills || []), a.meta ? JSON.stringify(a.meta) : null
      );
      return { agent_name: a.agent_name, status: "online" };
    }
    case "mem_connect_heartbeat": {
      const r = tdb.prepare(
        "UPDATE agent_registry SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=COALESCE(?, status) WHERE agent_name=?"
      ).run(a.status || null, a.agent_name);
      return { agent_name: a.agent_name, updated: r.changes > 0 };
    }
    case "mem_connect_list": {
      tdb.prepare(
        "UPDATE agent_registry SET status='offline' " +
        "WHERE status<>'offline' AND (julianday('now') - julianday(last_seen_at)) * 86400 > 300"
      ).run();
      const where = a.only_online ? "WHERE status='online'" : "";
      const rows = tdb.prepare(
        "SELECT agent_name, display_name, host, pid, status, registered_at, last_seen_at, skills_json, meta_json " +
        "FROM agent_registry " + where + " ORDER BY last_seen_at DESC"
      ).all();
      return {
        count: rows.length,
        agents: rows.map(r => Object.assign({}, r, {
          skills: r.skills_json ? JSON.parse(r.skills_json) : [],
          meta: r.meta_json ? JSON.parse(r.meta_json) : null,
        })),
      };
    }
    case "mem_connect_channel_upsert": {
      tdb.prepare(
        "INSERT INTO channel (name, description) VALUES (?,?) " +
        "ON CONFLICT(name) DO UPDATE SET description=COALESCE(excluded.description, channel.description)"
      ).run(a.name, a.description || null);
      return { name: a.name };
    }
    case "mem_connect_channel_subscribe": {
      tdb.prepare("INSERT INTO channel (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(a.channel);
      tdb.prepare("INSERT INTO channel_subscription (channel_name, agent_name) VALUES (?,?) ON CONFLICT DO NOTHING")
        .run(a.channel, a.agent_name);
      return { channel: a.channel, agent_name: a.agent_name, subscribed: true };
    }
    case "mem_connect_channel_post": {
      let subs = tdb.prepare(
        "SELECT s.agent_name, r.skills_json FROM channel_subscription s " +
        "LEFT JOIN agent_registry r ON r.agent_name = s.agent_name " +
        "WHERE s.channel_name = ?"
      ).all(a.channel);
      if (a.require_skill) {
        subs = subs.filter(s => {
          try { return (JSON.parse(s.skills_json || "[]")).includes(a.require_skill); }
          catch { return false; }
        });
      }
      const ids = [];
      const ins = tdb.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?,?,?,?,?)"
      );
      for (const s of subs) {
        const info = ins.run(s.agent_name, a.source_agent || null, a.content, a.channel,
                             a.meta ? JSON.stringify(a.meta) : null);
        ids.push(info.lastInsertRowid);
        try { fireBriefHook(tdb, info.lastInsertRowid, "channel_post", { agent_name: s.agent_name, channel: a.channel, source: a.source_agent || null }); } catch (e) {}
        try { ftsIndex(tdb, "brief", info.lastInsertRowid, s.agent_name, a.source_agent || "", a.content); } catch (e) {}
      }
      return { channel: a.channel, fanout: subs.length, brief_ids: ids };
    }
    case "mem_connect_channel_list": {
      const rows = tdb.prepare(
        "SELECT c.name, c.description, c.created_at, " +
        "(SELECT COUNT(*) FROM channel_subscription s WHERE s.channel_name = c.name) AS subscribers " +
        "FROM channel c ORDER BY c.created_at ASC"
      ).all();
      return { count: rows.length, channels: rows };
    }
    case "mem_brief_drop": {
      const info = tdb.prepare(
        "INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)"
      ).run(a.agent_name, a.source_agent || null, a.content, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      if (a.supersedes) {
        try { tdb.prepare("UPDATE agent_brief SET superseded_by_id=?, status=CASE WHEN status='pending' THEN 'superseded' ELSE status END WHERE id=?").run(newId, a.supersedes); } catch (e) {}
      }
      try { fireBriefHook(tdb, newId, "drop", { agent_name: a.agent_name }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, a.agent_name, a.source_agent || "", a.content); } catch (e) {}
      try {
        const skMatches = matchSkillsForText(tdb, a.content);
        if (skMatches.length) {
          const insR = tdb.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)");
          for (const m of skMatches) insR.run(newId, "mnemo-skills-engine", "skill_suggested", JSON.stringify(m));
        }
      } catch (e) {}
      return { id: newId, agent_name: a.agent_name, status: "pending", supersedes: a.supersedes || null };
    }
    case "mem_brief_pull": {
      const rows = tdb.prepare(
        "SELECT id, source_agent, content, channel, created_at, meta_json FROM agent_brief " +
        "WHERE agent_name=? AND status='pending' ORDER BY created_at ASC LIMIT ?"
      ).all(a.agent_name, Math.min(a.limit || 5, 50));
      if (!a.peek && rows.length) {
        const upd = tdb.prepare("UPDATE agent_brief SET status='dispatched', dispatched_at=? WHERE id=?");
        const now = new Date().toISOString();
        for (const r of rows) upd.run(now, r.id);
      }
      return { count: rows.length, briefs: rows };
    }
    case "mem_brief_done": {
      tdb.prepare("UPDATE agent_brief SET status=?, done_at=?, outcome=? WHERE id=?")
        .run(a.status, new Date().toISOString(), a.outcome || null, a.id);
      return { id: a.id, status: a.status };
    }
    case "mem_skill_list": {
      const rows = tdb.prepare("SELECT name, description, sandbox, requires_confirmation, status, source_path, length(body) AS body_len FROM skill_registry ORDER BY name").all();
      return { count: rows.length, skills: rows };
    }
    case "mem_skill_get": {
      const row = tdb.prepare("SELECT name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, body, source_path, status, created_at, updated_at FROM skill_registry WHERE name=?").get(a.name);
      if (!row) return { error: "skill_not_found", name: a.name };
      try { row.trigger_phrases = JSON.parse(row.trigger_phrases || "[]"); } catch {}
      try { row.sensitive_data = JSON.parse(row.sensitive_data || "[]"); } catch {}
      return row;
    }
    case "mem_skill_match": {
      if (!a.text) return { error: "text required" };
      return { matches: matchSkillsForText(tdb, a.text) };
    }
    case "mem_skill_register": {
      const triggers = Array.isArray(a.trigger_phrases) ? a.trigger_phrases : [];
      const sensitive = Array.isArray(a.sensitive_data) ? a.sensitive_data : [];
      tdb.prepare("INSERT INTO skill_registry (name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, body, source_path, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET description=excluded.description, trigger_phrases=excluded.trigger_phrases, sandbox=excluded.sandbox, requires_confirmation=excluded.requires_confirmation, sensitive_data=excluded.sensitive_data, body=excluded.body, source_path=excluded.source_path, status=excluded.status, updated_at=excluded.updated_at").run(a.name, a.description || "", JSON.stringify(triggers), a.sandbox || "none", a.requires_confirmation ? 1 : 0, JSON.stringify(sensitive), a.body || "", a.source_path || null, a.status || "active");
      return { name: a.name, status: "registered" };
    }
    case "mem_skill_run": {
      const sk = tdb.prepare("SELECT name, source_path, sandbox, requires_confirmation FROM skill_registry WHERE name=? AND status='active'").get(a.name);
      if (!sk) return { error: "skill_not_found_or_inactive", name: a.name };
      if (sk.requires_confirmation && !a.confirmed) return { error: "requires_confirmation", name: a.name, hint: "pass confirmed: true to authorize" };
      const skillDir = sk.source_path ? path.dirname(sk.source_path) : null;
      if (!skillDir) return { error: "no_runnable", name: a.name };
      const t0 = Date.now();
      const inv = tdb.prepare("INSERT INTO skill_invocation (skill_name, agent_name, input, status) VALUES (?,?,?,?)").run(a.name, a.agent_name || null, a.input || "", "running");
      const invId = inv.lastInsertRowid;
      try {
        const cp = require("child_process");
        const runScript = path.join(__dirname, "skills", "skill_runner.js");
        const args = [runScript, skillDir];
        if (a.input) { args.push("--input", a.input); }
        if (a.confirmed) { args.push("--allow-confirm"); }
        const out = cp.spawnSync("node", args, { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        const dur = Date.now() - t0;
        const outputCombined = (out.stdout || "") + (out.stderr ? "\n[stderr]\n" + out.stderr : "");
        tdb.prepare("UPDATE skill_invocation SET output=?, exit_code=?, duration_ms=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), status=? WHERE id=?").run(outputCombined.slice(0, 16384), out.status, dur, out.status === 0 ? "ok" : "error", invId);
        return { invocation_id: invId, name: a.name, exit_code: out.status, duration_ms: dur, output_preview: outputCombined.slice(0, 2000) };
      } catch (e) {
        tdb.prepare("UPDATE skill_invocation SET output=?, exit_code=?, status=? WHERE id=?").run(String(e.message), -1, "error", invId);
        return { error: "run_failed", name: a.name, message: e.message };
      }
    }
    case "mem_skill_invocations": {
      const where = []; const params = [];
      if (a.skill_name) { where.push("skill_name=?"); params.push(a.skill_name); }
      params.push(Math.min(a.limit || 20, 100));
      const sql = "SELECT id, skill_name, agent_name, exit_code, duration_ms, started_at, finished_at, status, substr(input,1,200) AS input_preview, substr(output,1,200) AS output_preview FROM skill_invocation" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY started_at DESC LIMIT ?";
      const rows = tdb.prepare(sql).all(...params);
      return { count: rows.length, invocations: rows };
    }
    case "mem_nudge_check": {
      const N = parseInt(a.threshold || 30, 10);
      const lastReflect = tdb.prepare("SELECT MAX(started_at) ts FROM agent_action WHERE agent_name=? AND topic='reflect'").get(a.agent_name);
      const since = lastReflect && lastReflect.ts ? lastReflect.ts : '1970-01-01';
      const actCount = tdb.prepare("SELECT COUNT(*) c FROM agent_action WHERE agent_name=? AND started_at > ? AND status != 'rollup'").get(a.agent_name, since).c;
      return { agent_name: a.agent_name, since, actions_since: actCount, threshold: N, reflect_recommended: actCount >= N };
    }
    case "mem_brief_drop_batch": {
      const items = Array.isArray(a.briefs) ? a.briefs : [];
      if (!items.length) return { error: "briefs array required and non-empty" };
      const ins = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const txn = tdb.transaction(rows => {
        const out = [];
        for (const r of rows) {
          const info = ins.run(r.agent_name, r.source_agent || a.source_agent || null, r.content, r.meta ? JSON.stringify(r.meta) : null, r.parent_id || null, r.supersedes || null);
          out.push({ id: info.lastInsertRowid, agent_name: r.agent_name });
        }
        return out;
      });
      const inserted = txn(items);
      // Fire hooks + FTS outside transaction (best effort)
      for (const r of inserted) {
        try { fireBriefHook(tdb, r.id, "drop_batch", { agent_name: r.agent_name }); } catch (e) {}
        const src = items.find(x => x.agent_name === r.agent_name) || items[0];
        try { ftsIndex(tdb, "brief", r.id, r.agent_name, src.source_agent || "", src.content); } catch (e) {}
      }
      return { count: inserted.length, ids: inserted.map(x => x.id), inserted };
    }
    case "mem_brief_drop_multi": {
      const targets = Array.isArray(a.agent_names) ? a.agent_names : [];
      if (!targets.length || !a.content) return { error: "agent_names array + content required" };
      const ins = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)");
      const ids = [];
      const txn = tdb.transaction(names => {
        for (const n of names) {
          const info = ins.run(n, a.source_agent || null, a.content, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
          ids.push({ id: info.lastInsertRowid, agent_name: n });
        }
      });
      txn(targets);
      for (const r of ids) {
        try { fireBriefHook(tdb, r.id, "drop_multi", { agent_name: r.agent_name }); } catch (e) {}
        try { ftsIndex(tdb, "brief", r.id, r.agent_name, a.source_agent || "", a.content); } catch (e) {}
      }
      return { fanout: ids.length, brief_ids: ids.map(x => x.id), inserted: ids };
    }
    case "mem_brief_drop_from_template": {
      const tpl = tdb.prepare("SELECT body_template FROM brief_template WHERE name=?").get(a.template);
      if (!tpl) return { error: "template_not_found", template: a.template };
      let body = tpl.body_template;
      const vars = a.vars || {};
      for (const k of Object.keys(vars)) {
        const re = new RegExp("\\{\\{\\s*" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}\\}", "g");
        body = body.replace(re, String(vars[k] == null ? "" : vars[k]));
      }
      const info = tdb.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json, parent_id, supersedes_id) VALUES (?,?,?,?,?,?)").run(a.agent_name, a.source_agent || null, body, a.meta ? JSON.stringify(a.meta) : null, a.parent_id || null, a.supersedes || null);
      const newId = info.lastInsertRowid;
      try { fireBriefHook(tdb, newId, "drop", { agent_name: a.agent_name, template: a.template }); } catch (e) {}
      try { ftsIndex(tdb, "brief", newId, a.agent_name, a.source_agent || "", body); } catch (e) {}
      return { id: newId, agent_name: a.agent_name, template: a.template };
    }
    case "mem_brief_template_list": {
      const rows = tdb.prepare("SELECT name, description, length(body_template) AS body_len FROM brief_template ORDER BY name").all();
      return { count: rows.length, templates: rows };
    }
    case "mem_brief_template_upsert": {
      tdb.prepare("INSERT INTO brief_template (name, body_template, description) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET body_template=excluded.body_template, description=excluded.description").run(a.name, a.body_template, a.description || null);
      return { name: a.name, status: "ok" };
    }
    case "mem_search": {
      const scopes = Array.isArray(a.scope) && a.scope.length ? a.scope : ["brief"];
      const limit = Math.min(a.limit || 20, 100);
      // Sanitize FTS5 query: strip operators except basic terms, allow phrase quoting
      const raw = String(a.query || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!raw) return { error: "query required" };
      const q = raw.split(/\s+/).filter(Boolean).map(t => '"' + t + '"').join(" ");
      const placeholders = scopes.map(() => "?").join(",");
      const rows = tdb.prepare(
        "SELECT scope, ref_id, agent_name, summary, snippet(mnemo_search_fts, 4, '<b>', '</b>', '...', 24) AS snippet, rank " +
        "FROM mnemo_search_fts WHERE scope IN (" + placeholders + ") AND mnemo_search_fts MATCH ? " +
        "ORDER BY rank LIMIT ?"
      ).all(...scopes, q, limit);
      return { count: rows.length, query: q, scopes, results: rows };
    }
    case "mem_brief_status": {
      const row = tdb.prepare("SELECT id, agent_name, source_agent, channel, status, created_at, dispatched_at, done_at, outcome, parent_id, supersedes_id, superseded_by_id, length(content) AS content_len FROM agent_brief WHERE id=?").get(a.id);
      if (!row) return { error: "not_found", id: a.id };
      const reactions = tdb.prepare("SELECT id, agent_name, kind, payload, created_at FROM agent_brief_reaction WHERE brief_id=? ORDER BY created_at ASC").all(a.id);
      row.reactions = reactions;
      return row;
    }
    case "mem_brief_react": {
      const info = tdb.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)").run(a.brief_id, a.agent_name, a.kind, a.payload ? (typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload)) : null);
      try { fireBriefHook(tdb, a.brief_id, "reaction", { agent_name: a.agent_name, kind: a.kind }); } catch (e) {}
      return { id: info.lastInsertRowid, brief_id: a.brief_id, agent_name: a.agent_name, kind: a.kind };
    }
    case "mem_agent_set_notify": {
      const cur = tdb.prepare("SELECT agent_name FROM agent_registry WHERE agent_name=?").get(a.agent_name);
      if (!cur) return { error: "agent_not_registered", agent_name: a.agent_name };
      tdb.prepare("UPDATE agent_registry SET notify_webhook=?, notify_telegram_chat=? WHERE agent_name=?").run(a.webhook || null, a.telegram_chat ? String(a.telegram_chat) : null, a.agent_name);
      return { agent_name: a.agent_name, webhook: a.webhook || null, telegram_chat: a.telegram_chat || null };
    }
    case "mem_health": {
      const tot = tdb.prepare("SELECT COUNT(*) c FROM agent_brief").get().c;
      const pending = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='pending'").get().c;
      const dispatched = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='dispatched'").get().c;
      const done = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE status='done' OR status='deploy-issue'").get().c;
      const perAgent = tdb.prepare("SELECT agent_name, COUNT(*) pending FROM agent_brief WHERE status='pending' GROUP BY agent_name ORDER BY 2 DESC").all();
      const lastHour = tdb.prepare("SELECT COUNT(*) c FROM agent_brief WHERE created_at > datetime('now','-1 hour')").get().c;
      return { briefs_total: tot, pending, dispatched, done, last_hour_drops: lastHour, queue_per_agent: perAgent, limits: { payload_max_kb: 4096, drops_per_hour_per_agent: 200, default_pull_limit: 50 } };
    }
    case "mem_brief_list": {
      const where = ["1=1"]; const params = [];
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.status)     { where.push("status=?");     params.push(a.status); }
      params.push(Math.min(a.limit || 20, 200));
      const rows = tdb.prepare(
        "SELECT id, agent_name, source_agent, status, created_at, dispatched_at, done_at, " +
        "substr(content,1,160) AS preview, channel, outcome " +
        "FROM agent_brief WHERE " + where.join(" AND ") + " ORDER BY created_at DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, briefs: rows };
    }
    case "mem_action_log": {
      const stmt = tdb.prepare("INSERT INTO agent_action (agent_name, action_kind, target, status, payload_json, started_at, session_id, topic, meta_json) VALUES (?,?,?,?,?,?,?,?,?)");
      const r = stmt.run(
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
    }
    case "mem_action_finish": {
      const finishedAt = new Date().toISOString();
      const startedRow = tdb.prepare("SELECT started_at FROM agent_action WHERE id=?").get(a.id);
      let latency = null;
      if (startedRow && startedRow.started_at) {
        latency = Date.parse(finishedAt) - Date.parse(startedRow.started_at);
      }
      tdb.prepare("UPDATE agent_action SET status=?, finished_at=?, latency_ms=?, result_json=? WHERE id=?")
        .run(a.status || "ok", finishedAt, latency, a.result ? JSON.stringify(a.result) : null, a.id);
      return { id: a.id, status: a.status || "ok", latency_ms: latency };
    }
    case "mem_actions_recent": {
      const where = ["1=1"]; const params = [];
      if (a.agent_name) { where.push("agent_name=?"); params.push(a.agent_name); }
      if (a.action_kind) { where.push("action_kind=?"); params.push(a.action_kind); }
      if (a.topic) { where.push("topic=?"); params.push(a.topic); }
      if (a.since) { where.push("started_at >= ?"); params.push(a.since); }
      params.push(Math.min(a.limit || 50, 500));
      const rows = tdb.prepare(
        "SELECT id, agent_name, action_kind, target, status, started_at, finished_at, latency_ms, " +
        "substr(payload_json,1,200) AS payload_preview, substr(result_json,1,200) AS result_preview, " +
        "session_id, topic " +
        "FROM agent_action WHERE " + where.join(" AND ") + " ORDER BY started_at DESC LIMIT ?"
      ).all(...params);
      return { count: rows.length, actions: rows };
    }
    case "mem_actions_search": {
      const q = String(a.q || "").trim();
      if (!q) throw new Error("q required");
      const like = "%" + q + "%";
      const rows = tdb.prepare(
        "SELECT id, agent_name, action_kind, target, status, started_at, latency_ms " +
        "FROM agent_action WHERE target LIKE ? OR payload_json LIKE ? OR result_json LIKE ? OR topic LIKE ? " +
        "ORDER BY started_at DESC LIMIT ?"
      ).all(like, like, like, like, Math.min(a.limit || 30, 200));
      return { count: rows.length, actions: rows };
    }
    case "mem_reflect_now": {
      const agent = a.agent_name || "dieter";
      const sinceIso = a.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const counts = tdb.prepare(
        "SELECT COUNT(*) c, SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) inflight " +
        "FROM agent_action WHERE agent_name=? AND started_at >= ?"
      ).get(agent, sinceIso);
      const topTopics = tdb.prepare(
        "SELECT COALESCE(topic,'(none)') AS topic, COUNT(*) AS n FROM agent_action " +
        "WHERE agent_name=? AND started_at >= ? GROUP BY topic ORDER BY n DESC LIMIT 5"
      ).all(agent, sinceIso);
      const lastFew = tdb.prepare(
        "SELECT id, action_kind, target, status, started_at FROM agent_action " +
        "WHERE agent_name=? AND started_at >= ? ORDER BY started_at DESC LIMIT 5"
      ).all(agent, sinceIso);
      const inflightTop = tdb.prepare(
        "SELECT id, action_kind, target, started_at FROM agent_action " +
        "WHERE agent_name=? AND finished_at IS NULL AND started_at >= ? " +
        "ORDER BY started_at DESC LIMIT 5"
      ).all(agent, sinceIso);
      let pendingBriefs = [];
      try {
        pendingBriefs = tdb.prepare(
          "SELECT id, source_agent, channel, created_at, substr(content,1,160) AS preview " +
          "FROM agent_brief WHERE agent_name=? AND status IN ('pending','dispatched') " +
          "ORDER BY created_at DESC LIMIT 5"
        ).all(agent);
      } catch (e) {}
      let lastReflection = null;
      try {
        lastReflection = tdb.prepare(
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
    }
    default:
      throw new Error("unknown tool: " + name);
  }
}
server.listen(PORT, HOST, () => {
  console.log(`[mnemo-daemon] HTTP on ${HOST}:${PORT}`);
  recordWrite("daemon_boot", 0, "alive");
});

// ---------- Telegram poller ----------
function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!TG_TOKEN) return reject(new Error("TELEGRAM_BOT_TOKEN missing"));
    const body = JSON.stringify(params || {});
    const req = https.request({
      method: "POST",
      host: "api.telegram.org",
      path: `/bot${TG_TOKEN}/${method}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (resp) => {
      let buf = "";
      resp.on("data", c => buf += c);
      resp.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function loadOffset() {
  try { return parseInt(fs.readFileSync(TG_OFFSET_FILE, "utf8"), 10) || 0; }
  catch { return 0; }
}
function saveOffset(off) {
  try { fs.writeFileSync(TG_OFFSET_FILE, String(off)); } catch {}
}

async function pollTelegram() {
  if (!TG_TOKEN) return;
  let offset = loadOffset();
  try {
    const r = await tgRequest("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    if (!r.ok) {
      recordWrite("telegram_poller", 0, "error: " + (r.description || "unknown"));
      return;
    }
    let added = 0;
    for (const upd of r.result || []) {
      offset = Math.max(offset, upd.update_id + 1);
      const msg = upd.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat && msg.chat.id);
      if (OWNER_CHAT_ID && chatId !== OWNER_CHAT_ID) continue;
      const userId = String(msg.from && msg.from.id);
      const isOwner = userId === OWNER_CHAT_ID;
      const occurred = new Date((msg.date || 0) * 1000).toISOString();
      const result = ingestEvent({
        kind: "message",
        source: "telegram",
        source_ref: "tg:" + msg.message_id,
        occurred_at: occurred,
        actor: isOwner ? OWNER_NAME : (msg.from && (msg.from.first_name || msg.from.username) || "unknown"),
        actor_id: userId,
        importance: isOwner ? 7 : 5,
        text: msg.text,
        meta: { chat_id: chatId, message_id: msg.message_id, raw_from: msg.from },
      });
      if (result.inserted) added++;
    }
    saveOffset(offset);
    if (added > 0) recordWrite("telegram_poller", added, "alive");
    else recordWrite("telegram_poller", 0, "alive_no_new");
  } catch (e) {
    recordWrite("telegram_poller", 0, "error: " + String(e.message).slice(0, 100));
  }
}

// Long-poll loop
async function telegramLoop() {
  while (true) {
    await pollTelegram();
    await new Promise(r => setTimeout(r, 1000));
  }
}
if (TG_TOKEN) {
  console.log("[mnemo-daemon] starting Telegram poller for chat", OWNER_CHAT_ID || "(any)");
  telegramLoop();
} else {
  console.log("[mnemo-daemon] TELEGRAM_BOT_TOKEN not set, poller disabled");
  recordWrite("telegram_poller", 0, "disabled_no_token");
}

// ---------- Auto-Scar from corrections — every 30s scan new messages ----------
function getHighWater() {
  try {
    const r = db.prepare("SELECT v FROM scar_high_water WHERE k='last_scanned_id'").get();
    return r ? r.v : 0;
  } catch { return 0; }
}
function setHighWater(v) {
  try {
    db.prepare("INSERT INTO scar_high_water (k,v) VALUES ('last_scanned_id',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(v);
  } catch {}
}

const SCAR_DEDUP_WINDOW_MIN = 30;

function autoScarSweep() {
  try {
    const cursor = getHighWater();
    const newMessages = db.prepare(`
      SELECT id, actor, occurred_at, text FROM memory
      WHERE kind='message' AND id > ?
      ORDER BY id ASC
      LIMIT 500
    `).all(cursor);
    if (!newMessages.length) return;
    const patterns = db.prepare("SELECT * FROM correction_pattern").all();
    let scarCount = 0;
    let maxId = cursor;
    for (const msg of newMessages) {
      maxId = Math.max(maxId, msg.id);
      for (const pat of patterns) {
        // Honor actor_scope: only scan messages from the right speaker
        if (pat.actor_scope && pat.actor_scope !== msg.actor) continue;
        let regex;
        try { regex = new RegExp(pat.pattern, "i"); } catch { continue; }
        if (!regex.test(msg.text)) continue;
        // Dedup window: skip if same pattern fired within last 30 min
        const recentHit = db.prepare(`
          SELECT id FROM scar_event
          WHERE pattern_id = ?
            AND occurred_at > datetime('now', '-${SCAR_DEDUP_WINDOW_MIN} minutes')
          LIMIT 1
        `).get(pat.id);
        if (recentHit) continue;
        db.prepare(`INSERT INTO scar_event (scar_slug, triggering_memory_id, pattern_id, trait_delta_applied, notes) VALUES (?,?,?,?,?)`)
          .run(pat.classifier, msg.id, pat.id, pat.delta || 0,
            `Pattern '${pat.pattern}' matched in ${msg.actor}: "${msg.text.slice(0,80)}"`);
        db.prepare(`UPDATE correction_pattern SET hit_count=hit_count+1, last_hit_at=? WHERE id=?`)
          .run(now(), pat.id);
        if (pat.trait_to_adjust && pat.delta) {
          const trait = db.prepare("SELECT name, weight, notes FROM personality_trait WHERE name=?").get(pat.trait_to_adjust);
          if (trait) {
            const isHardCapped = trait.notes && trait.notes.includes("HARD_CAP=0.0");
            if (!isHardCapped) {
              const newWeight = Math.max(0, Math.min(1, trait.weight + pat.delta));
              db.prepare("UPDATE personality_trait SET weight=?, evidence_count=evidence_count+1, last_updated_at=? WHERE name=?")
                .run(newWeight, now(), pat.trait_to_adjust);
              db.prepare(`INSERT INTO trait_event (trait_id, memory_id, delta, reason, classifier) VALUES ((SELECT id FROM personality_trait WHERE name=?),?,?,?,?)`)
                .run(pat.trait_to_adjust, msg.id, pat.delta, `auto-scar from pattern ${pat.id}`, pat.classifier);
            }
          }
        }
        scarCount++;
      }
    }
    setHighWater(maxId);
    recordWrite("auto_scar_scanner", scarCount, "alive");
  } catch (e) {
    recordWrite("auto_scar_scanner", 0, "error: " + String(e.message).slice(0,100));
  }
}
setInterval(autoScarSweep, 30 * 1000);
setTimeout(autoScarSweep, 7000);

// ---------- Sleep-Protect outbound queue flusher ----------
function isInQuietHours() {
  const now_utc = new Date();
  const local_h = (now_utc.getUTCHours() + TZ_OFFSET_HOURS + 24) % 24;
  if (QUIET_START < QUIET_END) {
    return local_h >= QUIET_START && local_h < QUIET_END;
  }
  return local_h >= QUIET_START || local_h < QUIET_END;
}

// Channel registry — abstracts over Telegram/WhatsApp/Email/etc.
let channelRegistry = null;
try { channelRegistry = require("./channels"); }
catch (e) { console.error("[mnemo-daemon] channels registry load failed:", e.message); }

async function flushOutboundQueue() {
  try {
    const now_iso = now();
    const due = db.prepare(`SELECT * FROM outbound_queue WHERE status='queued' AND (not_before IS NULL OR not_before <= ?) ORDER BY priority DESC, queued_at ASC LIMIT 20`).all(now_iso);
    let sent = 0, failed = 0, skipped = 0;
    for (const m of due) {
      if (isInQuietHours() && m.priority < 9) { skipped++; continue; }
      if (!channelRegistry) { skipped++; continue; }
      const ch = channelRegistry.get(m.channel);
      if (!ch || !ch.isEnabled()) { skipped++; continue; }
      try {
        const r = await ch.send(m.recipient, m.text, {});
        db.prepare("UPDATE outbound_queue SET status='delivered', delivered_at=? WHERE id=?")
          .run(now(), m.id);
        sent++;
      } catch (e) {
        db.prepare("UPDATE outbound_queue SET status='failed' WHERE id=?").run(m.id);
        failed++;
      }
    }
    if (sent || failed) recordWrite("outbound_flusher", sent, failed > 0 ? `partial:${failed}_failed` : "alive");
  } catch (e) {}
}
setInterval(() => { flushOutboundQueue().catch(() => {}); }, 60 * 1000);

// ---------- Daily reflection cron ----------
function maybeRunDailyReflection() {
  const d = new Date();
  if (d.getHours() === 23 && d.getMinutes() < 5) {
    const today = d.toISOString().slice(0, 10);
    const exists = db.prepare("SELECT 1 FROM daily_reflection WHERE reflection_date=?").get(today);
    if (!exists) {
      try {
        // simple synthesis (counts only — full LLM-pass added in Phase 2)
        const fromTs = today + "T00:00:00Z";
        const toTs = today + "T23:59:59Z";
        const all = db.prepare(`
          SELECT actor, text FROM memory
          WHERE kind='message' AND occurred_at BETWEEN ? AND ?
        `).all(fromTs, toTs);
        let corrections = 0, praises = 0;
        for (const e of all) {
          if (e.actor !== OWNER_NAME) continue;
          if (/\b(stop|hör auf|nicht so|falsch|kein|fantasi|kacke|scheiße|kaputt)/i.test(e.text)) corrections++;
          if (/\b(geil|super|perfekt|top|stark|hammer|granate)/i.test(e.text)) praises++;
        }
        db.prepare(`
          INSERT INTO daily_reflection (reflection_date, events_examined, corrections, praises, summary)
          VALUES (?,?,?,?,?)
        `).run(today, all.length, corrections, praises,
          `${all.length} messages, ${corrections} corrections, ${praises} praises (auto-cron synthesis).`);
        recordWrite("reflection_cron", 1, "alive");
      } catch (e) {
        recordWrite("reflection_cron", 0, "error: " + String(e.message).slice(0,100));
      }
    }
  }
}

// ---------- URL Watcher — polls tracked_url every 5 min ----------
const url_module = require("url");
function pollUrl(rec) {
  return new Promise((resolve) => {
    try {
      const u = url_module.parse(rec.url);
      const lib = u.protocol === "https:" ? https : http;
      const start = Date.now();
      const req = lib.request({
        method: "HEAD",
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.path || "/",
        timeout: 8000,
        headers: { "user-agent": "Mnemo-URL-Watcher/0.1" },
      }, (res) => {
        const ms = Date.now() - start;
        resolve({ status: res.statusCode || 0, ms });
        res.resume();
      });
      req.on("error", () => resolve({ status: 0, ms: Date.now() - start, error: true }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, ms: Date.now() - start, timeout: true }); });
      req.end();
    } catch (e) { resolve({ status: 0, ms: 0, error: true }); }
  });
}

async function urlSweep() {
  const urls = db.prepare("SELECT * FROM tracked_url").all();
  for (const u of urls) {
    const r = await pollUrl(u);
    const success = r.status === u.expected_status;
    const failures = success ? 0 : (u.consecutive_failures || 0) + 1;
    db.prepare(`UPDATE tracked_url SET last_checked_at=?, last_status=?, last_response_ms=?, last_failure_at=?, consecutive_failures=? WHERE id=?`)
      .run(now(), r.status, r.ms, success ? u.last_failure_at : now(), failures, u.id);
    // If 3 consecutive failures, queue a next_action
    if (failures === 3) {
      db.prepare(`INSERT INTO next_action (title, rationale, source, source_ref, priority, suggested_agent, meta_json) VALUES (?,?,?,?,?,?,?)`)
        .run(
          `URL down: ${u.url}`,
          `Returned ${r.status} (expected ${u.expected_status}) for 3 consecutive checks. Topic: ${u.topic || "unknown"}.`,
          "url_failed", String(u.id), 8, "dieter",
          JSON.stringify({ url: u.url, status: r.status, ms: r.ms })
        );
    }
  }
  recordWrite("url_watcher", urls.length, "alive");
}
setInterval(() => { urlSweep().catch(() => {}); }, 5 * 60 * 1000);
// Immediate first sweep
setTimeout(() => { urlSweep().catch(() => {}); }, 5000);

// ---------- Health-checker every 5 min ----------
function healthSweep() {
  const writers = db.prepare("SELECT writer, last_write_at FROM writer_health").all();
  const now_ms = Date.now();
  for (const w of writers) {
    if (!w.last_write_at) continue;
    const ageMs = now_ms - new Date(w.last_write_at).getTime();
    let status = "alive";
    if (ageMs > 24 * 3600 * 1000) status = "dead";
    else if (ageMs > 2 * 3600 * 1000) status = "stale";
    db.prepare("UPDATE writer_health SET status=?, last_check_at=? WHERE writer=?")
      .run(status, now(), w.writer);
  }
}

setInterval(healthSweep, 5 * 60 * 1000);
setInterval(maybeRunDailyReflection, 60 * 1000);

// #9 TTL job + #10 action-log rollup
const BRIEF_TTL_HOURS = parseInt(process.env.BRIEF_TTL_HOURS || "168", 10);
const ROLLUP_AFTER_HOURS = parseInt(process.env.ROLLUP_AFTER_HOURS || "24", 10);
function runMaintenanceCycle() {
  try {
    const ttlInfo = db.prepare("UPDATE agent_brief SET status='stale' WHERE status='pending' AND created_at < datetime('now', '-' || ? || ' hours')").run(BRIEF_TTL_HOURS);
    if (ttlInfo.changes > 0) console.log("[ttl] flipped " + ttlInfo.changes + " briefs to stale");
  } catch (e) { console.error("[ttl]", e.message); }
  try {
    const cutoff = new Date(Date.now() - ROLLUP_AFTER_HOURS * 3600 * 1000).toISOString();
    const groups = db.prepare("SELECT agent_name, action_kind, topic, COUNT(*) c FROM agent_action WHERE started_at < ? AND topic IN ('brief-poll','heartbeat','poll') AND status != 'rollup' GROUP BY agent_name, action_kind, topic HAVING COUNT(*) > 10").all(cutoff);
    for (const g of groups) {
      const ids = db.prepare("SELECT id FROM agent_action WHERE agent_name=? AND action_kind=? AND topic=? AND started_at < ? AND status != 'rollup'").all(g.agent_name, g.action_kind, g.topic, cutoff);
      const idList = ids.map(r => r.id);
      const txn = db.transaction(() => {
        db.prepare("INSERT INTO agent_action (agent_name, action_kind, topic, status, payload_json, started_at) VALUES (?,?,?,?,?, ?)").run(g.agent_name, g.action_kind, g.topic, "rollup", JSON.stringify({ rollup: true, hours: ROLLUP_AFTER_HOURS, count: g.c, original_ids: idList.slice(0,500) }), cutoff);
        const placeholders = idList.map(() => "?").join(",");
        if (idList.length) db.prepare("DELETE FROM agent_action WHERE id IN (" + placeholders + ")").run(...idList);
      });
      txn();
      console.log("[rollup] " + g.agent_name + "/" + g.topic + ": " + g.c + " rows -> 1 rollup");
    }
  } catch (e) { console.error("[rollup]", e.message); }
}
setTimeout(runMaintenanceCycle, 30 * 1000);
setInterval(runMaintenanceCycle, 60 * 60 * 1000);

process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT", () => { db.close(); process.exit(0); });
