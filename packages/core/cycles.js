#!/usr/bin/env node
/**
 * cycles.js — phased memory consolidation.
 *
 * Short-term memory accumulates fast: every message, every tool call.
 * Most rows are noise after a day. A small fraction become long-term
 * signals (decisions, preferences, recurring frustrations, identity shifts).
 *
 * Three consolidation cycles, each with a distinct cadence and purpose:
 *
 *   PULSE  — runs hourly. Cheap. Clusters the last hour by topic + actor,
 *            counts mentions, flags high-importance singles. Writes one
 *            `cycle_event` row per pass.
 *
 *   SETTLE — runs nightly (~02:00 local). Reviews the day's PULSE events.
 *            Promotes recurring clusters to importance-bumps on the underlying
 *            memory rows. Surfaces candidate beliefs / correction patterns.
 *
 *   ARC    — runs weekly (Sunday 03:00 local). Long-range reflection.
 *            Aggregates trait drift, surveys open promises and commitments,
 *            refreshes `self_snapshot` for the new week.
 *
 * All cycles write to one `cycle_event` table for explainability — read
 * `exports/CYCLES.md` to see what the system has noticed without having to
 * read the full memory log.
 */
"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const PHASE = (process.argv[2] || "pulse").toLowerCase();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// --------------------------------------------------------------------------
// Schema bootstrap (idempotent)
// --------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS cycle_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phase        TEXT NOT NULL,                    -- pulse | settle | arc
  ran_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  window_from  TEXT NOT NULL,                    -- ISO8601 start of input window
  window_to    TEXT NOT NULL,                    -- ISO8601 end
  inputs_count INTEGER NOT NULL DEFAULT 0,       -- how many memory rows examined
  promoted_count INTEGER NOT NULL DEFAULT 0,     -- rows that drove a downstream change
  summary      TEXT,                             -- prose summary of what changed
  delta_json   TEXT                              -- JSON: details of what was created/updated
);
CREATE INDEX IF NOT EXISTS idx_cycle_phase ON cycle_event(phase);
CREATE INDEX IF NOT EXISTS idx_cycle_ran   ON cycle_event(ran_at);
`);

const insertCycle = db.prepare(`
  INSERT INTO cycle_event (phase, window_from, window_to, inputs_count, promoted_count, summary, delta_json)
  VALUES (?,?,?,?,?,?,?)
