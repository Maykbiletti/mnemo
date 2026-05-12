#!/usr/bin/env node
"use strict";
/**
 * email_gateway.js — IMAP poller + SMTP outbound for Mnemo.
 *
 * Inbound: poll an IMAP mailbox every 60s, ingest each new email as
 *          kind="message" source="email" with metadata (from, subject, message-id).
 * Outbound: tiny REST endpoint POST /email/send for any agent to dispatch mail.
 *
 * Auth: IMAP_HOST / IMAP_USER / IMAP_PASS / IMAP_PORT (default 993, TLS) and
 *       SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_PORT (default 465, TLS).
 *
 * No external deps when running in send-only mode. For IMAP requires
 *   npm install imapflow mailparser
 *
 * Default REST port: 7121
 */

const http = require("http");
const net = require("net");
const { collectBody } = require("../http_utils");
const tls = require("tls");

const PORT = parseInt(process.env.MNEMO_EMAIL_PORT || "7121", 10);
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const POLL_MS = parseInt(process.env.IMAP_POLL_MS || "60000", 10);

let imapflow = null, mailparser = null;
try { imapflow = require("imapflow"); mailparser = require("mailparser"); } catch (_) {}

function ingest(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": process.env.MNEMO_EMAIL_TENANT || "shared" },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 300 ? resolve() : reject(new Error(d))); });
    req.on("error", reject); req.write(buf); req.end();
  });
}

async function pollImap() {
  if (!imapflow) { console.log("[email] imapflow not installed — IMAP polling disabled"); return; }
  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASS) { console.log("[email] IMAP env not set, polling disabled"); return; }
  const client = new imapflow.ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000);
    for await (const msg of client.fetch({ since }, { source: true, envelope: true, uid: true })) {
      if (!msg.source) continue;
      const parsed = await mailparser.simpleParser(msg.source);
      const from = (parsed.from && parsed.from.text) || "";
      const subject = parsed.subject || "(no subject)";
      const text = parsed.text || parsed.html || "";
      const messageId = parsed.messageId || ("uid-" + msg.uid);
      try {
        await ingest({
          kind: "message", source: "email", source_ref: messageId,
          occurred_at: (parsed.date || new Date()).toISOString(),
          actor: from, importance: 5, text: subject + "\n\n" + text.slice(0, 4000),
          topic: "email:inbound",
          meta_json: JSON.stringify({ from, subject, to: parsed.to && parsed.to.text, message_id: messageId, uid: msg.uid }),
        });
      } catch (e) { console.error("[email-ingest]", e.message); }
    }
  } finally {
    lock.release();
    await client.logout();
  }
}

function smtpSend(opts) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || "465", 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) return reject(new Error("SMTP env not configured"));
    const sock = (port === 465 ? tls : net).connect(port, host);
    let buf = "", state = 0;
    function send(line) { sock.write(line + "\r\n"); }
    function expect(code) { return buf.split(/\r?\n/).slice(-2,-1)[0]?.startsWith(code); }
    sock.setEncoding("utf8");
    sock.on("data", chunk => {
      buf += chunk;
      // very minimal SMTP exchange — for production swap to nodemailer
      if (state === 0 && expect("220")) { send("EHLO mnemo"); state = 1; }
      else if (state === 1 && expect("250")) { send("AUTH LOGIN"); state = 2; }
      else if (state === 2 && expect("334")) { send(Buffer.from(user).toString("base64")); state = 3; }
      else if (state === 3 && expect("334")) { send(Buffer.from(pass).toString("base64")); state = 4; }
      else if (state === 4 && expect("235")) { send("MAIL FROM:<" + (opts.from || user) + ">"); state = 5; }
      else if (state === 5 && expect("250")) { send("RCPT TO:<" + opts.to + ">"); state = 6; }
      else if (state === 6 && expect("250")) { send("DATA"); state = 7; }
      else if (state === 7 && expect("354")) {
        const headers = "From: " + (opts.from || user) + "\r\nTo: " + opts.to + "\r\nSubject: " + (opts.subject || "(no subject)") + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n";
        send(headers + (opts.text || "") + "\r\n.");
        state = 8;
      }
      else if (state === 8 && expect("250")) { send("QUIT"); state = 9; sock.end(); resolve({ ok: true }); }
      else if (buf.match(/\b(5\d\d|4\d\d)\b/)) { sock.end(); reject(new Error("SMTP response: " + buf.slice(-200))); }
    });
    sock.on("error", reject);
    setTimeout(() => { try { sock.end(); } catch(_) {} reject(new Error("smtp timeout state=" + state)); }, 15000);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  if (parsed.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, email: true, port: PORT, imap: !!imapflow, smtp: !!process.env.SMTP_HOST })); }
  if (parsed.pathname === "/email/send" && req.method === "POST") {
    collectBody(req, res, async (body) => {
      let p; try { p = JSON.parse(body); } catch(_) { res.writeHead(400); return res.end('{"error":"bad_json"}'); }
      if (!p.to || !p.subject) { res.writeHead(400); return res.end('{"error":"to+subject required"}'); }
      try {
        const r = await smtpSend(p);
        try { await ingest({ kind: "message", source: "email", source_ref: "outbound:" + Date.now(), occurred_at: new Date().toISOString(), actor: p.from || process.env.SMTP_USER || "system", importance: 5, text: "(sent) " + p.subject + "\n\n" + (p.text || ""), topic: "email:outbound", meta_json: JSON.stringify({ to: p.to, subject: p.subject }) }); } catch(_){}
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  res.writeHead(404); res.end('{"error":"not_found"}');
});
server.listen(PORT, () => console.log("[email-gateway]", PORT, "imap=" + (imapflow && process.env.IMAP_HOST ? "on" : "off"), "smtp=" + (process.env.SMTP_HOST ? "on" : "off")));

if (imapflow && process.env.IMAP_HOST) setInterval(() => pollImap().catch(e => console.error("[imap-poll]", e.message)), POLL_MS);

function shutdown(signal) {
  console.log(`[email-gateway] ${signal} received, closing server…`);
  server.close(() => {
    console.log("[email-gateway] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.error("[email-gateway] forced exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[email-gateway] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[email-gateway] uncaughtException:", err);
  shutdown("uncaughtException");
});
