#!/usr/bin/env node
"use strict";
/**
 * email_gateway.js - IMAP poller + SMTP outbound for Mnemo.
 *
 * Preferred mode:
 *   Reads fixed BLUN agent mail accounts from agent_mail_account, polls each
 *   enabled Inbox, records inbound messages into agent_mail_message, and turns
 *   them into agent_briefs. Outbound mail is sent only from the tracked Outbox.
 *
 * Compatibility mode:
 *   If no agent mail accounts exist, falls back to IMAP_HOST/IMAP_USER/IMAP_PASS
 *   and the legacy /email/send endpoint.
 *
 * Secrets:
 *   Account rows store env:/file: references, not raw passwords.
 */

const http = require("http");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { collectBody } = require("../http_utils");
const {
  ensureAgentMailTables,
  listAgentMailAccounts,
  recordInboundMail,
  dispatchInboundBriefs,
  pendingOutboundMessages,
  markMailMessage,
  updateAccountFetchStatus,
  updateAccountSendStatus
} = require("../agent_mail");

const PORT = parseInt(process.env.MNEMO_EMAIL_PORT || "7121", 10);
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const POLL_MS = parseInt(process.env.IMAP_POLL_MS || "60000", 10);
const OUTBOX_MS = parseInt(process.env.MNEMO_EMAIL_OUTBOX_MS || "60000", 10);
const FIRST_FETCH_MINUTES = parseInt(process.env.MNEMO_EMAIL_FIRST_FETCH_MINUTES || "15", 10);
const FETCH_OVERLAP_MINUTES = parseInt(process.env.MNEMO_EMAIL_FETCH_OVERLAP_MINUTES || "2", 10);
const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "..", "mnemo.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
ensureAgentMailTables(db);

let imapflow = null, mailparser = null;
try { imapflow = require("imapflow"); mailparser = require("mailparser"); } catch (_) {}

function secretValue(ref, fallback) {
  if (!ref) return fallback || "";
  const raw = String(ref).trim();
  if (raw.startsWith("env:")) return process.env[raw.slice(4)] || fallback || "";
  if (raw.startsWith("file:")) {
    try { return fs.readFileSync(raw.slice(5), "utf8").trim(); } catch { return fallback || ""; }
  }
  if (/^[A-Z0-9_]+$/.test(raw)) return process.env[raw] || fallback || "";
  return fallback || "";
}

function ingest(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": buf.length,
        "X-Tenant-Id": process.env.MNEMO_EMAIL_TENANT || "shared"
      }
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => res.statusCode < 300 ? resolve() : reject(new Error(d)));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function accountImapConfig(account) {
  const host = account.imap_host || process.env.IMAP_HOST || "";
  const port = parseInt(account.imap_port || process.env.IMAP_PORT || "993", 10);
  const secure = account.imap_secure !== false;
  const user = secretValue(account.imap_user_ref, process.env.IMAP_USER || account.email_address);
  const pass = secretValue(account.imap_pass_ref, process.env.IMAP_PASS || "");
  if (!host || !user || !pass) return null;
  return { host, port, secure, auth: { user, pass }, logger: false };
}

function accountSmtpConfig(message) {
  const host = message.smtp_host || process.env.SMTP_HOST || "";
  const port = parseInt(message.smtp_port || process.env.SMTP_PORT || "465", 10);
  const user = secretValue(message.smtp_user_ref, process.env.SMTP_USER || message.email_address || message.from_addr);
  const pass = secretValue(message.smtp_pass_ref, process.env.SMTP_PASS || "");
  if (!host || !user || !pass) return null;
  return { host, port, secure: port === 465, user, pass };
}

function activeInboundAccounts() {
  const accounts = listAgentMailAccounts(db, { status: "active" }).accounts.filter((account) => account.inbound_enabled);
  if (accounts.length) return accounts;
  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASS) return [];
  return [{
    id: 0,
    agent_name: process.env.MNEMO_DEFAULT_AGENT || "agent",
    email_address: process.env.IMAP_USER,
    imap_host: process.env.IMAP_HOST,
    imap_port: parseInt(process.env.IMAP_PORT || "993", 10),
    imap_secure: true,
    imap_user_ref: "IMAP_USER",
    imap_pass_ref: "IMAP_PASS",
    imap_mailbox: "INBOX",
    last_fetch_at: null
  }];
}

