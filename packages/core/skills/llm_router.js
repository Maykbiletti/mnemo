#!/usr/bin/env node
"use strict";
/**
 * llm_router.js — pick the right model for a request, no code change per provider.
 *
 * Targets:
 *   --target cheap   → smallest/cheapest model that fits
 *   --target fast    → lowest-latency model for the task class
 *   --target quality → frontier model for the task class
 *
 * Task classes: chat, code, summarize, classify, vision, embed
 *
 * Usage:
 *   node llm_router.js --task chat --target fast --input "hello"
 *   echo "..." | node llm_router.js --task summarize --target cheap
 *   node llm_router.js --providers     # list configured providers
 */

const http = require("http");
const https = require("https");

const ENV = process.env;

// Catalog of providers + their models per task-class. Add by adding here.
const CATALOG = [
  // Preferred internal providers when configured.
  { provider: "internal-quality", model: "internal-quality", classes: ["chat","code","summarize","classify"], target: "quality", base: ENV.INTERNAL_QUALITY_API_BASE, keyEnv: "INTERNAL_QUALITY_API_KEY", cost_per_mtok: 10, latency_ms: 900 },
  { provider: "internal-fast",    model: "internal-fast",    classes: ["chat","summarize","classify"],         target: "fast",    base: ENV.INTERNAL_FAST_API_BASE,    keyEnv: "INTERNAL_FAST_API_KEY",    cost_per_mtok: 3,  latency_ms: 220 },
  { provider: "internal-vision",  model: "internal-vision",  classes: ["vision","classify"],                   target: "quality", base: ENV.INTERNAL_VISION_API_BASE,  keyEnv: "INTERNAL_VISION_API_KEY",  cost_per_mtok: 8,  latency_ms: 700 },

  // External fallbacks (only used when internal providers are not configured)
  { provider: "openai",     model: "gpt-5",        classes: ["chat","code","summarize","classify","vision"], target: "quality", base: "https://api.openai.com/v1",     keyEnv: "OPENAI_API_KEY",     cost_per_mtok: 30, latency_ms: 1100 },
  { provider: "openai",     model: "gpt-5-mini",   classes: ["chat","summarize","classify"],                  target: "fast",    base: "https://api.openai.com/v1",     keyEnv: "OPENAI_API_KEY",     cost_per_mtok: 6,  latency_ms: 280 },
  { provider: "openai",     model: "gpt-4o-mini",  classes: ["chat","summarize","classify"],                  target: "cheap",   base: "https://api.openai.com/v1",     keyEnv: "OPENAI_API_KEY",     cost_per_mtok: 1.5,latency_ms: 350 },
  { provider: "external-llm",  model: "external-agent-opus-4-7",   classes: ["chat","code","summarize","classify","vision"], target: "quality", base: "https://api.external-llm.com/v1", keyEnv: "EXTERNAL_LLM_API_KEY",  cost_per_mtok: 45, latency_ms: 1400 },
  { provider: "external-llm",  model: "external-agent-haiku-4-5", classes: ["chat","summarize","classify"],                  target: "fast",    base: "https://api.external-llm.com/v1", keyEnv: "EXTERNAL_LLM_API_KEY",  cost_per_mtok: 3,  latency_ms: 250 },
  { provider: "openrouter", model: "openrouter/auto",  classes: ["chat","code","summarize","classify","vision"], target: "cheap",   base: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", cost_per_mtok: 4,  latency_ms: 600 },
  { provider: "nous",       model: "nous-portal-default", classes: ["chat","code","summarize"],                target: "fast",    base: "https://api.nousresearch.com/v1", keyEnv: "NOUS_API_KEY",   cost_per_mtok: 5,  latency_ms: 500 },
];

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function isConfigured(entry) {
  if (!entry.keyEnv) return false;
  const key = ENV[entry.keyEnv];
  if (!key) return false;
  if (entry.base && entry.base.startsWith("undefined")) return false;
  if (!entry.base) return false;
  return true;
}

function pick(taskClass, target) {
  const hits = CATALOG.filter(c => c.classes.includes(taskClass) && c.target === target);
  for (const h of hits) {
    if (h.provider === "internal-quality" || h.provider === "internal-fast" || h.provider === "internal-vision") {
      if (isConfigured(h)) return h;
    }
  }
  for (const h of hits) if (isConfigured(h)) return h;
  return null;
}

function callOpenAICompatible(entry, prompt) {
  return new Promise((resolve, reject) => {
    const u = new URL(entry.base.replace(/\/$/, "") + "/chat/completions");
    const body = Buffer.from(JSON.stringify({
      model: entry.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    }));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "POST", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Authorization": "Bearer " + (ENV[entry.keyEnv] || ""),
      },
      timeout: 30000,
    }, res => {
      let chunks = ""; res.on("data", c => chunks += c);
      res.on("end", () => res.statusCode < 300 ? resolve(JSON.parse(chunks)) : reject(new Error("HTTP " + res.statusCode + ": " + chunks.slice(0, 300))));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body); req.end();
  });
}

function listProviders() {
  console.log("provider          | model                  | classes                                      | target  | configured");
  console.log("------------------|------------------------|----------------------------------------------|---------|-----------");
  for (const c of CATALOG) {
    console.log(
      c.provider.padEnd(17), "|",
      c.model.padEnd(22), "|",
      c.classes.join(",").padEnd(44), "|",
      c.target.padEnd(7), "|",
      isConfigured(c) ? "yes" : "no"
    );
  }
}

async function main() {
  if (process.argv.includes("--providers")) return listProviders();

  const taskClass = arg("task", "chat");
  const target = arg("target", "fast");
  let prompt = arg("input", null);
  if (!prompt && !process.stdin.isTTY) {
    prompt = await new Promise(resolve => {
      let s = ""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => resolve(s));
    });
  }
  if (!prompt) { console.error("usage: --task <chat|code|summarize|classify|vision|embed> --target <cheap|fast|quality> --input '...' (or stdin)"); process.exit(2); }

  const choice = pick(taskClass, target);
  if (!choice) {
    console.error("no configured provider for task=" + taskClass + " target=" + target + ". Run --providers to see status.");
    process.exit(3);
  }

  console.error("[router] picked", choice.provider + ":" + choice.model, "(target=" + target + ", task=" + taskClass + ")");
  if (process.argv.includes("--dry-run")) { console.log(JSON.stringify({ chose: choice.provider + ":" + choice.model, target, task_class: taskClass })); return; }

  const t0 = Date.now();
  const r = await callOpenAICompatible(choice, prompt);
  const dt = Date.now() - t0;
  const text = (r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || JSON.stringify(r);
  console.error("[router] " + choice.provider + ":" + choice.model + " latency=" + dt + "ms");
  console.log(text);
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
