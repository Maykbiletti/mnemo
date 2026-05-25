#!/usr/bin/env node
"use strict";

const os = require("os");
const { flushQueue, queueStats } = require("./hook_queue");

const BASE_URL = String(process.env.MNEMO_HUB_URL || process.env.MNEMO_HOST || "http://127.0.0.1:7117").replace(/\/+$/, "");
const PROJECT = process.env.MNEMO_HOOK_WATCHDOG_PROJECT || process.env.MNEMO_PROJECT || process.env.MNEMO_DEFAULT_SCOPE || "mnemo";
const DEFAULT_AGENT = process.env.MNEMO_AGENT || process.env.MNEMO_DEFAULT_AGENT || "";
const AGENTS = String(process.env.MNEMO_HOOK_WATCHDOG_AGENTS || DEFAULT_AGENT || "angel,dieter")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const STALE_MINUTES = Math.max(5, Number(process.env.MNEMO_HOOK_WATCHDOG_STALE_MINUTES || 180));
const WINDOW_MINUTES = Math.max(STALE_MINUTES, Number(process.env.MNEMO_HOOK_WATCHDOG_WINDOW_MINUTES || 1440));
const RETRY_ATTEMPTS = Math.max(1, Number(process.env.MNEMO_HOOK_RETRY_ATTEMPTS || 4));
const RETRY_BASE_MS = Math.max(50, Number(process.env.MNEMO_HOOK_RETRY_BASE_MS || 350));
const RETRY_MAX_MS = Math.max(RETRY_BASE_MS, Number(process.env.MNEMO_HOOK_RETRY_MAX_MS || 5000));
const HTTP_TIMEOUT_MS = Math.max(1000, Number(process.env.MNEMO_HOOK_HTTP_TIMEOUT_MS || 15000));
const NOTIFY_AGENT = String(process.env.MNEMO_HOOK_WATCHDOG_NOTIFY_AGENT || "").trim().toLowerCase();
const SOURCE_CHECK_ENABLED = process.env.MNEMO_HOOK_WATCHDOG_SOURCE_CHECK !== "0";
const SOURCE_WINDOW_MINUTES = Math.max(5, Number(process.env.MNEMO_HOOK_WATCHDOG_SOURCE_WINDOW_MINUTES || 60));
const WRITER_STALE_MINUTES = Math.max(5, Number(process.env.MNEMO_HOOK_WATCHDOG_WRITER_STALE_MINUTES || 30));
const CRITICAL_WRITERS = String(process.env.MNEMO_HOOK_WATCHDOG_CRITICAL_WRITERS || "capture:codexlink")
  .split(",").map((item) => item.trim()).filter(Boolean);
const REQUIRED_HOOKS = String(process.env.MNEMO_HOOK_WATCHDOG_REQUIRED_HOOKS || "session_start")
  .split(",").map((item) => item.trim()).filter(Boolean);
const args = new Set(process.argv.slice(2));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(base + Math.random() * Math.min(250, base));
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryableFetchError(error) {
  const name = String(error && error.name || "");
  const msg = String(error && error.message || "");
  return name === "AbortError" || /timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg);
}

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function fetchWithRetry(url, options, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      const res = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
      clearTimeout(timer);
      timer = null;
      if (res.ok || !retryableStatus(res.status) || attempt >= RETRY_ATTEMPTS) return res;
      let sample = "";
      try { sample = (await res.clone().text()).slice(0, 180); } catch {}
      lastError = new Error(`${label || "request"} ${res.status}: ${sample}`);
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (!retryableFetchError(error) || attempt >= RETRY_ATTEMPTS) throw error;
      lastError = error;
    }
    await sleep(retryDelayMs(attempt));
  }
  throw lastError || new Error(`${label || "request"} failed after retries`);
}

