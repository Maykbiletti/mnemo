#!/usr/bin/env node
"use strict";
/**
 * agent_worker.js — generic autonomous worker for a Mnemo-registered agent.
 *
 * Polls the local Mnemo daemon for new briefs addressed to the worker's
 * agent_name, dispatches each brief to a handler (default: agent-exec subprocess),
 * captures stdout, and ingests the result back as kind=agent_action.
 *
 * Usage:
 *   node agent_worker.js --agent send-content [--agent "agent exec --pkg=mini"] [--poll 10]
 *
 * Run with PM2 once per agent:
 *   pm2 start agent_worker.js --name send-content-worker -- --agent send-content
 *
 * Heartbeats every 30s via mem_connect_heartbeat.
 */

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }

const AGENT = arg("agent");
if (!AGENT) { console.error("usage: agent_worker.js --agent <name> [--runner \"<cmd>\"] [--poll <sec>]"); process.exit(2); }
const AGENT_CMD = arg("runner", "agent exec --pkg=mini -");
const POLL_SEC = parseInt(arg("poll", "10"), 10);
const HEARTBEAT_SEC = parseInt(arg("heartbeat", "30"), 10);
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const STATE_FILE = "/root/mnemo/.worker_state_" + AGENT + ".json";
const RESULT_DIR = "/root/mnemo/.worker_results";
const LLM_ROUTER = "/root/mnemo/packages/core/skills/llm_router.js";
try { fs.mkdirSync(RESULT_DIR, { recursive: true }); } catch(_) {}

// Token-saver: read agent's SOUL to determine cost-target. Cached for 60s.
let _cachedSoul = null, _soulAt = 0;
async function getSoulTarget() {
  if (_cachedSoul && Date.now() - _soulAt < 60000) return _cachedSoul;
  try {
    const r = await call("GET", "/recall?q=token+target&limit=3", null, { "X-Tenant-Id": AGENT });
    const arr = Array.isArray(r) ? r : [];
    const txt = (arr.find(x => /token\s*target/i.test(x.preview || "")) || {}).preview || "";
    let target = "fast";
    if (/cheap-cheapest|rule-based/i.test(txt)) target = "cheap";
    else if (/cheap-fast/i.test(txt)) target = "fast";
    else if (/quality/i.test(txt)) target = "quality";
    _cachedSoul = target; _soulAt = Date.now();
    return target;
  } catch (_) { return "fast"; }
}

// Decide whether brief needs LLM or can be handled rule-based (per agent role).
function needsLLM(brief) {
  // If brief is purely structured data (CSV-like, mostly digits), try rule-based path
  const t = brief.content || "";
  if (/^[\d,\s\.\-:e]+$/.test(t.slice(0, 200))) return false;  // pure data
  if (/^csv:/i.test(t.slice(0, 8))) return false;
  if (/^smtp-throttle|^suppress:|^bounce:/i.test(t.slice(0, 30))) return false;  // ops directives for deliver-agent
  return true;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch(_) { return { last_brief_id: 0 }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function call(method, urlPath, body, hdrs) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + urlPath);
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { "Content-Type": "application/json" };
    if (buf) headers["Content-Length"] = buf.length;
    if (hdrs) Object.assign(headers, hdrs);
    const req = http.request({ method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers, timeout: 10000 }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(_) { resolve(d); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (buf) req.write(buf);
    req.end();
  });
}

async function ingest(payload) {
  return call("POST", "/ingest", payload, { "X-Tenant-Id": AGENT });
}

async function heartbeat() {
  try { await call("POST", "/tool/mem_connect_heartbeat", { agent_name: AGENT, status: "online" }); }
  catch (e) { console.error("[" + AGENT + "] heartbeat:", e.message); }
}

async function pullBriefs() {
  try {
    const r = await call("POST", "/tool/mem_brief_pull", { agent_name: AGENT, limit: 5 });
    const briefs = (r && r.result && r.result.briefs) || [];
    return briefs;
  } catch (e) { console.error("[" + AGENT + "] pull:", e.message); return []; }
}

