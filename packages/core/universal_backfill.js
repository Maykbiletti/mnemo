#!/usr/bin/env node
/**
 * Universal capture backfill.
 *
 * Imports historical channel/session exports through mem_capture_ingest, so
 * replayed rows are idempotent and duplicate skips still leave an audit receipt.
 *
 * Default mode is dry-run. Add --commit to write to a Mnemo daemon/hub.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_HUB = process.env.MNEMO_HUB_URL || "http://127.0.0.1:7117";
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || "owner";
const OWNER_ID = process.env.MNEMO_OWNER_ID || process.env.MNEMO_OWNER_USER_ID || process.env.MNEMO_OWNER_TELEGRAM_USER_ID || "";

function parseArgs(argv) {
  const out = {
    source: "auto",
    paths: [],
    agentRoots: [],
    hubUrl: DEFAULT_HUB,
    commit: false,
    limit: 0,
    batchSize: 100,
    maxChars: 12000,
    promoteMemory: "owner",
    ownerName: OWNER_NAME,
    ownerId: OWNER_ID,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--source") out.source = next();
    else if (a === "--path") out.paths.push(next());
    else if (a === "--agent-root") out.agentRoots.push(next());
    else if (a === "--hub-url") out.hubUrl = next();
    else if (a === "--commit") out.commit = true;
    else if (a === "--dry-run") out.commit = false;
    else if (a === "--limit") out.limit = parseInt(next(), 10) || 0;
    else if (a === "--batch-size") out.batchSize = parseInt(next(), 10) || 100;
    else if (a === "--max-chars") out.maxChars = parseInt(next(), 10) || 12000;
    else if (a === "--promote-memory") out.promoteMemory = next();
    else if (a === "--owner-name") out.ownerName = next();
    else if (a === "--owner-id") out.ownerId = next();
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("--")) out.paths.push(a);
    else throw new Error("unknown arg: " + a);
  }
  return out;
}

function help() {
  return `
Usage:
  node universal_backfill.js --source auto --hub-url http://127.0.0.1:7117 --dry-run
  node universal_backfill.js --source telegram --path "<ChatExport>/result.json" --commit
  node universal_backfill.js --source agent --path "%USERPROFILE%\\.agent-sessions" --commit
  node universal_backfill.js --source local-agent --agent-root "<agent-client-root>" --commit

Sources:
  auto         Telegram Desktop exports, local CLI history/sessions, plus --agent-root roots
  telegram    Telegram Desktop export directory or result.json
  agent       local CLI history.jsonl and sessions under a .agent-sessions root
  local-agent Generic JSONL session/history root from another agent client
  pm2         PM2 log directory

Safety:
  --dry-run is default. Use --commit to write.
  --batch-size N controls write batch size in commit mode (default 100).
  --promote-memory none|owner|all controls semantic memory promotion.
`;
}

function listFiles(root, pred, acc = []) {
  if (!root || !fs.existsSync(root)) return acc;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (!pred || pred(root)) acc.push(root);
    return acc;
  }
  for (const name of fs.readdirSync(root)) {
    const fp = path.join(root, name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.isDirectory()) listFiles(fp, pred, acc);
    else if (!pred || pred(fp)) acc.push(fp);
  }
  return acc;
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "number") {
    const ms = value > 100000000000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (/^\d+$/.test(String(value))) return toIso(parseInt(value, 10));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function flattenText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      if (typeof item.value === "string") return item.value;
      return "";
    }).filter(Boolean).join("");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
  }
  return "";
}

function clip(text, maxChars) {
  const s = String(text || "");
  return s.length > maxChars ? s.slice(0, maxChars) + "\n...[truncated by universal_backfill]" : s;
}

function looksOwner(actor, actorId, opts) {
  if (opts.ownerId && actorId && String(actorId) === String(opts.ownerId)) return true;
  const a = String(actor || "").toLowerCase();
  const owner = String(opts.ownerName || "").toLowerCase();
  return !!(owner && owner !== "owner" && a.includes(owner.split(/\s+/)[0]));
}

function shouldPromoteMemory(ev, opts) {
  if (opts.promoteMemory === "all") return true;
  if (opts.promoteMemory === "none") return false;
  return !!ev.isOwner;
}

function eventBase(ev, opts) {
  const content = clip(ev.content, opts.maxChars);
  return {
    source: ev.source,
    channel: ev.channel || null,
    direction: ev.direction || "inbound",
    actor: ev.actor || null,
    actor_id: ev.actor_id || null,
    event_kind: ev.event_kind || "message",
    ref_kind: ev.ref_kind || "source_message",
    ref_id: ev.ref_id || ev.source_ref || null,
    source_ref: ev.source_ref || ev.ref_id || null,
    thread_id: ev.thread_id || ev.channel || null,
    occurred_at: ev.occurred_at || new Date().toISOString(),
    content,
    promote_transcript: ev.promote_transcript !== false,
    promote_memory: shouldPromoteMemory(ev, opts),
    importance: ev.importance || (ev.isOwner ? 6 : 4),
    topic: ev.topic || ev.channel || null,
    meta: Object.assign({}, ev.meta || {}, {
      backfill: true,
      importer: "universal_backfill",
      source_file: ev.source_file || null,
    }),
  };
}

function* telegramEvents(fp, opts) {
  const file = fs.statSync(fp).isDirectory() ? path.join(fp, "result.json") : fp;
  if (!fs.existsSync(file)) return;
  let data;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) {
      console.error("[backfill:skip] empty telegram export:", file);
      return;
    }
    data = JSON.parse(raw);
  } catch (e) {
    console.error("[backfill:skip] invalid telegram export:", file, e.message);
    return;
  }
  const chatId = data.id != null ? String(data.id) : path.basename(path.dirname(file));
  const channel = "telegram:" + chatId;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (const m of messages) {
    const text = flattenText(m.text);
    if (!text.trim()) continue;
    const actor = m.from || m.actor || "unknown";
    const actorId = m.from_id || m.actor_id || "";
    const isOwner = looksOwner(actor, actorId, opts);
    const msgId = m.id != null ? String(m.id) : String(messages.indexOf(m));
    const sourceRef = "tg:" + chatId + ":" + msgId;
    yield {
      source: "telegram",
      channel,
      direction: "inbound",
      actor,
      actor_id: actorId ? String(actorId) : null,
      isOwner,
      ref_kind: "telegram_message",
      ref_id: sourceRef,
      source_ref: sourceRef,
      thread_id: chatId,
      occurred_at: m.date_unixtime ? toIso(parseInt(m.date_unixtime, 10)) : toIso(m.date),
      content: text,
      source_file: file,
      meta: { chat_id: chatId, chat_name: data.name || null, chat_type: data.type || null, message_id: msgId },
    };
  }
}

function* agentHistoryEvents(fp, opts) {
  const file = fs.statSync(fp).isDirectory() ? path.join(fp, "history.jsonl") : fp;
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let idx = 0;
  for (const line of lines) {
    idx++;
    if (!line.trim()) continue;
    const o = safeJson(line);
    if (!o || !o.text) continue;
    const session = o.session_id || "unknown";
    yield {
      source: "agent-history",
      channel: "agent-session:" + session,
      direction: "inbound",
      actor: opts.ownerName,
      actor_id: opts.ownerId || null,
      isOwner: true,
      ref_kind: "agent_history",
      ref_id: "agent-history:" + session + ":" + (o.ts || idx),
      source_ref: "agent-history:" + session + ":" + (o.ts || idx),
      thread_id: session,
      occurred_at: toIso(o.ts || Date.now()),
      content: o.text,
      source_file: file,
      meta: { session_id: session, line: idx },
    };
  }
}

function contentFromMessagePayload(payload) {
  if (!payload) return "";
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) return flattenText(payload.content);
  if (payload.message) return contentFromMessagePayload(payload.message);
  return "";
}

function* agentSessionEvents(rootOrFile, opts) {
  const files = listFiles(rootOrFile, (f) => f.endsWith(".jsonl") && path.basename(f).startsWith("rollout-"));
  for (const file of files) {
    const fallbackSession = path.basename(file).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let idx = 0;
    let session = fallbackSession;
    for (const line of lines) {
      idx++;
      if (!line.trim()) continue;
      const o = safeJson(line);
      if (!o) continue;
      if (o.type === "session_meta" && o.payload && o.payload.id) {
        session = o.payload.id;
        continue;
      }
      if (o.type !== "response_item" || !o.payload || o.payload.type !== "message") continue;
      const role = o.payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = contentFromMessagePayload(o.payload);
      if (!text.trim()) continue;
      const isOwner = role === "user";
      yield {
        source: "agent-session",
        channel: "agent-session:" + session,
        direction: role === "assistant" ? "outbound" : "inbound",
        actor: isOwner ? opts.ownerName : "agent",
        actor_id: isOwner ? (opts.ownerId || null) : null,
        isOwner,
        ref_kind: "agent_session_message",
        ref_id: "agent-session:" + session + ":" + idx,
        source_ref: "agent-session:" + session + ":" + idx,
        thread_id: session,
        occurred_at: toIso(o.timestamp),
        content: text,
        source_file: file,
        meta: { session_id: session, line: idx, role, phase: o.payload.phase || null },
      };
    }
  }
}

function* localAgentHistoryEvents(rootOrFile, opts) {
  const file = fs.statSync(rootOrFile).isDirectory() ? path.join(rootOrFile, "history.jsonl") : rootOrFile;
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let idx = 0;
  for (const line of lines) {
    idx++;
    if (!line.trim()) continue;
    const o = safeJson(line);
    if (!o) continue;
    const text = flattenText(o.display || o.text || o.content);
    if (!text.trim()) continue;
    const session = o.sessionId || o.session_id || "unknown";
    yield {
      source: "local-agent-history",
      channel: "local-agent-session:" + session,
      direction: "inbound",
      actor: opts.ownerName,
      actor_id: opts.ownerId || null,
      isOwner: true,
      ref_kind: "local_agent_history",
      ref_id: "local-agent-history:" + session + ":" + (o.timestamp || idx),
      source_ref: "local-agent-history:" + session + ":" + (o.timestamp || idx),
      thread_id: session,
      occurred_at: toIso(o.timestamp || Date.now()),
      content: text,
      source_file: file,
      meta: { project: o.project || null, session_id: session, line: idx },
    };
  }
}

function* localAgentSessionEvents(rootOrFile, opts) {
  const roots = fs.statSync(rootOrFile).isDirectory() ? [path.join(rootOrFile, "projects"), path.join(rootOrFile, "sessions")] : [rootOrFile];
  for (const root of roots) {
    const files = listFiles(root, (f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      let idx = 0;
      for (const line of lines) {
        idx++;
        if (!line.trim()) continue;
        const o = safeJson(line);
        if (!o) continue;
        if (o.type === "attachment" || o.type === "permission-mode") continue;
        let text = "";
        let role = "event";
        if (o.type === "queue-operation" && o.content) {
          text = o.content;
          role = "queue";
        } else if (o.message) {
          text = contentFromMessagePayload(o.message);
          role = o.message.role || o.type || "message";
        } else {
          text = flattenText(o.content || o.text || o.display);
          role = o.role || o.type || "event";
        }
        if (!text.trim()) continue;
        const session = o.sessionId || o.session_id || "unknown";
        const isOwner = role === "user" || o.userType === "human" || o.userType === "external";
        yield {
          source: "local-agent-session",
          channel: "local-agent-session:" + session,
          direction: role === "assistant" ? "outbound" : "inbound",
          actor: isOwner ? opts.ownerName : (role || "agent"),
          actor_id: null,
          isOwner,
          ref_kind: "local_agent_session_message",
          ref_id: "local-agent-session:" + session + ":" + idx,
          source_ref: "local-agent-session:" + session + ":" + idx,
          thread_id: session,
          occurred_at: toIso(o.timestamp || Date.now()),
          content: text,
          source_file: file,
          meta: { session_id: session, line: idx, role, project: o.cwd || o.project || null },
        };
      }
    }
  }
}

function* pm2Events(root, opts) {
  const files = listFiles(root, (f) => /\.log(\.\d+)?$/.test(f));
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let idx = 0;
    for (const line of lines) {
      idx++;
      if (!line.trim()) continue;
      const ts = (line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\]/) || [])[1];
      yield {
        source: "pm2-log",
        channel: path.basename(file),
        direction: "internal",
        actor: "pm2",
        isOwner: false,
        event_kind: "log_line",
        ref_kind: "pm2_log_line",
        ref_id: "pm2:" + file + ":" + idx,
        source_ref: "pm2:" + file + ":" + idx,
        thread_id: path.basename(file),
        occurred_at: ts ? toIso(ts) : new Date(fs.statSync(file).mtime).toISOString(),
        content: line,
        source_file: file,
        promote_transcript: false,
        meta: { line: idx, file: path.basename(file) },
      };
    }
  }
}

function discover(opts) {
  const home = os.homedir();
  const tasks = [];
  const add = (source, fp) => { if (fp && fs.existsSync(fp)) tasks.push({ source, path: fp }); };
  const paths = opts.paths.length ? opts.paths : [];
  if (opts.source === "telegram") paths.forEach((p) => add("telegram", p));
  else if (opts.source === "agent") paths.forEach((p) => add("agent", p));
  else if (opts.source === "local-agent") paths.concat(opts.agentRoots).forEach((p) => add("local-agent", p));
  else if (opts.source === "pm2") paths.forEach((p) => add("pm2", p));
  else {
    const tgRoot = path.join(home, "Downloads", "Telegram Desktop");
    if (fs.existsSync(tgRoot)) {
      for (const d of fs.readdirSync(tgRoot)) {
        if (d.startsWith("ChatExport_")) add("telegram", path.join(tgRoot, d, "result.json"));
      }
    }
    add("agent", path.join(home, ".agent-sessions"));
    const extraRoots = []
      .concat(opts.agentRoots)
      .concat(String(process.env.MNEMO_BACKFILL_AGENT_ROOTS || "").split(path.delimiter).filter(Boolean));
    extraRoots.forEach((p) => add("local-agent", p));
    add("pm2", path.join(home, ".pm2", "logs"));
  }
  return tasks;
}

function* eventsForTask(task, opts) {
  if (task.source === "telegram") yield* telegramEvents(task.path, opts);
  else if (task.source === "agent") {
    const st = fs.statSync(task.path);
    if (st.isDirectory()) {
      yield* agentHistoryEvents(task.path, opts);
      yield* agentSessionEvents(path.join(task.path, "sessions"), opts);
    } else if (path.basename(task.path) === "history.jsonl") {
      yield* agentHistoryEvents(task.path, opts);
    } else {
      yield* agentSessionEvents(task.path, opts);
    }
  } else if (task.source === "local-agent") {
    const st = fs.statSync(task.path);
    if (st.isDirectory()) {
      yield* localAgentHistoryEvents(task.path, opts);
      yield* localAgentSessionEvents(task.path, opts);
    } else if (path.basename(task.path) === "history.jsonl") {
      yield* localAgentHistoryEvents(task.path, opts);
    } else {
      yield* localAgentSessionEvents(task.path, opts);
    }
  } else if (task.source === "pm2") {
    yield* pm2Events(task.path, opts);
  }
}

function toolUrl(base, tool) {
  const b = String(base || DEFAULT_HUB).replace(/\/$/, "");
  return b.endsWith("/tool") ? `${b}/${tool}` : `${b}/tool/${tool}`;
}

async function callTool(opts, tool, args) {
  const res = await fetch(toolUrl(opts.hubUrl, tool), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${tool} ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

async function flushBatch(opts, stats, batch) {
  if (!batch.length) return;
  if (!opts.commit) {
    stats.captured += batch.length;
    batch.length = 0;
    return;
  }
  try {
    const result = batch.length === 1
      ? await callTool(opts, "mem_capture_ingest", batch[0])
      : await callTool(opts, "mem_capture_ingest_batch", { items: batch, limit: Math.max(batch.length, opts.batchSize) });
    if (batch.length === 1) {
      if (result && result.duplicate) stats.duplicate++;
      else if (result && result.ok) stats.captured++;
      else stats.errors++;
    } else {
      stats.captured += result.captured || 0;
      stats.duplicate += result.duplicate || 0;
      stats.errors += result.errors || 0;
    }
  } catch (e) {
    stats.errors += batch.length;
    console.error("[backfill:error] batch", batch.length, e.message);
  } finally {
    batch.length = 0;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(help());
    return;
  }
  const tasks = discover(opts);
  const stats = { mode: opts.commit ? "commit" : "dry-run", tasks: tasks.length, seen: 0, captured: 0, duplicate: 0, errors: 0, by_source: {} };
  if (!tasks.length) {
    console.log(JSON.stringify(Object.assign(stats, { error: "no sources found" }), null, 2));
    process.exitCode = 1;
    return;
  }
  const batch = [];
  for (const task of tasks) {
    if (opts.verbose) console.error("[backfill]", task.source, task.path);
    for (const ev of eventsForTask(task, opts)) {
      if (opts.limit && stats.seen >= opts.limit) break;
      stats.seen++;
      stats.by_source[ev.source] = (stats.by_source[ev.source] || 0) + 1;
      const payload = eventBase(ev, opts);
      batch.push(payload);
      if (batch.length >= opts.batchSize) await flushBatch(opts, stats, batch);
    }
    if (opts.limit && stats.seen >= opts.limit) break;
  }
  await flushBatch(opts, stats, batch);
  console.log(JSON.stringify(stats, null, 2));
  if (opts.commit) {
    try {
      await callTool(opts, "mem_event_log", {
        source: "universal_backfill",
        direction: "internal",
        event_kind: "backfill_run",
        status: stats.errors ? "partial" : "ok",
        content: JSON.stringify(stats),
        payload: stats,
      });
    } catch {}
  }
  if (stats.errors) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e && e.stack || e.message || e);
  process.exitCode = 1;
});
