"use strict";

const { requeueStaleDispatchedBriefs } = require("./brief_coordination");

const LOOP_DOCTOR_TOOL_DEFS = {
  mem_loop_doctor: {
    description: "Diagnose autonomous agent loop health from Mnemo state: heartbeats, engine cooldowns, pending/dispatched briefs, stale actions, autonomy tasks, and recent handoffs.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        stale_minutes: { type: "integer", default: 30 },
        recent_hours: { type: "integer", default: 24 },
        include_recent: { type: "boolean", default: false },
      },
    },
  },
  mem_agent_name_migrate: {
    description: "Consolidate an agent-name variant into a canonical lowercase agent id across Mnemo coordination tables. Defaults to dry-run; pass dry_run:false to update non-conflicting rows.",
    inputSchema: {
      type: "object",
      properties: {
        from_agent: { type: "string" },
        to_agent: { type: "string" },
        dry_run: { type: "boolean", default: true },
      },
      required: ["from_agent", "to_agent"],
    },
  },
  mem_brief_requeue_stale: {
    description: "Dry-run or requeue stale dispatched briefs back to pending for offline or non-heartbeating agents. Use after mem_loop_doctor reports stale_dispatched_brief.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        older_than_minutes: { type: "integer", default: 30 },
        agent_stale_sec: { type: "integer", default: 300 },
        limit: { type: "integer", default: 25 },
        dry_run: { type: "boolean", default: true },
      },
    },
  },
  mem_brief_reconcile_stale: {
    description: "Safely reconcile stale dispatched briefs. Defaults to dry-run. Can close non-executable status/idle/autonomy-pointer briefs and optionally requeue executable briefs.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        older_than_minutes: { type: "integer", default: 60 },
        limit: { type: "integer", default: 50 },
        close_nonexec: { type: "boolean", default: false },
        requeue_exec: { type: "boolean", default: false },
        dry_run: { type: "boolean", default: true },
      },
    },
  },
};

function handleLoopDoctorTool(db, name, args) {
  if (!LOOP_DOCTOR_TOOL_DEFS[name]) return { handled: false };
  if (name === "mem_loop_doctor") return { handled: true, result: loopDoctor(db, args || {}) };
  if (name === "mem_agent_name_migrate") return { handled: true, result: agentNameMigrate(db, args || {}) };
  if (name === "mem_brief_requeue_stale") return { handled: true, result: requeueStaleDispatchedBriefs(db, args || {}) };
  if (name === "mem_brief_reconcile_stale") return { handled: true, result: briefReconcileStale(db, args || {}) };
  return { handled: false };
}

function loopDoctor(db, args) {
  const agentFilter = normalizeAgentId(clean(args.agent_name, 80));
  const staleMinutes = clampInt(args.stale_minutes, 30, 5, 24 * 60);
  const recentHours = clampInt(args.recent_hours, 24, 1, 24 * 14);
  const includeRecent = !!args.include_recent;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - staleMinutes * 60 * 1000).toISOString();
  const recentIso = new Date(now.getTime() - recentHours * 60 * 60 * 1000).toISOString();
  const agents = agentNames(db, agentFilter);

  const rows = agents.map((agentName) => agentSnapshot(db, agentName, { now, nowIso, staleIso, recentIso, staleMinutes, includeRecent }));
  const globals = globalSnapshot(db, { agentFilter, staleIso, recentIso });
  const summary = summarize(rows, globals);

  return {
    now: nowIso,
    stale_minutes: staleMinutes,
    recent_hours: recentHours,
    agent_filter: agentFilter || null,
    summary,
    agents: rows,
    global: globals,
    next_step: summary.status === "ok"
      ? "Loops look healthy from Mnemo state. Keep watching pending briefs, open findings, and reviewer queues."
      : (summary.status === "blocked"
        ? "Fix current engine/auth/heartbeat blockers first, then re-run mem_loop_doctor before assuming the team is working."
        : "Current loops are not hard-blocked. Clean stale queues, case splits, and old actions as maintenance while active work continues."),
  };
}

