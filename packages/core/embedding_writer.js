#!/usr/bin/env node
/**
 * embedding_writer.js — backfill missing embeddings.
 *
 * Pulls memory rows where embedding_id IS NULL, prioritized by importance,
 * computes embeddings, writes to memory_embedding + updates memory.embedding_id.
 *
 * Run as a one-shot CLI (cron) or required as a module.
 *
 * Env:
 *   MNEMO_DB                 default ./mnemo.db
 *   MNEMO_EMBED_BATCH        default 500
 *   MNEMO_EMBED_MAX          default 10000  (per run)
 *   MNEMO_EMBED_MIN_IMPORTANCE  default 5
 */
"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const { embedText, bufFromVector, MODEL_TAG, DIM } = require("./embeddings");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const BATCH = parseInt(process.env.MNEMO_EMBED_BATCH || "500", 10);
const MAX = parseInt(process.env.MNEMO_EMBED_MAX || "10000", 10);
const MIN_IMP = parseInt(process.env.MNEMO_EMBED_MIN_IMPORTANCE || "5", 10);

async function backfillBatch(db) {
  const rows = db.prepare(`
    SELECT id, text FROM memory
    WHERE embedding_id IS NULL
      AND importance >= ?
      AND length(text) >= 12
      AND length(text) <= 8000
    ORDER BY importance DESC, occurred_at DESC
    LIMIT ?
  `).all(MIN_IMP, BATCH);
  if (!rows.length) return { processed: 0, done: true };

  const insertEmb = db.prepare(`
    INSERT INTO memory_embedding (memory_id, model, dim, vector)
    VALUES (?,?,?,?)
  `);
  const updateMem = db.prepare(`UPDATE memory SET embedding_id=? WHERE id=?`);

  const tx = db.transaction(async (rs) => {
    for (const r of rs) {
      const vec = await embedText(r.text);
      const buf = bufFromVector(vec);
      const er = insertEmb.run(r.id, MODEL_TAG, DIM, buf);
      updateMem.run(er.lastInsertRowid, r.id);
    }
  });

  // Compute embeddings outside transaction (async), then write inside.
  const computed = [];
  for (const r of rows) {
    const vec = await embedText(r.text);
    computed.push({ id: r.id, vec });
  }

  const txSync = db.transaction((items) => {
    for (const it of items) {
      const buf = bufFromVector(it.vec);
      const er = insertEmb.run(it.id, MODEL_TAG, DIM, buf);
      updateMem.run(er.lastInsertRowid, it.id);
    }
  });
  txSync(computed);

  return { processed: rows.length, done: rows.length < BATCH };
}

async function recordWriterHealth(db, processed, status) {
  db.prepare(`
    INSERT INTO writer_health (writer, last_write_at, rows_written, status, last_check_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(writer) DO UPDATE SET
      last_write_at = CASE WHEN excluded.rows_written > 0 THEN excluded.last_write_at ELSE writer_health.last_write_at END,
      rows_written = writer_health.rows_written + excluded.rows_written,
      status = excluded.status,
      last_check_at = excluded.last_check_at
  `).run("embedding_writer",
    new Date().toISOString(),
    processed,
    status,
    new Date().toISOString()
  );
}

async function run() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  let total = 0;
  while (total < MAX) {
    const r = await backfillBatch(db);
    total += r.processed;
    if (r.processed > 0) {
      console.log(`[embedding-writer] +${r.processed} (total ${total})`);
    }
    if (r.done) break;
  }
  await recordWriterHealth(db, total, total > 0 ? "alive" : "alive_no_new");
  db.close();
  console.log(`[embedding-writer] finished, ${total} embeddings written`);
}

if (require.main === module) {
  run().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, backfillBatch };
