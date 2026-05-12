#!/usr/bin/env node
"use strict";
/**
 * mnemo_remote_mcp.js — expose Mnemo tools over HTTP/SSE so a remote agent
 * (Hermes / Cursor / external agent client / fast-agent / etc.) can use them without
 * stdio coupling.
 *
 * Reuses the existing /tool/<name> endpoints on the Mnemo daemon and adds a
 * minimal MCP-style protocol envelope:
 *
 *   GET  /mcp/list_tools                      — return [{name, description, schema}]
 *   POST /mcp/call_tool   { name, args }      — invoke + return
 *   GET  /mcp/sse                             — server-sent events of new memories (live tail)
 *   GET  /healthz                             — liveness
 *
 * Authentication: simple Bearer token via MNEMO_REMOTE_TOKEN env (no token = open).
 *
 * Default port: 7120
 */

const http = require("http");

const PORT = parseInt(process.env.MNEMO_REMOTE_MCP_PORT || "7120", 10);
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const TOKEN = process.env.MNEMO_REMOTE_TOKEN || "";
const { readBody } = require("./http_utils");

const TOOLS = [
  { name: "mem_recall", description: "Search Mnemo memory by text query.", schema: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer", default: 20 } }, required: ["q"] } },
  { name: "mem_ingest", description: "Insert a new memory entry.", schema: { type: "object", properties: { kind: { type: "string" }, source: { type: "string" }, actor: { type: "string" }, text: { type: "string" }, importance: { type: "integer" } }, required: ["kind", "source", "actor", "text"] } },
  { name: "mem_brief_post", description: "Post a brief into a Mnemo Connect channel.", schema: { type: "object", properties: { channel: { type: "string" }, agent_name: { type: "string" }, content: { type: "string" }, source_agent: { type: "string" } }, required: ["channel", "content"] } },
  { name: "mem_health", description: "Get Mnemo daemon health.", schema: { type: "object", properties: {} } },
];


function callMnemo(method, path, body, tenantHeader) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + path);
    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { "Content-Type": "application/json" };
    if (buf) headers["Content-Length"] = buf.length;
    if (tenantHeader) headers["X-Tenant-Id"] = tenantHeader;
    const req = http.request({
      method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers, timeout: 8000,
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (buf) req.write(buf);
    req.end();
  });
}

function authOk(req) {
  if (!TOKEN) return true;
  const h = req.headers["authorization"] || "";
  return h === "Bearer " + TOKEN;
}

function respond(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  if (parsed.pathname === "/healthz") return respond(res, 200, { ok: true, mcp_remote: true, port: PORT, tools: TOOLS.length, auth: TOKEN ? "bearer" : "open" });

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    return res.end();
  }
  if (!authOk(req)) return respond(res, 401, { error: "unauthorized" });

  if (parsed.pathname === "/mcp/list_tools") return respond(res, 200, { tools: TOOLS });

  if (parsed.pathname === "/mcp/call_tool" && req.method === "POST") {
    const raw = await readBody(req);
    let payload; try { payload = JSON.parse(raw); } catch (_) { return respond(res, 400, { error: "bad_json" }); }
    const name = payload && payload.name;
    const args = (payload && payload.args) || {};
    const tenant = payload && payload.tenant;
    if (!name) return respond(res, 400, { error: "name_required" });
    try {
      let r;
      if (name === "mem_recall") {
        const qs = "?q=" + encodeURIComponent(args.q || "") + "&limit=" + (args.limit || 20);
        r = await callMnemo("GET", "/recall" + qs, null, tenant);
      } else if (name === "mem_ingest") {
        r = await callMnemo("POST", "/ingest", Object.assign({ occurred_at: new Date().toISOString() }, args), tenant);
      } else if (name === "mem_brief_post") {
        r = await callMnemo("POST", "/tool/mem_connect_channel_post", args);
      } else if (name === "mem_health") {
        r = await callMnemo("GET", "/health", null);
      } else {
        return respond(res, 404, { error: "unknown_tool", name });
      }
      return respond(res, 200, { ok: true, name, result: r.body });
    } catch (e) {
      return respond(res, 500, { error: "tool_error", message: e.message });
    }
  }

  if (parsed.pathname === "/mcp/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Connection": "keep-alive", "Access-Control-Allow-Origin": "*",
    });
    let lastSeen = 0;
    const tick = setInterval(async () => {
      try {
        const r = await callMnemo("GET", "/recall?q=a&limit=10");
        const arr = Array.isArray(r.body) ? r.body : [];
        for (const m of arr.reverse()) {
          if (m.id <= lastSeen) continue;
          lastSeen = Math.max(lastSeen, m.id);
          res.write("event: memory\ndata: " + JSON.stringify(m) + "\n\n");
        }
      } catch (_) {}
    }, 3000);
    req.on("close", () => clearInterval(tick));
    return;
  }

  respond(res, 404, { error: "not_found" });
});

server.listen(PORT, () => console.log("[remote-mcp] listening on", PORT, "→", MNEMO_URL, TOKEN ? "(bearer required)" : "(open — set MNEMO_REMOTE_TOKEN)"));

function shutdown(signal) {
  console.log(`[remote-mcp] ${signal} received, closing server…`);
  server.close(() => {
    console.log("[remote-mcp] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.error("[remote-mcp] forced exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[remote-mcp] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[remote-mcp] uncaughtException:", err);
  shutdown("uncaughtException");
});