async function pollAccountImap(account, cfg) {
  const client = new imapflow.ImapFlow(cfg);
  await client.connect();
  const mailbox = account.imap_mailbox || "INBOX";
  const lock = await client.getMailboxLock(mailbox);
  let inserted = 0;
  try {
    const lastFetch = account.last_fetch_at ? Date.parse(account.last_fetch_at) : 0;
    const sinceMs = Number.isFinite(lastFetch) && lastFetch > 0
      ? lastFetch - FETCH_OVERLAP_MINUTES * 60 * 1000
      : Date.now() - FIRST_FETCH_MINUTES * 60 * 1000;
    const since = new Date(sinceMs);
    for await (const msg of client.fetch({ since }, { source: true, envelope: true, uid: true })) {
      if (!msg.source) continue;
      const parsed = await mailparser.simpleParser(msg.source);
      const from = (parsed.from && parsed.from.text) || "";
      const subject = parsed.subject || "(no subject)";
      const text = parsed.text || parsed.html || "";
      const messageId = parsed.messageId || ("uid-" + msg.uid);
      try {
        if (account.id) {
          const result = recordInboundMail(db, {
            account_id: account.id,
            from_addr: from,
            to_addr: (parsed.to && parsed.to.text) || account.email_address,
            cc_addr: parsed.cc && parsed.cc.text,
            reply_to: parsed.replyTo && parsed.replyTo.text,
            subject,
            body_text: text,
            body_html: parsed.html || null,
            provider_message_id: messageId,
            received_at: (parsed.date || new Date()).toISOString(),
            meta: {
              uid: msg.uid,
              mailbox,
              attachments: (parsed.attachments || []).map((att) => ({ filename: att.filename, contentType: att.contentType, size: att.size }))
            }
          });
          if (result.inserted) inserted++;
        } else {
          await ingest({
            kind: "message",
            source: "email",
            source_ref: messageId,
            occurred_at: (parsed.date || new Date()).toISOString(),
            actor: from,
            importance: 5,
            text: subject + "\n\n" + text.slice(0, 4000),
            topic: "email:inbound",
            meta_json: JSON.stringify({ from, subject, to: parsed.to && parsed.to.text, message_id: messageId, uid: msg.uid })
          });
          inserted++;
        }
      } catch (e) {
        console.error("[email-ingest]", e.message);
      }
    }
    if (account.id) updateAccountFetchStatus(db, account.id, "ok", null);
  } finally {
    lock.release();
    await client.logout();
  }
  return inserted;
}

async function pollImap() {
  if (!imapflow) { console.log("[email] imapflow not installed - IMAP polling disabled"); return; }
  const accounts = activeInboundAccounts();
  if (!accounts.length) { console.log("[email] no agent mail accounts and IMAP env not set, polling disabled"); return; }
  let totalInserted = 0;
  for (const account of accounts) {
    const cfg = accountImapConfig(account);
    if (!cfg) {
      if (account.id) updateAccountFetchStatus(db, account.id, "missing_config", "IMAP host/user/pass secret refs incomplete");
      continue;
    }
    try {
      totalInserted += await pollAccountImap(account, cfg);
    } catch (e) {
      console.error("[imap-account]", account.agent_name, account.email_address, e.message);
      if (account.id) updateAccountFetchStatus(db, account.id, "error", e.message);
    }
  }
  const dispatched = dispatchInboundBriefs(db, { limit: Math.max(25, totalInserted + 10) });
  if (totalInserted || dispatched.dispatched) console.log("[email] inbound inserted=" + totalInserted + " briefs=" + dispatched.dispatched);
}

function smtpSend(opts, cfg) {
  return new Promise((resolve, reject) => {
    const config = cfg || accountSmtpConfig(opts) || null;
    const host = config && config.host || process.env.SMTP_HOST;
    const port = parseInt(config && config.port || process.env.SMTP_PORT || "465", 10);
    const user = config && config.user || process.env.SMTP_USER;
    const pass = config && config.pass || process.env.SMTP_PASS;
    if (!host || !user || !pass) return reject(new Error("SMTP env not configured"));
    const sock = (port === 465 ? tls : net).connect(port, host);
    let buf = "", state = 0;
    function send(line) { sock.write(line + "\r\n"); }
    function expect(code) { return buf.split(/\r?\n/).slice(-2, -1)[0]?.startsWith(code); }
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      if (state === 0 && expect("220")) { send("EHLO mnemo"); state = 1; }
      else if (state === 1 && expect("250")) { send("AUTH LOGIN"); state = 2; }
      else if (state === 2 && expect("334")) { send(Buffer.from(user).toString("base64")); state = 3; }
      else if (state === 3 && expect("334")) { send(Buffer.from(pass).toString("base64")); state = 4; }
      else if (state === 4 && expect("235")) { send("MAIL FROM:<" + (opts.from || user) + ">"); state = 5; }
      else if (state === 5 && expect("250")) { send("RCPT TO:<" + opts.to + ">"); state = 6; }
      else if (state === 6 && expect("250")) { send("DATA"); state = 7; }
      else if (state === 7 && expect("354")) {
        const headers = [
          "From: " + (opts.from || user),
          "To: " + opts.to,
          opts.cc ? "Cc: " + opts.cc : null,
          "Subject: " + (opts.subject || "(no subject)"),
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          ""
        ].filter((line) => line != null).join("\r\n");
        send(headers + (opts.text || "") + "\r\n.");
        state = 8;
      }
      else if (state === 8 && expect("250")) { send("QUIT"); state = 9; sock.end(); resolve({ ok: true }); }
      else if (buf.match(/\b(5\d\d|4\d\d)\b/)) { sock.end(); reject(new Error("SMTP response: " + buf.slice(-200))); }
    });
    sock.on("error", reject);
    setTimeout(() => { try { sock.end(); } catch (_) {} reject(new Error("smtp timeout state=" + state)); }, 15000);
  });
}

