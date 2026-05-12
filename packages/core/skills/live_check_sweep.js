#!/usr/bin/env node
"use strict";
/**
 * live_check_sweep.js — Daily sweep of mem_project_live_check for all
 * registered projects. Briefs results to strategy-review.
 *
 * Usage: node live_check_sweep.js
 */

const http = require("http");
const MNEMO_URL = process.env.MNEMO_URL || "http://127.0.0.1:7117";

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args);
    const url = new URL(MNEMO_URL + "/tool/" + name);
    const opts = { method: "POST", hostname: url.hostname, port: url.port, path: url.pathname, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const list = await callTool("mem_project_registry_list", { limit: 50 });
  const projects = (list.projects || []).map((p) => p.name).filter(Boolean);
  if (!projects.length) { console.log("[live-check-sweep] no projects in registry"); return; }

  const results = [];
  for (const name of projects) {
    const check = await callTool("mem_project_live_check", { name, agent_name: "live-check-sweep" });
    results.push({ project: name, status: check.status, passed: check.passed || [], blocked: check.blocked || [], unknown: check.unknown || [] });
  }

  const lines = ["## Daily Live-Check Sweep — " + new Date().toISOString().slice(0, 10), ""];
  let anyBlock = false;
  for (const r of results) {
    const icon = r.status === "pass" ? "PASS" : "BLOCK";
    if (r.status !== "pass") anyBlock = true;
    lines.push(`**${r.project}**: ${icon} — ${r.passed.length} pass, ${r.blocked.length} block, ${r.unknown.length} unknown`);
    if (r.blocked.length) lines.push(`  Blocked: ${r.blocked.join(", ")}`);
    if (r.unknown.length) lines.push(`  Unknown: ${r.unknown.join(", ")}`);
  }

  const content = lines.join("\n");
  console.log(content);

  // Brief to strategy-review (dieter)
  await callTool("mem_agent_brief", {
    agent_name: "dieter",
    source_agent: "live-check-sweep",
    content,
    meta: { sweep: true, projects: projects.length, any_block: anyBlock },
  });
  console.log("[live-check-sweep] briefed dieter with results for", projects.length, "projects");
}

main().catch((e) => { console.error("[live-check-sweep] error:", e.message); process.exit(1); });
