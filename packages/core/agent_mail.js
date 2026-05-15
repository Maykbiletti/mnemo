"use strict";

const crypto = require("crypto");
const { normalizeAgentName, parseMaybeJson } = require("./shared_utils");

const BLUN_COMPANY_NAME = "BLUN";
const MAIL_STATUSES = new Set(["new", "unread", "briefed", "processing", "processed", "ignored", "draft", "queued", "sending", "sent", "failed", "replied"]);

function nowIso() {
  return new Date().toISOString();
}

function boolInt(value, fallback = true) {
  if (value == null) return fallback ? 1 : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  const s = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(s)) return 0;
  if (["1", "true", "yes", "on", "enabled"].includes(s)) return 1;
  return fallback ? 1 : 0;
}

function normalizeEmail(value) {
  const raw = String(value || "").trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).replace(/^mailto:/, "").trim();
}

function parseEmailList(value) {
  if (Array.isArray(value)) return value.map(normalizeEmail).filter(Boolean);
  return String(value || "")
    .split(/[;,]/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function defaultSignature(account) {
  const display = account.employee_name || account.display_name || account.agent_name || "BLUN Agent";
  const role = account.role_title || "AI Agent";
  const email = account.email_address ? `\n${account.email_address}` : "";
  return `${display}\n${role}, BLUN${email}`;
}

function cleanStatus(status, fallback) {
  const value = String(status || fallback || "new").trim().toLowerCase();
  return MAIL_STATUSES.has(value) ? value : fallback;
}

function ensureAgentMailTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_mail_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  employee_name TEXT,
  company_name TEXT NOT NULL DEFAULT 'BLUN',
  employee_status TEXT NOT NULL DEFAULT 'active',
  department TEXT,
  role_title TEXT,
  email_address TEXT NOT NULL UNIQUE,
  inbound_enabled INTEGER NOT NULL DEFAULT 1,
  outbound_enabled INTEGER NOT NULL DEFAULT 1,
  imap_host TEXT,
  imap_port INTEGER,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_user_ref TEXT,
  imap_pass_ref TEXT,
  imap_mailbox TEXT NOT NULL DEFAULT 'INBOX',
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  smtp_user_ref TEXT,
  smtp_pass_ref TEXT,
  signature_text TEXT,
  handling_policy TEXT,
  send_policy TEXT NOT NULL DEFAULT 'agent_queue',
  status TEXT NOT NULL DEFAULT 'active',
  last_fetch_at TEXT,
  last_fetch_status TEXT,
  last_send_at TEXT,
  last_error TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_mail_account_agent ON agent_mail_account(agent_name, status);
CREATE INDEX IF NOT EXISTS idx_agent_mail_account_email ON agent_mail_account(email_address);

CREATE TABLE IF NOT EXISTS agent_mail_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES agent_mail_account(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  provider_message_id TEXT,
  thread_key TEXT,
  from_addr TEXT,
  to_addr TEXT,
  cc_addr TEXT,
  bcc_addr TEXT,
  reply_to TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  body_preview TEXT,
  received_at TEXT,
  queued_at TEXT,
  sent_at TEXT,
  processed_at TEXT,
  brief_id INTEGER,
  error TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(account_id, direction, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_mail_message_agent ON agent_mail_message(agent_name, direction, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_mail_message_account ON agent_mail_message(account_id, direction, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_mail_message_brief ON agent_mail_message(brief_id);
  `);
}

function accountRow(row) {
  if (!row) return null;
  return Object.assign({}, row, {
    inbound_enabled: !!row.inbound_enabled,
    outbound_enabled: !!row.outbound_enabled,
    imap_secure: !!row.imap_secure,
    smtp_secure: !!row.smtp_secure,
    meta: parseMaybeJson(row.meta_json, null)
  });
}

function messageRow(row) {
  if (!row) return null;
  return Object.assign({}, row, {
    meta: parseMaybeJson(row.meta_json, null)
  });
}

function findAccount(db, input = {}) {
  ensureAgentMailTables(db);
  if (input.account_id) return accountRow(db.prepare("SELECT * FROM agent_mail_account WHERE id=?").get(input.account_id));
  if (input.email_address) return accountRow(db.prepare("SELECT * FROM agent_mail_account WHERE lower(email_address)=lower(?) ORDER BY status='active' DESC, id ASC LIMIT 1").get(normalizeEmail(input.email_address)));
  if (input.to_addr || input.to) {
    const emails = parseEmailList(input.to_addr || input.to);
    for (const email of emails) {
      const row = db.prepare("SELECT * FROM agent_mail_account WHERE lower(email_address)=lower(?) ORDER BY status='active' DESC, id ASC LIMIT 1").get(email);
      if (row) return accountRow(row);
    }
  }
  if (input.agent_name) {
    return accountRow(db.prepare("SELECT * FROM agent_mail_account WHERE lower(agent_name)=lower(?) AND status='active' ORDER BY id ASC LIMIT 1").get(normalizeAgentName(input.agent_name)));
  }
  return null;
}

function upsertAgentMailAccount(db, input = {}) {
  ensureAgentMailTables(db);
  const agentName = normalizeAgentName(input.agent_name);
  const email = normalizeEmail(input.email_address || input.email);
  if (!agentName) return { ok: false, error: "agent_name required" };
  if (!email || !email.includes("@")) return { ok: false, error: "valid email_address required" };
  const row = {
    agent_name: agentName,
    employee_name: input.employee_name || input.display_name || agentName,
    company_name: BLUN_COMPANY_NAME,
    employee_status: input.employee_status || "active",
    department: input.department || null,
    role_title: input.role_title || "AI Agent",
    email_address: email,
    inbound_enabled: boolInt(input.inbound_enabled, true),
    outbound_enabled: boolInt(input.outbound_enabled, true),
    imap_host: input.imap_host || null,
    imap_port: input.imap_port ? parseInt(input.imap_port, 10) : null,
    imap_secure: boolInt(input.imap_secure, true),
    imap_user_ref: input.imap_user_ref || input.imap_user_env || null,
    imap_pass_ref: input.imap_pass_ref || input.imap_pass_env || null,
    imap_mailbox: input.imap_mailbox || "INBOX",
    smtp_host: input.smtp_host || null,
    smtp_port: input.smtp_port ? parseInt(input.smtp_port, 10) : null,
    smtp_secure: boolInt(input.smtp_secure, true),
    smtp_user_ref: input.smtp_user_ref || input.smtp_user_env || null,
    smtp_pass_ref: input.smtp_pass_ref || input.smtp_pass_env || null,
    signature_text: input.signature_text || defaultSignature(Object.assign({}, input, { agent_name: agentName, email_address: email })),
    handling_policy: input.handling_policy || "Fetch regularly. Create an agent brief for every new inbound email. Never invent BLUN policy or send untracked mail.",
    send_policy: input.send_policy || "agent_queue",
    status: input.status || "active",
    meta_json: input.meta ? JSON.stringify(input.meta) : null
  };
  const info = db.prepare(`
INSERT INTO agent_mail_account (
  agent_name, employee_name, company_name, employee_status, department, role_title, email_address,
  inbound_enabled, outbound_enabled, imap_host, imap_port, imap_secure, imap_user_ref, imap_pass_ref, imap_mailbox,
  smtp_host, smtp_port, smtp_secure, smtp_user_ref, smtp_pass_ref, signature_text, handling_policy, send_policy, status, meta_json
) VALUES (
  @agent_name, @employee_name, @company_name, @employee_status, @department, @role_title, @email_address,
  @inbound_enabled, @outbound_enabled, @imap_host, @imap_port, @imap_secure, @imap_user_ref, @imap_pass_ref, @imap_mailbox,
  @smtp_host, @smtp_port, @smtp_secure, @smtp_user_ref, @smtp_pass_ref, @signature_text, @handling_policy, @send_policy, @status, @meta_json
)
ON CONFLICT(email_address) DO UPDATE SET
  agent_name=excluded.agent_name,
  employee_name=excluded.employee_name,
  company_name='BLUN',
  employee_status=excluded.employee_status,
  department=excluded.department,
  role_title=excluded.role_title,
  inbound_enabled=excluded.inbound_enabled,
  outbound_enabled=excluded.outbound_enabled,
  imap_host=excluded.imap_host,
  imap_port=excluded.imap_port,
  imap_secure=excluded.imap_secure,
  imap_user_ref=excluded.imap_user_ref,
  imap_pass_ref=excluded.imap_pass_ref,
  imap_mailbox=excluded.imap_mailbox,
  smtp_host=excluded.smtp_host,
  smtp_port=excluded.smtp_port,
  smtp_secure=excluded.smtp_secure,
  smtp_user_ref=excluded.smtp_user_ref,
  smtp_pass_ref=excluded.smtp_pass_ref,
  signature_text=excluded.signature_text,
  handling_policy=excluded.handling_policy,
  send_policy=excluded.send_policy,
  status=excluded.status,
  meta_json=excluded.meta_json,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
`).run(row);
  const account = findAccount(db, { email_address: email });
  return { ok: true, id: account && account.id, inserted: info.changes > 0, account, company_enforced: BLUN_COMPANY_NAME };
}

function listAgentMailAccounts(db, input = {}) {
  ensureAgentMailTables(db);
  const where = [];
  const params = [];
  if (input.agent_name) { where.push("lower(agent_name)=lower(?)"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.status) { where.push("status=?"); params.push(input.status); }
  const sql = "SELECT * FROM agent_mail_account" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY agent_name ASC, email_address ASC";
  const rows = db.prepare(sql).all(...params).map(accountRow);
  return { ok: true, count: rows.length, accounts: rows };
}

function insertEmailMemory(db, message) {
  try {
    const hash = hashText(["agent_mail", message.direction, message.account_id, message.provider_message_id || message.id, message.subject || "", message.body_text || ""].join("|"));
    const text = [
      message.direction === "outbound" ? "(sent email)" : "(inbound email)",
      "Subject: " + (message.subject || "(no subject)"),
      message.from_addr ? "From: " + message.from_addr : null,
      message.to_addr ? "To: " + message.to_addr : null,
      "",
      String(message.body_text || "").slice(0, 4000)
    ].filter((line) => line != null).join("\n");
    db.prepare(`
INSERT OR IGNORE INTO memory (kind, source, source_ref, occurred_at, actor, topic, importance, text, meta_json, hash)
VALUES (?,?,?,?,?,?,?,?,?,?)
`).run(
      "message",
      "email",
      "agent_mail:" + (message.direction || "mail") + ":" + (message.provider_message_id || message.id || hash.slice(0, 12)),
      message.received_at || message.sent_at || message.queued_at || nowIso(),
      message.direction === "outbound" ? message.agent_name : (message.from_addr || "email"),
      "email:" + message.agent_name,
      6,
      text,
      JSON.stringify({ agent_name: message.agent_name, account_id: message.account_id, mail_message_id: message.id || null, direction: message.direction }),
      hash
    );
  } catch {}
}

function recordInboundMail(db, input = {}) {
  ensureAgentMailTables(db);
  const account = findAccount(db, input);
  if (!account) return { ok: false, error: "no agent mail account matched inbound recipient", to: input.to_addr || input.to || null };
  const providerId = input.provider_message_id || input.message_id || hashText([input.from_addr || input.from, input.to_addr || input.to, input.subject, input.received_at || input.date, input.body_text || input.text].join("|"));
  const bodyText = String(input.body_text || input.text || "").slice(0, 100000);
  const row = {
    account_id: account.id,
    agent_name: account.agent_name,
    direction: "inbound",
    status: cleanStatus(input.status, "new"),
    provider_message_id: providerId,
    thread_key: input.thread_key || input.in_reply_to || providerId,
    from_addr: input.from_addr || input.from || null,
    to_addr: input.to_addr || input.to || account.email_address,
    cc_addr: input.cc_addr || input.cc || null,
    bcc_addr: null,
    reply_to: input.reply_to || null,
    subject: input.subject || "(no subject)",
    body_text: bodyText,
    body_html: input.body_html || input.html || null,
    body_preview: bodyText.replace(/\s+/g, " ").slice(0, 240),
    received_at: input.received_at || input.date || nowIso(),
    meta_json: input.meta ? JSON.stringify(input.meta) : null
  };
  const info = db.prepare(`
INSERT OR IGNORE INTO agent_mail_message (
  account_id, agent_name, direction, status, provider_message_id, thread_key, from_addr, to_addr, cc_addr, bcc_addr,
  reply_to, subject, body_text, body_html, body_preview, received_at, meta_json
) VALUES (
  @account_id, @agent_name, @direction, @status, @provider_message_id, @thread_key, @from_addr, @to_addr, @cc_addr, @bcc_addr,
  @reply_to, @subject, @body_text, @body_html, @body_preview, @received_at, @meta_json
)
`).run(row);
  const stored = messageRow(db.prepare("SELECT * FROM agent_mail_message WHERE account_id=? AND direction='inbound' AND provider_message_id=?").get(account.id, providerId));
  if (info.changes) insertEmailMemory(db, stored);
  return { ok: true, inserted: info.changes > 0, duplicate: info.changes === 0, message: stored, account };
}

function createBriefForMessage(db, message, account) {
  const content = [
    "[EMAIL INBOX] " + (message.subject || "(no subject)"),
    "Agent: " + message.agent_name + " (" + account.employee_name + ", BLUN)",
    "From: " + (message.from_addr || "unknown"),
    "To: " + (message.to_addr || account.email_address),
    "Received: " + (message.received_at || message.created_at),
    "Mail message ID: " + message.id,
    "",
    String(message.body_text || "").slice(0, 6000),
    "",
    "Rules:",
    "- You are answering as a BLUN employee/agent.",
    "- Do not send untracked mail. Queue replies through mem_agent_mail_queue_outbound.",
    "- Mark this mail processed, replied, or ignored with mem_agent_mail_mark."
  ].join("\n");
  const meta = {
    agent_mail_message_id: message.id,
    agent_mail_account_id: account.id,
    email_subject: message.subject || null,
    email_from: message.from_addr || null,
    email_to: message.to_addr || null,
    company: BLUN_COMPANY_NAME,
    employee_context_required: true
  };
  try {
    return db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, channel, meta_json) VALUES (?,?,?,?,?)")
      .run(message.agent_name, "mnemo-agent-mail", content, "email", JSON.stringify(meta)).lastInsertRowid;
  } catch {
    return db.prepare("INSERT INTO agent_brief (agent_name, source_agent, content, meta_json) VALUES (?,?,?,?)")
      .run(message.agent_name, "mnemo-agent-mail", content, JSON.stringify(meta)).lastInsertRowid;
  }
}

function dispatchInboundBriefs(db, input = {}) {
  ensureAgentMailTables(db);
  const limit = Math.max(1, Math.min(parseInt(input.limit || 25, 10), 200));
  const agentWhere = input.agent_name ? " AND lower(m.agent_name)=lower(?)" : "";
  const params = input.agent_name ? [normalizeAgentName(input.agent_name), limit] : [limit];
  const rows = db.prepare(`
SELECT m.*, a.employee_name, a.email_address, a.company_name
FROM agent_mail_message m
JOIN agent_mail_account a ON a.id=m.account_id
WHERE m.direction='inbound' AND m.status IN ('new','unread') AND m.brief_id IS NULL${agentWhere}
ORDER BY COALESCE(m.received_at, m.created_at) ASC
LIMIT ?
`).all(...params);
  const made = [];
  const tx = db.transaction((messages) => {
    for (const raw of messages) {
      const msg = messageRow(raw);
      const account = {
        id: msg.account_id,
        employee_name: raw.employee_name || msg.agent_name,
        email_address: raw.email_address || msg.to_addr,
        company_name: raw.company_name || BLUN_COMPANY_NAME
      };
      const briefId = createBriefForMessage(db, msg, account);
      db.prepare("UPDATE agent_mail_message SET status='briefed', brief_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(briefId, msg.id);
      made.push({ message_id: msg.id, brief_id: briefId, agent_name: msg.agent_name, subject: msg.subject });
    }
  });
  tx(rows);
  return { ok: true, dispatched: made.length, briefs: made };
}

function listMailMessages(db, input = {}, direction) {
  ensureAgentMailTables(db);
  const where = ["m.direction=?"];
  const params = [direction];
  if (input.agent_name) { where.push("lower(m.agent_name)=lower(?)"); params.push(normalizeAgentName(input.agent_name)); }
  if (input.account_id) { where.push("m.account_id=?"); params.push(input.account_id); }
  const statuses = Array.isArray(input.status) ? input.status : (input.status ? [input.status] : []);
  if (statuses.length) {
    where.push("m.status IN (" + statuses.map(() => "?").join(",") + ")");
    params.push(...statuses.map((s) => cleanStatus(s, s)));
  }
  const limit = Math.max(1, Math.min(parseInt(input.limit || 50, 10), 200));
  params.push(limit);
  const rows = db.prepare(`
SELECT m.*, a.email_address, a.employee_name, a.company_name, a.role_title
FROM agent_mail_message m
JOIN agent_mail_account a ON a.id=m.account_id
WHERE ${where.join(" AND ")}
ORDER BY COALESCE(m.received_at, m.queued_at, m.created_at) DESC
LIMIT ?
`).all(...params).map(messageRow);
  return { ok: true, count: rows.length, messages: rows };
}

function queueOutboundMail(db, input = {}) {
  ensureAgentMailTables(db);
  const account = findAccount(db, input);
  if (!account) return { ok: false, error: "no agent mail account found for outbound mail" };
  if (!account.outbound_enabled) return { ok: false, error: "outbound disabled for account", account_id: account.id };
  const to = parseEmailList(input.to_addr || input.to).join(", ");
  if (!to) return { ok: false, error: "to required" };
  const subject = String(input.subject || "").trim() || "(no subject)";
  let text = String(input.body_text || input.text || "");
  const includeSignature = input.include_signature !== false;
  if (includeSignature && account.signature_text && !text.includes(account.signature_text)) {
    text = text.replace(/\s+$/, "") + "\n\n-- \n" + account.signature_text;
  }
  const queuedAt = nowIso();
  const info = db.prepare(`
INSERT INTO agent_mail_message (
  account_id, agent_name, direction, status, provider_message_id, thread_key, from_addr, to_addr, cc_addr, bcc_addr,
  reply_to, subject, body_text, body_preview, queued_at, meta_json
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
    account.id,
    account.agent_name,
    "outbound",
    cleanStatus(input.status, "queued"),
    input.provider_message_id || null,
    input.thread_key || input.reply_to_message_id || null,
    account.email_address,
    to,
    input.cc_addr || input.cc || null,
    input.bcc_addr || input.bcc || null,
    input.reply_to || null,
    subject,
    text,
    text.replace(/\s+/g, " ").slice(0, 240),
    queuedAt,
    input.meta ? JSON.stringify(input.meta) : null
  );
  const message = messageRow(db.prepare("SELECT * FROM agent_mail_message WHERE id=?").get(info.lastInsertRowid));
  insertEmailMemory(db, message);
  return { ok: true, id: info.lastInsertRowid, message, account };
}

function markMailMessage(db, input = {}) {
  ensureAgentMailTables(db);
  const id = parseInt(input.id || input.message_id, 10);
  if (!Number.isFinite(id)) return { ok: false, error: "id required" };
  const status = cleanStatus(input.status, null);
  if (!status) return { ok: false, error: "valid status required" };
  const processedAt = ["processed", "ignored", "replied", "sent", "failed"].includes(status) ? nowIso() : null;
  db.prepare(`
UPDATE agent_mail_message
SET status=?, processed_at=COALESCE(?, processed_at), error=COALESCE(?, error), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id=?
`).run(status, processedAt, input.error || null, id);
  return { ok: true, message: messageRow(db.prepare("SELECT * FROM agent_mail_message WHERE id=?").get(id)) };
}

function pendingOutboundMessages(db, input = {}) {
  ensureAgentMailTables(db);
  const limit = Math.max(1, Math.min(parseInt(input.limit || 20, 10), 100));
  return db.prepare(`
SELECT m.*, a.email_address, a.employee_name, a.company_name, a.smtp_host, a.smtp_port, a.smtp_secure, a.smtp_user_ref, a.smtp_pass_ref, a.signature_text
FROM agent_mail_message m
JOIN agent_mail_account a ON a.id=m.account_id
WHERE m.direction='outbound' AND m.status='queued' AND a.outbound_enabled=1 AND a.status='active'
ORDER BY COALESCE(m.queued_at, m.created_at) ASC
LIMIT ?
`).all(limit).map(messageRow);
}

function updateAccountFetchStatus(db, accountId, status, error) {
  ensureAgentMailTables(db);
  db.prepare("UPDATE agent_mail_account SET last_fetch_at=?, last_fetch_status=?, last_error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(nowIso(), status || "ok", error || null, accountId);
}

function updateAccountSendStatus(db, accountId, status, error) {
  ensureAgentMailTables(db);
  db.prepare("UPDATE agent_mail_account SET last_send_at=?, last_error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(status === "sent" ? nowIso() : null, error || null, accountId);
}

function handleAgentMailTool(db, name, args = {}) {
  switch (name) {
    case "mem_agent_mail_account_upsert":
      return { handled: true, result: upsertAgentMailAccount(db, args) };
    case "mem_agent_mail_account_list":
      return { handled: true, result: listAgentMailAccounts(db, args) };
    case "mem_agent_mail_inbox":
      return { handled: true, result: listMailMessages(db, args, "inbound") };
    case "mem_agent_mail_outbox":
      return { handled: true, result: listMailMessages(db, args, "outbound") };
    case "mem_agent_mail_record_inbound":
      return { handled: true, result: recordInboundMail(db, args) };
    case "mem_agent_mail_dispatch":
      return { handled: true, result: dispatchInboundBriefs(db, args) };
    case "mem_agent_mail_queue_outbound":
      return { handled: true, result: queueOutboundMail(db, args) };
    case "mem_agent_mail_mark":
      return { handled: true, result: markMailMessage(db, args) };
    default:
      return { handled: false };
  }
}

const AGENT_MAIL_TOOL_DEFS = {
  mem_agent_mail_account_upsert: {
    description: "Install or update a fixed BLUN employee mail identity for an agent. Stores mail server access as env:/file: secret references, never raw passwords.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        email_address: { type: "string" },
        employee_name: { type: "string" },
        department: { type: "string" },
        role_title: { type: "string" },
        inbound_enabled: { type: "boolean", default: true },
        outbound_enabled: { type: "boolean", default: true },
        imap_host: { type: "string" },
        imap_port: { type: "integer" },
        imap_secure: { type: "boolean", default: true },
        imap_user_ref: { type: "string", description: "env:VAR or file:/path secret reference" },
        imap_pass_ref: { type: "string", description: "env:VAR or file:/path secret reference" },
        smtp_host: { type: "string" },
        smtp_port: { type: "integer" },
        smtp_secure: { type: "boolean", default: true },
        smtp_user_ref: { type: "string" },
        smtp_pass_ref: { type: "string" },
        signature_text: { type: "string" },
        handling_policy: { type: "string" },
        send_policy: { type: "string", default: "agent_queue" },
        meta: { type: "object" }
      },
      required: ["agent_name", "email_address"]
    }
  },
  mem_agent_mail_account_list: {
    description: "List installed BLUN agent mail accounts and their fetch/send status.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, status: { type: "string" } } }
  },
  mem_agent_mail_inbox: {
    description: "List inbound agent mail messages from the structured Inbox.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, account_id: { type: "integer" }, status: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, limit: { type: "integer", default: 50 } } }
  },
  mem_agent_mail_outbox: {
    description: "List outbound agent mail messages from the structured Outbox.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, account_id: { type: "integer" }, status: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, limit: { type: "integer", default: 50 } } }
  },
  mem_agent_mail_record_inbound: {
    description: "Record a fetched inbound email into an agent mailbox. The gateway uses this; agents can use it for manual import.",
    inputSchema: { type: "object", properties: { account_id: { type: "integer" }, to_addr: { type: "string" }, from_addr: { type: "string" }, subject: { type: "string" }, body_text: { type: "string" }, body_html: { type: "string" }, message_id: { type: "string" }, provider_message_id: { type: "string" }, received_at: { type: "string" }, meta: { type: "object" } } }
  },
  mem_agent_mail_dispatch: {
    description: "Turn new inbound emails into agent_brief rows so agents regularly see and process their mail.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, limit: { type: "integer", default: 25 } } }
  },
  mem_agent_mail_queue_outbound: {
    description: "Queue a tracked outbound email from an agent's BLUN mailbox. Signature is appended by default and the gateway sends queued mail.",
    inputSchema: { type: "object", properties: { agent_name: { type: "string" }, account_id: { type: "integer" }, to: { type: "string" }, to_addr: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, body_text: { type: "string" }, cc: { type: "string" }, bcc: { type: "string" }, include_signature: { type: "boolean", default: true }, meta: { type: "object" } }, required: ["to", "subject"] }
  },
  mem_agent_mail_mark: {
    description: "Mark an agent mail message as processed, ignored, replied, sent, or failed.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, message_id: { type: "integer" }, status: { type: "string" }, error: { type: "string" } }, required: ["status"] }
  }
};

module.exports = {
  AGENT_MAIL_TOOL_DEFS,
  BLUN_COMPANY_NAME,
  ensureAgentMailTables,
  upsertAgentMailAccount,
  listAgentMailAccounts,
  recordInboundMail,
  dispatchInboundBriefs,
  listMailMessages,
  queueOutboundMail,
  markMailMessage,
  pendingOutboundMessages,
  updateAccountFetchStatus,
  updateAccountSendStatus,
  handleAgentMailTool,
  findAccount,
  normalizeEmail,
  parseEmailList
};
