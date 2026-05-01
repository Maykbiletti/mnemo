#!/usr/bin/env node
"use strict";
/**
 * mnemo CLI — top-level entrypoint.
 *
 * Subcommands:
 *   init                  interactive bootstrap wizard
 *   start                 alias for `node daemon.js`
 *   mcp                   alias for `node mcp.js`
 *   embed                 backfill missing embeddings
 *   loops                 run open-loop scanner sweep
 *   export                regenerate AGENTS/SOUL/TOOLS markdown
 *   pack apply <name>     apply a personality pack (e.g. pack-dieter)
 *   --help                show this
 */
const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const cmd = args[0];

function run(file, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, file)], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  }).status || 0;
}

function help() {
  console.log(`mnemo — persistent memory + identity engine

Usage: mnemo <command> [options]

Commands:
  init                  interactive bootstrap wizard
  start                 boot the daemon (HTTP + writers)
  mcp                   stdio MCP server (run from your client)
  embed                 backfill embeddings for new memory rows
  loops                 sweep open-loop scanner
  export                regenerate SOUL.md / AGENTS.md / TOOLS.md
  pack apply <name>     load a personality pack
  --help                this message

Env vars (all optional):
  MNEMO_DB                  path to SQLite file (default ./mnemo.db)
  MNEMO_HTTP_PORT           HTTP port (default 7117)
  MNEMO_HTTP_HOST           HTTP host (default 127.0.0.1)
  MNEMO_OWNER_NAME          name of the agent's owner (e.g. "Mayk")
  MNEMO_OWNER_CHAT_ID       owner's Telegram chat-id (if Telegram channel)
  MNEMO_TZ_OFFSET_HOURS     timezone offset for quiet-hours
  MNEMO_QUIET_START         hour (0-23) when quiet hours begin
  MNEMO_QUIET_END           hour (0-23) when quiet hours end
  TELEGRAM_BOT_TOKEN        Telegram bot token (enables Telegram channel)
`);
}

if (!cmd || cmd === "--help" || cmd === "-h") {
  help(); process.exit(0);
}

if (cmd === "init") {
  return process.exit(run("bootstrap.js"));
}
if (cmd === "start") return process.exit(run("daemon.js"));
if (cmd === "mcp")   return process.exit(run("mcp.js"));
if (cmd === "embed") return process.exit(run("embedding_writer.js"));
if (cmd === "loops") return process.exit(run("loop_scanner_v2.js"));
if (cmd === "export") return process.exit(run("export_declarative.js"));

if (cmd === "pack" && args[1] === "apply" && args[2]) {
  const packName = args[2];
  // Try local path first, then node_modules
  const local = path.join(process.cwd(), "packages", packName, "pack.js");
  const installed = path.join(process.cwd(), "node_modules", `@mnemo/${packName}`, "pack.js");
  const candidates = [local, installed];
  const target = candidates.find(p => fs.existsSync(p));
  if (!target) {
    console.error(`Pack '${packName}' not found at any of:\n  ${candidates.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Applying pack: ${target}`);
  process.exit(spawnSync(process.execPath, [target], { stdio: "inherit" }).status || 0);
}

console.error("Unknown command:", cmd);
help();
process.exit(2);
