#!/usr/bin/env node
"use strict";
/**
 * skills_watcher.js — hot-reload skill registry.
 *
 * Watches one or more skill directories. When a SKILL.md file is created or
 * modified, re-runs agent_skills_loader.js for that file's parent folder so the
 * skill is re-ingested into Mnemo without a manual scan or daemon restart.
 *
 * Usage:
 *   node skills_watcher.js <dir> [<dir2> ...] [--tenant <name>]
 *
 * Run as a long-lived process (PM2):
 *   pm2 start skills_watcher.js --name mnemo-skills-watcher -- /root/skills-pool --tenant shared
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const LOADER = "/root/mnemo/packages/core/skills/agent_skills_loader.js";
const args = process.argv.slice(2);

let tenant = "shared";
const dirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--tenant") tenant = args[++i];
  else dirs.push(path.resolve(args[i]));
}
if (!dirs.length) {
  console.error("usage: skills_watcher.js <dir1> [<dir2> ...] [--tenant <name>]");
  process.exit(2);
}

console.log("[watcher] hot-reload tenant=" + tenant + " dirs=" + dirs.join(","));

const debounce = new Map();
function reloadFolder(folder) {
  if (debounce.has(folder)) return;
  debounce.set(folder, setTimeout(() => {
    debounce.delete(folder);
    console.log("[watcher] re-ingest", folder);
    const child = spawn("node", [LOADER, folder, "--tenant", tenant], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", d => process.stdout.write("[loader] " + d));
    child.stderr.on("data", d => process.stderr.write("[loader-err] " + d));
    child.on("error", e => console.error("[watcher] spawn error for", folder, e.message));
    child.on("close", code => { if (code) console.error("[watcher] loader exited with code", code, "for", folder); });
  }, 800));
}

for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    console.error("[watcher] skipping missing", dir);
    continue;
  }
  fs.watch(dir, { recursive: true }, (event, filename) => {
    if (!filename) return;
    if (!/skill\.md$/i.test(filename)) return;
    const full = path.join(dir, filename);
    const folder = path.dirname(full);
    console.log("[watcher] change:", event, filename);
    reloadFolder(folder);
  });
  console.log("[watcher] watching", dir);
  reloadFolder(dir); // initial scan
}

process.on("SIGINT", () => { console.log("[watcher] bye"); process.exit(0); });
process.on("SIGTERM", () => { console.log("[watcher] bye"); process.exit(0); });
process.on("unhandledRejection", (reason) => {
  console.error("[watcher] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[watcher] uncaughtException:", err);
  process.exit(1);
});
