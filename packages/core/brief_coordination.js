"use strict";

const { parseMaybeJson, normalizeAgentName } = require("./shared_utils");

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback) {
  try { return JSON.stringify(value == null ? fallback : value); } catch { return JSON.stringify(fallback || {}); }
}

function markStaleAgentsOffline(db, staleSec = 300) {
  const seconds = Math.max(30, Number(staleSec || 300));
  try {
    const info = db.prepare(
      "UPDATE agent_registry SET status='offline' " +
      "WHERE status<>'offline' AND (last_seen_at IS NULL OR (julianday('now') - julianday(last_seen_at)) * 86400 > ?)"
    ).run(seconds);
    return info.changes || 0;
  } catch {
    return 0;
  }
}

function requeueStaleDispatchedBriefs(db, options = {}) {
  const olderThanMinutes = Math.max(1, Math.min(Number(options.older_than_minutes || options.minutes || process.env.MNEMO_BRIEF_REQUEUE_MIN || 30), 1440));
  const agentStaleSec = Math.max(30, Number(options.agent_stale_sec || process.env.MNEMO_AGENT_OFFLINE_SEC || 300));
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 1000));
  const dryRun = !!options.dry_run;
  const staleBefore = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  markStaleAgentsOffline(db, agentStaleSec);
  const rows = db.prepare(
    "SELECT b.id, b.agent_name, b.source_agent, b.channel, b.created_at, b.dispatched_at, " +
    "r.status AS agent_status, r.last_seen_at AS agent_last_seen_at " +
    "FROM agent_brief b " +
    "LEFT JOIN agent_registry r ON lower(r.agent_name)=lower(b.agent_name) " +
    "WHERE b.status='dispatched' AND b.dispatched_at IS NOT NULL AND b.dispatched_at < ? " +
    "AND (r.agent_name IS NULL OR r.status='offline' OR r.last_seen_at IS NULL OR (julianday('now') - julianday(r.last_seen_at)) * 86400 > ?) " +
    "ORDER BY b.dispatched_at ASC LIMIT ?"
  ).all(staleBefore, agentStaleSec, limit);
  if (dryRun || !rows.length) {
    return { ok: true, requeued: 0, candidates: rows, stale_before: staleBefore, older_than_minutes: olderThanMinutes, agent_stale_sec: agentStaleSec, dry_run: dryRun };
  }
  const stamp = nowIso();
  const update = db.prepare("UPDATE agent_brief SET status='pending', dispatched_at=NULL, outcome=COALESCE(outcome, ?) WHERE id=? AND status='dispatched'");
  const react = db.prepare("INSERT INTO agent_brief_reaction (brief_id, agent_name, kind, payload) VALUES (?,?,?,?)");
  let changed = 0;
  const tx = db.transaction((items) => {
    for (const row of items) {
      const reason = {
        auto_requeue: true,
        reason: "dispatched brief stale and target agent offline or not heartbeating",
        previous_status: "dispatched",
        dispatched_at: row.dispatched_at,
        agent_status: row.agent_status || "unregistered",
        agent_last_seen_at: row.agent_last_seen_at || null,
        older_than_minutes: olderThanMinutes,
        agent_stale_sec: agentStaleSec,
        requeued_at: stamp
      };
      const info = update.run("auto-requeued at " + stamp + ": target agent offline/stale", row.id);
      if (info.changes) {
        changed += info.changes;
        react.run(row.id, "mnemo-auto-requeue", "auto_requeue", safeJson(reason, {}));
      }
    }
  });
  tx(rows);
  return { ok: true, requeued: changed, candidates: rows, stale_before: staleBefore, older_than_minutes: olderThanMinutes, agent_stale_sec: agentStaleSec };
}

