"use strict";

const Database = require("better-sqlite3");
const {
  requeueStaleDispatchedBriefs,
  channelListWithSubscribers,
  resolveAutonomyTaskUpdateId
} = require("./brief_coordination");

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error("FAIL", name, detail || "");
  }
}

function setupDb() {
  const db = new Database(":memory:");
  db.exec(`
CREATE TABLE agent_registry (
  agent_name TEXT PRIMARY KEY,
  display_name TEXT,
  host TEXT,
  pid INTEGER,
  skills_json TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta_json TEXT
);
CREATE TABLE channel (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE channel_subscription (
  channel_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_name, agent_name)
);
CREATE TABLE agent_brief (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  source_agent TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at TEXT,
  done_at TEXT,
  outcome TEXT,
  meta_json TEXT,
  channel TEXT
);
CREATE TABLE agent_brief_reaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE autonomy_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  department_name TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'M',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent TEXT,
  reviewer_agent TEXT,
  source_kind TEXT,
  source_id TEXT,
  checklist_json TEXT,
  notes TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  done_at TEXT
);
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  text TEXT,
  meta_json TEXT
);
`);
  return db;
}

function run() {
  const db = setupDb();
  const old = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();

  db.prepare("INSERT INTO agent_registry (agent_name, status, last_seen_at, skills_json) VALUES (?,?,?,?)").run("offline-agent", "online", old, "[]");
  db.prepare("INSERT INTO agent_registry (agent_name, status, last_seen_at, skills_json) VALUES (?,?,?,?)").run("active-agent", "online", fresh, JSON.stringify(["ops"]));
  db.prepare("INSERT INTO agent_brief (id, agent_name, content, status, dispatched_at, channel) VALUES (?,?,?,?,?,?)").run(800, "offline-agent", "stale dispatched", "dispatched", old, "ops");
  db.prepare("INSERT INTO agent_brief (id, agent_name, content, status, dispatched_at, channel) VALUES (?,?,?,?,?,?)").run(801, "active-agent", "active dispatched", "dispatched", old, "ops");

  const requeue = requeueStaleDispatchedBriefs(db, { older_than_minutes: 30, agent_stale_sec: 300 });
  assert("requeued stale offline brief", requeue.requeued === 1, requeue);
  assert("stale brief returned to pending", db.prepare("SELECT status FROM agent_brief WHERE id=800").get().status === "pending");
  assert("active agent brief stayed dispatched", db.prepare("SELECT status FROM agent_brief WHERE id=801").get().status === "dispatched");
  assert("auto requeue reaction written", db.prepare("SELECT COUNT(*) c FROM agent_brief_reaction WHERE brief_id=800 AND kind='auto_requeue'").get().c === 1);

  db.prepare("INSERT INTO channel (name, description) VALUES (?,?)").run("ops", "Operations");
  db.prepare("INSERT INTO channel_subscription (channel_name, agent_name) VALUES (?,?)").run("ops", "active-agent");
  db.prepare("INSERT INTO channel_subscription (channel_name, agent_name) VALUES (?,?)").run("ops", "offline-agent");
  const channels = channelListWithSubscribers(db, { active_window_sec: 300 });
  const ops = channels.channels.find((row) => row.name === "ops");
  assert("channel includes active subscriber count", ops && ops.active_subscribers === 1, ops);
  assert("channel includes offline subscriber count", ops && ops.offline_subscribers === 1, ops);
  assert("channel details expose heartbeat status", ops && ops.subscribers_detail.some((row) => row.agent_name === "active-agent" && row.active));

  db.prepare("INSERT INTO autonomy_task (project, department_name, title, category, source_kind, source_id) VALUES (?,?,?,?,?,?)").run("p", "backend", "from source", "coordination", "agent_brief", "900");
  const sourceTaskId = db.prepare("SELECT id FROM autonomy_task WHERE source_id='900'").get().id;
  db.prepare("INSERT INTO agent_brief (id, agent_name, content, meta_json) VALUES (?,?,?,?)").run(900, "agent", "source linked brief", null);
  assert("resolves brief id via autonomy_task.source_id", resolveAutonomyTaskUpdateId(db, 900).id === sourceTaskId);

  db.prepare("INSERT INTO autonomy_task (project, department_name, title, category) VALUES (?,?,?,?)").run("p", "backend", "from meta", "coordination");
  const metaTaskId = db.prepare("SELECT id FROM autonomy_task WHERE title='from meta'").get().id;
  db.prepare("INSERT INTO agent_brief (id, agent_name, content, meta_json) VALUES (?,?,?,?)").run(901, "agent", "meta linked brief", JSON.stringify({ autonomy_task_id: metaTaskId }));
  assert("resolves brief id via brief meta autonomy_task_id", resolveAutonomyTaskUpdateId(db, 901).id === metaTaskId);

  db.prepare("INSERT INTO autonomy_task (project, department_name, title, category) VALUES (?,?,?,?)").run("p", "backend", "from content", "coordination");
  const contentTaskId = db.prepare("SELECT id FROM autonomy_task WHERE title='from content'").get().id;
  db.prepare("INSERT INTO agent_brief (id, agent_name, content, meta_json) VALUES (?,?,?,?)").run(902, "agent", "# Autonomy task #" + contentTaskId, null);
  assert("resolves brief id via brief content", resolveAutonomyTaskUpdateId(db, 902).id === contentTaskId);

  db.close();
}

run();
console.log(`${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed) process.exit(1);
