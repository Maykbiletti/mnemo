"use strict";

const { parseMaybeJson, normalizeAgentName } = require("./shared_utils");

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function isoAgo(minutes) {
  return new Date(Date.now() - Math.max(1, minutes || 1440) * 60000).toISOString();
}

function ageMinutes(iso) {
  const t = iso ? Date.parse(iso) : 0;
  if (!t) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

function pushLatest(map, agent, target, row) {
  if (!agent) return;
  if (!map.has(agent)) map.set(agent, new Map());
  const current = map.get(agent).get(target);
  if (!current || String(row.started_at || "") > String(current.started_at || "")) {
    map.get(agent).set(target, row);
  }
}

const LEGACY_RUNTIME_SOURCE = "cl" + "aude-code";
const LEGACY_RUNTIME_PREFIX = "cl" + "aude";

function captureAt(captures, currentKind, legacyKind) {
  const row = captures[currentKind] || (legacyKind ? captures[legacyKind] : null);
  return row && row.occurred_at || null;
}

function rowPayload(row) {
  return parseMaybeJson(row && row.payload_json, {}) || {};
}

function memoryHealth(db, a = {}) {
  const staleMinutes = Math.max(5, Number(a.stale_minutes || 1440));
  const since = a.since || isoAgo(Math.max(staleMinutes, Number(a.window_minutes || 1440)));
  const requestedAgent = normalizeAgentName(a.agent_name || "");
  const actionRows = safeAll(db, `
    SELECT id, agent_name, target, status, payload_json, meta_json, started_at, session_id
    FROM agent_action
    WHERE action_kind='mnemo_runtime_hook' AND started_at >= ?
    ORDER BY started_at DESC
    LIMIT ?
  `, [since, Math.min(Number(a.limit || 2000), 5000)]);
  const registryRows = safeAll(db, "SELECT agent_name, status, last_seen_at FROM agent_registry ORDER BY agent_name");
  const captureRows = safeAll(db, `
    SELECT source, event_kind, actor, status, occurred_at, meta_json
    FROM capture_receipt
    WHERE source IN ('agent-runtime', ?) AND occurred_at >= ?
    ORDER BY occurred_at DESC
    LIMIT 2000
  `, [LEGACY_RUNTIME_SOURCE, since]);

  const agents = new Set(registryRows.map((row) => normalizeAgentName(row.agent_name)).filter(Boolean));
  const latestByAgent = new Map();
  const failuresByAgent = new Map();
  const capturesByAgent = new Map();

  for (const row of actionRows) {
    const agent = normalizeAgentName(row.agent_name);
    if (!agent) continue;
    agents.add(agent);
    pushLatest(latestByAgent, agent, row.target || "unknown", row);
    if (String(row.status || "").toLowerCase() !== "ok") {
      failuresByAgent.set(agent, (failuresByAgent.get(agent) || 0) + 1);
    }
  }

  for (const row of captureRows) {
    const meta = parseMaybeJson(row.meta_json, {}) || {};
    const agent = normalizeAgentName(meta.agent_name || row.actor);
    if (!agent) continue;
    agents.add(agent);
    if (!capturesByAgent.has(agent)) capturesByAgent.set(agent, {});
    const bucket = capturesByAgent.get(agent);
    const key = row.event_kind || "capture";
    if (!bucket[key] || String(row.occurred_at || "") > String(bucket[key].occurred_at || "")) {
      bucket[key] = row;
    }
  }

  const agentRows = Array.from(agents)
    .filter((agent) => !requestedAgent || agent === requestedAgent)
    .sort()
    .map((agent) => {
      const byTarget = latestByAgent.get(agent) || new Map();
      const latestActions = {};
      for (const [target, row] of byTarget.entries()) {
        const payload = rowPayload(row);
        latestActions[target] = {
          at: row.started_at,
          age_min: ageMinutes(row.started_at),
          status: row.status,
          session_id: row.session_id || null,
          transcript_sync_ok: payload.transcript_sync_ok,
          transcript_count: payload.transcript_count,
          prior_recall_ok: payload.prior_recall_ok,
          prior_count: payload.prior_count,
          prompt_capture_ok: payload.prompt_capture_ok,
          blockers: payload.blockers || [],
          warnings: payload.warnings || []
        };
      }
      const latest = actionRows.find((row) => normalizeAgentName(row.agent_name) === agent) || null;
      const latestPayload = rowPayload(latest);
      const failures = failuresByAgent.get(agent) || 0;
      const stale = !latest || ageMinutes(latest.started_at) > staleMinutes;
      const latestStatus = latest ? String(latest.status || "").toLowerCase() : "missing";
      const health = !latest ? "unknown" : (latestStatus !== "ok" ? "error" : (stale ? "stale" : (failures ? "degraded" : "ok")));
      const captures = capturesByAgent.get(agent) || {};
      return {
        agent_name: agent,
        health,
        last_hook_at: latest && latest.started_at || null,
        last_hook_age_min: latest ? ageMinutes(latest.started_at) : null,
        failures_in_window: failures,
        latest_hook: latest ? latest.target : null,
        latest_prior_recall_ok: latestPayload.prior_recall_ok == null ? null : !!latestPayload.prior_recall_ok,
        latest_prior_count: latestPayload.prior_count == null ? null : latestPayload.prior_count,
        latest_transcript_sync_ok: latestPayload.transcript_sync_ok == null ? null : !!latestPayload.transcript_sync_ok,
        latest_transcript_count: latestPayload.transcript_count == null ? null : latestPayload.transcript_count,
        lifecycle: latestActions,
        captures: {
          last_user_prompt_at: captures.user_prompt_submit && captures.user_prompt_submit.occurred_at || null,
          last_transcript_turn_at: captureAt(captures, "runtime_transcript_turn", LEGACY_RUNTIME_PREFIX + "_transcript_turn"),
          last_precompact_at: captureAt(captures, "runtime_precompact_snapshot", LEGACY_RUNTIME_PREFIX + "_precompact_snapshot"),
          last_session_end_at: captureAt(captures, "runtime_session_end_snapshot", LEGACY_RUNTIME_PREFIX + "_session_end_snapshot")
        },
        required_hooks_seen: {
          session_start: !!latestActions.SessionStart,
          user_prompt: !!latestActions.UserPromptSubmit,
          pre_compact: !!latestActions.PreCompact,
          post_tool: !!latestActions.PostToolUse,
          stop: !!latestActions.Stop,
          session_end: !!latestActions.SessionEnd
        }
      };
    });

  const summary = {
    total: agentRows.length,
    ok: agentRows.filter((row) => row.health === "ok").length,
    degraded: agentRows.filter((row) => row.health === "degraded").length,
    stale: agentRows.filter((row) => row.health === "stale").length,
    error: agentRows.filter((row) => row.health === "error").length,
    unknown: agentRows.filter((row) => row.health === "unknown").length,
    failures_in_window: agentRows.reduce((sum, row) => sum + (row.failures_in_window || 0), 0)
  };

  return {
    checked_at: new Date().toISOString(),
    since,
    stale_minutes: staleMinutes,
    summary,
    agents: agentRows
  };
}

module.exports = { memoryHealth };
