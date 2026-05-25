"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const { runtimeTurnBegin } = require("./runtime_turn_gate");

const db = new Database(":memory:");
db.exec(`
CREATE TABLE mnemo_event_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  channel TEXT,
  direction TEXT NOT NULL DEFAULT 'internal',
  actor TEXT,
  actor_id TEXT,
  event_kind TEXT NOT NULL,
  ref_kind TEXT,
  ref_id TEXT,
  thread_id TEXT,
  status TEXT,
  content TEXT,
  payload_json TEXT,
  meta_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

const calls = [];
const result = runtimeTurnBegin(db, {
  runtime_name: "codexlink",
  agent_name: "otto",
  channel: "telegram",
  project: "chat",
  thread_id: "team",
  message: "weiter mit Claude API",
}, {
  capture: () => ({ ok: true, status: "captured", event_id: 1 }),
  recall: () => [],
  briefPull: () => ({ count: 0, briefs: [] }),
  projectBoard: () => ({ ok: true, tasks: [] }),
  workReportFeed: (payload) => {
    calls.push(["workReportFeed", payload]);
    return { ok: true, feed_count: 1, feed: [{ kind: "report", id: 912, summary: "Claude API erledigt" }] };
  },
  timelineReport: (payload) => {
    calls.push(["timelineReport", payload]);
    return { ok: true, status: "ready", next_actions: ["Claude default beibehalten"] };
  },
  eventLog: () => ({ ok: true, id: 2 }),
});

assert.strictEqual(result.ok, true);
assert.strictEqual(result.resume_pack_loaded, true);
assert.strictEqual(result.full_sync.work_report_feed_count, 1);
assert.strictEqual(result.full_sync.project_timeline_loaded, true);
assert(result.context_block.includes("resume_pack: yes"));
assert(calls.some(([name]) => name === "workReportFeed"));
assert(calls.some(([name]) => name === "timelineReport"));

console.log("test_runtime_turn_resume_pack ok");
