#!/usr/bin/env node
"use strict";
/**
 * context_files.js — auto-ingest project-specific context markdown files
 * (CONTEXT.md, PROJECT.md, AGENTS.md, README.md, RUNTIME.md, NOTES.md, SOUL.md)
 * from a project root into Mnemo, so any agent working in that project
 * sees the same baseline context.
 *
 * Idempotent: hash-skips files that haven't changed since last ingest.
 *
 * Usage:
 *   node context_files.js <project-root> [--tenant <name>] [--prefix <topic-prefix>]
 *   node context_files.js /root/listing-company --tenant shared --prefix listing
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const TARGETS = ["CONTEXT.md", "PROJECT.md", "AGENTS.md", "README.md", "RUNTIME.md", "NOTES.md", "SOUL.md", "ARCHITECTURE.md", "ROADMAP.md", "AGENTS.MD", "PROJECT.MD"];
const STATE = "/root/mnemo/.context_files_state.json";

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (_) { return {}; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

function ingest(tenant, body) {
  const url = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "") + "/ingest";
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": tenant },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 300 ? resolve() : reject(new Error(d))); });
    req.on("error", reject); req.write(buf); req.end();
  });
}

async function main() {
  const root = path.resolve(process.argv[2] || "");
  const tenant = arg("tenant", "shared");
  const prefix = arg("prefix", path.basename(root));
  if (!root || !fs.existsSync(root)) { console.error("usage: context_files.js <project-root> [--tenant <name>] [--prefix <topic-prefix>]"); process.exit(2); }

  const state = loadState();
  let processed = 0, skipped = 0;
  for (const fname of TARGETS) {
    const file = path.join(root, fname);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const key = file;
    if (state[key] === hash) { skipped++; continue; }
    await ingest(tenant, {
      kind: "context_file",
      source: "context_files",
      source_ref: file,
      occurred_at: new Date().toISOString(),
      actor: "system",
      topic: prefix + ":context:" + fname.toLowerCase().replace(/\.md$/i, ""),
      importance: 9,
      text: "[" + prefix + "/" + fname + "]\n\n" + text,
      meta_json: JSON.stringify({ project: prefix, file, hash, bytes: text.length }),
    });
    state[key] = hash;
    processed++;
    console.log("ingested", fname, "(" + text.length + " bytes)");
  }
  saveState(state);
  console.log("\nDONE  ingested=" + processed + "  skipped(unchanged)=" + skipped + "  tenant=" + tenant);
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
