#!/usr/bin/env node
/**
 * export_declarative.js — emit AGENTS.md / SOUL.md / TOOLS.md from DB state.
 *
 * Run nightly via cron. Output lands in $MNEMO_EXPORTS_DIR (default ./exports).
 * These files become the declarative grounding for any agent that loads Mnemo.
 *
 * Env:
 *   MNEMO_DB             default ./mnemo.db
 *   MNEMO_EXPORTS_DIR    default ./exports
 *   MNEMO_MCP_PATH       default ./mcp.js (used to introspect tools)
 *   MNEMO_AGENT_NAME     default agent
 */
"use strict";

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.MNEMO_DB || path.join(__dirname, "mnemo.db");
const OUT_DIR = process.env.MNEMO_EXPORTS_DIR || path.join(__dirname, "exports");
const MCP_PATH = process.env.MNEMO_MCP_PATH || path.join(__dirname, "mcp.js");
const AGENT_NAME = process.env.MNEMO_AGENT_NAME || "agent";

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(DB_PATH, { readonly: true });

function exportSoul() {
  const values = db.prepare(
    "SELECT name, statement, scope, rationale, set_at FROM core_value WHERE is_active=1 ORDER BY name"
  ).all();
  const traits = db.prepare(
    "SELECT name, dimension, weight, evidence_count, notes FROM personality_trait ORDER BY weight DESC"
  ).all();
  const cappedTraits = traits.filter(t => t.notes && /HARD_CAP/.test(t.notes));
  const topTraits = traits.filter(t => !cappedTraits.includes(t)).slice(0, 12);
  const lastReflection = db.prepare(
    "SELECT reflection_date, summary, next_day_focus FROM daily_reflection ORDER BY reflection_date DESC LIMIT 1"
  ).get();

  let md = `# SOUL.md — ${AGENT_NAME}\n\n`;
  md += `*Generated ${new Date().toISOString()} from mnemo.db. Do not hand-edit; regenerate via \`node export_declarative.js\`.*\n\n`;
  md += `## Hard-coded Values (non-negotiable)\n\n`;
  for (const v of values) {
    md += `### ${v.name}\n`;
    md += `**Statement:** ${v.statement}\n`;
    if (v.scope) md += `**Scope:** ${v.scope}\n`;
    if (v.rationale) md += `**Why:** ${v.rationale}\n`;
    md += `\n`;
  }
  md += `## Capped Traits (hard locks)\n\n`;
  if (cappedTraits.length) {
    md += `| trait | dimension | locked at | note |\n|---|---|---|---|\n`;
    for (const t of cappedTraits) {
      md += `| ${t.name} | ${t.dimension} | ${t.weight} | ${(t.notes || "").replace(/\|/g, "/")} |\n`;
    }
  } else {
    md += `_(none)_\n`;
  }
  md += `\n## Top Traits (mutable, evidence-driven)\n\n`;
  md += `| trait | dimension | weight | evidence | note |\n|---|---|---|---|---|\n`;
  for (const t of topTraits) {
    md += `| ${t.name} | ${t.dimension} | ${t.weight.toFixed(2)} | ${t.evidence_count} | ${(t.notes || "").replace(/\|/g, "/")} |\n`;
  }
  if (lastReflection) {
    md += `\n## Last Daily Reflection (${lastReflection.reflection_date})\n\n`;
    md += `${lastReflection.summary || "_(no summary)_"}\n\n`;
    if (lastReflection.next_day_focus) md += `**Next-day focus:** ${lastReflection.next_day_focus}\n`;
  }
  return md;
}

function exportAgents() {
  let md = `# AGENTS.md\n\n`;
  md += `*Generated ${new Date().toISOString()}. Lists every agent / persona this Mnemo instance knows about.*\n\n`;
  md += `## Primary\n\n`;
  md += `- **${AGENT_NAME}** — owner of this memory. Personality + values defined in SOUL.md.\n\n`;

  const sessions = db.prepare(
    "SELECT agent, COUNT(*) cnt, MAX(started_at) last_seen FROM session GROUP BY agent ORDER BY cnt DESC"
  ).all();
  if (sessions.length) {
    md += `## Observed in session log\n\n`;
    md += `| agent | sessions | last seen |\n|---|---:|---|\n`;
    for (const s of sessions) {
      md += `| ${s.agent || "_(unknown)_"} | ${s.cnt} | ${s.last_seen || "—"} |\n`;
    }
  }

  const actors = db.prepare(
    "SELECT actor, COUNT(*) cnt FROM memory WHERE actor IS NOT NULL GROUP BY actor ORDER BY cnt DESC LIMIT 20"
  ).all();
  if (actors.length) {
    md += `\n## Actor frequency (top 20)\n\n`;
    md += `| actor | rows |\n|---|---:|\n`;
    for (const a of actors) md += `| ${a.actor} | ${a.cnt} |\n`;
  }
  return md;
}

function exportTools() {
  let md = `# TOOLS.md\n\n`;
  md += `*Generated ${new Date().toISOString()}. MCP tools exposed by mnemo.*\n\n`;
  let mcpSrc = "";
  try { mcpSrc = fs.readFileSync(MCP_PATH, "utf8"); }
  catch (e) {
    md += `_Could not read MCP_PATH (${MCP_PATH}): ${e.message}_\n`;
    return md;
  }
  // Match each tool definition: `key: {\n    description: "...",`
  const re = /(\w+):\s*\{\s*description:\s*"((?:[^"\\]|\\.)*)"/g;
  const tools = [];
  let m;
  while ((m = re.exec(mcpSrc)) !== null) {
    tools.push({ name: m[1], description: m[2].replace(/\\"/g, '"').replace(/\\n/g, " ") });
  }
  if (!tools.length) {
    md += `_No tools detected in ${MCP_PATH} (regex did not match)._\n`;
    return md;
  }
  md += `${tools.length} tools detected.\n\n`;
  md += `| tool | description |\n|---|---|\n`;
  for (const t of tools) {
    md += `| \`${t.name}\` | ${t.description.replace(/\|/g, "/")} |\n`;
  }
  return md;
}

function main() {
  const soul = exportSoul();
  const agents = exportAgents();
  const tools = exportTools();
  fs.writeFileSync(path.join(OUT_DIR, "SOUL.md"), soul);
  fs.writeFileSync(path.join(OUT_DIR, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(OUT_DIR, "TOOLS.md"), tools);
  console.log(`[mnemo-export] wrote SOUL.md (${soul.length} chars), AGENTS.md (${agents.length}), TOOLS.md (${tools.length}) → ${OUT_DIR}`);
}

main();
db.close();