async function runHandler(brief) {
  const startedAt = new Date().toISOString();
  const resultPath = path.join(RESULT_DIR, AGENT + "-" + brief.id + ".log");
  const out = fs.createWriteStream(resultPath, { flags: "w" });

  // Token-saver: try rule-based first
  if (!needsLLM(brief)) {
    out.write("# agent=" + AGENT + " brief=" + brief.id + " mode=rule-based (no LLM call)\n# started=" + startedAt + "\n\n--- BRIEF ---\n" + brief.content + "\n--- HANDLER ---\nrule-based: brief content recognized as structured data — would dispatch to native handler. (Stub: no actual rule-engine wired yet.)\n");
    out.end();
    return { exit_code: 0, started_at: startedAt, finished_at: new Date().toISOString(), result_path: resultPath, stdout_tail: "rule-based no-op stub", stderr_tail: "", mode: "rule-based" };
  }

  const target = await getSoulTarget();
  out.write("# agent=" + AGENT + " brief=" + brief.id + " mode=llm-router target=" + target + "\n# from=" + (brief.source_agent || "?") + "\n# started=" + startedAt + "\n\n--- BRIEF ---\n" + brief.content + "\n--- HANDLER ---\n\n");

  // Try llm_router; if no provider configured, fallback to agent-exec
  return new Promise(resolve => {
    const child = spawn("node", [LLM_ROUTER, "--task", "chat", "--target", target], { stdio: ["pipe", "pipe", "pipe"] });
    let outBuf = "", errBuf = "";
    child.stdout.on("data", d => { outBuf += d; out.write(d); });
    child.stderr.on("data", d => { errBuf += d; out.write(d); });
    child.stdin.write(brief.content + "\n");
    child.stdin.end();
    const timeout = setTimeout(() => { try { child.kill("SIGTERM"); } catch(_) {} }, 600 * 1000);
    child.on("close", code => {
      clearTimeout(timeout);
      // Fallback to agent if router exited 3 (no configured provider) and AGENT_CMD set
      if (code === 3 && AGENT_CMD) {
        const parts = AGENT_CMD.split(/\s+/);
        const fb = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
        let fbOut = "", fbErr = "";
        fb.stdout.on("data", d => { fbOut += d; out.write(d); });
        fb.stderr.on("data", d => { fbErr += d; out.write(d); });
        fb.stdin.write(brief.content + "\n");
        fb.stdin.end();
        fb.on("close", c2 => { out.end(); resolve({ exit_code: c2, started_at: startedAt, finished_at: new Date().toISOString(), result_path: resultPath, stdout_tail: fbOut.slice(-2000), stderr_tail: fbErr.slice(-1000), mode: "agent-fallback" }); });
        fb.on("error", e => { out.end(); resolve({ exit_code: -1, started_at: startedAt, finished_at: new Date().toISOString(), result_path: resultPath, stdout_tail: "", stderr_tail: "fb-spawn-error: " + e.message, mode: "agent-fallback-error" }); });
        return;
      }
      out.end();
      resolve({ exit_code: code, started_at: startedAt, finished_at: new Date().toISOString(), result_path: resultPath, stdout_tail: outBuf.slice(-2000), stderr_tail: errBuf.slice(-1000), mode: "llm-router:" + target });
    });
    child.on("error", e => { clearTimeout(timeout); out.end(); resolve({ exit_code: -1, started_at: startedAt, finished_at: new Date().toISOString(), result_path: resultPath, stdout_tail: "", stderr_tail: "spawn-error: " + e.message, mode: "spawn-error" }); });
  });
}

async function processBrief(brief) {
  console.log("[" + AGENT + "] processing brief #" + brief.id + " from " + (brief.source_agent || "?") + " (" + brief.content.length + " B)");
  const result = await runHandler(brief);
  await ingest({
    kind: "agent_action",
    source: "agent_worker",
    source_ref: "brief-" + brief.id,
    occurred_at: result.finished_at,
    actor: AGENT,
    topic: "worker:" + AGENT,
    importance: 6,
    text: "[" + AGENT + "] handled brief #" + brief.id + " exit=" + result.exit_code + "\n\nBRIEF (head):\n" + brief.content.slice(0, 400) + "\n\nOUTPUT (tail):\n" + result.stdout_tail.slice(-1500) + (result.stderr_tail ? "\n\nERR:\n" + result.stderr_tail.slice(-500) : ""),
    meta_json: JSON.stringify({ brief_id: brief.id, exit_code: result.exit_code, started_at: result.started_at, finished_at: result.finished_at, result_path: result.result_path }),
  });
  try { await call("POST", "/tool/mem_brief_done", { brief_id: brief.id, outcome: result.exit_code === 0 ? "ok" : "failed:" + result.exit_code }); } catch(_) {}
  console.log("[" + AGENT + "] done brief #" + brief.id + " exit=" + result.exit_code + " log=" + result.result_path);
}

async function loop() {
  const briefs = await pullBriefs();
  for (const b of briefs) { await processBrief(b); }
}

console.log("[" + AGENT + "] worker started, runner=\"" + AGENT_CMD + "\" poll=" + POLL_SEC + "s");
heartbeat();
setInterval(heartbeat, HEARTBEAT_SEC * 1000);
loop();
setInterval(loop, POLL_SEC * 1000);

process.on("SIGTERM", () => { console.log("[" + AGENT + "] bye"); process.exit(0); });
process.on("SIGINT",  () => { console.log("[" + AGENT + "] bye"); process.exit(0); });

process.on("unhandledRejection", (reason) => {
  console.error("[" + AGENT + "] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[" + AGENT + "] uncaughtException:", err);
  process.exit(1);
});
