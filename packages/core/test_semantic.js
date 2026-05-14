"use strict";
const sv = require("sqlite-vec");
const Database = require("better-sqlite3");
const path = require("path");
const { embedText, bufFromVector } = require("./embeddings");

const DB = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const db = new Database(DB);
sv.load(db);

const queries = process.argv.slice(2);
if (!queries.length) queries.push("pricing source of truth", "customer pitch", "owner preference rule");

(async () => {
  const hasMemory = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory'").get();
  if (!hasMemory) {
    console.log("semantic smoke skipped: no memory table in " + DB);
    db.close();
    return;
  }
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding float[384])");
  const vecRows = db.prepare("SELECT COUNT(*) AS c FROM vec_memory").get().c;
  if (!vecRows) {
    console.log("semantic smoke skipped: no vec_memory rows in " + DB);
    db.close();
    return;
  }
  for (const q of queries) {
    const vec = await embedText(q);
    const buf = bufFromVector(vec);
    const t0 = Date.now();
    const rows = db.prepare(`
      SELECT m.id, m.actor, m.occurred_at, substr(m.text,1,180) preview, v.distance
      FROM vec_memory v
      JOIN memory m ON m.id = v.rowid
      WHERE v.embedding MATCH ? AND k = 8
      ORDER BY v.distance
    `).all(buf);
    console.log("\n=== query:", q, "(latency:", Date.now() - t0, "ms)");
    for (const r of rows) {
      console.log(`  d=${r.distance.toFixed(3)} | ${r.actor || "?"} | ${(r.preview || "").replace(/\s+/g, " ").slice(0, 130)}`);
    }
  }
  db.close();
})();
