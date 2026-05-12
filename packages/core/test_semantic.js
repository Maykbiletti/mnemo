"use strict";
const sv = require("sqlite-vec");
const Database = require("better-sqlite3");
const { embedText, bufFromVector } = require("./embeddings");

const DB = process.env.MNEMO_DB || "/root/mnemo/mnemo.db";
const db = new Database(DB);
sv.load(db);

const queries = process.argv.slice(2);
if (!queries.length) queries.push("pricing source of truth", "customer pitch", "owner preference rule");

(async () => {
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
