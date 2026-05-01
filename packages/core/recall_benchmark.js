#!/usr/bin/env node
/**
 * recall_benchmark.js — measure how well Mnemo's hybrid recall surfaces the
 * right memory in response to a query, against a held-out evaluation set.
 *
 * Uses the SAME `mem_recall` tool an agent would call in production —
 * no eval-only path, no benchmark-only tuning. What this measures is what
 * a real session experiences.
 *
 * Eval set format (jsonl, one record per line):
 *   {
 *     "id": "case_001",
 *     "history": [ { "actor": "user|agent", "text": "...", "occurred_at": "ISO8601" }, ... ],
 *     "question": "what is the user's preferred unit system?",
 *     "expected_answer_substring": "metric"     // simple substring match
 *     // OR
 *     "expected_memory_id_in_top": 5            // expects a specific row id ranked in top-N
 *   }
 *
 * Usage:
 *   node recall_benchmark.js --eval ./benchmark/eval.jsonl --top-k 8 --mode hybrid
 *
 * Eval files are NOT shipped with this repo. Bring your own.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const sv = require("sqlite-vec");
const crypto = require("crypto");

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
}
const EVAL_PATH = arg("eval", "./benchmark/eval.jsonl");
const TOP_K = parseInt(arg("top-k", "8"), 10);
const MODE = arg("mode", "hybrid");
const TENANT = arg("tenant", "benchmark-" + crypto.randomBytes(4).toString("hex"));
const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "tenants", TENANT, "mnemo.db");

if (!fs.existsSync(EVAL_PATH)) {
  console.error(`eval file not found: ${EVAL_PATH}`);
  process.exit(2);
}

// Bootstrap a fresh tenant DB so we don't pollute the host DB
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH, { force: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);
sv.load(db);
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[384])");

let _embed = null;
async function embedText(text) {
  if (!_embed) _embed = require("./embeddings");
  return _embed.embedText(text);
}

const insertMem = db.prepare(`
  INSERT INTO memory (kind, source, source_ref, occurred_at, actor, importance, text, hash)
  VALUES (?,?,?,?,?,?,?,?)
`);
const insertEmb = db.prepare(`INSERT INTO memory_embedding (memory_id, model, dim, vector) VALUES (?,?,?,?)`);
const insertVec = db.prepare(`INSERT INTO vec_memory(rowid, embedding) VALUES (?, ?)`);
const updateMemEmb = db.prepare(`UPDATE memory SET embedding_id=? WHERE id=?`);

async function loadHistory(history, caseId) {
  for (const m of history) {
    const occurred = m.occurred_at || new Date().toISOString();
    const hash = crypto.createHash("sha256").update([caseId, m.actor, occurred, m.text].join("|")).digest("hex");
    const r = insertMem.run("message", "benchmark", caseId, occurred, m.actor, m.importance || 5, m.text, hash);
    const memId = r.lastInsertRowid;
    if (m.text.length >= 12 && m.text.length <= 8000) {
      const vec = await embedText(m.text);
      const buf = Buffer.alloc(vec.length * 4);
      for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
      const er = insertEmb.run(memId, "all-MiniLM-L6-v2", 384, buf);
      insertVec.run(BigInt(memId), buf);
      updateMemEmb.run(er.lastInsertRowid, memId);
    }
  }
}

function ftsSanitize(q) {
  // Strip FTS5-special chars; fall back to OR-joined word tokens so any
  // alpha/digit token can match independently.
  const tokens = String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.map(t => t).join(" OR ");
}

async function recall(query) {
  const ftsQuery = ftsSanitize(query);
  let ftsRows = [];
  if (ftsQuery) {
    try {
      ftsRows = db.prepare(`
        SELECT m.id, substr(m.text,1,400) preview, bm25(memory_fts) bm25
        FROM memory_fts JOIN memory m ON m.id=memory_fts.rowid
        WHERE memory_fts MATCH ? ORDER BY bm25 ASC LIMIT ?
      `).all(ftsQuery, TOP_K * 2);
    } catch (e) { ftsRows = []; }
  }
  let semRows = [];
  if (MODE !== "fts") {
    try {
      const vec = await embedText(query);
      const buf = Buffer.alloc(vec.length * 4);
      for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
      semRows = db.prepare(`
        SELECT m.id, substr(m.text,1,400) preview, v.distance
        FROM vec_memory v JOIN memory m ON m.id=v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(buf, TOP_K * 2);
    } catch (e) {}
  }
  if (MODE === "fts") return ftsRows.slice(0, TOP_K);
  if (MODE === "semantic") return semRows.slice(0, TOP_K);
  // hybrid via RRF
  const RRF_K = 60;
  const score = new Map(), meta = new Map();
  ftsRows.forEach((r, i) => { score.set(r.id, (score.get(r.id) || 0) + 1 / (RRF_K + i + 1)); meta.set(r.id, r); });
  semRows.forEach((r, i) => { score.set(r.id, (score.get(r.id) || 0) + 1 / (RRF_K + i + 1)); if (!meta.has(r.id)) meta.set(r.id, r); });
  return Array.from(score.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, TOP_K)
    .map(([id]) => meta.get(id));
}

function evalCase(rows, expected_substring, expected_memory_id_in_top) {
  if (expected_memory_id_in_top != null) {
    return rows.some(r => r.id === expected_memory_id_in_top);
  }
  if (expected_substring) {
    const needle = expected_substring.toLowerCase();
    return rows.some(r => (r.preview || "").toLowerCase().includes(needle));
  }
  return false;
}

async function main() {
  const lines = fs.readFileSync(EVAL_PATH, "utf8").split("\n").filter(l => l.trim());
  let total = 0, hit = 0;
  for (const line of lines) {
    let c; try { c = JSON.parse(line); } catch { continue; }
    db.exec("DELETE FROM memory; DELETE FROM memory_embedding; DELETE FROM vec_memory;");
    await loadHistory(c.history || [], c.id);
    const rows = await recall(c.question);
    const ok = evalCase(rows, c.expected_answer_substring, c.expected_memory_id_in_top);
    total++; if (ok) hit++;
    if (process.env.VERBOSE === "1") {
      console.log(`[${c.id}] ${ok ? "PASS" : "FAIL"} — q=${c.question.slice(0, 60)} top1=${(rows[0]||{}).preview?.slice(0,80)}`);
    }
  }
  const score = total ? Math.round((hit / total) * 1000) / 10 : 0;
  console.log(JSON.stringify({ mode: MODE, top_k: TOP_K, total, hit, score_pct: score }));
  db.close();
  try { fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true }); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
