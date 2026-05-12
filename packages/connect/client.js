#!/usr/bin/env node
/**
 * Mnemo Connect — Node client (stdin-pipe transport).
 *
 * Registers a local agent with the Mnemo hub, sends heartbeats, subscribes
 * to channels, and writes pulled briefs to a named pipe / FIFO that the
 * agent process reads from.
 *
 * Usage:
 *   MNEMO_URL=http://127.0.0.1:7117 node packages/connect/client.js \
 *     --agent agent-a \
 *     --display "Agent A" \
 *     --skills scraper,postal,deploy \
 *     --channels listings,deploy \
 *     --pipe /tmp/agent-a.in
 *
 * The hub-side MCP tools wired here:
 *   mem_connect_register, mem_connect_heartbeat,
 *   mem_connect_channel_subscribe, mem_brief_pull
 */
"use strict";
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const AGENT = arg("agent");
const DISPLAY = arg("display") || AGENT;
const SKILLS = (arg("skills") || "").split(",").map(s => s.trim()).filter(Boolean);
const CHANNELS = (arg("channels") || "").split(",").map(s => s.trim()).filter(Boolean);
const PIPE = arg("pipe");
const HEARTBEAT_S = parseInt(arg("heartbeat", "30"), 10);
const PULL_S = parseInt(arg("pull", "5"), 10);

if (!AGENT || !PIPE) {
  console.error("usage: client.js --agent <name> --pipe <path> [--display <s>] [--skills a,b] [--channels a,b]");
  process.exit(2);
}

function call(tool, args) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/tool/" + tool);
    const lib = u.protocol === "https:" ? https : http;
    const body = JSON.stringify(args || {});
    const req = lib.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, res => {
      let buf = ""; res.on("data", c => buf += c);
      res.on("end", () => {
        try { resolve(JSON.parse(buf || "{}")); }
        catch (e) { reject(new Error("bad JSON: " + buf.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function register() {
  await call("mem_connect_register", {
    agent_name: AGENT, display_name: DISPLAY, host: os.hostname(),
    pid: process.pid, skills: SKILLS,
    meta: { transport: "stdin-pipe", pipe: PIPE, started_at: new Date().toISOString() },
  });
  for (const ch of CHANNELS) {
    await call("mem_connect_channel_upsert", { name: ch }).catch(() => {});
    await call("mem_connect_channel_subscribe", { channel: ch, agent_name: AGENT });
  }
  console.log(`[${new Date().toISOString()}] registered ${AGENT} on ${MNEMO_URL} channels=${CHANNELS.join(",") || "(none)"} skills=${SKILLS.join(",") || "(none)"}`);
}

async function heartbeat() {
  try { await call("mem_connect_heartbeat", { agent_name: AGENT, status: "online" }); }
  catch (e) { console.error("heartbeat:", e.message); }
}

async function pullAndDispatch() {
  try {
    const r = await call("mem_brief_pull", { agent_name: AGENT, limit: 5 });
    const briefs = (r.result?.briefs) || r.briefs || [];
    if (!briefs.length) return;
    for (const b of briefs) {
      const block = `\n--- BRIEF id=${b.id} from=${b.source_agent || "?"} ch=${b.channel || ""} at=${b.created_at} ---\n${b.content}\n--- BRIEF END ---\n`;
      fs.appendFileSync(PIPE, block);
      console.log(`[${new Date().toISOString()}] dispatched id=${b.id} (${b.content.length}B) to ${PIPE}`);
    }
  } catch (e) { console.error("pull:", e.message); }
}

(async () => {
  try { await register(); }
  catch (e) { console.error("registration failed:", e.message); process.exit(3); }
  setInterval(heartbeat, HEARTBEAT_S * 1000);
  setInterval(pullAndDispatch, PULL_S * 1000);
  pullAndDispatch();
})();
