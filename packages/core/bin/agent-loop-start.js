#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

process.noDeprecation = true;

const parsed = parseArgs(process.argv.slice(2));
const agent = parsed.positionals[0] || process.env.MNEMO_AGENT || process.env.MNEMO_DEFAULT_AGENT || "agent";
const workspace = parsed.positionals[1] || process.env.AGENT_WORKSPACE || process.cwd();
const engine = normalizeEngine(parsed.flags.engine || process.env.MNEMO_AGENT_LOOP_ENGINE || process.env.MNEMO_AGENT_ENGINE || "agent");
const loopName = parsed.flags.name || process.env.LOOP_PM2_NAME || `agent-loop-${safeName(agent)}`;
const coreDir = path.resolve(__dirname, "..");
const workerPath = path.join(coreDir, "agent_loop_worker.js");
const pm2Bin = process.env.PM2_BIN || (process.platform === "win32" ? "pm2.cmd" : "pm2");

const env = Object.assign({}, process.env, {
  AGENT_WORKSPACE: workspace,
  MNEMO_AGENT: agent,
  MNEMO_DEFAULT_AGENT: agent,
  AGENT_ENGINE: engine,
  MNEMO_AGENT_LOOP_ENGINE: engine,
  LOOP_REVIEWER_AGENT: process.env.LOOP_REVIEWER_AGENT || "coordinator",
  MNEMO_REQUIRE_PRE_WORK_GUARD: process.env.MNEMO_REQUIRE_PRE_WORK_GUARD || "1",
  LOOP_PRE_WORK_MODE: process.env.LOOP_PRE_WORK_MODE || process.env.MNEMO_PRE_WORK_MODE || "deterministic",
  PREWORK_MAX_TURNS: process.env.PREWORK_MAX_TURNS || "20",
  MNEMO_REQUIRE_COMPLETION_GUARD: process.env.MNEMO_REQUIRE_COMPLETION_GUARD || "1",
  MNEMO_REQUIRE_REGRESSION_GUARD: process.env.MNEMO_REQUIRE_REGRESSION_GUARD || "1",
  MNEMO_REQUIRE_SITE_CONTRACT_GUARD: process.env.MNEMO_REQUIRE_SITE_CONTRACT_GUARD || "1",
  MNEMO_REQUIRE_TOKEN_EFFICIENT_MEMORY: process.env.MNEMO_REQUIRE_TOKEN_EFFICIENT_MEMORY || "1",
  MNEMO_MAX_MEMORY_FETCH_IDS: process.env.MNEMO_MAX_MEMORY_FETCH_IDS || "8",
  MNEMO_REQUIRE_SMART_CODE_READ: process.env.MNEMO_REQUIRE_SMART_CODE_READ || "1",
  MNEMO_SMART_CODE_READ_MIN_BYTES: process.env.MNEMO_SMART_CODE_READ_MIN_BYTES || "20000"
});

if (!fs.existsSync(workerPath)) {
  console.error(`agent loop worker not found: ${workerPath}`);
  process.exit(1);
}

if (!commandOk(pm2Bin, ["--version"])) {
  console.error("pm2 is required for self-start. Install it with: npm install -g pm2");
  process.exit(1);
}

if (commandOk(pm2Bin, ["describe", loopName])) {
  run(pm2Bin, ["delete", loopName], { allowFailure: true });
}
run(pm2Bin, ["start", workerPath, "--name", loopName, "--", agent, workspace]);
run(pm2Bin, ["save"], { allowFailure: true });
run(pm2Bin, ["describe", loopName], { allowFailure: true });

function safeName(raw) {
  return String(raw || "agent").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "agent";
}

function parseArgs(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = "1";
    }
  }
  return { flags, positionals };
}

function normalizeEngine(raw) {
  const engine = String(raw || "agent").toLowerCase();
  if (engine !== "agent" && engine !== "print-cli") {
    console.error(`Unsupported --engine "${raw}". Use "agent" or "print-cli".`);
    process.exit(1);
  }
  return engine;
}

function commandOk(command, args) {
  const res = spawnSync(command, args, {
    cwd: coreDir,
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true
  });
  return res.status === 0;
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: coreDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true
  });
  if (res.error && !options.allowFailure) {
    console.error(res.error.message);
    process.exit(1);
  }
  if (res.status !== 0 && !options.allowFailure) {
    process.exit(res.status || 1);
  }
  return res.status === 0;
}
