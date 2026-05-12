#!/usr/bin/env node
"use strict";
/**
 * approval_queue.js — pending-actions queue for skills that require_confirmation.
 *
 * Any agent that wants to run a skill marked requires_confirmation=true posts
 * a request here. The owner sees pending requests, approves or denies in bulk
 * or individually. On approve, the runner picks up + executes via skill_runner.
 *
 * Usage:
 *   node approval_queue.js request --skill <folder> [--input "<text>"] [--reason "<why>"] [--requester <agent>]
 *   node approval_queue.js list [--status pending|approved|denied|all]
 *   node approval_queue.js approve <id> [--note "..."]
 *   node approval_queue.js deny    <id> [--note "..."]
 *   node approval_queue.js drain                       # owner-side: run all approved-but-not-yet-executed
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");

const QFILE = process.env.MNEMO_APPROVAL_QUEUE || "/root/mnemo/.approval_queue.json";
const RUNNER = "/root/mnemo/packages/core/skills/skill_runner.js";
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");

function load() { try { return JSON.parse(fs.readFileSync(QFILE, "utf8")); } catch (_) { return { items: [] }; } }
function save(s) { fs.writeFileSync(QFILE, JSON.stringify(s, null, 2)); }
function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }

function ingest(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": "shared" },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 300 ? resolve() : reject(new Error(d))); });
    req.on("error", reject); req.write(buf); req.end();
  });
}

const action = process.argv[2];

async function request() {
  const skill = path.resolve(arg("skill", ""));
  if (!skill || !fs.existsSync(path.join(skill, "SKILL.md"))) { console.error("--skill <folder containing SKILL.md> required"); process.exit(2); }
  const id = crypto.randomBytes(4).toString("hex");
  const item = {
    id, skill_folder: skill,
    skill_name: path.basename(skill),
    input: arg("input", ""),
    reason: arg("reason", ""),
    requester: arg("requester", process.env.MNEMO_AGENT || "dieter"),
    status: "pending",
    created_at: new Date().toISOString(),
  };
  const s = load(); s.items.push(item); save(s);
  await ingest({
    kind: "approval_request", source: "approval_queue", source_ref: id,
    occurred_at: item.created_at, actor: item.requester, topic: "approvals",
    importance: 8,
    text: "Approval requested: " + item.skill_name + (item.reason ? "\nReason: " + item.reason : "") + (item.input ? "\nInput: " + item.input.slice(0, 200) : ""),
    meta_json: JSON.stringify(item),
  });
  console.log("queued", id, "—", item.skill_name);
}

function list() {
  const status = arg("status", "pending");
  const items = load().items.filter(i => status === "all" || i.status === status);
  if (!items.length) return console.log("(none)");
  for (const i of items) console.log(i.id, "|", i.status.padEnd(8), "|", i.skill_name.padEnd(20), "|", (i.requester || "?").padEnd(10), "|", (i.reason || "").slice(0, 60));
}

async function decide(id, decision) {
  const s = load();
  const it = s.items.find(x => x.id === id);
  if (!it) { console.error("not found:", id); process.exit(1); }
  if (it.status !== "pending") { console.error("already", it.status); process.exit(1); }
  it.status = decision;
  it.decision_note = arg("note", "");
  it.decided_at = new Date().toISOString();
  save(s);
  await ingest({
    kind: "approval_decision", source: "approval_queue", source_ref: id,
    occurred_at: it.decided_at, actor: "owner", topic: "approvals",
    importance: 8,
    text: "Approval " + decision + ": " + it.skill_name + (it.decision_note ? " — " + it.decision_note : ""),
    meta_json: JSON.stringify(it),
  });
  console.log(decision, id, "—", it.skill_name);
}

function runOne(it) {
  return new Promise(resolve => {
    const child = spawn("node", [RUNNER, it.skill_folder, "--allow-confirm", "--input", it.input || ""], { stdio: "inherit" });
    child.on("close", code => { it.status = code === 0 ? "executed" : "failed"; it.executed_at = new Date().toISOString(); it.exit_code = code; resolve(); });
    child.on("error", () => { it.status = "failed"; resolve(); });
  });
}

async function drain() {
  const s = load();
  const pending = s.items.filter(i => i.status === "approved");
  if (!pending.length) return console.log("nothing approved-and-pending.");
  for (const it of pending) {
    console.log("running", it.id, it.skill_name, "...");
    await runOne(it);
  }
  save(s);
  console.log("drain complete.");
}

if (action === "request") request();
else if (action === "list") list();
else if (action === "approve") decide(process.argv[3], "approved");
else if (action === "deny") decide(process.argv[3], "denied");
else if (action === "drain") drain();
else {
  console.log(`usage:
  approval_queue.js request --skill <folder> [--input "<text>"] [--reason "<why>"] [--requester <agent>]
  approval_queue.js list [--status pending|approved|denied|executed|failed|all]
  approval_queue.js approve <id> [--note "..."]
  approval_queue.js deny    <id> [--note "..."]
  approval_queue.js drain`);
}
