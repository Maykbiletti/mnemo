#!/usr/bin/env node
"use strict";
/**
 * trajectory_export.js — export agent decision paths as JSONL for inspection
 * or downstream training/eval.
 *
 * Reads memory entries between two timestamps for a tenant, optionally
 * filtered by actor + kinds, and writes one JSON object per line to a file
 * or stdout. Includes only public-safe fields (no API keys / secrets).
 *
 * Usage:
 *   node trajectory_export.js --tenant dieter --since 2026-05-01 --until 2026-05-04 --out trajectory.jsonl
 *   node trajectory_export.js --tenant shared --kinds message,decision --out -
 */

const fs = require("fs");
const http = require("http");

const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }

function fetchAll(tenant, since, until, kinds, actor) {
  return new Promise((resolve, reject) => {
    // /recall isn't time-bounded, so paginate by recalling broad terms
    const u = new URL(MNEMO_URL + "/recall?q=a&limit=500");
    const req = http.request({
      method: "GET", hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      headers: tenant ? { "X-Tenant-Id": tenant } : {}, timeout: 10000,
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const arr = JSON.parse(d);
          const filtered = arr.filter(m => {
            if (since && m.occurred_at < since) return false;
            if (until && m.occurred_at > until) return false;
            if (kinds && kinds.length && !kinds.includes(m.kind)) return false;
            if (actor && m.actor !== actor) return false;
            return true;
          });
          resolve(filtered);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}

async function main() {
  const tenant = arg("tenant", "shared");
  const since = arg("since", null);
  const until = arg("until", null);
  const kinds = arg("kinds", null) ? arg("kinds", "").split(",") : null;
  const actor = arg("actor", null);
  const out = arg("out", "-");

  const items = await fetchAll(tenant, since, until, kinds, actor);
  const stream = out === "-" ? process.stdout : fs.createWriteStream(out);
  let count = 0;
  for (const m of items.sort((a, b) => (a.occurred_at || "").localeCompare(b.occurred_at || ""))) {
    stream.write(JSON.stringify({
      id: m.id, kind: m.kind, actor: m.actor, occurred_at: m.occurred_at,
      importance: m.importance, text: m.preview || m.text || "", tenant,
    }) + "\n");
    count++;
  }
  if (out !== "-") { stream.end(); console.error("[trajectory] wrote " + count + " entries → " + out); }
  else console.error("[trajectory] wrote " + count + " entries to stdout");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