async function flushAgentOutbox() {
  const due = pendingOutboundMessages(db, { limit: parseInt(process.env.MNEMO_EMAIL_OUTBOX_LIMIT || "20", 10) });
  let sent = 0, failed = 0;
  for (const msg of due) {
    const cfg = accountSmtpConfig(msg);
    if (!cfg) {
      markMailMessage(db, { id: msg.id, status: "failed", error: "SMTP host/user/pass secret refs incomplete" });
      failed++;
      continue;
    }
    try {
      markMailMessage(db, { id: msg.id, status: "sending" });
      await smtpSend({ from: msg.from_addr || msg.email_address, to: msg.to_addr, cc: msg.cc_addr, subject: msg.subject, text: msg.body_text }, cfg);
      db.prepare("UPDATE agent_mail_message SET status='sent', sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(msg.id);
      updateAccountSendStatus(db, msg.account_id, "sent", null);
      sent++;
    } catch (e) {
      markMailMessage(db, { id: msg.id, status: "failed", error: e.message });
      updateAccountSendStatus(db, msg.account_id, "failed", e.message);
      failed++;
    }
  }
  if (sent || failed) console.log("[email] outbox sent=" + sent + " failed=" + failed);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  if (parsed.pathname === "/healthz") {
    const accounts = listAgentMailAccounts(db, { status: "active" }).accounts;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      email: true,
      port: PORT,
      imap: !!imapflow,
      smtp: !!process.env.SMTP_HOST || accounts.some((a) => a.smtp_host),
      agent_accounts: accounts.length,
      active_inbound_accounts: accounts.filter((a) => a.inbound_enabled).length,
      active_outbound_accounts: accounts.filter((a) => a.outbound_enabled).length
    }));
  }
  if (parsed.pathname === "/email/send" && req.method === "POST") {
    collectBody(req, res, async (body) => {
      let p; try { p = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end('{"error":"bad_json"}'); }
      if (!p.to || !p.subject) { res.writeHead(400); return res.end('{"error":"to+subject required"}'); }
      try {
        const r = await smtpSend(p);
        try {
          await ingest({
            kind: "message",
            source: "email",
            source_ref: "outbound:" + Date.now(),
            occurred_at: new Date().toISOString(),
            actor: p.from || process.env.SMTP_USER || "system",
            importance: 5,
            text: "(sent) " + p.subject + "\n\n" + (p.text || ""),
            topic: "email:outbound",
            meta_json: JSON.stringify({ to: p.to, subject: p.subject })
          });
        } catch (_) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('{"error":"not_found"}');
});

server.listen(PORT, () => {
  const accounts = listAgentMailAccounts(db, { status: "active" }).accounts;
  console.log("[email-gateway]", PORT, "imap=" + (imapflow ? "ready" : "missing-deps"), "agent_accounts=" + accounts.length);
});

if (imapflow) setInterval(() => pollImap().catch((e) => console.error("[imap-poll]", e.message)), POLL_MS);
setInterval(() => flushAgentOutbox().catch((e) => console.error("[email-outbox]", e.message)), OUTBOX_MS);
setTimeout(() => { if (imapflow) pollImap().catch((e) => console.error("[imap-poll]", e.message)); }, 5000);
setTimeout(() => { flushAgentOutbox().catch((e) => console.error("[email-outbox]", e.message)); }, 8000);

function shutdown(signal) {
  console.log(`[email-gateway] ${signal} received, closing server`);
  server.close(() => {
    console.log("[email-gateway] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.error("[email-gateway] forced exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[email-gateway] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[email-gateway] uncaughtException:", err);
  shutdown("uncaughtException");
});