function agentSnapshot(db, agentName, ctx) {
  const registry = tableExists(db, "agent_registry")
    ? safeGet(db, "SELECT agent_name, display_name, host, pid, status, last_seen_at, meta_json FROM agent_registry WHERE agent_name=?", [agentName])
    : null;
  const live = tableExists(db, "agent_status_live")
    ? safeGet(db, "SELECT agent_name, current_task, current_brief_id, blocked_on, dnd_until, host, pid, last_heartbeat_at, meta_json FROM agent_status_live WHERE agent_name=?", [agentName])
    : null;
  const queue = briefQueue(db, agentName);
  const actions = actionHealth(db, agentName, ctx);
  const autonomy = autonomyHealth(db, agentName);
  const handoff = lastHandoff(db, agentName);
  const registryMeta = parseJson(registry && registry.meta_json);
  const liveMeta = parseJson(live && live.meta_json);
  const currentEngine = String((registryMeta && registryMeta.engine) || (liveMeta && liveMeta.engine) || "").toLowerCase();
  const engineBlocked = !!((registryMeta && registryMeta.engine_blocked) || (liveMeta && liveMeta.engine_blocked));
  const heartbeat = freshestTimestamp([
    { at: live && live.last_heartbeat_at, source: "agent_status_live" },
    { at: registry && registry.last_seen_at, source: "agent_registry" },
  ]);
  const heartbeatAt = heartbeat.at || "";
  const heartbeatAge = ageMinutes(heartbeatAt, ctx.now);
  const problems = [];
  const nextActions = [];

  if (!registry && !live) {
    problems.push("agent_not_registered");
    nextActions.push("Start the agent loop or call mem_connect_register/mem_agent_status_set from its runtime.");
  }
  if (heartbeatAge !== null && heartbeatAge > ctx.staleMinutes) {
    problems.push("stale_heartbeat");
    nextActions.push(`Restart or inspect the loop; last heartbeat is ${heartbeatAge} minutes old.`);
  }
  if (engineBlocked) {
    problems.push("engine_blocked");
    nextActions.push("Fix CLI authentication or engine availability; loop is intentionally cooling down.");
  }
  if (live && live.blocked_on) {
    problems.push("blocked_on");
    nextActions.push(`Resolve blocker: ${redact(live.blocked_on, 180)}`);
  }
  if (queue.dispatched > 0 && queue.oldest_dispatched_minutes !== null && queue.oldest_dispatched_minutes > ctx.staleMinutes) {
    problems.push("stale_dispatched_brief");
    nextActions.push("A dispatched brief is stale; requeue, complete, or investigate the worker run.");
  }
  if (queue.pending > 0 && queue.oldest_pending_minutes !== null && queue.oldest_pending_minutes > ctx.staleMinutes) {
    problems.push("pending_brief_waiting");
    nextActions.push("Pending briefs are waiting; confirm the loop polls the right hub and agent name.");
  }
  if (actions.stale_started > 0) {
    problems.push("stale_started_action");
    nextActions.push("Close or investigate started actions older than the stale threshold.");
  }
  const authFailuresStillBlock = actions.auth_failed_recent > 0
    && !actions.auth_failures_superseded_by_active_work
    && !(currentEngine && currentEngine !== "agent" && !engineBlocked);
  if (authFailuresStillBlock) {
    problems.push("recent_auth_failures");
    nextActions.push("Fix CLI auth before expecting autonomous execution.");
  }
  if (actions.failed_recent > 0) {
    problems.push("recent_failures");
    nextActions.push("Read recent failed actions and create/clear quality findings or blockers.");
  }
  if (autonomy.claimed > 0 && actions.active_loop_work === 0 && queue.dispatched === 0) {
    problems.push("claimed_autonomy_without_active_work");
    nextActions.push("Claimed autonomy tasks need review, requeue, or a fresh loop execution.");
  }

  const status = problems.some((p) => ["engine_blocked", "stale_heartbeat", "recent_auth_failures"].includes(p))
    ? "blocked"
    : (problems.length ? "attention" : "ok");

  return {
    agent_name: agentName,
    status,
    problems,
    next_actions: unique(nextActions),
    heartbeat: {
      last_at: heartbeatAt || null,
      age_minutes: heartbeatAge,
      source: heartbeat.source,
    },
    registry: registry ? redactRow(Object.assign({}, registry, { meta_json: registryMeta || registry.meta_json })) : null,
    live_status: live ? redactRow(Object.assign({}, live, { meta_json: liveMeta || live.meta_json })) : null,
    queue,
    actions,
    autonomy,
    last_handoff: handoff,
  };
}