function agentAgeSec(lastSeenAt) {
  const t = Date.parse(lastSeenAt || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function channelListWithSubscribers(db, options = {}) {
  const activeWindowSec = Math.max(30, Number(options.active_window_sec || process.env.MNEMO_CHANNEL_ACTIVE_SEC || 300));
  const includeSubscribers = options.include_subscribers !== false;
  markStaleAgentsOffline(db, activeWindowSec);
  const rows = db.prepare(
    "SELECT c.name, c.description, c.created_at, " +
    "(SELECT COUNT(*) FROM channel_subscription s WHERE s.channel_name = c.name) AS subscribers " +
    "FROM channel c ORDER BY c.created_at ASC"
  ).all();
  if (!includeSubscribers) return { count: rows.length, channels: rows, active_window_sec: activeWindowSec };
  const subStmt = db.prepare(
    "SELECT s.agent_name, s.subscribed_at, r.display_name, r.host, r.pid, r.status, r.last_seen_at, r.skills_json, r.meta_json, " +
    "(SELECT COUNT(*) FROM agent_brief b WHERE b.channel=s.channel_name AND lower(b.agent_name)=lower(s.agent_name) AND b.status='pending') AS pending_briefs, " +
    "(SELECT COUNT(*) FROM agent_brief b WHERE b.channel=s.channel_name AND lower(b.agent_name)=lower(s.agent_name) AND b.status='dispatched') AS dispatched_briefs " +
    "FROM channel_subscription s " +
    "LEFT JOIN agent_registry r ON lower(r.agent_name)=lower(s.agent_name) " +
    "WHERE s.channel_name=? ORDER BY s.agent_name ASC"
  );
  const channels = rows.map((row) => {
    const details = subStmt.all(row.name).map((sub) => {
      const age = agentAgeSec(sub.last_seen_at);
      const status = sub.status || "unregistered";
      const active = ["online", "busy", "idle"].includes(String(status).toLowerCase()) && age != null && age <= activeWindowSec;
      return {
        agent_name: sub.agent_name,
        display_name: sub.display_name || sub.agent_name,
        subscribed_at: sub.subscribed_at,
        status,
        active,
        last_seen_at: sub.last_seen_at || null,
        last_seen_age_sec: age,
        host: sub.host || null,
        pid: sub.pid || null,
        skills: parseMaybeJson(sub.skills_json, []) || [],
        meta: parseMaybeJson(sub.meta_json, null),
        pending_briefs: sub.pending_briefs || 0,
        dispatched_briefs: sub.dispatched_briefs || 0
      };
    });
    return Object.assign({}, row, {
      active_subscribers: details.filter((sub) => sub.active).length,
      offline_subscribers: details.filter((sub) => !sub.active).length,
      subscribers_detail: details
    });
  });
  return { count: channels.length, channels, active_window_sec: activeWindowSec };
}

function pushCandidate(candidates, id, source) {
  const value = parseInt(id, 10);
  if (Number.isFinite(value) && value > 0) candidates.push({ id: value, source });
}

function collectTaskIdsFromText(text, source, candidates) {
  const patterns = [
    /(?:Autonomy task|Blocked autonomy review)\s*#\s*(\d+)/gi,
    /\bautonomy[_\s-]*task[_\s-]*id["':=\s]+(\d+)/gi,
    /\bblocked[_\s-]*autonomy[_\s-]*task[_\s-]*id["':=\s]+(\d+)/gi,
    /\btask[_\s-]*id["':=\s]+(\d+)/gi
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(String(text || "")))) pushCandidate(candidates, match[1], source);
  }
}

function collectTaskIdsFromMeta(meta, source, candidates) {
  const keys = ["autonomy_task_id", "blocked_autonomy_task_id", "task_id", "source_task_id", "autonomyTaskId", "blockedAutonomyTaskId"];
  for (const key of keys) pushCandidate(candidates, meta && meta[key], source + "." + key);
}

function resolveAutonomyTaskUpdateId(db, inputId) {
  const raw = parseInt(inputId, 10);
  if (!Number.isFinite(raw)) return { id: inputId, error: "invalid id" };
  const direct = db.prepare("SELECT id FROM autonomy_task WHERE id=?").get(raw);
  if (direct) return { id: raw, resolved_from: "autonomy_task.id" };

  const candidates = [];
  let inputKind = "unknown";
  try {
    const brief = db.prepare("SELECT id, content, meta_json FROM agent_brief WHERE id=?").get(raw);
    if (brief) {
      inputKind = "agent_brief";
      const meta = parseMaybeJson(brief.meta_json, {}) || {};
      collectTaskIdsFromMeta(meta, "agent_brief.meta", candidates);
      collectTaskIdsFromText(brief.content, "agent_brief.content", candidates);
    }
  } catch {}
  try {
    const reverseRows = db.prepare(
      "SELECT id FROM autonomy_task WHERE source_id=? " +
      "OR meta_json LIKE ? OR meta_json LIKE ? OR meta_json LIKE ? OR checklist_json LIKE ? OR checklist_json LIKE ? LIMIT 20"
    ).all(
      String(raw),
      '%"brief_id":' + raw + '%',
      '%"agent_brief_id":' + raw + '%',
      '%"source_brief_id":' + raw + '%',
      '%"brief_id":' + raw + '%',
      '%"agent_brief_id":' + raw + '%'
    );
    for (const row of reverseRows) pushCandidate(candidates, row.id, "autonomy_task.reverse_link");
  } catch {}
  try {
    const mem = db.prepare("SELECT id, text, meta_json FROM memory WHERE id=?").get(raw);
    if (mem) {
      if (inputKind === "unknown") inputKind = "memory";
      const meta = parseMaybeJson(mem.meta_json, {}) || {};
      collectTaskIdsFromMeta(meta, "memory.meta", candidates);
      collectTaskIdsFromText(mem.text, "memory.text", candidates);
    }
  } catch {}

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const row = db.prepare("SELECT id FROM autonomy_task WHERE id=?").get(candidate.id);
    if (row) return { id: candidate.id, resolved_from: candidate.source, input_id: raw, input_kind: inputKind, candidates };
  }
  return { id: raw, error: "task not found", input_kind: inputKind, candidates };
}

module.exports = {
  markStaleAgentsOffline,
  requeueStaleDispatchedBriefs,
  channelListWithSubscribers,
  resolveAutonomyTaskUpdateId
};
