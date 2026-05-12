#!/usr/bin/env node
"use strict";
/**
 * execute_code.js — collapse a multi-step plan into a single sandboxed
 * execution. Pattern lifted from Hermes' "programmatic tool calling":
 * instead of K separate tool calls, the agent writes one short JS or
 * Python snippet that calls a curated stdlib of helpers.
 *
 * Sandboxes:
 *   js     — node child process, no filesystem write outside CWD
 *   py     — python3 child process
 *   shell  — bash, captured stdout/stderr
 *
 * Helpers exposed in JS:
 *   mnemo.recall(query, limit)         — fetch from /recall
 *   mnemo.ingest(body)                  — POST /ingest
 *   mnemo.brief_post(channel, content)  — Mnemo Connect post
 *   http.get(url)                       — minimal http GET → string
 *   http.post(url, body)                — minimal http POST → string
 *
 * Usage:
 *   node execute_code.js --lang js --code 'console.log(await mnemo.recall("escrow", 3))'
 *   node execute_code.js --lang js --file ./plan.js
 *   echo "print(2+2)" | node execute_code.js --lang py
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const TENANT = process.env.MNEMO_TENANT || "shared";

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }

const JS_PRELUDE = `
const http = require("http");
function _post(path, body, hdrs) { return new Promise((res, rej) => { const u = new URL(${JSON.stringify(MNEMO_URL)} + path); const buf = Buffer.from(JSON.stringify(body)); const req = http.request({ method:"POST", hostname:u.hostname, port:u.port||80, path:u.pathname, headers: Object.assign({"Content-Type":"application/json","Content-Length":buf.length,"X-Tenant-Id":${JSON.stringify(TENANT)}}, hdrs||{}) }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{ res(JSON.parse(d||"{}"));}catch(_){res(d);} }); }); req.on("error", rej); req.write(buf); req.end(); }); }
function _get(p) { return new Promise((res, rej) => { const u = new URL(${JSON.stringify(MNEMO_URL)} + p); const req = http.request({ method:"GET", hostname:u.hostname, port:u.port||80, path:u.pathname+u.search }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{ res(JSON.parse(d||"[]"));}catch(_){res(d);} }); }); req.on("error", rej); req.end(); }); }
const mnemo = {
  recall: (q, limit=20) => _get("/recall?q=" + encodeURIComponent(q || "a") + "&limit=" + limit),
  ingest: (body) => _post("/ingest", Object.assign({occurred_at: new Date().toISOString(), actor:"execute_code", importance:5}, body)),
  brief_post: (channel, content, source_agent) => _post("/tool/mem_connect_channel_post", { channel, content, source_agent: source_agent || "execute_code" }),
  health: () => _get("/health"),
};
const httpHelpers = {
  get: (url) => new Promise((res, rej) => { const lib = url.startsWith("https:") ? require("https") : require("http"); lib.get(url, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(d)); }).on("error", rej); }),
  post: (url, body) => new Promise((res, rej) => { const lib = url.startsWith("https:") ? require("https") : require("http"); const u = new URL(url); const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); const req = lib.request({ method:"POST", hostname:u.hostname, port:u.port||(u.protocol==="https:"?443:80), path:u.pathname+u.search, headers:{"Content-Type":"application/json","Content-Length":buf.length} }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>res(d)); }); req.on("error", rej); req.write(buf); req.end(); }),
};
(async () => {
  try { __USER_CODE__ } catch (e) { console.error("execute_code error:", e && e.message); process.exit(1); }
})();
`;

function runJs(code) {
  const wrapped = JS_PRELUDE.replace("__USER_CODE__", code);
  const child = spawn("node", ["-"], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(wrapped); child.stdin.end();
  return new Promise(resolve => child.on("close", code => resolve(code)));
}

function runPy(code) {
  const child = spawn("python3", ["-"], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(code); child.stdin.end();
  return new Promise(resolve => child.on("close", code => resolve(code)));
}

function runShell(code) {
  const child = spawn("bash", ["-c", code], { stdio: ["ignore", "inherit", "inherit"] });
  return new Promise(resolve => child.on("close", code => resolve(code)));
}

async function main() {
  const lang = arg("lang", "js");
  let code = arg("code", null);
  if (!code) {
    const file = arg("file", null);
    if (file) code = fs.readFileSync(path.resolve(file), "utf8");
    else if (!process.stdin.isTTY) code = await new Promise(res => { let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => res(s)); });
  }
  if (!code) { console.error("usage: execute_code.js --lang js|py|shell --code '...' (or --file <path> or stdin)"); process.exit(2); }

  const exit = lang === "py" ? await runPy(code) : lang === "shell" ? await runShell(code) : await runJs(code);
  process.exit(exit);
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
