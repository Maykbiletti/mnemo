"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  assessWriterHealth,
  enrichWriterHealth,
  writerStatusClass,
} = require("./writer_health");

const nowMs = Date.parse("2026-05-26T03:40:00.000Z");

assert.strictEqual(writerStatusClass("alive"), "healthy");
assert.strictEqual(writerStatusClass("alive_no_new"), "healthy");
assert.strictEqual(writerStatusClass("disabled_by_env"), "disabled");
assert.strictEqual(writerStatusClass("error: database is locked"), "error");
assert.strictEqual(writerStatusClass("partial:1_failed"), "degraded");

{
  const health = assessWriterHealth({
    writer: "capture:codexlink",
    status: "alive",
    last_write_at: "2026-05-26T03:30:00.000Z",
    last_check_at: "2026-05-26T03:39:00.000Z",
  }, { nowMs, requiredFreshWriters: ["capture:codexlink"] });
  assert.strictEqual(health.healthy, true);
  assert.strictEqual(health.freshness_required, true);
  assert.strictEqual(health.next_status, "alive");
}

{
  const health = assessWriterHealth({
    writer: "capture:codexlink",
    status: "alive",
    last_write_at: "2026-05-26T00:00:00.000Z",
    last_check_at: "2026-05-26T03:39:00.000Z",
  }, { nowMs, requiredFreshWriters: ["capture:codexlink"], staleMs: 30 * 60 * 1000 });
  assert.strictEqual(health.healthy, false);
  assert.strictEqual(health.drift, true);
  assert.strictEqual(health.next_status, "stale");
}

{
  const health = assessWriterHealth({
    writer: "capture:brief",
    status: "dead",
    last_write_at: "2026-05-16T00:00:00.000Z",
    last_check_at: "2026-05-26T03:39:00.000Z",
  }, { nowMs, requiredFreshWriters: ["capture:codexlink"] });
  assert.strictEqual(health.healthy, true);
  assert.strictEqual(health.drift, false);
  assert.strictEqual(health.next_status, "idle");
}

{
  const health = assessWriterHealth({
    writer: "telegram_poller",
    status: "disabled_by_env",
    last_write_at: null,
    last_check_at: "2026-05-26T03:39:00.000Z",
  }, { nowMs, requiredFreshWriters: ["capture:codexlink"] });
  assert.strictEqual(health.healthy, true);
  assert.strictEqual(health.status_class, "disabled");
  assert.strictEqual(health.next_status, "disabled_by_env");
}

{
  const health = enrichWriterHealth({
    writer: "capture:codexlink",
    status: "error: database is locked",
    last_write_at: "2026-05-26T03:39:00.000Z",
  }, { nowMs });
  assert.strictEqual(health.healthy, false);
  assert.strictEqual(health.drift, true);
  assert.strictEqual(health.drift_severity, "H");
}

{
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE writer_health (
      writer TEXT PRIMARY KEY,
      last_write_at TEXT,
      last_check_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      rows_written INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unknown',
      notes TEXT
    )
  `);
  const upsert = db.prepare(`
    INSERT INTO writer_health (writer, last_write_at, rows_written, status, last_check_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(writer) DO UPDATE SET
      last_write_at=COALESCE(excluded.last_write_at, writer_health.last_write_at),
      rows_written=writer_health.rows_written + excluded.rows_written,
      status=excluded.status,
      last_check_at=excluded.last_check_at
  `);
  upsert.run("capture:codexlink", "2026-05-26T03:30:00.000Z", 1, "alive", "2026-05-26T03:30:00.000Z");
  upsert.run("capture:codexlink", null, 0, "alive_no_new", "2026-05-26T03:40:00.000Z");
  const row = db.prepare("SELECT * FROM writer_health WHERE writer=?").get("capture:codexlink");
  assert.strictEqual(row.last_write_at, "2026-05-26T03:30:00.000Z");
  assert.strictEqual(row.status, "alive_no_new");
  assert.strictEqual(row.rows_written, 1);
}

console.log("test_writer_health ok");
