#!/usr/bin/env node
"use strict";
/**
 * multi_gateway.js — single HTTP gateway that receives messages from
 * Slack, Discord, WhatsApp (Meta or Twilio), and generic webhooks,
 * normalizes the payload, and ingests into Mnemo.
 *
 * Mounts on MNEMO_GATEWAY_PORT (default 7118).
 *
 * Endpoints:
 *   POST /slack/events       — Slack Events API (URL verification + message events)
 *   POST /discord/webhook    — Discord interactions / outgoing-webhook bridge
 *   POST /whatsapp/twilio    — Twilio WhatsApp Sandbox / Business POST
 *   POST /whatsapp/meta      — Meta WhatsApp Business webhook
 *   POST /generic            — any custom integration ({ source, actor, text, channel? })
 *   GET  /healthz            — liveness
 */

const http = require("http");

const PORT = parseInt(process.env.MNEMO_GATEWAY_PORT || "7118", 10);
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const SLACK_VERIFY_TOKEN = process.env.SLACK_VERIFY_TOKEN || "";
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "";
const { readBody } = require("../http_utils");

function ingestMnemo(tenant, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": tenant || "shared" },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => res.statusCode < 300 ? resolve(JSON.parse(d || "{}")) : reject(new Error("HTTP " + res.statusCode + ": " + d.slice(0, 200))));
    });
    req.on("error", reject);
    req.write(buf); req.end();
  });
}

function respond(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, headers || {}));
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handleSlack(req, res, raw) {
  let p; try { p = JSON.parse(raw); } catch (e) { return respond(res, 400, { error: "bad_json" }); }
  if (p.type === "url_verification") return respond(res, 200, { challenge: p.challenge });
  if (SLACK_VERIFY_TOKEN && p.token !== SLACK_VERIFY_TOKEN) return respond(res, 401, { error: "bad_token" });
  const ev = p.event;
  if (!ev || ev.type !== "message" || ev.subtype === "bot_message") return respond(res, 200, { ok: true, ignored: true });
  await ingestMnemo("shared", {
    kind: "message", source: "slack", source_ref: ev.ts,
    occurred_at: new Date(parseFloat(ev.ts) * 1000).toISOString(),
    actor: ev.user, actor_id: ev.user, importance: 5,
    text: ev.text || "", topic: "slack:" + (ev.channel || "unknown"),
    meta_json: JSON.stringify({ team: p.team_id, channel: ev.channel, thread_ts: ev.thread_ts }),
  });
  respond(res, 200, { ok: true });
}

async function handleDiscord(req, res, raw) {
  let p; try { p = JSON.parse(raw); } catch (e) { return respond(res, 400, { error: "bad_json" }); }
  // Discord PING (interaction type 1) — must respond with 1
  if (p.type === 1) return respond(res, 200, { type: 1 });
  const text = (p.content) || (p.data && p.data.options && p.data.options.map(o => o.value).join(" ")) || "";
  if (!text) return respond(res, 200, { ok: true, ignored: true });
  await ingestMnemo("shared", {
    kind: "message", source: "discord", source_ref: p.id || (p.token && p.token.slice(0, 16)),
    occurred_at: new Date().toISOString(),
    actor: (p.user && p.user.username) || (p.member && p.member.user && p.member.user.username) || "discord-user",
    actor_id: (p.user && p.user.id) || (p.member && p.member.user && p.member.user.id) || null,
    importance: 5, text,
    topic: "discord:" + (p.channel_id || p.guild_id || "dm"),
    meta_json: JSON.stringify({ guild_id: p.guild_id, channel_id: p.channel_id }),
  });
  respond(res, 200, { type: 5 });  // deferred response, lets bot reply later
}

async function handleWhatsAppTwilio(req, res, raw) {
  // Twilio sends application/x-www-form-urlencoded
  const params = new URLSearchParams(raw);
  const from = params.get("From") || "";
  const body = params.get("Body") || "";
  if (!body) return respond(res, 200, "<Response/>", { "Content-Type": "text/xml" });
  await ingestMnemo("shared", {
    kind: "message", source: "whatsapp", source_ref: params.get("MessageSid"),
    occurred_at: new Date().toISOString(),
    actor: from.replace(/^whatsapp:/, ""), actor_id: from,
    importance: 5, text: body, topic: "whatsapp:twilio",
    meta_json: JSON.stringify({ provider: "twilio", to: params.get("To"), profile_name: params.get("ProfileName") }),
  });
  respond(res, 200, "<Response/>", { "Content-Type": "text/xml" });
}

async function handleWhatsAppMeta(req, res, raw, parsedUrl) {
  // GET hub.challenge for verification
  if (req.method === "GET") {
    const q = parsedUrl.searchParams;
    if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === META_VERIFY_TOKEN) return respond(res, 200, q.get("hub.challenge"));
    return respond(res, 403, { error: "verify_failed" });
  }
  let p; try { p = JSON.parse(raw); } catch (e) { return respond(res, 400, { error: "bad_json" }); }
  for (const entry of (p.entry || [])) {
    for (const change of (entry.changes || [])) {
      const v = change.value || {};
      for (const m of (v.messages || [])) {
        const text = (m.text && m.text.body) || "";
        if (!text) continue;
        await ingestMnemo("shared", {
          kind: "message", source: "whatsapp", source_ref: m.id,
          occurred_at: new Date(parseInt(m.timestamp || "0", 10) * 1000).toISOString(),
          actor: m.from, actor_id: m.from, importance: 5, text,
          topic: "whatsapp:meta",
          meta_json: JSON.stringify({ provider: "meta", phone_number_id: v.metadata && v.metadata.phone_number_id }),
        });
      }
    }
  }
  respond(res, 200, { ok: true });
}

async function handleGeneric(req, res, raw) {
  let p; try { p = JSON.parse(raw); } catch (e) { return respond(res, 400, { error: "bad_json" }); }
  if (!p.text) return respond(res, 400, { error: "text_required" });
  await ingestMnemo(p.tenant || "shared", {
    kind: "message", source: p.source || "generic", source_ref: p.source_ref,
    occurred_at: p.occurred_at || new Date().toISOString(),
    actor: p.actor || "unknown", actor_id: p.actor_id || null,
    importance: p.importance || 5, text: p.text,
    topic: p.channel ? p.source + ":" + p.channel : (p.source || "generic"),
    meta_json: p.meta ? JSON.stringify(p.meta) : null,
  });
  respond(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  if (parsed.pathname === "/healthz") return respond(res, 200, { ok: true, gateway: "multi", port: PORT });
  let raw = "";
  if (req.method === "POST") raw = await readBody(req);
  try {
    if (parsed.pathname === "/slack/events") return await handleSlack(req, res, raw);
    if (parsed.pathname === "/discord/webhook") return await handleDiscord(req, res, raw);
    if (parsed.pathname === "/whatsapp/twilio") return await handleWhatsAppTwilio(req, res, raw);
    if (parsed.pathname === "/whatsapp/meta") return await handleWhatsAppMeta(req, res, raw, parsed);
    if (parsed.pathname === "/generic") return await handleGeneric(req, res, raw);
    respond(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("[gateway]", e && e.message);
    respond(res, 500, { error: "gateway_error", message: e && e.message });
  }
});
server.listen(PORT, () => console.log("[multi-gateway] listening on", PORT, "→", MNEMO_URL));

function shutdown(signal) {
  console.log(`[multi-gateway] ${signal} received, closing server…`);
  server.close(() => {
    console.log("[multi-gateway] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.error("[multi-gateway] forced exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[multi-gateway] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[multi-gateway] uncaughtException:", err);
  shutdown("uncaughtException");
});
