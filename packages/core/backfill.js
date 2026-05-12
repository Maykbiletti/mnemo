#!/usr/bin/env node
/**
 * Mnemo Backfill — one-shot import of all historical memory sources into mnemo.db
 *
 * Sources:
 *   1. chat.json (exported owner/agent messages)
 *   2. memory/stream/*.jsonl (Telegram exports 2026-03-28 → 2026-04-29)
 *   3. memory/scars/*.md (failure-and-fix narratives)
 *   4. memory/dream/*.md (session reflections)
 *   5. memory/*.md (markdown memories: feedback_*, project_*, reference_*, user_*)
 *   6. agent-client/projects/<sid>.jsonl (current + recent session conversations)
 *
 * Idempotent: skips rows whose hash already exists (sha256 of kind|source_ref|occurred_at|text).
 * Logs to backfill_run table.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const SOURCE_ROOT = process.env.MNEMO_SRC || path.join(__dirname, "sources");
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";
const OWNER_USER_ID = process.env.MNEMO_OWNER_USER_ID || ""; // e.g. "user12345" for telegram
const SHARP = (s) => crypto.createHash("sha256").update(s).digest("hex");

function nowIso() { return new Date().toISOString(); }

function ensureRunRow(db, source_path, source_kind) {
  const existing = db.prepare("SELECT * FROM backfill_run WHERE source_path=? AND source_kind=?")
    .get(source_path, source_kind);
  if (existing && existing.status === "done") return null;
  if (existing) {
    db.prepare("UPDATE backfill_run SET status='running', started_at=?, error=NULL WHERE id=?")
      .run(nowIso(), existing.id);
    return existing.id;
  }
  const r = db.prepare(
    "INSERT INTO backfill_run (source_path, source_kind, status, started_at) VALUES (?,?,?,?)"
  ).run(source_path, source_kind, "running", nowIso());
  return r.lastInsertRowid;
}

function finishRunRow(db, run_id, rows_added, rows_skipped, error) {
  if (!run_id) return;
  db.prepare(
    "UPDATE backfill_run SET rows_added=?, rows_skipped=?, finished_at=?, status=?, error=? WHERE id=?"
  ).run(
    rows_added, rows_skipped, nowIso(),
    error ? "failed" : "done",
    error ? String(error).slice(0, 500) : null,
    run_id
  );
}

const insertMem = (db) => db.prepare(`
  INSERT OR IGNORE INTO memory
    (kind, source, source_ref, occurred_at, actor, actor_id, topic, importance, text, meta_json, hash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

function tryInsert(stmt, row) {
  const hash = SHARP([row.kind, row.source_ref || "", row.occurred_at, row.text].join("|"));
  const r = stmt.run(
    row.kind, row.source, row.source_ref || null, row.occurred_at,
    row.actor || null, row.actor_id || null, row.topic || null,
    row.importance ?? 5, row.text, row.meta_json || null, hash
  );
  return r.changes > 0;
}

// ---------- 1. chat.json ----------
function ingestChatJson(db) {
  const fp = path.join(SOURCE_ROOT, "chat.json");
  if (!fs.existsSync(fp)) return { added: 0, skipped: 0, error: "missing" };
  const run = ensureRunRow(db, fp, "chat_json");
  if (!run) return { added: 0, skipped: 0, error: "already done" };
  const stmt = insertMem(db);
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  let added = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const m of msgs) {
      if (!m || typeof m.text !== "string" || !m.text.trim()) { skipped++; continue; }
      const occurred = m.date_unixtime
        ? new Date(parseInt(m.date_unixtime, 10) * 1000).toISOString()
        : (m.date ? new Date(m.date).toISOString() : nowIso());
      const isOwner = OWNER_USER_ID && m.from_id === OWNER_USER_ID;
      const ok = tryInsert(stmt, {
        kind: "message",
        source: m.source === "terminal" ? "terminal" : "telegram",
        source_ref: m.telegram_id ? "tg:" + m.telegram_id : "chatjson:" + m.id,
        occurred_at: occurred,
        actor: isOwner ? OWNER_NAME : (m.from || "unknown"),
        actor_id: m.from_id || null,
        topic: null,
        importance: isOwner ? 6 : 5,
        text: m.text,
        meta_json: JSON.stringify({ from: m.from, source: m.source }),
      });
      if (ok) added++; else skipped++;
    }
  });
  try { tx(); finishRunRow(db, run, added, skipped, null); }
  catch (e) { finishRunRow(db, run, added, skipped, e); throw e; }
  return { added, skipped };
}

// ---------- 2. stream/*.jsonl ----------
function ingestStreamJsonl(db) {
  const dir = path.join(SOURCE_ROOT, "stream");
  if (!fs.existsSync(dir)) return { added: 0, skipped: 0, error: "missing" };
  const stmt = insertMem(db);
  let totalAdded = 0, totalSkipped = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dir, f);
    const run = ensureRunRow(db, fp, "stream_jsonl");
    if (!run) continue;
    let added = 0, skipped = 0;
    try {
      const lines = fs.readFileSync(fp, "utf8").split("\n");
      const tx = db.transaction(() => {
        for (const line of lines) {
          if (!line.trim()) continue;
          let o;
          try { o = JSON.parse(line); } catch { skipped++; continue; }
          if (!o.text || typeof o.text !== "string") { skipped++; continue; }
          const occurred = o.date ? new Date(o.date).toISOString() : nowIso();
          const isOwner = (o.from === OWNER_NAME) || (OWNER_USER_ID && o.from_id === OWNER_USER_ID);
          const ok = tryInsert(stmt, {
            kind: "message",
            source: "telegram",
            source_ref: "tg:" + (o.msg_id || o.hash || ""),
            occurred_at: occurred,
            actor: isOwner ? OWNER_NAME : (o.from || "unknown"),
            actor_id: o.from_id || null,
            topic: null,
            importance: isOwner ? 6 : 5,
            text: o.text,
            meta_json: JSON.stringify({ ingest_source: "stream_jsonl", file: f, hash: o.hash }),
          });
          if (ok) added++; else skipped++;
        }
      });
      tx();
      finishRunRow(db, run, added, skipped, null);
    } catch (e) {
      finishRunRow(db, run, added, skipped, e);
    }
    totalAdded += added; totalSkipped += skipped;
  }
  return { added: totalAdded, skipped: totalSkipped };
}

// ---------- 3. scars/*.md ----------
function ingestMarkdownDir(db, dirName, kind) {
  const dir = path.join(SOURCE_ROOT, dirName);
  if (!fs.existsSync(dir)) return { added: 0, skipped: 0 };
  const stmt = insertMem(db);
  const run = ensureRunRow(db, dir, kind === "scar" ? "scars_md" : kind === "dream" ? "dream_md" : "memory_md");
  if (!run) return { added: 0, skipped: 0 };
  let added = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const fp = path.join(dir, f);
      const text = fs.readFileSync(fp, "utf8");
      const stat = fs.statSync(fp);
      // Try to extract date from filename "YYYY-MM-DD-..." or use mtime
      const mDate = f.match(/^(\d{4}-\d{2}-\d{2})/);
      const occurred = mDate ? mDate[1] + "T00:00:00Z" : stat.mtime.toISOString();
      const ok = tryInsert(stmt, {
        kind,
        source: "memory_dir",
        source_ref: dirName + "/" + f,
        occurred_at: occurred,
        actor: kind === "scar" ? (process.env.MNEMO_AGENT_NAME || "agent") : kind === "dream" ? (process.env.MNEMO_AGENT_NAME || "agent") : "system",
        topic: null,
        importance: kind === "scar" ? 8 : (kind === "dream" ? 4 : 6),
        text,
        meta_json: JSON.stringify({ filename: f, mtime: stat.mtime.toISOString() }),
      });
      if (ok) added++; else skipped++;
    }
  });
  try { tx(); finishRunRow(db, run, added, skipped, null); }
  catch (e) { finishRunRow(db, run, added, skipped, e); throw e; }
  return { added, skipped };
}

// ---------- 4. session JSONL files ----------
function ingestSessionJsonl(db) {
  const dir = path.join(SOURCE_ROOT, "sessions");
  if (!fs.existsSync(dir)) return { added: 0, skipped: 0 };
  const stmt = insertMem(db);
  let totalAdded = 0, totalSkipped = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dir, f);
    const run = ensureRunRow(db, fp, "session_jsonl");
    if (!run) continue;
    let added = 0, skipped = 0;
    let sessionId = f.replace(/\.jsonl$/, "");
    let firstAt = null, lastAt = null, msgCount = 0;
    try {
      const lines = fs.readFileSync(fp, "utf8").split("\n");
      const tx = db.transaction(() => {
        for (const line of lines) {
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { skipped++; continue; }
          // Capture user prompts and assistant text content as memory
          const ts = o.timestamp || (o.message && o.message.timestamp) || null;
          if (!ts) { skipped++; continue; }
          const occurred = new Date(ts).toISOString();
          if (!firstAt) firstAt = occurred;
          lastAt = occurred;
          if (o.type === "user" || o.type === "assistant" || o.userType === "human") {
            let text = "";
            try {
              if (o.message && Array.isArray(o.message.content)) {
                text = o.message.content.map(c => c.text || "").filter(Boolean).join("\n").trim();
              } else if (o.message && typeof o.message.content === "string") {
                text = o.message.content;
              }
            } catch {}
            if (!text) { skipped++; continue; }
            const isUser = (o.type === "user") || (o.userType === "human");
            const ok = tryInsert(stmt, {
              kind: "message",
              source: "session_jsonl",
              source_ref: "session:" + sessionId + ":" + (o.uuid || ""),
              occurred_at: occurred,
              actor: isUser ? OWNER_NAME : "agent",
              actor_id: isUser ? (OWNER_USER_ID || null) : null,
              topic: null,
              importance: 5,
              text,
              meta_json: JSON.stringify({ session_id: sessionId, msg_uuid: o.uuid }),
            });
            if (ok) { added++; msgCount++; } else skipped++;
          }
        }
      });
      tx();
      // Upsert session row
      try {
        db.prepare(`INSERT OR IGNORE INTO session (id, started_at, jsonl_path, agent) VALUES (?,?,?,?)`)
          .run(sessionId, firstAt || nowIso(), fp, process.env.MNEMO_AGENT_NAME || process.env.MNEMO_AGENT || "agent");
        db.prepare(`UPDATE session SET ended_at=?, message_count=? WHERE id=?`)
          .run(lastAt, msgCount, sessionId);
      } catch {}
      finishRunRow(db, run, added, skipped, null);
    } catch (e) {
      finishRunRow(db, run, added, skipped, e);
    }
    totalAdded += added; totalSkipped += skipped;
  }
  return { added: totalAdded, skipped: totalSkipped };
}

// ---------- main ----------
(function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  console.log("[mnemo-backfill] starting against", DB_PATH);

  const summary = {};
  try { summary.chatJson = ingestChatJson(db); } catch (e) { summary.chatJson = { error: String(e) }; }
  try { summary.streamJsonl = ingestStreamJsonl(db); } catch (e) { summary.streamJsonl = { error: String(e) }; }
  try { summary.scars = ingestMarkdownDir(db, "scars", "scar"); } catch (e) { summary.scars = { error: String(e) }; }
  try { summary.dream = ingestMarkdownDir(db, "dream", "dream"); } catch (e) { summary.dream = { error: String(e) }; }
  try { summary.memoryMd = ingestMarkdownDir(db, "memory_md", "memory_md"); } catch (e) { summary.memoryMd = { error: String(e) }; }
  try { summary.sessions = ingestSessionJsonl(db); } catch (e) { summary.sessions = { error: String(e) }; }

  const totals = db.prepare("SELECT kind, COUNT(*) c FROM memory GROUP BY kind ORDER BY c DESC").all();
  const actors = db.prepare("SELECT actor, COUNT(*) c FROM memory GROUP BY actor ORDER BY c DESC LIMIT 5").all();
  const dateMin = db.prepare("SELECT MIN(occurred_at) m FROM memory").get().m;
  const dateMax = db.prepare("SELECT MAX(occurred_at) m FROM memory").get().m;

  console.log("[mnemo-backfill] summary:", JSON.stringify(summary, null, 2));
  console.log("[mnemo-backfill] totals by kind:", totals);
  console.log("[mnemo-backfill] top actors:", actors);
  console.log(`[mnemo-backfill] date range: ${dateMin} → ${dateMax}`);
  db.close();
})();
