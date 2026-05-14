#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { queueStats, flushQueue } = require("./hook_queue");

const ROOT = path.join(__dirname, "..");
const BASE_URL = String(process.env.MNEMO_HUB_URL || process.env.MNEMO_HOST || "http://127.0.0.1:7117").replace(/\/+$/, "");
const AGENT = process.env.MNEMO_AGENT || process.env.MNEMO_DEFAULT_AGENT || "unknown";
const PROJECT = process.env.MNEMO_PROJECT || process.env.MNEMO_DEFAULT_SCOPE || "unknown";
const args = new Set(process.argv.slice(2));

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function httpGet(pathname) {
  const res = await fetch(BASE_URL + pathname);
  const json = await readJson(res);
  return { ok: res.ok, status: res.status, json };
}

async function callTool(name, body) {
  const res = await fetch(`${BASE_URL}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const json = await readJson(res);
  return { ok: res.ok, status: res.status, json };
}

function nodeMajor() {
  const match = /^v?(\d+)/.exec(process.version);
  return match ? Number(match[1]) : 0;
}

async function main() {
  const hookPath = path.join(__dirname, "firm-runtime-hook.js");
  const out = {
    ok: true,
    status: "ok",
    base_url: BASE_URL,
    agent: AGENT,
    project: PROJECT,
    node: {
      version: process.version,
      ok: nodeMajor() >= 20
    },
    files: {
      hook: hookPath,
      hook_exists: fs.existsSync(hookPath),
      queue_module_exists: fs.existsSync(path.join(__dirname, "hook_queue.js"))
    },
    env: {
      MNEMO_HOOK_QUEUE_ON_FAILURE: process.env.MNEMO_HOOK_QUEUE_ON_FAILURE || "(default 1)",
      MNEMO_HOOK_FLUSH_ON_EVENT: process.env.MNEMO_HOOK_FLUSH_ON_EVENT || "(default 1)",
      MNEMO_REQUIRE_CHAT_CAPTURE: process.env.MNEMO_REQUIRE_CHAT_CAPTURE || "(default 1)",
      MNEMO_CAPTURE_TOOL_OBSERVATION: process.env.MNEMO_CAPTURE_TOOL_OBSERVATION || "(default 1)",
      MNEMO_CAPTURE_SESSION_SUMMARY: process.env.MNEMO_CAPTURE_SESSION_SUMMARY || "(default 1)"
    },
    queue: queueStats(),
    health: null,
    memory_health: null,
    flush: null,
    warnings: [],
    blockers: []
  };

  if (!out.node.ok) out.blockers.push("Node >=20 is required.");
  if (!out.files.hook_exists) out.blockers.push("firm-runtime-hook.js is missing.");
  if (!out.files.queue_module_exists) out.blockers.push("hook_queue.js is missing.");

  try {
    out.health = await httpGet("/health");
    if (!out.health.ok) out.warnings.push(`hub health returned ${out.health.status}`);
  } catch (e) {
    out.health = { ok: false, error: e.message };
    out.warnings.push("hub health unavailable: " + e.message);
  }

  try {
    out.memory_health = await callTool("mem_agent_memory_health", {
      agent_name: AGENT,
      project: PROJECT,
      include_queue: true
    });
    if (!out.memory_health.ok) out.warnings.push(`mem_agent_memory_health returned ${out.memory_health.status}`);
  } catch (e) {
    out.memory_health = { ok: false, error: e.message };
    out.warnings.push("mem_agent_memory_health unavailable: " + e.message);
  }

  if (args.has("--flush")) {
    try {
      out.flush = await flushQueue(BASE_URL, {});
      out.queue = queueStats();
      if (!out.flush.ok) out.warnings.push("queue flush had errors");
    } catch (e) {
      out.flush = { ok: false, error: e.message };
      out.warnings.push("queue flush failed: " + e.message);
    }
  }

  out.ok = out.blockers.length === 0;
  out.status = out.blockers.length ? "block" : (out.warnings.length ? "warn" : "ok");

  if (args.has("--json")) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    process.stdout.write([
      `Mnemo hook doctor: ${out.status}`,
      `hub: ${BASE_URL}`,
      `agent/project: ${AGENT} / ${PROJECT}`,
      `queue: ${out.queue.rows} row(s) in ${out.queue.queue_dir}`,
      out.flush ? `flush: attempted ${out.flush.attempted}, flushed ${out.flush.flushed}, remaining ${out.flush.remaining}` : null,
      out.blockers.length ? `blockers: ${out.blockers.join("; ")}` : null,
      out.warnings.length ? `warnings: ${out.warnings.join("; ")}` : null
    ].filter(Boolean).join("\n") + "\n");
  }

  process.exitCode = out.blockers.length ? 2 : 0;
}

main().catch((e) => {
  process.stderr.write("hook doctor failed: " + e.message + "\n");
  process.exitCode = 2;
});
