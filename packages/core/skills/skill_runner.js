#!/usr/bin/env node
"use strict";
/**
 * skill_runner.js — execute a skill with declared sandbox enforcement.
 *
 * Reads SKILL.md, parses sandbox + requires_confirmation + sensitive_data,
 * resolves the runnable (run.js, scripts/run.sh, ...), and dispatches into
 * the sandbox the skill declared. Refuses if a higher-trust sandbox is asked
 * for than the host can provide.
 *
 * Sandboxes:
 *   none           — current process, no isolation
 *   shell          — child_process spawn, current user, no chroot
 *   browser_only   — refuses shell access, expects URLs/HTTP only (still child_process for now)
 *   docker         — runs inside a docker container with --network=none unless override
 *
 * Usage:
 *   node skill_runner.js <skill-folder> [--input "<text>"] [--allow-confirm]
 *   node skill_runner.js <skill-folder> --dry-run
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes("--" + name); }

function parseFrontmatter(text) {
  const meta = {}; let body = text;
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta, body };
  body = m[2];
  for (const raw of m[1].split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) val = val.slice(1,-1).split(",").map(s=>s.trim().replace(/^['"]|['"]$/g,"")).filter(Boolean);
    else if (val === "true" || val === "false") val = val === "true";
    else if (/^[0-9]+$/.test(val)) val = parseInt(val,10);
    else if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) val = val.slice(1,-1);
    meta[key] = val;
  }
  return { meta, body };
}

function pickRunner(folder) {
  const c = ["run.js", "scripts/run.sh", "scripts/run.js", "run.sh", "run.py", "scripts/run.py"];
  for (const x of c) { const p = path.join(folder, x); if (fs.existsSync(p)) return p; }
  return null;
}

function runIn(sandbox, runner, input, env) {
  return new Promise((resolve) => {
    let cmd, args;
    if (sandbox === "docker") {
      cmd = "docker";
      args = ["run", "--rm", "-i", "--network=none", "--read-only", "-v", path.dirname(runner) + ":/skill:ro", "-w", "/skill", "node:20-slim", "node", path.basename(runner)];
    } else {
      const ext = path.extname(runner);
      if (ext === ".js") { cmd = "node"; args = [runner]; }
      else if (ext === ".py") { cmd = "python3"; args = [runner]; }
      else if (ext === ".sh") { cmd = "bash"; args = [runner]; }
      else { cmd = runner; args = []; }
    }
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: Object.assign({}, process.env, env || {}) });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; process.stdout.write(d); });
    child.stderr.on("data", d => { err += d; process.stderr.write(d); });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on("close", (code) => resolve({ exit_code: code, stdout: out, stderr: err }));
    child.on("error", (e) => resolve({ exit_code: -1, stdout: out, stderr: err + "\nspawn-error: " + e.message }));
  });
}

async function main() {
  const folder = path.resolve(process.argv[2] || "");
  if (!folder || !fs.existsSync(path.join(folder, "SKILL.md"))) {
    console.error("usage: skill_runner.js <skill-folder>  (folder must contain SKILL.md)");
    process.exit(2);
  }
  const text = fs.readFileSync(path.join(folder, "SKILL.md"), "utf8");
  const { meta } = parseFrontmatter(text);
  const sandbox = meta.sandbox || "none";
  const sensitive = Array.isArray(meta.sensitive_data) ? meta.sensitive_data : [];
  const requiresConfirm = meta.requires_confirmation === true;
  const runner = pickRunner(folder);

  console.error("[skill_runner] name=" + (meta.name || path.basename(folder)) + " sandbox=" + sandbox + " sensitive=" + sensitive.join(",") + " requires_confirmation=" + requiresConfirm);

  if (sandbox === "browser_only" && runner && /\.(sh|bash)$/.test(runner)) {
    console.error("[skill_runner] REFUSED: sandbox=browser_only but runner is shell — incompatible");
    process.exit(3);
  }
  if (requiresConfirm && !flag("allow-confirm")) {
    console.error("[skill_runner] REFUSED: skill requires confirmation, pass --allow-confirm to acknowledge");
    process.exit(3);
  }
  if (sandbox === "docker") {
    try { spawn("docker", ["--version"]).on("error", () => { throw new Error("docker not available"); }); }
    catch (e) { console.error("[skill_runner] sandbox=docker requested but", e.message); process.exit(4); }
  }
  if (!runner) {
    console.error("[skill_runner] no runner found (looked for run.js, scripts/run.sh, run.py)");
    process.exit(5);
  }
  if (flag("dry-run")) {
    console.log(JSON.stringify({ sandbox, runner, sensitive, requires_confirmation: requiresConfirm }, null, 2));
    return;
  }
  const input = arg("input", "");
  const result = await runIn(sandbox, runner, input);
  console.error("[skill_runner] exit=" + result.exit_code);
  process.exit(result.exit_code === 0 ? 0 : 1);
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
