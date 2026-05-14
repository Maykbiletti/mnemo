"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function queueDir() {
  return process.env.MNEMO_HOOK_QUEUE_DIR || path.join(os.homedir(), ".mnemo", "hook_queue");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dayFile(dir) {
  return path.join(dir, "queue-" + new Date().toISOString().slice(0, 10) + ".jsonl");
}

function enqueueToolCall(item) {
  const dir = ensureDir(queueDir());
  const row = Object.assign({
    queued_at: new Date().toISOString(),
    kind: "tool_call",
    attempts: 0
  }, item || {});
  fs.appendFileSync(dayFile(dir), JSON.stringify(row) + "\n", "utf8");
  return { ok: true, queued: true, queue_dir: dir };
}

function listQueueFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^queue-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

async function callTool(baseUrl, name, args) {
  const res = await fetch(`${String(baseUrl || "").replace(/\/+$/, "")}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args || {})
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 300)}`);
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

function rewriteQueueFile(file, rows) {
  if (!rows.length) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  fs.writeFileSync(file, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n", "utf8");
}

async function flushQueue(baseUrl, options = {}) {
  const dir = ensureDir(queueDir());
  const limit = Math.max(1, Number(options.limit || process.env.MNEMO_HOOK_QUEUE_FLUSH_LIMIT || 50));
  const files = listQueueFiles(dir);
  const out = { ok: true, queue_dir: dir, attempted: 0, flushed: 0, remaining: 0, errors: [] };
  for (const file of files) {
    if (out.attempted >= limit) break;
    const rawLines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
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
      out.remaining += fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
    } catch {}
  }
  out.ok = out.errors.length === 0;
  return out;
}

function queueStats() {
  const dir = ensureDir(queueDir());
  const files = listQueueFiles(dir);
  let rows = 0;
  let oldest = null;
  let newest = null;
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
      rows++;
      try {
        const row = JSON.parse(line);
        const at = row.queued_at || null;
        if (at && (!oldest || at < oldest)) oldest = at;
        if (at && (!newest || at > newest)) newest = at;
      } catch {}
    }
  }
  return { queue_dir: dir, files: files.length, rows, oldest_queued_at: oldest, newest_queued_at: newest };
}

module.exports = { enqueueToolCall, flushQueue, queueStats, queueDir };
