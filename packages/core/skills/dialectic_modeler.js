#!/usr/bin/env node
"use strict";
/**
 * dialectic_modeler.js — periodic refinement of the user-model based on recent
 * conversation. Inspired by Honcho's "dialectic" approach.
 *
 * Reads the last N memory entries for a tenant + actor pair, asks the LLM
 * router to summarize 3 things:
 *   1. New behavioral pattern observed
 *   2. Suggested trait adjustment (delta on dimension X)
 *   3. Open contradictions vs existing core_value entries
 * Writes the result back into Mnemo as kind="user_model_update" importance 8.
 *
 * Usage:
 *   node dialectic_modeler.js --tenant dieter --actor mayk --window 100
 *   node dialectic_modeler.js --tenant dieter --actor mayk --dry-run
 *
 * Cron-friendly:
 *   nl_cron.js "daily 3am: node /root/mnemo/packages/core/skills/dialectic_modeler.js --tenant dieter --actor mayk --window 200"
 */

const http = require("http");
const { spawn } = require("child_process");

const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const ROUTER = "/root/mnemo/packages/core/skills/llm_router.js";

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
function flag(name) { return process.argv.includes("--" + name); }

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: "GET", hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: headers || {}, timeout: 6000 }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { resolve([]); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}

function ingest(tenant, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": tenant },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 300 ? resolve() : reject(new Error(d))); });
    req.on("error", reject); req.write(buf); req.end();
  });
}

function callRouter(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [ROUTER, "--task", "summarize", "--target", "fast"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.stdin.write(prompt); child.stdin.end();
    child.on("close", code => code === 0 ? resolve(out.trim()) : resolve("ROUTER_UNAVAILABLE: " + err.split("\n").slice(-3).join(" ")));
    child.on("error", e => resolve("ROUTER_ERR: " + e.message));
  });
}

async function main() {
  const tenant = arg("tenant", "shared");
  const actor = arg("actor", null);
  const window = parseInt(arg("window", "100"), 10);

  // Pull recent memories filtered by actor — recall doesn't filter by actor server-side, so use common term + JS filter
  const items = await fetchJson(MNEMO_URL + "/recall?q=a&limit=" + Math.min(500, window * 5), { "X-Tenant-Id": tenant });
  const list = (Array.isArray(items) ? items : []).filter(m => !actor || m.actor === actor).slice(0, window);
  if (!list.length) { console.error("no recent memories matching tenant=" + tenant + " actor=" + (actor || "*")); process.exit(1); }

  const corpus = list.map(m => "- " + (m.occurred_at || "").slice(0, 16) + " [" + m.actor + "/" + m.kind + "] " + (m.preview || m.text || "").slice(0, 200)).join("\n");
  const prompt = `You are the dialectic-modeler for the autonomous-agent platform Mnemo.
Based on the following ${list.length} recent memory entries from tenant=${tenant}${actor ? " concerning actor=" + actor : ""}, output STRICT JSON with three fields:

{
  "new_pattern": "one-sentence behavioral pattern you newly observed (or null)",
  "trait_adjustment": { "dimension": "communication|execution|memory|judgment|social", "trait_name": "<short_snake_case>", "delta": -0.15 to +0.15, "justification": "..." } or null,
  "contradiction": "any open contradiction vs known principles" or null
}

ENTRIES:
${corpus}

JSON:`;

  if (flag("dry-run")) { console.log(prompt.slice(0, 1500), "\n... [", list.length, "entries ]"); return; }

  const reply = await callRouter(prompt);
  console.log("--- model reply ---\n" + reply.slice(0, 2000) + "\n---");

  await ingest(tenant, {
    kind: "user_model_update",
    source: "dialectic_modeler",
    source_ref: "window=" + window + ":actor=" + (actor || "*") + ":at=" + new Date().toISOString(),
    occurred_at: new Date().toISOString(),
    actor: "system",
    topic: "user_model:" + (actor || "all"),
    importance: 8,
    text: "Dialectic update for tenant=" + tenant + " actor=" + (actor || "*") + " window=" + window + ":\n\n" + reply.slice(0, 4000),
    meta_json: JSON.stringify({ tenant, actor, window, entries_seen: list.length }),
  });
  console.log("ingested user_model_update.");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
