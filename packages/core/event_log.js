"use strict";

const http = require("http");
const readline = require("readline");
const { spawn } = require("child_process");

const DEFAULT_HUB = process.env.MNEMO_HUB_URL || "http://127.0.0.1:7117";

function postTool(hubUrl, name, payload) {
  const url = new URL(`/tool/${name}`, hubUrl || DEFAULT_HUB);
  const body = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data || "{}")); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function captureLine(sourceName, line, opts = {}) {
  if (!line && opts.keep_empty !== true) return Promise.resolve({ skipped: true });
  return postTool(opts.hubUrl, "mem_event_log", {
    source: `process:${sourceName}`,
    channel: opts.channel || null,
    direction: opts.direction || "internal",
    actor: opts.actor || sourceName,
    event_kind: opts.event_kind || "process_stdout",
    ref_kind: opts.ref_kind || "process",
    ref_id: opts.ref_id || sourceName,
    thread_id: opts.thread_id || opts.session_id || null,
    status: opts.status || "line",
    content: String(line || ""),
    meta: Object.assign({
      process_name: sourceName,
      stream: opts.stream || "stdout",
    }, opts.meta || {}),
  });
}

function attachStreamCapture(stream, sourceName, opts = {}) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("line", (line) => {
    captureLine(sourceName, line, opts).catch(() => {});
  });
  return rl;
}

function spawnCaptured(sourceName, command, args = [], opts = {}) {
  const child = spawn(command, args, opts.spawn || {});
  if (child.stdout) attachStreamCapture(child.stdout, sourceName, Object.assign({}, opts, { stream: "stdout" }));
  if (child.stderr && opts.captureStderr !== false) {
    attachStreamCapture(child.stderr, sourceName, Object.assign({}, opts, {
      stream: "stderr",
      event_kind: opts.stderr_event_kind || "process_stderr",
      status: opts.stderr_status || "line",
    }));
  }
  return child;
}

module.exports = {
  attachStreamCapture,
  captureLine,
  spawnCaptured,
};