`);

// --------------------------------------------------------------------------
// PULSE — hourly cluster pass
// --------------------------------------------------------------------------
function runPulse() {
  const to = new Date();
  const from = new Date(to.getTime() - 3600e3);
  const rows = db.prepare(`
    SELECT id, kind, actor, topic, importance, text
    FROM memory
    WHERE occurred_at BETWEEN ? AND ?
  `).all(from.toISOString(), to.toISOString());

  if (rows.length === 0) {
    insertCycle.run("pulse", from.toISOString(), to.toISOString(), 0, 0,
      "no rows in window", "{}");
    return { phase: "pulse", inputs: 0, promoted: 0 };
  }

  // Cluster by (actor, topic). Count + max importance per cluster.
  const clusters = new Map();
  let highSingles = [];
  for (const r of rows) {
    const key = `${r.actor || "?"}|${r.topic || "?"}`;
    if (!clusters.has(key)) clusters.set(key, { actor: r.actor, topic: r.topic, count: 0, max_imp: 0, ids: [] });
    const c = clusters.get(key);
    c.count++;
    if (r.importance > c.max_imp) c.max_imp = r.importance;
    if (c.ids.length < 5) c.ids.push(r.id);
    if (r.importance >= 8) highSingles.push({ id: r.id, importance: r.importance, preview: r.text.slice(0, 120) });
  }

  const interestingClusters = Array.from(clusters.values())
    .filter(c => c.count >= 5 || c.max_imp >= 7)
    .sort((a, b) => (b.max_imp - a.max_imp) || (b.count - a.count));

  const summary = `pulse pass on ${rows.length} rows: ${interestingClusters.length} interesting clusters, ${highSingles.length} high-importance singles`;
  const delta = { clusters: interestingClusters.slice(0, 20), high_singles: highSingles.slice(0, 20) };
  insertCycle.run("pulse", from.toISOString(), to.toISOString(), rows.length, interestingClusters.length, summary, JSON.stringify(delta));
  return { phase: "pulse", inputs: rows.length, promoted: interestingClusters.length };
}

// --------------------------------------------------------------------------
// SETTLE — nightly synthesis pass
// --------------------------------------------------------------------------
function runSettle() {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3600e3);
  // Read PULSE events from the past 24h to build on existing analysis
  const lightEvents = db.prepare(
    "SELECT delta_json FROM cycle_event WHERE phase='pulse' AND ran_at BETWEEN ? AND ?"
  ).all(from.toISOString(), to.toISOString());

  // Aggregate cluster-keys across all pulse events
  const clusterTally = new Map();
  let totalInputs = 0;
  for (const e of lightEvents) {
    let d; try { d = JSON.parse(e.delta_json || "{}"); } catch { continue; }
    for (const c of d.clusters || []) {
      const key = `${c.actor || "?"}|${c.topic || "?"}`;
      if (!clusterTally.has(key)) clusterTally.set(key, { actor: c.actor, topic: c.topic, total: 0, max_imp: 0 });
      const t = clusterTally.get(key);
      t.total += c.count;
      if (c.max_imp > t.max_imp) t.max_imp = c.max_imp;
    }
    totalInputs += (d.clusters || []).length;
  }

  // Promote: clusters that recurred (>=15 mentions in 24h with max_imp>=6)
  const promoted = [];
  for (const c of clusterTally.values()) {
    if (c.total >= 15 && c.max_imp >= 6) {
      promoted.push(c);
    }
  }

  // Importance-bump on actual memory rows for promoted clusters (capped +1, max 9)
  const bumpStmt = db.prepare(
    "UPDATE memory SET importance = MIN(9, importance + 1) WHERE actor=? AND topic=? AND occurred_at BETWEEN ? AND ? AND importance < 9"
  );
  let totalBumped = 0;
  for (const p of promoted) {
    if (!p.actor || !p.topic) continue;
    const r = bumpStmt.run(p.actor, p.topic, from.toISOString(), to.toISOString());
    totalBumped += r.changes;
  }

  const summary = `settle pass on ${lightEvents.length} pulse events: ${promoted.length} clusters promoted, ${totalBumped} memory rows importance-bumped`;
  insertCycle.run("settle", from.toISOString(), to.toISOString(), totalInputs, promoted.length, summary,
    JSON.stringify({ promoted_clusters: promoted, rows_bumped: totalBumped }));
  return { phase: "settle", inputs: totalInputs, promoted: promoted.length, bumped: totalBumped };
}

// --------------------------------------------------------------------------
// ARC — weekly long-range reflection
// --------------------------------------------------------------------------
function runArc() {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600e3);

  // Look at trait drift over the week
  const traitEvents = db.prepare(
    "SELECT trait_id, SUM(delta) total_delta, COUNT(*) cnt FROM trait_event WHERE occurred_at BETWEEN ? AND ? GROUP BY trait_id"
  ).all(from.toISOString(), to.toISOString());

  const traitNames = new Map(db.prepare("SELECT id, name FROM personality_trait").all().map(r => [r.id, r.name]));

  const drift = traitEvents
    .filter(e => Math.abs(e.total_delta) >= 0.05)
    .map(e => ({
      trait: traitNames.get(e.trait_id) || `id:${e.trait_id}`,
      delta: Math.round(e.total_delta * 1000) / 1000,
      events: e.cnt
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Open commitments still hanging
  let openCommitments = 0;
  try {
    openCommitments = db.prepare("SELECT COUNT(*) c FROM commitment WHERE status='open'").get().c;
  } catch { /* commitment table may not exist yet */ }
  let openPromises = 0;
  try {
    openPromises = db.prepare("SELECT COUNT(*) c FROM promise WHERE status='open'").get().c;
  } catch {}

  // Refresh self_snapshot for the new week
  try {
    const today = to.toISOString().slice(0, 10);
    const traits = db.prepare("SELECT name, weight FROM personality_trait").all();
    const values = db.prepare("SELECT name, statement FROM core_value WHERE is_active=1").all();
    const beliefs = db.prepare("SELECT statement, confidence FROM belief WHERE status='active' ORDER BY confidence DESC LIMIT 50").all();
    db.prepare(
      "INSERT OR REPLACE INTO self_snapshot (snapshot_date, traits_json, values_json, beliefs_json) VALUES (?,?,?,?)"
    ).run(today, JSON.stringify(traits), JSON.stringify(values), JSON.stringify(beliefs));
  } catch (e) { /* schema may differ */ }

  const summary = `weekly reflection: ${drift.length} traits drifted ≥0.05, ${openPromises} open promises, ${openCommitments} open commitments`;
  insertCycle.run("arc", from.toISOString(), to.toISOString(), traitEvents.length, drift.length, summary,
    JSON.stringify({ trait_drift: drift, open_promises: openPromises, open_commitments: openCommitments }));
  return { phase: "arc", inputs: traitEvents.length, drift_count: drift.length };
}

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------
function main() {
  let result;
  switch (PHASE) {
    case "pulse": result = runPulse(); break;
    case "settle":  result = runSettle();  break;
    case "arc":   result = runArc();   break;
    case "all":   result = { pulse: runPulse(), settle: runSettle(), arc: runArc() }; break;
    default:
      console.error(`unknown phase '${PHASE}'. use one of: pulse | settle | arc | all`);
      process.exit(2);
  }
  console.log("[cycles]", JSON.stringify(result));
}

if (require.main === module) main();
db.close();

module.exports = { runPulse, runSettle, runArc };
