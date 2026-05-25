"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function queueDir() {
  return process.env.MNEMO_HOOK_QUEUE_DIR || path.join(os.homedir(), ".mnemo", "hook_queue");
}

function maxQueueFileBytes() {
  const n = Number(process.env.MNEMO_HOOK_QUEUE_MAX_FILE_BYTES || 512 * 1024);
  return Math.max(64 * 1024, Number.isFinite(n) ? n : 512 * 1024);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function queueFileParts(name) {
  const m = String(name || "").match(/^queue-(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?\.jsonl$/);
  if (!m) return null;
  return { date: m[1], seq: m[2] ? Number(m[2]) : 0 };
}

function queueFileName(date, seq) {
  return "queue-" + date + (seq > 0 ? "-" + String(seq).padStart(4, "0") : "") + ".jsonl";
}

function fileBytes(file) {
  try { return fs.statSync(file).size || 0; } catch { return 0; }
}

function dayFile(dir) {
  const date = new Date().toISOString().slice(0, 10);
  const files = listQueueFiles(dir).filter((file) => {
    const parts = queueFileParts(path.basename(file));
    return parts && parts.date === date;
  });
  const latest = files[files.length - 1];
  if (latest && fileBytes(latest) < maxQueueFileBytes()) return latest;
  const nextSeq = latest ? (queueFileParts(path.basename(latest)).seq + 1) : 0;
  return path.join(dir, queueFileName(date, nextSeq));
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAttempts() {
  const n = Number(process.env.MNEMO_HOOK_RETRY_ATTEMPTS || 4);
  return Math.max(1, Number.isFinite(n) ? n : 4);
}

function retryBaseMs() {
  const n = Number(process.env.MNEMO_HOOK_RETRY_BASE_MS || 350);
  return Math.max(50, Number.isFinite(n) ? n : 350);
}

function retryMaxMs() {
  const n = Number(process.env.MNEMO_HOOK_RETRY_MAX_MS || 5000);
  return Math.max(retryBaseMs(), Number.isFinite(n) ? n : 5000);
}

function retryDelayMs(attempt) {
  const base = Math.min(retryMaxMs(), retryBaseMs() * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(base + Math.random() * Math.min(250, base));
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function readUtf8Lines(file) {
  return fs.readFileSync(file).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
}

function enqueueToolCall(item) {
  const dir = ensureDir(queueDir());
  const row = Object.assign({
    queued_at: new Date().toISOString(),
    kind: "tool_call",
    attempts: 0
  }, item || {});
  const file = dayFile(dir);
  fs.appendFileSync(file, asciiJson(row) + "\n", "utf8");
  return { ok: true, queued: true, queue_dir: dir, queue_file: file, queue_file_bytes: fileBytes(file) };
}

function listQueueFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => queueFileParts(name))
    .sort((a, b) => {
      const pa = queueFileParts(a);
      const pb = queueFileParts(b);
      return String(pa.date).localeCompare(String(pb.date)) || (pa.seq - pb.seq);
    })
    .map((name) => path.join(dir, name));
}

async function callTool(baseUrl, name, args) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryAttempts(); attempt++) {
    let res = null;
    let text = "";
    try {
      res = await fetch(`${String(baseUrl || "").replace(/\/+$/, "")}/tool/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args || {})
      });
      text = await res.text();
    } catch (error) {
      lastError = error;
      if (attempt >= retryAttempts()) throw lastError;
      await sleep(retryDelayMs(attempt));
      continue;
    }
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (res.ok) return json && typeof json === "object" && "result" in json ? json.result : json;
    lastError = new Error(`${name} ${res.status}: ${text.slice(0, 300)}`);
    if (!retryableStatus(res.status) || attempt >= retryAttempts()) throw lastError;
    await sleep(retryDelayMs(attempt));
  }
  throw lastError || new Error(`${name} failed`);
}

function rewriteQueueFile(file, rows) {
  if (!rows.length) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  fs.writeFileSync(file, rows.map((row) => typeof row === "string" ? row : asciiJson(row)).join("\n") + "\n", "utf8");
}

async function flushQueue(baseUrl, options = {}) {
  const dir = ensureDir(queueDir());
  const limit = Math.max(1, Number(options.limit || process.env.MNEMO_HOOK_QUEUE_FLUSH_LIMIT || 50));
  const files = listQueueFiles(dir);
  const out = { ok: true, queue_dir: dir, attempted: 0, flushed: 0, remaining: 0, errors: [] };
  for (const file of files) {
    if (out.attempted >= limit) break;
    const rawLines = readUtf8Lines(file);
    const keep = [];
    for (const raw of rawLines) {
      if (out.attempted >= limit) {
        keep.push(raw);
        continue;
      }
      let row = null;
      try { row = JSON.parse(raw); } catch {
        out.errors.push({ file, error: "bad_json" });
        continue;
      }
      out.attempted++;
      try {
        await callTool(baseUrl, row.tool_name, row.args || {});
        out.flushed++;
      } catch (e) {
        row.attempts = Number(row.attempts || 0) + 1;
        row.last_error = e.message;
        row.last_attempt_at = new Date().toISOString();
        keep.push(row);
        out.errors.push({ tool_name: row.tool_name, error: e.message });
      }
    }
    rewriteQueueFile(file, keep);
  }
  for (const file of listQueueFiles(dir)) {
    try {
      out.remaining += readUtf8Lines(file).length;
    } catch {}
  }
  out.ok = out.errors.length === 0;
  return out;
}

function queueStats() {
  const dir = ensureDir(queueDir());
  const files = listQueueFiles(dir);
  let rows = 0;
  let bytes = 0;
  let largest = 0;
  let oldest = null;
  let newest = null;
  const pagesByDay = {};
  for (const file of files) {
    const parts = queueFileParts(path.basename(file));
    if (parts) pagesByDay[parts.date] = (pagesByDay[parts.date] || 0) + 1;
    const size = fileBytes(file);
    bytes += size;
    largest = Math.max(largest, size);
    for (const line of readUtf8Lines(file)) {
      rows++;
      try {
        const row = JSON.parse(line);
        const at = row.queued_at || null;
        if (at && (!oldest || at < oldest)) oldest = at;
        if (at && (!newest || at > newest)) newest = at;
      } catch {}
    }
  }
  return {
    queue_dir: dir,
    files: files.length,
    rows,
    bytes,
    largest_file_bytes: largest,
    max_file_bytes: maxQueueFileBytes(),
    pages_by_day: pagesByDay,
    oldest_queued_at: oldest,
    newest_queued_at: newest
  };
}

module.exports = { enqueueToolCall, flushQueue, queueStats, queueDir };
