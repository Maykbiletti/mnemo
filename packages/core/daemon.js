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
      `).all(q, limit);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(rows));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: String(e.message) }));
    }
  }
  res.writeHead(404); res.end("not found");
});
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

process.on("SIGTERM", () => { db.close(); process.exit(0); });
process.on("SIGINT", () => { db.close(); process.exit(0); });
