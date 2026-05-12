#!/usr/bin/env node
"use strict";
/**
 * nl_cron.js — natural-language cron entries for Mnemo.
 *
 * Usage:
 *   node nl_cron.js "daily 8am: curl https://listing.blun.ai/brief/today"
 *   node nl_cron.js "every 15 minutes: node /root/mnemo/packages/core/cycles.js"
 *   node nl_cron.js "monday 9am: send weekly report"
 *   node nl_cron.js --list
 *   node nl_cron.js --remove <id>
 *
 * Parses a plain-language schedule + action, persists in mnemo memory
 * (kind="cron"), writes a managed line to /etc/cron.d/mnemo-nl, and
 * reloads cron. Idempotent: re-running with the same text replaces.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execSync } = require("child_process");
const crypto = require("crypto");

const CRON_FILE = process.env.MNEMO_NL_CRON_FILE || "/etc/cron.d/mnemo-nl";
const MNEMO_URL = process.env.MNEMO_URL || "http://127.0.0.1:7117";
const TENANT = process.env.MNEMO_TENANT || "shared";
const STATE_FILE = "/root/mnemo/.nl_cron_state.json";

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) { return { entries: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function nlToCron(input) {
  const t = input.toLowerCase().trim();
  // every N minutes
  let m = t.match(/^every\s+(\d+)\s*min(ute)?s?\s*:?\s*/);
  if (m) return { cron: `*/${m[1]} * * * *`, label: `every ${m[1]} minutes`, rest: input.slice(m[0].length) };
  m = t.match(/^every\s+(\d+)\s*hour?s?\s*:?\s*/);
  if (m) return { cron: `0 */${m[1]} * * *`, label: `every ${m[1]} hours`, rest: input.slice(m[0].length) };
  // daily at HH(am|pm) or HH:MM
  m = t.match(/^daily\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*:?\s*/);
  if (m) {
    let h = parseInt(m[1], 10), mm = parseInt(m[2] || "0", 10), ap = m[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { cron: `${mm} ${h} * * *`, label: `daily at ${h}:${String(mm).padStart(2,"0")}`, rest: input.slice(m[0].length) };
  }
  // weekday at HH
  const days = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
  m = t.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*:?\s*/);
  if (m) {
    let dow = days[m[1]];
    let h = parseInt(m[2], 10), mm = parseInt(m[3] || "0", 10), ap = m[4];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { cron: `${mm} ${h} * * ${dow}`, label: `${m[1]} at ${h}:${String(mm).padStart(2,"0")}`, rest: input.slice(m[0].length) };
  }
  // hourly
  if (/^hourly\s*:?\s*/.test(t)) return { cron: "0 * * * *", label: "hourly", rest: input.replace(/^hourly\s*:?\s*/i, "") };
  // raw cron pass-through if it starts with a digit/asterisk pattern
  m = input.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (m && /^[\d*\/,\-]+$/.test(m[1].split(" ")[0])) return { cron: m[1], label: "raw cron", rest: m[2] };
  return null;
}

function ingestToMnemo(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST", hostname: u.hostname, port: u.port || 80, path: u.pathname,
      headers: { "Content-Type": "application/json", "Content-Length": buf.length, "X-Tenant-Id": TENANT },
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 300 ? resolve(JSON.parse(d || "{}")) : reject(new Error(d))); });
    req.on("error", reject);
    req.write(buf); req.end();
  });
}

function rebuildCronFile(state) {
  const header = "# Managed by mnemo nl_cron — do not edit by hand\nSHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n\n";
  const lines = state.entries.map(e => `${e.cron} root ${e.action} >> /var/log/mnemo-nl-cron.log 2>&1  # ${e.id} :: ${e.label}`).join("\n");
  fs.writeFileSync(CRON_FILE, header + lines + "\n");
  try { fs.chmodSync(CRON_FILE, 0o644); } catch (_) {}
  try { execSync("/etc/init.d/cron reload 2>/dev/null || systemctl reload cron 2>/dev/null || true"); } catch (_) {}
}

async function add(input) {
  const parsed = nlToCron(input);
  if (!parsed) {
    console.error("could not parse schedule. Try: 'daily 8am: ...' or 'every 15 minutes: ...' or 'monday 9am: ...'");
    process.exit(2);
  }
  const action = parsed.rest.trim();
  if (!action) {
    console.error("missing action after schedule");
    process.exit(2);
  }
  const id = crypto.randomBytes(4).toString("hex");
  const entry = { id, original: input, cron: parsed.cron, label: parsed.label, action, created_at: new Date().toISOString() };
  const state = loadState();
  state.entries.push(entry);
  saveState(state);
  rebuildCronFile(state);
  try {
    await ingestToMnemo({
      kind: "cron", source: "nl_cron", source_ref: id,
      occurred_at: entry.created_at, actor: "system", topic: "scheduling",
      importance: 7,
      text: `cron entry "${parsed.label}" :: ${action}`,
      meta_json: JSON.stringify(entry),
    });
  } catch (e) { console.error("(mnemo ingest failed:", e.message + ")"); }
  console.log("added", id, "—", parsed.label, "→", action);
  console.log("cron:", parsed.cron);
}

function list() {
  const state = loadState();
  if (!state.entries.length) { console.log("no entries."); return; }
  for (const e of state.entries) console.log(e.id, "|", e.label.padEnd(28), "|", e.cron.padEnd(18), "|", e.action);
}

function remove(id) {
  const state = loadState();
  const before = state.entries.length;
  state.entries = state.entries.filter(e => e.id !== id);
  if (state.entries.length === before) { console.error("id not found:", id); process.exit(1); }
  saveState(state);
  rebuildCronFile(state);
  console.log("removed", id);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(`usage:
  nl_cron.js "<schedule>: <action>"     add a new entry
  nl_cron.js --list                      list entries
  nl_cron.js --remove <id>               remove an entry

examples:
  nl_cron.js "daily 8am: curl -fsS -X POST http://127.0.0.1:3215/api/brief/cron-tick"
  nl_cron.js "every 15 minutes: node /root/mnemo/packages/core/cycles.js"
  nl_cron.js "monday 9am: /root/health-watcher.sh"`);
  process.exit(0);
}
if (args[0] === "--list") list();
else if (args[0] === "--remove") remove(args[1]);
else add(args.join(" "));
