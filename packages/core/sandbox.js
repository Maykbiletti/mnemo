"use strict";
/**
 * sandbox.js — execute a skill in an isolated environment.
 *
 * Reads `needs_sandbox` (or the older `sandbox: docker`) field from a
 * SKILL.md frontmatter. Three execution modes:
 *
 *   none      → run inline in the current Node process
 *   docker    → docker run --rm --network=none, read-only mount of the skill folder
 *   browser_only → forward to the upcoming PC-Agent browser tool (Phase 2)
 *
 * For Phase 1 the docker path is the load-bearing one. The wrapper:
 *   1. Mounts the skill folder read-only at /skill
 *   2. Mounts a writable scratch dir at /work
 *   3. Drops network capability via --network=none
 *   4. Pipes input.json on stdin, captures output.json + stderr
 *   5. Enforces a wall-clock timeout (default 60s)
 *
 * Image: node:22-alpine by default. Override via SKILL.md `runtime` field
 * or env MNEMO_SANDBOX_IMAGE.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_IMAGE = process.env.MNEMO_SANDBOX_IMAGE || "node:22-alpine";
const DEFAULT_TIMEOUT_SEC = 60;
const SKILLS_DIR = process.env.MNEMO_SKILLS || path.join(__dirname, "skills");

function parseFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return out;
}

function loadSkill(name) {
  const dir = path.join(SKILLS_DIR, name);
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) throw new Error(`skill '${name}' not found at ${skillFile}`);
  const md = fs.readFileSync(skillFile, "utf8");
  const fm = parseFrontmatter(md);
  return { name, dir, frontmatter: fm, raw: md };
}

function runInline(skill, input) {
  const runFile = path.join(skill.dir, "run.js");
  if (!fs.existsSync(runFile)) {
    return Promise.resolve({ ok: false, error: "no run.js for inline execution; skill is descriptive-only" });
  }
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [runFile], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", d => out += d);
    proc.stderr.on("data", d => err += d);
    proc.on("close", code => {
      let parsed;
      try { parsed = JSON.parse(out); } catch { parsed = { raw: out }; }
      resolve({ ok: code === 0, exit: code, output: parsed, stderr: err.slice(0, 4000) });
    });
    proc.stdin.write(JSON.stringify(input || {}));
    proc.stdin.end();
  });
}

function runDocker(skill, input, opts = {}) {
  const image = skill.frontmatter.runtime || DEFAULT_IMAGE;
  const timeout = opts.timeout_sec || DEFAULT_TIMEOUT_SEC;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-sandbox-"));

  return new Promise((resolve) => {
    const args = [
      "run", "--rm",
      "--network=none",
      "--memory=512m",
      "--cpus=1",
      "-v", `${skill.dir}:/skill:ro`,
      "-v", `${work}:/work`,
      "-w", "/work",
      "-i",
      image,
      "node", "/skill/run.js",
    ];
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    let killed = false;
    const t = setTimeout(() => { killed = true; proc.kill("SIGKILL"); }, timeout * 1000);

    proc.stdout.on("data", d => out += d);
    proc.stderr.on("data", d => err += d);
    proc.on("close", code => {
      clearTimeout(t);
      let parsed;
      try { parsed = JSON.parse(out); } catch { parsed = { raw: out }; }
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      if (killed) return resolve({ ok: false, error: "timeout", timeout_sec: timeout, stderr: err.slice(0, 4000) });
      resolve({ ok: code === 0, exit: code, output: parsed, stderr: err.slice(0, 4000), work_dir_cleaned: true });
    });
    proc.on("error", e => {
      clearTimeout(t);
      if (e.code === "ENOENT") return resolve({ ok: false, error: "docker not installed; install docker or set sandbox: none in SKILL.md", detail: e.message });
      resolve({ ok: false, error: String(e.message) });
    });
    proc.stdin.write(JSON.stringify(input || {}));
    proc.stdin.end();
  });
}

async function runSkill(name, input = {}, opts = {}) {
  const skill = loadSkill(name);
  const sandbox = (skill.frontmatter.needs_sandbox || skill.frontmatter.sandbox || "none").toLowerCase();
  switch (sandbox) {
    case "true": case "docker": return runDocker(skill, input, opts);
    case "browser_only": return { ok: false, error: "browser_only sandbox not yet supported (Phase 2 PC-Agent dependency)" };
    case "false": case "none": case "": return runInline(skill, input);
    default: return { ok: false, error: `unknown sandbox value '${sandbox}' in ${name}/SKILL.md` };
  }
}

if (require.main === module) {
  const [, , name, ...rest] = process.argv;
  if (!name) {
    console.error("usage: sandbox.js <skill_name> [json_input]");
    process.exit(2);
  }
  let input = {};
  if (rest.length) {
    try { input = JSON.parse(rest.join(" ")); } catch { console.error("input is not valid JSON"); process.exit(2); }
  }
  runSkill(name, input).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { runSkill, loadSkill };