function agentNames(db, agentFilter) {
  if (agentFilter) return [agentFilter];
  const names = new Set();
  addNames(db, names, "agent_registry", "SELECT agent_name FROM agent_registry WHERE agent_name IS NOT NULL");
  addNames(db, names, "agent_status_live", "SELECT agent_name FROM agent_status_live WHERE agent_name IS NOT NULL");
  addNames(db, names, "agent_brief", "SELECT agent_name FROM agent_brief WHERE agent_name IS NOT NULL");
  addNames(db, names, "agent_action", "SELECT agent_name FROM agent_action WHERE agent_name IS NOT NULL");
  addNames(db, names, "session_handoff", "SELECT agent_name FROM session_handoff WHERE agent_name IS NOT NULL");
  addNames(db, names, "autonomy_task", "SELECT assigned_agent AS agent_name FROM autonomy_task WHERE assigned_agent IS NOT NULL");
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function addNames(db, names, table, sql) {
  if (!tableExists(db, table)) return;
  for (const row of safeAll(db, sql, [])) {
    const name = clean(row.agent_name, 80);
    if (name) names.add(name);
  }
}

function briefQueue(db, agentName) {
  if (!tableExists(db, "agent_brief")) return emptyQueue();
  const counts = safeAll(db, "SELECT status, COUNT(*) AS c, MIN(created_at) AS oldest FROM agent_brief WHERE agent_name=? GROUP BY status", [agentName]);
  const out = emptyQueue();
  for (const row of counts) {
    const status = row.status || "unknown";
    out.by_status[status] = row.c || 0;
    if (status === "pending") {
      out.pending = row.c || 0;
      out.oldest_pending_at = row.oldest || null;
      out.oldest_pending_minutes = ageMinutes(row.oldest, new Date());
    }
    if (status === "dispatched") {
      out.dispatched = row.c || 0;
      out.oldest_dispatched_at = row.oldest || null;
      out.oldest_dispatched_minutes = ageMinutes(row.oldest, new Date());
    }
  }
  out.latest = safeAll(db, "SELECT id, source_agent, status, created_at, dispatched_at, substr(content,1,180) AS preview FROM agent_brief WHERE agent_name=? AND status IN ('pending','dispatched') ORDER BY created_at ASC LIMIT 5", [agentName]).map(redactRow);
  return out;
}

function emptyQueue() {
  return {
    pending: 0,
    dispatched: 0,
    oldest_pending_at: null,
    oldest_pending_minutes: null,
    oldest_dispatched_at: null,
    oldest_dispatched_minutes: null,
    by_status: {},
    latest: [],
  };
}

function actionHealth(db, agentName, ctx) {
  if (!tableExists(db, "agent_action")) {
    return { active_loop_work: 0, stale_started: 0, failed_recent: 0, auth_failed_recent: 0, recent: [] };
  }
  const staleStarted = safeGet(db, "SELECT COUNT(*) AS c FROM agent_action WHERE agent_name=? AND status='started' AND started_at < ?", [agentName, ctx.staleIso]);
  const failedRecent = safeGet(db, "SELECT COUNT(*) AS c FROM agent_action WHERE agent_name=? AND started_at >= ? AND lower(status) IN ('failed','error','blocked','guard_blocked')", [agentName, ctx.recentIso]);
  const authRecent = safeGet(db, "SELECT COUNT(*) AS c FROM agent_action WHERE agent_name=? AND started_at >= ? AND (lower(status)='auth_failed' OR result_json LIKE '%auth_failed%' OR payload_json LIKE '%auth_failed%')", [agentName, ctx.recentIso]);
  const activeLoop = safeGet(db, "SELECT COUNT(*) AS c FROM agent_action WHERE agent_name=? AND status='started' AND topic='agent-loop'", [agentName]);
  const latestAuth = safeGet(db, "SELECT MAX(started_at) AS at FROM agent_action WHERE agent_name=? AND started_at >= ? AND (lower(status)='auth_failed' OR result_json LIKE '%auth_failed%' OR payload_json LIKE '%auth_failed%')", [agentName, ctx.recentIso]);
  const latestActiveLoop = safeGet(db, "SELECT MAX(started_at) AS at FROM agent_action WHERE agent_name=? AND status='started' AND topic='agent-loop'", [agentName]);
  const latestAuthMs = latestAuth && latestAuth.at ? Date.parse(latestAuth.at) : NaN;
  const latestActiveMs = latestActiveLoop && latestActiveLoop.at ? Date.parse(latestActiveLoop.at) : NaN;
  const out = {
    active_loop_work: num(activeLoop && activeLoop.c),
    stale_started: num(staleStarted && staleStarted.c),
    failed_recent: num(failedRecent && failedRecent.c),
    auth_failed_recent: num(authRecent && authRecent.c),
    latest_auth_failed_at: latestAuth && latestAuth.at ? latestAuth.at : null,
    latest_active_loop_started_at: latestActiveLoop && latestActiveLoop.at ? latestActiveLoop.at : null,
    auth_failures_superseded_by_active_work: Number.isFinite(latestAuthMs) && Number.isFinite(latestActiveMs) && latestActiveMs > latestAuthMs,
  };
  if (ctx.includeRecent) {
    out.recent = safeAll(db, "SELECT id, action_kind, target, status, topic, started_at, finished_at FROM agent_action WHERE agent_name=? AND started_at >= ? ORDER BY started_at DESC LIMIT 12", [agentName, ctx.recentIso]).map(redactRow);
  }
  return out;
}

function autonomyHealth(db, agentName) {
  const out = { open: 0, claimed: 0, review: 0, blocked: 0, assigned: 0, latest: [] };
  if (!tableExists(db, "autonomy_task")) return out;
  const rows = safeAll(db, "SELECT status, COUNT(*) AS c FROM autonomy_task WHERE assigned_agent=? GROUP BY status", [agentName]);
  for (const row of rows) {
    out[row.status || "unknown"] = row.c || 0;
    out.assigned += row.c || 0;
  }
  out.latest = safeAll(db, "SELECT id, project, department_name, title, severity, status, updated_at FROM autonomy_task WHERE assigned_agent=? ORDER BY updated_at DESC LIMIT 5", [agentName]).map(redactRow);
  return out;
}

function lastHandoff(db, agentName) {
  if (!tableExists(db, "session_handoff")) return null;
  const row = safeGet(db, "SELECT id, project, summary, blockers, next_actions, created_at FROM session_handoff WHERE agent_name=? ORDER BY created_at DESC LIMIT 1", [agentName]);
  return row ? redactRow(row) : null;
}

function globalSnapshot(db, ctx) {
  const out = {};
  out.name_case_collisions = nameCaseCollisions(db);
  if (tableExists(db, "agent_brief")) {
    out.pending_by_agent = safeAll(db, "SELECT agent_name, COUNT(*) AS pending, MIN(created_at) AS oldest_at FROM agent_brief WHERE status='pending' GROUP BY agent_name ORDER BY pending DESC", []).map(redactRow);
    out.stale_dispatched = safeAll(db, "SELECT id, agent_name, source_agent, dispatched_at, substr(content,1,160) AS preview FROM agent_brief WHERE status='dispatched' AND COALESCE(dispatched_at, created_at) < ? ORDER BY COALESCE(dispatched_at, created_at) ASC LIMIT 20", [ctx.staleIso]).map(redactRow);
  }
  if (tableExists(db, "autonomy_task")) {
    out.open_autonomy_by_department = safeAll(db, "SELECT department_name, COUNT(*) AS open FROM autonomy_task WHERE status='open' GROUP BY department_name ORDER BY open DESC", []).map(redactRow);
  }
  if (tableExists(db, "agent_action")) {
    out.recent_auth_failures = safeAll(db, "SELECT id, agent_name, action_kind, target, status, started_at FROM agent_action WHERE started_at >= ? AND (lower(status)='auth_failed' OR result_json LIKE '%auth_failed%' OR payload_json LIKE '%auth_failed%') ORDER BY started_at DESC LIMIT 20", [ctx.recentIso]).map(redactRow);
  }
  return out;
}

function summarize(agents, globals) {
  const summary = {
    status: "ok",
    agents_total: agents.length,
    ok: agents.filter((a) => a.status === "ok").length,
    attention: agents.filter((a) => a.status === "attention").length,
    blocked: agents.filter((a) => a.status === "blocked").length,
    pending_briefs: agents.reduce((sum, a) => sum + a.queue.pending, 0),
    dispatched_briefs: agents.reduce((sum, a) => sum + a.queue.dispatched, 0),
    stale_started_actions: agents.reduce((sum, a) => sum + a.actions.stale_started, 0),
    recent_auth_failures: agents.reduce((sum, a) => sum + a.actions.auth_failed_recent, 0),
    top_problems: {},
  };
  for (const agent of agents) {
    for (const problem of agent.problems) summary.top_problems[problem] = (summary.top_problems[problem] || 0) + 1;
  }
  if (globals.name_case_collisions && globals.name_case_collisions.length) {
    summary.top_problems.agent_name_case_split = globals.name_case_collisions.length;
  }
  if (summary.blocked) summary.status = "blocked";
  else if (summary.attention || summary.pending_briefs || summary.dispatched_briefs || (globals.name_case_collisions && globals.name_case_collisions.length)) summary.status = "attention";
  return summary;
}

function nameCaseCollisions(db) {
  const names = agentNames(db, "");
  const groups = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  return Array.from(groups.entries())
    .filter(([, values]) => values.length > 1)
    .map(([canonical, variants]) => ({
      canonical,
      variants,
      problem: "Multiple case variants split queues, heartbeats, and actions. Pick one canonical agent_name and migrate or supersede the stale queue.",
    }));
}

function agentNameMigrate(db, args) {
  const fromAgent = String(args.from_agent || "").trim();
  const toAgent = normalizeAgentId(args.to_agent);
  const dryRun = args.dry_run !== false;
  if (!fromAgent || !toAgent) return { error: "from_agent and to_agent required" };
  if (fromAgent === toAgent) return { ok: true, dry_run: dryRun, from_agent: fromAgent, to_agent: toAgent, updated: [], conflicts: [], note: "from_agent already equals to_agent" };

  const normalRefs = [
    ["agent_brief", "agent_name"],
    ["agent_brief", "source_agent"],
    ["agent_brief_reaction", "agent_name"],
    ["agent_action", "agent_name"],
    ["session_handoff", "agent_name"],
    ["work_claim", "agent_name"],
    ["agent_proposal", "agent_name"],
    ["autonomy_task", "assigned_agent"],
    ["autonomy_task", "reviewer_agent"],
    ["department_member", "agent_name"],
    ["peer_consult", "source_agent"],
    ["peer_consult", "target_agent"],
    ["meeting_turn", "agent_name"],
    ["problem_attempt", "agent_name"],
    ["escalation", "source_agent"],
  ];
  const uniqueRefs = [
    ["agent_registry", "agent_name"],
    ["agent_status_live", "agent_name"],
    ["agent_mode", "agent_name"],
    ["agent_idle_config", "agent_name"],
    ["agent_focus", "agent_name"],
  ];
  const updated = [];
  const conflicts = [];

  const apply = db.transaction(() => {
    for (const [table, column] of normalRefs) {
      if (!columnExists(db, table, column)) continue;
      const count = countExact(db, table, column, fromAgent);
      updated.push({ table, column, rows: count, mode: "update" });
      if (!dryRun && count > 0) db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(toAgent, fromAgent);
    }
    for (const [table, column] of uniqueRefs) {
      if (!columnExists(db, table, column)) continue;
      const count = countExact(db, table, column, fromAgent);
      const targetExists = countExact(db, table, column, toAgent) > 0;
      if (count > 0 && targetExists) {
        conflicts.push({ table, column, rows: count, target_exists: true, action: "skipped_unique_conflict" });
        continue;
      }
      updated.push({ table, column, rows: count, mode: "unique_update" });
      if (!dryRun && count > 0) db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(toAgent, fromAgent);
    }
  });

  apply();
  return {
    ok: conflicts.length === 0,
    dry_run: dryRun,
    from_agent: fromAgent,
    to_agent: toAgent,
    updated,
    conflicts,
    next_step: dryRun
      ? "Review counts, then re-run with dry_run:false if this is the intended canonical agent id."
      : (conflicts.length ? "Some unique identity rows were skipped because the canonical row already exists. Inspect both rows before deleting old identities." : "Migration applied. Re-run mem_loop_doctor to confirm the case split is gone."),
  };
}

function briefRequeueStale(db, args) {
  const agentName = normalizeAgentId(args.agent_name);
  const olderThanMinutes = clampInt(args.older_than_minutes, 60, 5, 60 * 24 * 30);
  const limit = clampInt(args.limit, 25, 1, 500);
  const dryRun = args.dry_run !== false;
  if (!tableExists(db, "agent_brief")) return { error: "agent_brief table not found" };
  const thresholdIso = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const where = ["status='dispatched'", "COALESCE(dispatched_at, created_at) < ?"];
  const params = [thresholdIso];
  if (agentName) {
    where.push("lower(agent_name)=lower(?)");
    params.push(agentName);
  }
  params.push(limit);
  const rows = safeAll(db, `
SELECT id, agent_name, source_agent, created_at, dispatched_at, substr(content,1,220) AS preview
FROM agent_brief
WHERE ${where.join(" AND ")}
ORDER BY COALESCE(dispatched_at, created_at) ASC
LIMIT ?`, params).map(redactRow);

  let changed = 0;
  if (!dryRun && rows.length) {
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    changed = db.prepare(`UPDATE agent_brief SET status='pending', dispatched_at=NULL WHERE id IN (${placeholders})`).run(...ids).changes || 0;
  }

  return {
    ok: true,
    dry_run: dryRun,
    agent_name: agentName || null,
    older_than_minutes: olderThanMinutes,
    threshold: thresholdIso,
    count: rows.length,
    changed,
    briefs: rows,
    next_step: dryRun
      ? "Review briefs, then re-run with dry_run:false to requeue them."
      : "Requeued stale dispatched briefs. Re-run mem_loop_doctor and confirm the target loop pulls them.",
  };
}

function briefReconcileStale(db, args) {
  const agentName = normalizeAgentId(args.agent_name);
  const olderThanMinutes = clampInt(args.older_than_minutes, 60, 5, 60 * 24 * 30);
  const limit = clampInt(args.limit, 50, 1, 500);
  const closeNonexec = args.close_nonexec === true;
  const requeueExec = args.requeue_exec === true;
  const dryRun = args.dry_run !== false;
  if (!tableExists(db, "agent_brief")) return { error: "agent_brief table not found" };

  const thresholdIso = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const where = ["status='dispatched'", "COALESCE(dispatched_at, created_at) < ?"];
  const params = [thresholdIso];
  if (agentName) {
    where.push("lower(agent_name)=lower(?)");
    params.push(agentName);
  }
  params.push(limit);

  const rows = safeAll(db, `
SELECT id, agent_name, source_agent, channel, status, created_at, dispatched_at, meta_json, content
FROM agent_brief
WHERE ${where.join(" AND ")}
ORDER BY COALESCE(dispatched_at, created_at) ASC
LIMIT ?`, params);

  const classified = rows.map((row) => {
    const classification = classifyBrief(row);
    return redactRow({
      id: row.id,
      agent_name: row.agent_name,
      source_agent: row.source_agent,
      created_at: row.created_at,
      dispatched_at: row.dispatched_at,
      classification,
      preview: row.content || "",
    });
  });
  const nonexecIds = rows.filter((row) => classifyBrief(row) !== "executable").map((row) => row.id);
  const execIds = rows.filter((row) => classifyBrief(row) === "executable").map((row) => row.id);

  let closed_nonexec = 0;
  let requeued_exec = 0;
  if (!dryRun) {
    if (closeNonexec && nonexecIds.length) {
      const placeholders = nonexecIds.map(() => "?").join(",");
      closed_nonexec = db.prepare(
        `UPDATE agent_brief SET status='done', done_at=?, outcome=? WHERE id IN (${placeholders})`
      ).run(new Date().toISOString(), "Stale non-executable brief reconciled automatically by mem_brief_reconcile_stale.", ...nonexecIds).changes || 0;
    }
    if (requeueExec && execIds.length) {
      const placeholders = execIds.map(() => "?").join(",");
      requeued_exec = db.prepare(`UPDATE agent_brief SET status='pending', dispatched_at=NULL WHERE id IN (${placeholders})`).run(...execIds).changes || 0;
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    agent_name: agentName || null,
    older_than_minutes: olderThanMinutes,
    threshold: thresholdIso,
    count: rows.length,
    nonexec_count: nonexecIds.length,
    executable_count: execIds.length,
    closed_nonexec,
    requeued_exec,
    briefs: classified,
    next_step: dryRun
      ? "Review classifications, then run with dry_run:false and close_nonexec:true. Only set requeue_exec:true when the old executable briefs are still valid."
      : "Reconciliation applied. Re-run mem_loop_doctor to verify stale dispatched noise is reduced.",
  };
}

function classifyBrief(row) {
  const meta = parseJson(row && row.meta_json) || {};
  if (meta.no_action || meta.status_only || meta.idle_cycle || meta.autonomy_task_id) return "nonexec_meta";
  if (meta.type && /^(team_status|deploy_status|status|status_update|info)$/i.test(String(meta.type))) return "nonexec_meta";
  if (meta.status && /^(done|ok|complete|completed|deployed|verified|info|status|update|team_update|team-update)$/i.test(String(meta.status))) return "nonexec_meta";

  const text = String((row && row.content) || "").trim();
  if (/^\s*\[IDLE-CYCLE\]/i.test(text)) return "nonexec_idle";
  if (/^\s*(\[(status|team-status|info|fyi|update)\]|status\b|team-status\b|info\s*[:\-]|fyi\s*[:\-]|update\s*[:\-])/i.test(text)) {
    if (!/\b(action required|todo|to do|next action|bitte\s+(fix|change|update|deploy|restart|pruef|check|mach|baue|implement)|please\s+(fix|change|update|deploy|restart|check|implement|build))\b/i.test(text)) {
      return "nonexec_status";
    }
  }
  return "executable";
}

function countExact(db, table, column, value) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column}=?`).get(value);
    return num(row && row.c);
  } catch {
    return 0;
  }
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function normalizeAgentId(value) {
  return String(value || "").trim().toLowerCase();
}

function safeGet(db, sql, params) {
  try { return db.prepare(sql).get(...(params || [])) || null; } catch { return null; }
}

function safeAll(db, sql, params) {
  try { return db.prepare(sql).all(...(params || [])); } catch { return []; }
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name); } catch { return false; }
}

function parseJson(value) {
  if (!value || typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function clean(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "...";
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function ageMinutes(value, now) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round(((now || new Date()).getTime() - ts) / 60000));
}

function freshestTimestamp(items) {
  let best = { at: "", source: null, ts: -Infinity };
  for (const item of items || []) {
    if (!item || !item.at) continue;
    const ts = Date.parse(item.at);
    if (!Number.isFinite(ts)) continue;
    if (ts > best.ts) best = { at: item.at, source: item.source || null, ts };
  }
  return { at: best.at, source: best.source };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function unique(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function redactRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (typeof value === "string") out[key] = redact(value, 260);
    else if (value && typeof value === "object") out[key] = redactObject(value);
    else out[key] = value;
  }
  return out;
}

function redactObject(value) {
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => (typeof item === "string" ? redact(item, 160) : item));
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    out[key] = typeof item === "string" ? redact(item, 200) : item;
  }
  return out;
}

function redact(value, max) {
  let text = String(value || "");
  text = text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]");
  text = text.replace(/\b(sk|pk|rk|ghp|gho|github_pat)_[A-Za-z0-9_=-]{12,}\b/g, "[secret]");
  text = text.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;}]+/gi, "$1=[secret]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "...";
}

module.exports = {
  LOOP_DOCTOR_TOOL_DEFS,
  handleLoopDoctorTool,
  loopDoctor,
  agentNameMigrate,
  briefRequeueStale,
  briefReconcileStale,
};
