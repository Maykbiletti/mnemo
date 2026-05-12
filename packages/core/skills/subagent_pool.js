#!/usr/bin/env node
"use strict";
/**
 * subagent_pool.js — spawn isolated subagents for parallel workstreams.
 *
 * Each subagent runs as a child process (agent-exec by default, or any shell
 * command via --cmd), captures stdout+stderr, persists result in Mnemo as
 * kind="subagent_result", and never pollutes the parent's context.
 *
 * Usage:
 *   node subagent_pool.js spawn --task "Summarize today's escrow_event log" [--cmd "agent exec --pkg=mini -"]
 *   node subagent_pool.js list
 *   node subagent_pool.js drain [--max 4]            # foreground worker drains pending
 *   node subagent_pool.js show <id>
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");

const QUEUE_FILE = process.env.MNEMO_SUBAGENT_QUEUE || "/root/mnemo/.subagent_queue.json";
const RESULTS_DIR = process.env.MNEMO_SUBAGENT_RESULTS || "/root/mnemo/.subagent_results";
const MNEMO_URL = process.env.MNEMO_URL || "http://127.0.0.1:7117";
const TENANT = process.env.MNEMO_TENANT || "shared";
const DEFAULT_CMD = process.env.MNEMO_SUBAGENT_CMD || "agent exec --pkg=mini -";

try { fs.mkdirSync(RESULTS_DIR, { recursive: true }); } catch (_) {}

function loadQ() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch (_) { return { tasks: [] }; } }
function saveQ(q) { fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2)); }

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function ingestToMnemo(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": TENANT },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 300 ? resolve() : reject(new Error("HTTP " + res.statusCode + " " + d.slice(0, 200)))); });
    req.on("error", reject);
    req.write(buf); req.end();
  });
}

function spawnTask() {
  const task = arg("task");
  if (!task) { console.error("--task required"); process.exit(2); }
  const cmd = arg("cmd") || DEFAULT_CMD;
  const id = crypto.randomBytes(4).toString("hex");
  const q = loadQ();
  q.tasks.push({
    id, task, cmd, status: "pending", created_at: new Date().toISOString(),
    parent: process.env.SUBAGENT_PARENT || "dieter",
  });
  saveQ(q);
  console.log("queued", id, "—", task.slice(0, 80));
  console.log("cmd:", cmd);
}

function listTasks() {
  const q = loadQ();
  if (!q.tasks.length) return console.log("(empty)");
  for (const t of q.tasks) console.log(t.id, "|", (t.status || "?").padEnd(8), "|", (t.created_at || "").slice(11, 19), "|", t.task.slice(0, 90));
}

function showTask(id) {
  const q = loadQ();
  const t = q.tasks.find(x => x.id === id);
  if (!t) { console.error("not found"); process.exit(1); }
  console.log(JSON.stringify(t, null, 2));
  if (t.result_path && fs.existsSync(t.result_path)) {
    console.log("\n--- output ---");
    console.log(fs.readFileSync(t.result_path, "utf8").slice(0, 6000));
  }
}

function runOne(t) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const resultPath = path.join(RESULTS_DIR, t.id + ".log");
    const out = fs.createWriteStream(resultPath, { flags: "w" });
    out.write(`# subagent ${t.id}\n# task: ${t.task}\n# cmd: ${t.cmd}\n# started: ${startedAt}\n\n`);
    const parts = t.cmd.split(/\s+/);
    const child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", d => out.write(d));
    child.stderr.on("data", d => out.write(d));
    child.stdin.write(t.task + "\n");
    child.stdin.end();
    child.on("close", async (code) => {
      out.end();
      const finishedAt = new Date().toISOString();
      Object.assign(t, { status: code === 0 ? "done" : "failed", started_at: startedAt, finished_at: finishedAt, result_path: resultPath, exit_code: code });
      const q = loadQ();
      const i = q.tasks.findIndex(x => x.id === t.id);
      if (i >= 0) q.tasks[i] = t;
      saveQ(q);
      try {
        const tail = fs.readFileSync(resultPath, "utf8").slice(-4000);
        await ingestToMnemo({
          kind: "subagent_result", source: "subagent_pool", source_ref: t.id,
          occurred_at: finishedAt, actor: "subagent:" + t.id, topic: "delegation",
          importance: 6,
          text: "subagent " + t.id + " (" + t.status + " exit=" + code + ")\n\nTASK: " + t.task + "\n\nOUTPUT TAIL:\n" + tail,
          meta_json: JSON.stringify({ task: t.task, cmd: t.cmd, exit_code: code, started_at: startedAt, finished_at: finishedAt }),
        });
      } catch (e) { console.error("(mnemo ingest failed:", e.message + ")"); }
      console.log(t.id, t.status, "exit=" + code, "log=" + resultPath);
      resolve();
    });
    child.on("error", (e) => { out.end(); console.error(t.id, "spawn-error:", e.message); resolve(); });
  });
}

async function drain() {
  const max = parseInt(arg("max") || "4", 10);
  const q = loadQ();
  const pending = q.tasks.filter(t => t.status === "pending");
  if (!pending.length) return console.log("nothing to drain.");
  console.log("draining", pending.length, "task(s) up to", max, "in parallel...");
  const slots = Array.from({ length: max }, () => Promise.resolve());
  let idx = 0;
  for (const t of pending) {
    const slot = idx++ % max;
    slots[slot] = slots[slot].then(() => runOne(t));
  }
  await Promise.all(slots);
  console.log("drain complete.");
}

const cmd = process.argv[2];
if (cmd === "spawn") spawnTask();
else if (cmd === "list") listTasks();
else if (cmd === "show") showTask(process.argv[3]);
else if (cmd === "drain") drain();
else {
  console.log(`usage:
  subagent_pool.js spawn --task "<text>" [--cmd "<shell>"]
  subagent_pool.js list
  subagent_pool.js show <id>
  subagent_pool.js drain [--max 4]

Default cmd: ${DEFAULT_CMD}`);
}