async function callTool(name, body) {
  const res = await fetchWithRetry(`${BASE_URL}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  }, name);
  const json = await readJson(res);
  if (!res.ok) throw new Error(`${name} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

async function heartbeatAgent(agent) {
  const meta = {
    hook_watchdog: true,
    source: "hook-watchdog",
    project: PROJECT,
    host: os.hostname(),
    pid: process.pid
  };
  const connect = await callTool("mem_connect_heartbeat", {
    agent_name: agent,
    status: "online",
    meta
  });
  const liveStatus = await callTool("mem_agent_status_set", {
    agent_name: agent,
    current_task: "mnemo hook watchdog heartbeat",
    host: os.hostname(),
    pid: process.pid,
    meta
  });
  const hookStatus = await callTool("mem_action_log", {
    agent_name: agent,
    action_kind: "mnemo_runtime_hook",
    target: "HookWatchdogHeartbeat",
    status: "ok",
    topic: "runtime_hook",
    payload: {
      hook_event: "HookWatchdogHeartbeat",
      project: PROJECT,
      ok: true,
      watchdog_heartbeat: true
    },
    meta
  });
  return { connect, live_status: liveStatus, hook_status: hookStatus };
}

function healthAgent(memoryHealth, agent) {
  const agents = memoryHealth && Array.isArray(memoryHealth.agents) ? memoryHealth.agents : [];
  return agents.find((row) => String(row.agent_name || "").toLowerCase() === agent) || null;
}

function hookGaps(row) {
  const seen = row && row.required_hooks_seen || {};
  return REQUIRED_HOOKS.filter((name) => !seen[name]);
}

function shouldHeal(row) {
  if (!row) return true;
  const health = String(row.health || "").toLowerCase();
  if (health === "unknown" || health === "error" || health === "stale" || !health) return true;
  if (hookGaps(row).includes("session_start")) return true;
  return false;
}

function healReason(row) {
  if (!row) return "missing memory-health row";
  const parts = [];
  if (row.health) parts.push(`health=${row.health}`);
  const gaps = hookGaps(row);
  if (gaps.includes("session_start")) parts.push("session_start_missing");
  if (!parts.length) parts.push("watchdog requested");
  return parts.join("; ");
}

function minutesSince(iso) {
  const t = iso ? Date.parse(iso) : 0;
  if (!t) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

async function checkSourceCoverage() {
  const since = new Date(Date.now() - SOURCE_WINDOW_MINUTES * 60000).toISOString();
  const coverage = await callTool("mem_source_coverage", { since });
  const writers = new Map((coverage.writers || []).map((row) => [String(row.writer || ""), row]));
  const gaps = [];
  for (const writer of CRITICAL_WRITERS) {
    const row = writers.get(writer);
    const age = row ? minutesSince(row.last_write_at) : null;
    const status = row && row.status || "missing";
    if (!row) {
      gaps.push({ writer, status: "missing", reason: "writer not registered" });
    } else if (status !== "alive" || age == null || age > WRITER_STALE_MINUTES) {
      gaps.push({ writer, status, age_min: age, last_write_at: row.last_write_at || null, reason: `critical writer not fresh within ${WRITER_STALE_MINUTES} min` });
    }
  }
  return { since, critical_writers: CRITICAL_WRITERS, writer_stale_minutes: WRITER_STALE_MINUTES, gaps, coverage };
}

async function selfHeal(agent, row) {
  const reason = healReason(row);
  const sessionStart = await callTool("mem_session_start", {
    agent_name: agent,
    project: PROJECT,
    task: `hook watchdog self-heal: ${reason}`
  });
  const hookStatus = await callTool("mem_action_log", {
    agent_name: agent,
    action_kind: "mnemo_runtime_hook",
    target: "SessionStart",
    status: "ok",
    topic: "runtime_hook",
    payload: {
      hook_event: "SessionStart",
      project: PROJECT,
      ok: true,
      session_start_ok: true,
      self_heal: true,
      watchdog: "hook-watchdog",
      reason
    },
    meta: {
      hook: "hook-watchdog",
      host: os.hostname(),
      self_heal: true,
      reason
    }
  });
  return { agent_name: agent, healed: true, reason, session_start: sessionStart, hook_status: hookStatus };
}

async function notifyIfNeeded(out) {
  if (!NOTIFY_AGENT) return null;
  const healed = out.results.filter((row) => row.healed).map((row) => `${row.agent_name}: ${row.reason}`);
  const errors = out.results.filter((row) => row.error).map((row) => `${row.agent_name}: ${row.error}`);
  if (!healed.length && !errors.length && !out.blockers.length) return null;
  const content = [
    "# Mnemo Hook Watchdog",
    "",
    `Host: ${out.host}`,
    `Project: ${out.project}`,
    `Status: ${out.status}`,
    healed.length ? "" : null,
    healed.length ? "## Self-Heal" : null,
    ...healed.map((line) => `- ${line}`),
    errors.length ? "" : null,
    errors.length ? "## Errors" : null,
    ...errors.map((line) => `- ${line}`),
    out.blockers.length ? "" : null,
    out.blockers.length ? "## Blockers" : null,
    ...out.blockers.map((line) => `- ${line}`)
  ].filter(Boolean).join("\n");
  try {
    return await callTool("mem_brief_drop", {
      agent_name: NOTIFY_AGENT,
      source_agent: "mnemo-hook-watchdog",
      channel: "watchdog",
      content,
      meta: { hook_watchdog: true, host: out.host, project: out.project, status: out.status }
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function main() {
  const out = {
    ok: true,
    status: "ok",
    base_url: BASE_URL,
    host: os.hostname(),
    project: PROJECT,
    agents: AGENTS,
    stale_minutes: STALE_MINUTES,
    queue_before: queueStats(),
    queue_flush: null,
    results: [],
    blockers: []
  };

  if (!AGENTS.length) out.blockers.push("no agents configured");

  if (args.has("--flush")) {
    try {
      out.queue_flush = await flushQueue(BASE_URL, {});
    } catch (error) {
      out.queue_flush = { ok: false, error: error.message };
      out.blockers.push("queue flush failed: " + error.message);
    }
  }

  for (const agent of AGENTS) {
    try {
      const heartbeat = await heartbeatAgent(agent);
      const memoryHealth = await callTool("mem_agent_memory_health", {
        agent_name: agent,
        stale_minutes: STALE_MINUTES,
        window_minutes: WINDOW_MINUTES
      });
      const row = healthAgent(memoryHealth, agent);
      const missingRequiredHooks = hookGaps(row);
      const needsHeal = shouldHeal(row);
      if (needsHeal && args.has("--heal")) {
        const healed = await selfHeal(agent, row);
        healed.heartbeat = heartbeat;
        healed.missing_required_hooks = missingRequiredHooks;
        out.results.push(healed);
        for (const hook of missingRequiredHooks.filter((name) => name !== "session_start")) {
          out.blockers.push(`${agent}: required hook missing: ${hook}`);
        }
      } else {
        out.results.push({ agent_name: agent, healed: false, health: row && row.health || "missing", required_hooks_seen: row && row.required_hooks_seen || null, missing_required_hooks: missingRequiredHooks, heartbeat });
        for (const hook of missingRequiredHooks) {
          out.blockers.push(`${agent}: required hook missing: ${hook}`);
        }
      }
    } catch (error) {
      out.results.push({ agent_name: agent, healed: false, error: error.message });
      out.blockers.push(`${agent}: ${error.message}`);
    }
  }

  if (SOURCE_CHECK_ENABLED || args.has("--sources")) {
    try {
      out.source_coverage = await checkSourceCoverage();
      for (const gap of out.source_coverage.gaps || []) {
        out.blockers.push(`source coverage gap: ${gap.writer} ${gap.status}${gap.age_min != null ? " age=" + gap.age_min + "min" : ""}`);
      }
    } catch (error) {
      out.source_coverage = { ok: false, error: error.message };
      out.blockers.push("source coverage check failed: " + error.message);
    }
  }

  out.queue_after = queueStats();
  out.ok = out.blockers.length === 0;
  out.status = out.blockers.length ? "block" : (out.results.some((row) => row.healed) ? "healed" : "ok");
  out.notification = await notifyIfNeeded(out);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = out.ok ? 0 : 2;
}

main().catch((error) => {
  process.stderr.write("hook watchdog failed: " + error.message + "\n");
  process.exitCode = 2;
});
