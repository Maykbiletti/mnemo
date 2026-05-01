#!/usr/bin/env node
/**
 * cycles_export.js — generate CYCLES.md from cycle_event table.
 *
 * Human-readable trace of what the consolidation cycles have observed
 * and changed. Run after each Arc cycle or via cron.
 */
"use strict";
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const OUT_DIR = process.env.MNEMO_EXPORTS_DIR || path.join(__dirname, "exports");
const LIMIT_PULSE = 10;
const LIMIT_SETTLE = 7;
const LIMIT_ARC = 4;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(DB_PATH, { readonly: true });

function fmt(rows, label, limit) {
  if (!rows.length) return `## ${label}\n\n_(none yet)_\n\n`;
  let md = `## ${label}\n\n`;
  for (const r of rows.slice(0, limit)) {
    md += `### ${r.ran_at}\n`;
    md += `Window: ${r.window_from} → ${r.window_to}\n\n`;
    md += `${r.summary || "_(no summary)_"}\n\n`;
    if (r.delta_json && r.delta_json !== "{}") {
      md += `<details>\n<summary>delta</summary>\n\n\`\`\`json\n${r.delta_json}\n\`\`\`\n</details>\n\n`;
    }
  }
  return md;
}

function main() {
  let md = `# CYCLES.md\n\n`;
  md += `*Generated ${new Date().toISOString()} from cycle_event. Most-recent first.*\n\n`;
  md += `Cycles: **Pulse** runs hourly (clusters the last hour). **Settle** runs nightly (synthesizes the day, importance-bumps recurring topics). **Arc** runs weekly (reflects on trait drift + open loops, refreshes self_snapshot).\n\n`;

  try {
    const arc = db.prepare("SELECT * FROM cycle_event WHERE phase='arc' ORDER BY ran_at DESC").all();
    const settle = db.prepare("SELECT * FROM cycle_event WHERE phase='settle' ORDER BY ran_at DESC").all();
    const pulse = db.prepare("SELECT * FROM cycle_event WHERE phase='pulse' ORDER BY ran_at DESC").all();
    md += fmt(arc, "Arc (weekly)", LIMIT_ARC);
    md += fmt(settle, "Settle (nightly)", LIMIT_SETTLE);
    md += fmt(pulse, "Pulse (hourly, last 10)", LIMIT_PULSE);
  } catch (e) {
    md += `_(cycle_event table not yet populated — run \`node cycles.js pulse\` to start.)_\n`;
  }

  const out = path.join(OUT_DIR, "CYCLES.md");
  fs.writeFileSync(out, md);
  console.log(`[cycles-export] wrote ${md.length} chars → ${out}`);
}

main();
db.close();
