#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");

const argv = new Set(process.argv.slice(2));
const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const AGENT = String(positional[0] || process.env.MNEMO_AGENT || process.env.MNEMO_DEFAULT_AGENT || "agent").trim().toLowerCase() || "agent";
const OWNER_NAME = String(process.env.MNEMO_OWNER_NAME || process.env.OWNER_NAME || "the owner").trim() || "the owner";
const OWNER_AGENT = String(process.env.MNEMO_OWNER_AGENT || process.env.OWNER_AGENT || "owner").trim().toLowerCase() || "owner";
const CONSOLE_NAME = String(process.env.MNEMO_CONSOLE_NAME || "Mission Control").trim() || "Mission Control";
const MNEMO_URL = normalizeUrl(process.env.MNEMO_URL || process.env.MNEMO_HUB_URL || "http://127.0.0.1:7117");
const WORKSPACE = process.env.AGENT_WORKSPACE || positional[1] || process.cwd();
const MNEMO_REPO_ROOT = path.resolve(__dirname, "..", "..");
const POLL_SEC = intEnv("LOOP_POLL_SEC", 60);
const IDLE_SEC = intEnv("LOOP_IDLE_SEC", 180);
const AGENT_TIMEOUT_MIN = intEnv("AGENT_TIMEOUT_MIN", 120);
const DRAIN_IDLE_LIMIT = intEnv("DRAIN_IDLE_LIMIT", 25);
const ONCE = argv.has("--once") || process.env.LOOP_ONCE === "1";
const DRY_RUN = argv.has("--dry-run") || process.env.LOOP_DRY_RUN === "1";
const NO_BRIEFS = argv.has("--no-briefs") || process.env.LOOP_NO_BRIEFS === "1";
const NO_AUTONOMY = argv.has("--no-autonomy") || process.env.LOOP_NO_AUTONOMY === "1";
const ONLY_MISSION_CONSOLE = argv.has("--only-mission-console") || process.env.LOOP_ONLY_MISSION_CONSOLE === "1";
const LOCK_PATH = process.env.LOOP_LOCK_PATH || path.join(os.tmpdir(), `mnemo-agent-loop-${AGENT}.lock`);
const REQUESTED_ENGINE = (process.env.AGENT_ENGINE || process.env.MNEMO_AGENT_LOOP_ENGINE || "agent").toLowerCase();
const ENGINE = REQUESTED_ENGINE === "agent" ? "agent" : "print-cli";
const ENGINE_LABEL = REQUESTED_ENGINE || ENGINE;
const AGENT_BIN = process.env.AGENT_BIN || process.env.ASSISTANT_CLI_BIN || (process.platform === "win32" ? "assistant.cmd" : "assistant");
const DEFAULT_EXTERNAL_AGENT_BIN = REQUESTED_ENGINE && !["agent", "print-cli"].includes(REQUESTED_ENGINE)
  ? REQUESTED_ENGINE
  : (process.platform === "win32" ? "assistant.cmd" : "assistant");
const EXTERNAL_AGENT_BIN = process.env.EXTERNAL_AGENT_BIN || process.env.ASSISTANT_CLI_BIN || DEFAULT_EXTERNAL_AGENT_BIN;
const EXTERNAL_AGENT_MAX_TURNS = intEnv("EXTERNAL_AGENT_MAX_TURNS", intEnv("ASSISTANT_CLI_MAX_TURNS", 40));
const PREWORK_MAX_TURNS = intEnv("PREWORK_MAX_TURNS", 20);
const ACTION_TAIL_MAX = intEnv("ACTION_TAIL_MAX", 700);
const ACTION_FINISH_RETRIES = intEnv("ACTION_FINISH_RETRIES", 3);
const ENGINE_AUTH_COOLDOWN_MIN = intEnv("ENGINE_AUTH_COOLDOWN_MIN", 15);
const REQUIRE_PRE_WORK_GUARD = process.env.LOOP_NO_PRE_WORK_GUARD !== "1" && process.env.LOOP_NO_PREWORK_GUARD !== "1" && process.env.MNEMO_REQUIRE_PRE_WORK_GUARD !== "0" && process.env.MNEMO_REQUIRE_PREWORK_GUARD !== "0";
const REQUIRE_COMPLETION_GUARD = process.env.LOOP_NO_COMPLETION_GUARD !== "1" && process.env.MNEMO_REQUIRE_COMPLETION_GUARD !== "0";
const REQUIRE_REGRESSION_GUARD = process.env.LOOP_NO_REGRESSION_GUARD !== "1" && process.env.MNEMO_REQUIRE_REGRESSION_GUARD !== "0";
const REQUIRE_SITE_CONTRACT_GUARD = process.env.LOOP_NO_SITE_CONTRACT_GUARD !== "1" && process.env.MNEMO_REQUIRE_SITE_CONTRACT_GUARD !== "0";
const HARD_AGENT_PREFLIGHT = process.env.LOOP_NO_HARD_AGENT_PREFLIGHT !== "1" && process.env.MNEMO_HARD_AGENT_PREFLIGHT !== "0";
const HARD_PREFLIGHT_REQUIRE_PROJECT_RULES = process.env.LOOP_HARD_PREFLIGHT_REQUIRE_PROJECT_RULES === "1" || process.env.MNEMO_HARD_PREFLIGHT_REQUIRE_PROJECT_RULES === "1";
const HARD_PREFLIGHT_BLOCK_ON_HIGH_FINDINGS = process.env.LOOP_HARD_PREFLIGHT_BLOCK_HIGH_FINDINGS !== "0" && process.env.MNEMO_HARD_PREFLIGHT_BLOCK_HIGH_FINDINGS !== "0";
const PRE_WORK_MODE = (process.env.LOOP_PRE_WORK_MODE || process.env.MNEMO_PRE_WORK_MODE || (process.env.LOOP_LLM_PRE_WORK_GUARD === "1" ? "llm" : "deterministic")).toLowerCase();
const USE_LLM_PRE_WORK_GUARD = PRE_WORK_MODE === "llm" || PRE_WORK_MODE === "agent";
const REVIEWER_AGENT = process.env.LOOP_REVIEWER_AGENT || process.env.MNEMO_REVIEWER_AGENT || "coordinator";
const INITIATIVE_ENABLED = !argv.has("--no-initiative") && process.env.LOOP_NO_INITIATIVE !== "1";
const INITIATIVE_FORCE = argv.has("--force-initiative") || process.env.LOOP_FORCE_INITIATIVE === "1";
const INITIATIVE_INTERVAL_MIN = intEnv("INITIATIVE_INTERVAL_MIN", 90);
const INITIATIVE_STATE_DIR = process.env.INITIATIVE_STATE_DIR || path.join(os.tmpdir(), "mnemo-agent-loop");
const INITIATIVE_STATE_PATH = process.env.INITIATIVE_STATE_PATH || path.join(INITIATIVE_STATE_DIR, `${safeName(AGENT)}-initiative.json`);
const ENGINE_STATE_PATH = process.env.ENGINE_STATE_PATH || path.join(INITIATIVE_STATE_DIR, `${safeName(AGENT)}-engine.json`);
const AUTONOMY_SWEEP_ENABLED = !argv.has("--no-autonomy-sweep") && process.env.LOOP_NO_AUTONOMY_SWEEP !== "1";
const AUTONOMY_SWEEP_INTERVAL_MIN = intEnv("AUTONOMY_SWEEP_INTERVAL_MIN", 15);
const AUTONOMY_SWEEP_DROP_BRIEFS = process.env.LOOP_AUTONOMY_SWEEP_DROP_BRIEFS !== "0";
const AUTONOMY_SWEEP_STATE_PATH = process.env.AUTONOMY_SWEEP_STATE_PATH || path.join(INITIATIVE_STATE_DIR, `${safeName(AGENT)}-autonomy-sweep.json`);
const AUTONOMY_TAKEOVER_MINUTES = intEnv("AUTONOMY_TAKEOVER_MINUTES", 20);

function intEnv(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeUrl(raw) {
  return String(raw || "").replace(/\/+$/, "");
}

function safeName(raw) {
  return String(raw || "agent").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80) || "agent";
}

function toolUrl(tool) {
  if (MNEMO_URL.endsWith("/tool")) return `${MNEMO_URL}/${tool}`;
  return `${MNEMO_URL}/tool/${tool}`;
}

function log(message, extra) {
  const line = `[${new Date().toISOString()}] [${AGENT}] ${message}${extra ? " " + JSON.stringify(extra) : ""}`;
  console.log(line);
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

const gitInfoCache = new Map();
function readGitInfo(repoPath = WORKSPACE) {
  const nowMs = Date.now();
  const key = path.resolve(repoPath || ".");
  const cached = gitInfoCache.get(key);
  if (cached && nowMs - cached.at < 60 * 1000) return cached.value;
  const info = { commit: null, branch: null, dirty: null };
  try {
    const commit = spawnSync("git", ["-C", key, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 3000 });
    if (commit.status === 0) info.commit = commit.stdout.trim() || null;
    const branch = spawnSync("git", ["-C", key, "branch", "--show-current"], { encoding: "utf8", timeout: 3000 });
    if (branch.status === 0) info.branch = branch.stdout.trim() || null;
    const status = spawnSync("git", ["-C", key, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 });
    if (status.status === 0) info.dirty = !!status.stdout.trim();
  } catch {}
  gitInfoCache.set(key, { at: nowMs, value: info });
  return info;
}

const LOOP_VERSION = readPackageVersion();
let lastRuntimePreflight = null;
let lastRuntimeBlockSignature = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function callTool(tool, body = {}) {
  const target = new URL(toolUrl(tool));
  const data = JSON.stringify(body);
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: "POST",
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data)
      },
      timeout: 45000
    }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => out += c);
      res.on("end", () => {
        let parsed = null;
        try { parsed = out ? JSON.parse(out) : {}; } catch (e) { return reject(new Error(`Invalid JSON from ${tool}: ${out.slice(0, 400)}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${tool} HTTP ${res.statusCode}: ${out.slice(0, 400)}`));
        resolve(parsed.result !== undefined ? parsed.result : parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${tool} timeout`)));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function tail(text, max = 1800) {
  const clean = String(text || "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (clean.length <= max) return clean;
  return clean.slice(clean.length - max);
}

function isIdleCycle(brief) {
  const content = String(brief && brief.content || "");
  return brief && brief.source_agent === "mnemo-idle-loop" && content.startsWith("[IDLE-CYCLE]");
}

function preWorkGuardProtocol(scope) {
  return `Mandatory pre-work guard (${scope}):
- First think, then work. This guard must pass before edits, deploys, restarts, installs, commits, pushes, or "done" status.
- In the pre-work phase, read and reason only. Do not modify files, write memory conclusions as final truth, deploy, restart services, install packages, commit, push, or mark anything complete.
- Reload compact Mnemo context, identity, owner taste/no-gos, project rules, open claims, recent actions, and relevant file/project memory before planning non-trivial work.
- Identify the real acceptance criteria, dependencies to inspect, files/modules to claim, blast radius, site-contract surfaces, planned verification, and stop conditions.
- Website work must plan checks for canonical header/menu/footer, links, forbidden domain leaks, languages/locales, logos in light/dark, mobile, desktop, and crossover surfaces when relevant.
- If the project has a canonical brand/design source, do not invent a variant. Fonts, font sizes, logo assets, logo sizes, button sizes, header spacing, and login entrypoints must mirror the canonical source unless project rules declare a written exception.
- Coding work must plan dependency reads and tests before execution. If the plan cannot prove the work end-to-end, block instead of guessing.
- Large-codebase bugs, regressions, API/backend/database issues, auth, billing, checkout, deploy risk, and crossover work must plan a deep diagnosis lane: root cause, dependency path, shared callers, regression perimeter, and reviewer/handoff evidence.
- Never end with "user should check". The agent must name concrete checks it will run or state exactly why it is blocked.
- Finish with exactly one single-line JSON marker:
MNEMO_PRE_WORK_GUARD: {"status":"pass|blocked|not_applicable","task_summary":"","acceptance_criteria":[],"context_to_load":[],"dependencies_to_inspect":[],"files_or_modules_to_claim":[],"blast_radius":[],"site_contract_surfaces":[],"risk_level":"low|medium|high","planned_checks":[],"stop_conditions":[],"blocked_reason":[]}
- Use "not_applicable" only for trivial read-only status work with no code, content, config, deploy, live-site, memory-truth, or task-state change.`;
}

function regressionGuardProtocol(scope) {
  return `Mandatory regression guard (${scope}):
- Before changing anything, write down the blast radius: direct target, sibling pages/components, shared header/menu/footer, locale routes, theme assets, mobile layout, auth/pricing/legal/billing surfaces when relevant.
- Capture a baseline for the target and at least the nearest shared surfaces before editing when the project can be run or inspected.
- After editing, verify the exact target and the blast-radius surfaces. A narrow fix is not complete if it breaks another language, header/footer/menu link, mobile layout, dark/light logo, route, checkout/pricing/auth/legal link, or shared component.
- For website/UI changes, mobile-first checks are mandatory. Verify mobile and desktop, not just a wide desktop.
- For header/menu/footer/legal/i18n changes, check every declared language/locale route and confirm text stays in that locale.
- For theme/header/logo changes, check light and dark mode assets.
- For BLUN-linked portals, "close enough" is failure. Matching the canonical source is required; local reinterpretation is not allowed.
- For strict website work, "pass" requires baseline_checks, post_change_checks, cross_checks, mobile_checked=true, desktop_checked=true, and the relevant languages_checked, links_checked, and themes_checked arrays.
- If any required surface cannot be checked, do not claim success. Record status "blocked" and the missing checks.
- Finish with exactly one single-line JSON marker:
MNEMO_REGRESSION_GUARD: {"status":"pass|blocked|not_applicable","changed_files":[],"changed_surfaces":[],"baseline_checks":[],"post_change_checks":[],"cross_checks":[],"languages_checked":[],"themes_checked":[],"mobile_checked":false,"desktop_checked":false,"links_checked":[],"commands":[],"remaining_risks":[],"blockers":[]}
- Use "not_applicable" only for read-only/status work with no code, content, config, deploy, or live-site change.`;
}

function completionGuardProtocol(scope) {
  return `Mandatory coding completion guard (${scope}):
- No quick shots. Before coding, restate the real acceptance criteria and the dependencies you must not break.
- Before edits, inspect the relevant callers, shared components, routes, schemas, config, tests, styles, translations, assets, and deploy/runtime wiring touched by the change.
- For bug fixes and regressions, include root-cause and dependency evidence. A one-file patch is not complete until the shared path that allowed the bug is understood.
- If you code, finish the whole coherent task. Do not leave half-wired UI, half-updated routes, missing language copies, missing tests, unused code, TODO placeholders, or broken related flows.
- After edits, review your own diff and run the strongest available checks: tests, lint, build, typecheck, smoke calls, browser checks, or explicit file/content verification. If a check cannot run, block and say why.
- Verify there are no unrelated changes from your work. Preserve teammate/user changes.
- If the task is not fully complete, do not say finished. Record status "blocked" with the exact remaining work and next action.
- Finish with exactly one single-line JSON marker:
MNEMO_COMPLETION_GUARD: {"status":"pass|blocked|not_applicable","task_understood":true,"dependencies_checked":[],"changed_files":[],"acceptance_checks":[],"tests_run":[],"self_review":[],"unrelated_changes":[],"remaining_work":[],"blockers":[]}
- Use "not_applicable" only for read-only/status work with no code, content, config, deploy, or live-site change.`;
}

function siteContractGuardProtocol(scope) {
  return `Mandatory site contract guard (${scope}):
- Use this for any task touching or auditing websites, pages, header, menu, nav, footer, legal links, logos, style parity, mobile, languages/locales, or "all pages".
- Do not accept HTTP 200 as proof. You must compare contract, not just availability.
- Before changing, identify the canonical source for the surface (for example the owner-approved header/menu/style source) and the target pages/domains that must match it.
- Check header style/structure, menu labels/order, href targets, footer/legal links, language/locale route preservation, logo assets in light/dark, mobile and desktop.
- Check fonts, font sizes, button sizes, header spacing, and the exact approved light/dark logo asset rule when the project defines a canonical source.
- Flag forbidden domain leaks: internal nav/menu/footer/legal links on a target site must not silently point to the canonical/source domain unless project rules explicitly allow it.
- Prefer running the generic audit helper when useful:
  node packages/core/bin/site-contract-audit.js --canonical <url> --targets <url1,url2> --paths /,/de,/en --forbidden-host <host>
- For UI/style/header/mobile/page work, screenshot or browser evidence is mandatory. HTML checks alone are not enough for style.
- Visual quality must include a human-readable check for clipped text, overflow, broken buttons/inputs, invisible icons/logos, wrong theme assets, inconsistent header/menu/footer styling, and content that looks unfinished.
- Finish with exactly one single-line JSON marker:
MNEMO_SITE_CONTRACT_GUARD: {"status":"pass|blocked|not_applicable","canonical_source":"","target_urls":[],"pages_checked":[],"header_style_checked":false,"menu_structure_checked":false,"footer_checked":false,"links_checked":[],"forbidden_domain_leaks":[],"locale_routes_checked":[],"logos_checked":[],"mobile_checked":false,"desktop_checked":false,"visual_quality_checked":false,"layout_overflow_checked":false,"audit_commands":[],"screenshots":[],"remaining_risks":[],"blockers":[]}
- Use "not_applicable" only when the work truly does not touch or assess website/page/header/menu/footer/link/logo/language/style surfaces.`;
}

function preWorkPlanContext(prework) {
  const guard = prework && prework.guard ? prework.guard : prework;
  if (!guard) return "";
  return `Pre-work guard plan that allowed execution:
${JSON.stringify(guard, null, 2)}

Follow this plan. If reality differs, stop, record the blocker, and do not improvise a shortcut.`;
}

function promptForPreWork(kind, target, source) {
  const sourceText = typeof source === "string" ? source : JSON.stringify(source || {}, null, 2);
  return `You are ${AGENT} running inside the autonomous Mnemo agent loop.

This is the mandatory PRE-WORK phase for ${kind} ${target}.

You must think first. You are not allowed to execute the task yet.
Allowed now: read compact context, inspect relevant files/config/project rules, list dependencies, decide checks, and identify blockers.
Forbidden now: editing files, writing code, changing memory as final outcome, deploying, restarting services, installing packages, committing, pushing, marking briefs/tasks done, or saying the owner should check manually.

Use Mnemo at ${MNEMO_URL} token-efficiently:
- mem_context_preview first for non-trivial work, so you can choose context before loading it
- mem_session_brief with a small token budget
- owner taste/no-gos and project rules when relevant
- mem_agent_training_rules for active corrections relevant to the agent/project
- mem_site_contract_get and mem_site_golden_check_plan for website/header/menu/link/logo/language work
- mem_code_outline before reading source files, then mem_code_unfold for only the needed symbol/range
- open claims, recent actions, readiness board, quality findings, and recent handoffs only when needed

${preWorkGuardProtocol(kind)}

Task/source:
${sourceText}

Return only the concise pre-work result plus the required MNEMO_PRE_WORK_GUARD marker.`;
}

function sourceText(source) {
  return typeof source === "string" ? source : JSON.stringify(source || {});
}

function compactLine(text, max = 180) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Autonomous loop task";
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "...";
}

function uniqueList(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function sourceProject(source) {
  if (source && typeof source === "object") return source.project || source.project_name || "";
  const match = String(source || "").match(/\bProject:\s*([^\n]+)/i);
  return match ? match[1].trim() : "";
}

function sourceConversationContext(source) {
  if (!source || typeof source !== "object") return {};
  let meta = {};
  try { meta = source.meta_json ? JSON.parse(source.meta_json) : (source.meta || {}); } catch {}
  return {
    brief_id: source.id != null ? String(source.id) : null,
    channel: source.channel || meta.channel || null,
    thread_id: meta.thread_id || meta.console_thread_id || null,
    source_agent: source.source_agent || meta.source_agent || null,
    source_name: meta.source || null,
    created_at: source.created_at || meta.occurred_at || null
  };
}

function inferRiskLevel(kind, source) {
  const text = sourceText(source);
  if (/\b(auth|login|signup|billing|checkout|stripe|vat|oss|legal|privacy|datenschutz|impressum|server|deploy|nginx|database|db|schema|migration|secret|token|password|payment|refund|cancel)\b/i.test(text)) return "high";
  if (kind === "autonomy" || strictRegressionNeeded(kind, source) || strictSiteContractNeeded(kind, source)) return "medium";
  return "low";
}

function deterministicPreWorkGuard(kind, target, source) {
  const text = sourceText(source);
  const project = sourceProject(source);
  const needsCoding = strictCompletionNeeded(kind, source);
  const needsRegression = strictRegressionNeeded(kind, source);
  const needsSiteContract = strictSiteContractNeeded(kind, source);
  const needsAuth = /\b(auth|login|signup|signin|sign-in|sso|session|cookie|oauth|password|reset|forgot|verify|onboarding|account)\b/i.test(text);
  const needsCrossover = /\b(auth|login|signup|pricing|price|preise|checkout|billing|vat|oss|stripe|crossover|legal|impressum|datenschutz)\b/i.test(text);
  const needsI18n = /\b(language|locale|translation|sprache|sprachen|i18n|de|en|impressum|privacy|datenschutz|terms|agb|legal)\b/i.test(text);
  const needsTheme = /\b(logo|dark|light|dunkel|hell|theme|header|headder|style|stil)\b/i.test(text);
  const needsMobile = /\b(page|site|website|frontend|mobile|mobil|responsive|header|headder|menu|menue|nav|footer|landing)\b/i.test(text);
  const taskTitle = source && typeof source === "object" && source.title ? source.title : "";

  const acceptance = [
    "Task intent and success criteria are understood before action",
    "Relevant Mnemo context, project rules, owner taste/no-gos, and recent corrections are loaded first",
    "No completion claim until verification evidence is produced and logged",
    needsCoding ? "All affected code/config/content surfaces are wired completely with no placeholders or half-finished paths" : "",
    needsRegression ? "Direct target and blast-radius surfaces are checked before completion" : "",
    needsSiteContract ? "Canonical header/menu/footer/link/logo/language contract is compared, not only HTTP status" : "",
    needsCrossover ? "Crossover surfaces such as auth, pricing, checkout, billing, VAT/OSS, and legal links stay consistent where relevant" : ""
  ];

  const context = [
    `mem_context_preview({agent_name:"${AGENT}", project:${JSON.stringify(project || "<project-if-known>")}, task:"<current task>", token_budget:1800})`,
    `mem_session_brief({agent_name:"${AGENT}", token_budget:250})`,
    project ? `mem_work_report_feed({project:${JSON.stringify(project)}, agent_name:"${AGENT}", limit:12})` : "unified work report feed for the active project before execution",
    project ? `mem_project_timeline_report({project:${JSON.stringify(project)}, agent_name:"${AGENT}", token_budget:2200, max_items:6})` : "project timeline report for the active project before execution",
    needsAuth && project ? `mem_auth_contract_check({project:${JSON.stringify(project)}})` : "",
    needsTheme && project ? `mem_ui_contract_check({project:${JSON.stringify(project)}})` : "",
    "owner taste/no-gos, active corrections, and agent training rules",
    "project registry, project rules, live gates, and readiness board for the affected project",
    "open work claims, recent actions, recent handoffs, unified work reports, and blocking quality findings",
    kind === "autonomy" ? "claimed autonomy task checklist, department ownership, reviewer, and current task status" : "",
    kind === "initiative" ? "pending proposals, open autonomy tasks, scorecard, department list, and duplicate recent work" : "",
    needsSiteContract ? "site contract, golden check plan, canonical source, target domains, routes, locales, and theme assets" : ""
  ];

  const dependencies = [
    "target repo/workspace and current git status before edits",
    "existing project conventions and local helper APIs before adding new patterns",
    needsCoding ? "callers, shared components, routes, schemas, config, tests, package scripts, and deploy/runtime wiring touched by the change" : "",
    needsSiteContract ? "canonical navigation/header/footer source plus every target route/domain that must match it" : "",
    needsI18n ? "language/locale files, legal routes, translated route targets, and footer/legal link wiring" : "",
    needsTheme ? "canonical brand visual contract: shared header structure, identical buttons, light/dark behavior, theme assets, and mobile header layout" : "",
    needsAuth ? "canonical auth contract, shared identity scope, central login url, cookie/session scope, and allowed login entrypoints" : "",
    needsCrossover ? "auth/session, pricing, checkout, billing, VAT/OSS, legal, and account surfaces across sibling projects" : ""
  ];

  const filesToClaim = needsCoding ? [
    "Exact files/modules discovered from the dependency read before the first edit",
    "Any shared component, route, schema, config, translation, or asset file touched by the task"
  ] : [];

  const blastRadius = [
    "direct target requested by the brief/task",
    needsRegression ? "nearest shared siblings, callers, routes, tests, and runtime/deploy wiring" : "",
    needsMobile ? "mobile and desktop layouts for affected pages/components" : "",
    needsSiteContract ? "canonical header/menu/footer, nav targets, footer/legal links, locale routes, and target domains" : "",
    needsI18n ? "all declared languages/locales and legal page links" : "",
    needsTheme ? "light and dark mode logos/theme assets" : "",
    needsCrossover ? "auth, pricing, checkout, billing, VAT/OSS, account, and legal cross-project consistency" : ""
  ];

  const siteSurfaces = needsSiteContract ? [
    "canonical header/menu/footer source",
    "target domain homepage and locale routes",
    "navigation labels/order and href targets",
    "footer/legal links with forbidden-domain leak check",
    "light/dark logos and mobile/desktop header behavior"
  ] : [];

  const plannedChecks = [
    "read the unified work report feed, project timeline report, recent handoffs, and recent actions before deciding what is still undone",
    "load the listed Mnemo context and project rules before action",
    "inspect dependencies and claim write paths before any edit",
    needsCoding ? "run the strongest available repository checks: tests, lint, typecheck, build, smoke calls, or explicit file/content verification with blocker if unavailable" : "verify the requested read/status outcome against Mnemo/tool evidence",
    needsRegression ? "compare pre/post behavior for the direct target plus blast-radius surfaces" : "",
    needsSiteContract ? "run site-contract/browser/http checks for canonical header/menu/footer, links, locales, logos, mobile, and desktop" : "",
    needsI18n ? "check every affected language/locale route and confirm text/links remain in the correct locale" : "",
    needsTheme ? "check light and dark logo/theme assets on affected surfaces" : "",
    "review git diff and confirm unrelated user/teammate changes are preserved",
    "write Mnemo action/handoff evidence and brief the reviewer/team when coordination or review is needed"
  ];

  const stopConditions = [
    "project rules, owner facts, or required credentials/context are missing",
    "another agent owns the write path or recent work would be overwritten",
    "acceptance criteria cannot be verified end-to-end",
    "a required test/build/smoke/browser/site-contract check cannot run and no equivalent evidence exists",
    "forbidden domain leak, broken locale route, wrong menu/header/footer, missing logo/theme state, or crossover mismatch is found",
    "task touches secrets, destructive operations, live flips, auth/billing/checkout/VAT/legal risk beyond the loaded rules"
  ];

  return {
    status: "pass",
    task_summary: compactLine(`${project ? project + ": " : ""}${taskTitle || `${kind} ${target}: ${text}`}`),
    acceptance_criteria: uniqueList(acceptance),
    context_to_load: uniqueList(context),
    dependencies_to_inspect: uniqueList(dependencies),
    files_or_modules_to_claim: uniqueList(filesToClaim),
    blast_radius: uniqueList(blastRadius),
    site_contract_surfaces: uniqueList(siteSurfaces),
    risk_level: inferRiskLevel(kind, source),
    planned_checks: uniqueList(plannedChecks),
    stop_conditions: uniqueList(stopConditions),
    blocked_reason: []
  };
}

function preWorkMarker(guard) {
  return `MNEMO_PRE_WORK_GUARD: ${JSON.stringify(guard)}`;
}

function hasTimelineReportPlan(text) {
  return /\bmem_work_report_feed\b|\bmem_project_timeline_report\b|\bproject timeline report\b|\btimeline report\b|\bwork report feed\b/i.test(String(text || ""));
}

function hasHandoffReadPlan(text) {
  return /\bmem_work_report_feed\b|\brecent handoffs?\b|\bsession handoff\b|\bwork reports?\b|\bwork report feed\b|\bhandoffs?\b/i.test(String(text || ""));
}

function hasRecentActionsPlan(text) {
  return /\bmem_actions_recent\b|\brecent actions\b/i.test(String(text || ""));
}

function compactJson(value, max = 6500) {
  let text = "";
  try { text = JSON.stringify(value || {}, null, 2); }
  catch { text = String(value || ""); }
  if (text.length <= max) return text;
  return text.slice(0, max - 160) + "\n...truncated for token budget...\n" + text.slice(-120);
}

function parseMetaJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function hardPreflightText(source) {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object") return String(source || "");
  const meta = parseMetaJson(source.meta_json || source.meta || source.metadata_json || source.metadata);
  const pieces = [
    source.title,
    source.summary,
    source.subject,
    source.task,
    source.description,
    source.content,
    source.notes,
    source.outcome,
    meta.title,
    meta.summary,
    meta.task,
    meta.description,
    meta.content,
    meta.notes,
    compactJson(source, 2400),
  ];
  return pieces.filter(Boolean).map(String).join("\n");
}

function cleanToken(value) {
  return String(value || "")
    .replace(/[),.;\]}>"']+$/g, "")
    .replace(/^[([{<"']+/g, "")
    .trim();
}

function extractUrlsFromText(text) {
  const urls = [];
  const matches = String(text || "").match(/https?:\/\/[^\s)\]}>"']+/gi) || [];
  for (const match of matches) urls.push(cleanToken(match));
  return uniqueList(urls).slice(0, 25);
}

function extractDomainsFromText(text, urls = []) {
  const domains = [];
  for (const url of urls || []) {
    try { domains.push(new URL(url).hostname); } catch {}
  }
  const matches = String(text || "").match(/\b(?:[a-z0-9-]+\.)+(?:ai|app|com|de|dev|io|net|org|co|se|at|ch|cloud|site)\b/gi) || [];
  for (const match of matches) {
    if (/@/.test(match)) continue;
    domains.push(cleanToken(match).toLowerCase());
  }
  return uniqueList(domains).slice(0, 25);
}

function slugFromDomain(domain) {
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length >= 3) return parts[0];
  if (parts.length >= 2) return parts[0];
  return "";
}

function slugsFromPaths(text) {
  const out = [];
  const matches = String(text || "").match(/(?:^|[\s('"`])\/(?:root|var|etc|home|mnt|tmp|usr|opt|srv)\/([A-Za-z0-9_.-]+)/g) || [];
  for (const match of matches) {
    const cleaned = match.replace(/^[\s('"`]+/, "");
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length >= 2) out.push(parts[1]);
  }
  return uniqueList(out).slice(0, 20);
}

function extractRoutesFromText(text, urls = []) {
  const routes = [];
  for (const url of urls || []) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname && parsed.pathname !== "/") routes.push(parsed.pathname);
    } catch {}
  }
  const matches = String(text || "").match(/(?:^|[\s('"`])\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]+/g) || [];
  for (const match of matches) {
    const route = cleanToken(match.trim());
    if (!route.startsWith("/")) continue;
    if (/^\/(?:root|var|etc|home|mnt|tmp|usr|opt|srv|proc|dev)(?:\/|$)/i.test(route)) continue;
    if (route.length > 1) routes.push(route);
  }
  return uniqueList(routes).slice(0, 25);
}

function extractFilesFromText(text, source) {
  const files = [];
  const visit = (value, key, depth) => {
    if (!value || depth > 6) return;
    if (typeof value === "string") {
      const raw = value.trim();
      if (!raw || /^https?:\/\//i.test(raw) || raw.includes("\n")) return;
      if (/^(file|file_path|filepath|path|old_path|new_path|target_file|filename|absolute_path)$/i.test(String(key || ""))) files.push(raw);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
    }
  };
  visit(source, "", 0);
  const unixPath = /(?:^|[\s('"`])((?:\/(?:root|var|etc|home|mnt|tmp|usr|opt|srv)\/)[^\s),;'"`]+(?:\.[A-Za-z0-9]+)?)/g;
  const winPath = /\b([A-Za-z]:\\[^\s),;'"`]+(?:\.[A-Za-z0-9]+)?)/g;
  const repoFile = /(?:^|[\s('"`])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:js|jsx|mjs|cjs|ts|tsx|css|scss|html|htm|json|yml|yaml|md|py|sh|ps1|sql|vue|svelte))/g;
  let match;
  while ((match = unixPath.exec(String(text || ""))) !== null) files.push(cleanToken(match[1]));
  while ((match = winPath.exec(String(text || ""))) !== null) files.push(cleanToken(match[1]));
  while ((match = repoFile.exec(String(text || ""))) !== null) files.push(cleanToken(match[1]));
  return uniqueList(files).slice(0, 35);
}

function inferProjectForHardPreflight(source, text, domains) {
  const meta = source && typeof source === "object" ? parseMetaJson(source.meta_json || source.meta || source.metadata_json || source.metadata) : {};
  const explicit = source && typeof source === "object"
    ? (source.project || source.project_name || source.project_slug || meta.project || meta.project_name || meta.project_slug)
    : "";
  if (explicit) return String(explicit).trim();
  const lower = String(text || "").toLowerCase();
  if (/\ball(?:e|en)?\s+portale\b|\bglobal(?:er|es|e)?\s+login\b/i.test(text)) return "global";
  const domainSlug = uniqueList((domains || []).map(slugFromDomain).filter(Boolean))[0];
  if (domainSlug) return domainSlug;
  const pathSlug = slugsFromPaths(lower)[0];
  if (pathSlug) return pathSlug;
  return "";
}

function inferSystemsForHardPreflight(text, domains) {
  const systems = [
    ...(domains || []).map(slugFromDomain).filter(Boolean),
    ...slugsFromPaths(text)
  ];
  return uniqueList(systems).slice(0, 20);
}

function inferActionForHardPreflight(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(deploy|restart|pm2|nginx|systemctl|git push|push|rollout|ausrollen|serverseitig|live)\b/.test(lower)) return "deploy";
  if (/\b(rollback|restore|zurück|zurueck|revert|wiederherstellen)\b/.test(lower)) return "code_edit";
  if (/\b(edit|write|patch|change|fix|build|implement|umbau|ändern|aendern|bauen|einbauen|löschen|loeschen)\b/.test(lower)) return "code_edit";
  if (/\b(email|telegram|brief|senden|antworten)\b/.test(lower)) return "external_comm";
  return "code_read";
}

function shouldRunHardAgentPreflight(kind, source, payload) {
  if (!HARD_AGENT_PREFLIGHT || DRY_RUN) return false;
  if (kind === "autonomy") return true;
  if (kind === "initiative") return false;
  if (kind === "brief" && isMissionConsoleBrief(source)) return false;
  if (isNonExecutableBrief(source)) return false;
  const text = payload && payload.text || hardPreflightText(source);
  if ((payload.files || []).length || (payload.urls || []).length || (payload.domains || []).length) return true;
  return /\b(deploy|restart|pm2|nginx|push|rollout|ausrollen|serverseitig|live|rollback|restore|revert|edit|write|patch|change|fix|build|implement|umbau|ändern|aendern|bauen|einbauen|löschen|loeschen)\b/i.test(text);
}

function buildHardPreflightPayload(kind, target, source) {
  const text = hardPreflightText(source);
  const urls = extractUrlsFromText(text);
  const domains = extractDomainsFromText(text, urls);
  const routes = extractRoutesFromText(text, urls);
  const files = extractFilesFromText(text, source);
  const project = inferProjectForHardPreflight(source, text, domains);
  const system_names = inferSystemsForHardPreflight(text, domains);
  const action_type = inferActionForHardPreflight(text);
  const topics = uniqueList([
    /\bauth|login|session|cookie|2fa|oauth/i.test(text) ? "auth" : "",
    /\bbilling|stripe|invoice|subscription|vat|oss|checkout|price|pricing/i.test(text) ? "billing" : "",
    /\bheader|footer|menu|nav|logo|theme|dark|light|language|sprache|i18n|translation/i.test(text) ? "site-contract" : "",
    /\bdeploy|pm2|nginx|server|production|live/i.test(text) ? "deploy" : "",
  ]);
  return {
    agent_name: AGENT,
    project: project || "unknown",
    task: compactLine(text, 500),
    summary: compactLine(text, 500),
    action_type,
    topics,
    files,
    urls,
    routes,
    domains,
    system_names,
    scope: "default",
    auto_claim: action_type === "code_edit" || action_type === "deploy",
    require_project_rules: HARD_PREFLIGHT_REQUIRE_PROJECT_RULES,
    block_on_high_findings: HARD_PREFLIGHT_BLOCK_ON_HIGH_FINDINGS,
    meta: {
      loop_kind: kind,
      loop_target: String(target),
      inferred_project: project || null,
      inferred_systems: system_names,
    },
    text,
  };
}

function hardPreflightOutcome(result, payload, error) {
  if (error) return `Hard Mnemo preflight failed before execution: ${error}`;
  const blockers = result && Array.isArray(result.blockers) ? result.blockers : [];
  const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
  const details = blockers.length ? blockers.join("; ") : warnings.join("; ");
  return `Hard Mnemo preflight ${result && result.status || "unknown"} for ${payload.project || "unknown"} (${payload.action_type || "unknown"}).${details ? " " + details : ""}`;
}

async function runHardAgentPreflight(kind, target, source) {
  const payload = buildHardPreflightPayload(kind, target, source);
  if (!shouldRunHardAgentPreflight(kind, source, payload)) {
    return { allowed: true, skipped: true, payload, result: { status: "skipped" } };
  }
  log("hard agent preflight start", { kind, target, project: payload.project, action_type: payload.action_type });
  const action = await callTool("mem_action_log", {
    agent_name: AGENT,
    action_kind: "hard_agent_preflight",
    target: `${kind}#${target}`,
    status: "started",
    topic: "agent-loop",
    payload: Object.assign({}, payload, { text: undefined })
  }).catch(() => null);
  try {
    const result = await callTool("mem_agent_preflight", Object.assign({}, payload, { text: undefined }));
    const blocked = result && result.status === "block";
    const outcome = hardPreflightOutcome(result, payload);
    await finishAction(action, blocked ? "failed" : "ok", {
      decision: blocked ? "block" : "allow",
      preflight: result,
      payload: Object.assign({}, payload, { text: undefined }),
      outcome
    });
    log("hard agent preflight finish", { kind, target, status: result && result.status || "unknown", blockers: result && result.blockers && result.blockers.length || 0 });
    return {
      allowed: !blocked,
      retryable: false,
      result,
      payload,
      outcome,
    };
  } catch (e) {
    const outcome = hardPreflightOutcome(null, payload, e.message);
    await finishAction(action, "failed", { decision: "block", error: e.message, payload: Object.assign({}, payload, { text: undefined }), outcome });
    log("hard agent preflight error", { kind, target, error: e.message });
    return {
      allowed: false,
      retryable: true,
      result: { status: "error", error: e.message, blockers: ["hard agent preflight unavailable: " + e.message] },
      payload,
      outcome,
    };
  }
}

async function loadMandatoryWorkReports(kind, source) {
  const project = sourceProject(source);
  const conversation = sourceConversationContext(source);
  const out = {
    checked_at: new Date().toISOString(),
    kind,
    project: project || null,
    conversation,
    reports_loaded: [],
    errors: [],
  };
  try {
    out.recent_actions = await callTool("mem_actions_recent", { agent_name: AGENT, limit: 8 });
    out.reports_loaded.push("mem_actions_recent");
  } catch (e) {
    out.errors.push({ tool: "mem_actions_recent", error: String(e.message || e) });
  }
  try {
    out.work_report_feed = await callTool("mem_work_report_feed", {
      project: project || undefined,
      agent_name: AGENT,
      limit: 12
    });
    out.reports_loaded.push("mem_work_report_feed");
  } catch (e) {
    out.errors.push({ tool: "mem_work_report_feed", project, error: String(e.message || e) });
  }
  if (project) {
    try {
      out.project_timeline_report = await callTool("mem_project_timeline_report", {
        project,
        agent_name: AGENT,
        token_budget: 2200,
        max_items: 6,
        include_doc: true,
        live_focus: true
      });
      out.reports_loaded.push("mem_project_timeline_report");
    } catch (e) {
      out.errors.push({ tool: "mem_project_timeline_report", project, error: String(e.message || e) });
    }
  }
  if (conversation.brief_id) {
    try {
      out.brief_transcripts = await callTool("mem_transcript_recent", {
        ref_kind: "agent_brief",
        ref_id: conversation.brief_id,
        limit: 16
      });
      out.reports_loaded.push("mem_transcript_recent:brief");
    } catch (e) {
      out.errors.push({ tool: "mem_transcript_recent", scope: "brief", ref_id: conversation.brief_id, error: String(e.message || e) });
    }
    try {
      out.brief_events = await callTool("mem_event_recent", {
        ref_kind: "agent_brief",
        ref_id: conversation.brief_id,
        limit: 24
      });
      out.reports_loaded.push("mem_event_recent:brief");
    } catch (e) {
      out.errors.push({ tool: "mem_event_recent", scope: "brief", ref_id: conversation.brief_id, error: String(e.message || e) });
    }
  }
  if (conversation.channel && conversation.source_agent) {
    try {
      out.channel_transcripts = await callTool("mem_transcript_recent", {
        channel: conversation.channel,
        speaker: conversation.source_agent,
        limit: 20
      });
      out.reports_loaded.push("mem_transcript_recent:channel_speaker");
    } catch (e) {
      out.errors.push({ tool: "mem_transcript_recent", scope: "channel_speaker", channel: conversation.channel, speaker: conversation.source_agent, error: String(e.message || e) });
    }
  }
  if (conversation.thread_id) {
    try {
      out.thread_events = await callTool("mem_event_recent", {
        thread_id: conversation.thread_id,
        limit: 24
      });
      out.reports_loaded.push("mem_event_recent:thread");
    } catch (e) {
      out.errors.push({ tool: "mem_event_recent", scope: "thread", thread_id: conversation.thread_id, error: String(e.message || e) });
    }
  }
  out.ok = out.errors.length === 0;
  out.finished_at = new Date().toISOString();
  return out;
}

async function buildRuntimeMemoryContext(kind, target, source, reportBootstrap = null) {
  const project = sourceProject(source);
  const task = compactLine(typeof source === "string" ? source : (source && source.title) || `${kind} ${target}`, 220);
  const scope = process.env.MNEMO_SCOPE || process.env.MNEMO_DEFAULT_SCOPE || "default";
  const owner = process.env.MNEMO_OWNER_NAME || "owner";
  const context = {
    generated_at: new Date().toISOString(),
    agent_name: AGENT,
    kind,
    target,
    project: project || null,
    source_summary: task,
    required_protocol: [
      "read this bootstrap before acting",
      "load additional Mnemo records only when needed",
      "preserve identity, owner taste/no-gos, open work, project rules, findings, and recent actions",
      "read the unified work report feed before starting, so completed work is not repeated",
      "do not claim finished until guards and concrete verification pass"
    ]
  };
  context.mandatory_work_reports = reportBootstrap || await loadMandatoryWorkReports(kind, source).catch(e => ({ ok: false, errors: [{ tool: "mandatory_work_reports", error: String(e.message || e) }] }));
  context.session_start = await callTool("mem_session_start", {
    agent_name: AGENT,
    project: project || null,
    task
  }).catch(e => ({ error: String(e.message || e) }));
  context.session_brief = await callTool("mem_session_brief", {
    owner_name: owner,
    token_budget: 1200,
    layers: ["identity", "traits", "open_loops", "today", "recent_decisions"]
  }).catch(e => ({ error: String(e.message || e) }));
  context.context_preview = await callTool("mem_context_preview", {
    agent_name: AGENT,
    project: project || undefined,
    task,
    token_budget: 1800
  }).catch(e => ({ error: String(e.message || e) }));
  context.readiness_board = await callTool("mem_firm_readiness_board", {
    scope,
    agent_name: AGENT
  }).catch(e => ({ error: String(e.message || e) }));
  return `Mandatory runtime memory bootstrap:
The loop already loaded this from Mnemo before calling the model. Treat it as required context, then fetch more narrowly if needed.

${compactJson(context)}
`;
}

function universalMemoryCaptureProtocol() {
  return `Universal capture requirements:
- Every owner/agent text, console reply, bridge message, tool/action result, handoff, blocker, access hint, and "I already did this" fact must be preserved in Mnemo.
- Every screenshot, photo, PDF, document, and attachment must also be preserved in Mnemo with a searchable title, labels, route/page context, and project mapping.
- Use mem_transcript_log for human-readable conversation turns and channel messages.
- Use mem_event_log for small raw receipts that are too noisy for semantic memory but must never disappear.
- Use mem_action_log/mem_action_finish for every concrete action you start: command, edit, deploy, check, browser run, audit, brief, or investigation.
- Read your own agent passport first with mem_agent_pass_get so you know your live rights, review duty, and approval class before acting outside simple read/report work.
- Before touching infra or asking how to get somewhere, read the fixed access point first: mem_access_guide or mem_access_list. Check whether the route already exists before adding a new one.
- Before touching providers, OAuth, Stripe, VAT, PM2, nginx, mail, DNS, or shared infra, read the connector register first with mem_connector_list. If a system is missing, add it with mem_connector_upsert before improvising.
- Use mem_access_upsert / mem_access_event_log when you discover or verify how to reach a server, repo, admin, dashboard, API, database, provider, or console. Otto, Dieter, Angel, and Alfred must all store verified access routes there. Store secret_ref/key/env/path labels only; never store raw passwords, private keys, tokens, or customer secrets.
- Before asking "did we already do this?", search Mnemo first: mem_event_recent, mem_actions_search, mem_transcript_recent, mem_access_guide, mem_access_list, mem_question_answer, or mem_recall_layered as appropriate.`;
}

function promptForBrief(brief, prework, memoryContext = "") {
  return `You are ${AGENT} running inside the autonomous Mnemo agent loop.

Operating rules:
- Start by calling mem_context_preview for non-trivial work, then fetch only the selected Mnemo context, project rules, open claims, relevant memories, and recent actions.
- Start by reading the already-loaded work reports first: unified work report feed, project timeline report, recent handoffs, and recent actions. Do not start coding blindly.
- Then call mem_context_preview for non-trivial work and fetch only the selected Mnemo context, project rules, open claims, relevant memories, and recent actions.
- Work like a senior engineer: understand context, preflight risk, make the smallest clean change, verify, then store the outcome.
- Work as a complementary team, not as competing engines. Use the deep diagnosis lane for large code bugs and regressions; use coordination/visual lanes for cross-lane routing, browser evidence, and owner communication.
- Do not ask the owner what to do when the next safe action is clear. If a useful low-risk improvement is in your lane, execute it and verify. If it belongs to another lane, brief the responsible agent/reviewer and continue with your own safe work.
- Use Mnemo at ${MNEMO_URL} for memory, brief, action, task, and handoff updates.
- Before any real work, read the loaded reports and avoid duplicate work. If the unified report feed says the work is already done, do not redo it.
- If blocked or risky, write the blocker to Mnemo and stop cleanly. Do not blind-deploy.
- Brief ${REVIEWER_AGENT}/the team when coordination or review is needed.
- If owner/reviewer feedback identifies a mistake, call mem_correction_capture so it becomes a durable training rule.
- For website changes, call mem_site_golden_check_plan before approval and mem_site_golden_check_report with real evidence after checks.
- Before claiming risky/live work complete, check mem_agent_scorecard for yourself and clear blocking signals or report them.
- End real work with mem_session_handoff. If you forget, the loop will write an automatic work report.

${universalMemoryCaptureProtocol()}

${memoryContext}

${preWorkPlanContext(prework)}

${regressionGuardProtocol("brief")}

${completionGuardProtocol("brief")}

${siteContractGuardProtocol("brief")}

${missionConsoleReplyProtocol(brief)}

${telegramBridgeReplyProtocol(brief)}

Brief:
- id: ${brief.id}
- source_agent: ${brief.source_agent || ""}
- created_at: ${brief.created_at || ""}

Content:
${brief.content || ""}

Before your final answer, make sure the work is documented in Mnemo where appropriate.`;
}

function promptForMissionConsoleBrief(brief, prework, memoryContext = "") {
  const guardStatus = prework && (prework.status || prework.reason || prework.mode || "checked");
  return `You are ${AGENT} in ${OWNER_NAME}'s ${CONSOLE_NAME} console.

This is a live conversation with ${OWNER_NAME}, not a normal delivery brief.

Console behavior:
- Answer in the owner's language; default to plain, direct language.
- Use owner-cleartext: short sentences, no system jargon, no process lecture.
- Default answer shape:
  1. "Kurz:" one sentence with the point.
  2. "Ich mache jetzt:" one sentence with the next action.
  3. "Offen:" one sentence only if something is actually open.
- If the answer is simple, use only one or two sentences.
- Avoid these words unless the owner explicitly asks for technical detail: durable, Mnemo, guard, pre-work, lane, payload, action ledger, include_content, token, worker, daemon, PM2, stdout, meta, brief id.
- Do not expose internal ids, logs, JSON, stack traces, command output, or implementation details unless they help the owner decide something.
- Think first, then answer. If the next safe action is obvious, state it and start the proper background path instead of asking the owner what to do.
- Do not ask multiple-choice or permission questions when a safe route is clear.
- For tiny read-only diagnostics or status checks, you may use the available shell/tooling if it is safe and quick.
- Do not edit files, deploy, restart services, install packages, or run risky/live operations from this fast console unless the owner explicitly asks and the risk is low.
- For real code/deploy/project work, say in human words what you will start and who will handle it.
- If another agent owns the work, say the person's name and the result expected. Do not describe routing mechanics.
- If you are blocked, name the blocker and the exact next unblock step in plain German. Do not hide behind generic "cannot".
- Never paste guard JSON, raw tool JSON, stack traces, or long logs into the console reply unless the owner asks for them.
- Do not say "check it" or ask the owner to verify as the completion path; describe what was checked or what remains.
- The worker will publish your MISSION_CONSOLE_REPLY back to Mnemo. Do not call mem_brief_drop yourself just to answer this console message.
- Any non-trivial console command/request must still be captured as transcript/event/action evidence in Mnemo so the main loop can find it later.

Safety guard: ${guardStatus}. Use it silently as background. Do not mention it to the owner unless it blocks the request.

${memoryContext}

Brief:
- id: ${brief.id}
- source_agent: ${brief.source_agent || ""}
- created_at: ${brief.created_at || ""}

Content:
${brief.content || ""}

Final output contract:
- End stdout with exactly one marker:
MISSION_CONSOLE_REPLY:
<your full reply to ${OWNER_NAME}>
- Put nothing after the reply.
`;
}

function fixCommonMojibake(text) {
  return String(text || "")
    .replace(/Ã¤/g, "ä").replace(/Ã¶/g, "ö").replace(/Ã¼/g, "ü")
    .replace(/Ã„/g, "Ä").replace(/Ã–/g, "Ö").replace(/Ãœ/g, "Ü")
    .replace(/ÃŸ/g, "ß").replace(/Â·/g, "·").replace(/Â /g, " ");
}

function missionConsoleReplyText(output, brief, status) {
  const clean = String(output || "").replace(/\u001b\[[0-9;]*m/g, "");
  const marker = /MISSION_CONSOLE_REPLY:\s*/ig;
  let match;
  let last = null;
  while ((match = marker.exec(clean)) !== null) last = match;
  if (last) {
    const reply = fixCommonMojibake(clean.slice(last.index + last[0].length))
      .replace(/\n+tokens used[\s\S]*$/i, "")
      .trim();
    if (reply) return reply.slice(0, 4500);
  }
  return `ACK. Console brief #${brief.id} processed with status=${status}.`;
}

function promptForTask(task, prework, memoryContext = "") {
  const takeoverContext = task.takeover_eligible
    ? `\nTakeover context:\n- This task was stale for at least ${AUTONOMY_TAKEOVER_MINUTES} minutes and is now yours to finish.\n- Previous assigned agent: ${task.previous_assigned_agent || "unknown"}\n- Do not wait for the previous owner. Complete the work if safe, then leave a Mnemo handoff/brief so the team knows you handled it.\n`
    : "";
  return `You are ${AGENT} running inside the autonomous Mnemo agent loop.

You have claimed this durable autonomy task. Execute it end-to-end where responsibly possible.

Required workflow:
- Read Mnemo context first: session brief, department list, project rules, readiness board, open findings and recent actions.
- Check crossover gates: navigation, header/footer, links, auth, pricing, checkout, billing, VAT/OSS, legal, mobile, i18n, deploy, monitoring.
- Load active training rules and site contract before touching user-facing surfaces.
- Use mem_code_outline before opening large source files, then mem_code_unfold for the needed symbol/range.
- Route work to the strongest lane: deep code bugs and regressions need root-cause diagnosis; visual/browser/coordination risk needs the responsible visual or review lane.
- Do not invent project-specific headers, footers, colors, menus, buttons, or pricing logic outside project rules.
- Claim files before edits, respect existing changes, test concretely, and include evidence.
- ${REVIEWER_AGENT} is reviewer. Do not mark a live gate pass without evidence.
- If a correction occurs, immediately call mem_correction_capture; do not leave it as chat-only feedback.
- At the end write a Mnemo handoff and, if review is needed, brief ${REVIEWER_AGENT}.

${universalMemoryCaptureProtocol()}

${memoryContext}

${preWorkPlanContext(prework)}

${regressionGuardProtocol("autonomy task")}

${completionGuardProtocol("autonomy task")}

${siteContractGuardProtocol("autonomy task")}

Task JSON:
${JSON.stringify(task, null, 2)}
${takeoverContext}

If you cannot safely complete it, record the blocker and the next action.`;
}

function promptForInitiative(prework, memoryContext = "") {
  return `You are ${AGENT} running inside the autonomous Mnemo agent loop.

This is a rate-limited initiative cycle. The goal is not generic brainstorming.
The goal is to find project-relevant improvements, preserve them in Mnemo, and
ship a safe low-risk improvement when evidence says it is appropriate.

Owner-default policy:
- Useful, reversible, low-risk ideas inside your lane are pre-approved. Do not ask the owner what to do and then wait.
- If a safe improvement can be verified in this workspace, implement exactly one in this cycle, record the evidence, and brief the reviewer.
- If the best idea belongs to another department, create or preserve the finding/task and brief the assigned agent/reviewer with a concrete recommendation.
- Ask or wait only for destructive actions, live flips/deploys, secrets, customer data, auth, billing, checkout, VAT/OSS, legal, pricing, major brand/identity changes, public claims, or meaningful external cost.

First read compact context:
- mem_context_preview({agent_name:"${AGENT}", project:"<project-if-known>", task:"<this initiative cycle>", token_budget:1800})
- mem_session_brief({agent_name:"${AGENT}", token_budget:250})
- mem_recall_layered for owner taste, no-gos, current priorities, and recent corrections
- mem_agent_scorecard({agent_name:"${AGENT}"}) so you do not take initiative while blocked
- mem_agent_training_rules for active team/project lessons
- mem_department_list
- mem_firm_readiness_board
- mem_work_report_feed for the current project/agent, so you read finished work and recent reports before inventing new work
- mem_project_timeline_report for any project you consider touching, so you see blockers, recent work, open findings, and next actions first
- mem_proposals_pending({agent_name:"${AGENT}", limit:20})
- relevant project rules, project registry, open findings, recent handoffs, and recent actions

Complementary lane policy:
- If the best idea is a large code bug, regression, auth, billing, checkout, deploy, or crossover diagnosis, record/brief it for the deep diagnosis lane unless that is your lane and you can verify it end-to-end now.
- If the best idea is visual QA, browser verification, language parity, owner taste, or cross-lane coordination, keep it in the coordination/visual lane and attach evidence.
- Do not stall after raising an idea. Ship one safe lane-owned improvement, or create the finding/task and continue with the next safe item.

Generate 2-5 concrete proposals with mem_propose. Each idea must name the
project, the affected surface, and the expected verification. Do not duplicate
open proposals, open autonomy tasks, quality findings, or recent shipped work.

You must implement exactly one proposal in this cycle when all are true:
- mem_propose returns ship_eligible or the idea is clearly low-cost/high-fit
- it is a small bug fix, consistency cleanup, broken link fix, mobile polish,
  documentation/test improvement, or memory/coordination hygiene
- it does not touch auth, billing, checkout, VAT/OSS, legal, pricing, customer
  data, secrets, destructive operations, live flips, deploys, or major identity
  changes
- project rules are loaded and the change respects canonical navigation,
  headers, footers, colors, buttons, language, checkout, and pricing sources
- you can claim the files/modules, verify the change, and leave a clean handoff

If you ship an idea:
- claim files/modules before edits
- for website work, use mem_site_golden_check_plan and mem_site_golden_check_report
- make the smallest coherent change
- run concrete verification
- update the proposal with mem_proposal_update({status:"shipped"})
- record decision/finding/action evidence
- brief ${REVIEWER_AGENT}/the team with what changed and the test evidence

If no safe idea should ship now:
- leave the proposals queued
- if the work belongs to another department, create or preserve the finding/task and brief the assigned agent/reviewer instead of implementing it yourself
- brief ${REVIEWER_AGENT}/the team with the top idea, the responsible lane, why it should wait, and the recommended next action
- continue to the next safe item instead of stopping just because one idea needed review

Token rules:
- search small first; fetch full records only when needed
- no raw dumps or long transcripts
- max one project/repo touched per initiative cycle
- stop when there is no useful project-specific idea

${universalMemoryCaptureProtocol()}

Before your final answer, make sure Mnemo contains the proposal(s), outcome,
handoff, and any reviewer brief needed.

${memoryContext}

${preWorkPlanContext(prework)}

${regressionGuardProtocol("initiative cycle")}

${completionGuardProtocol("initiative cycle")}

${siteContractGuardProtocol("initiative cycle")}`;
}

function isAuthFailure(output, exitCode = 1, stderr = "") {
  const strongAuthFailure = /invalid_workspace_selected|auth(?:entication)? error|403 Forbidden|No API key provided|not logged in|login required|not authenticated|unauthorized|invalid api key|please (?:log|sign) in/i;
  if (exitCode === 0) return false;
  if (strongAuthFailure.test(String(stderr || ""))) return true;
  if (strongAuthFailure.test(String(output || ""))) return true;
  return false;
}

function needsContinuation(output) {
  return /Reached max turns|turn limit|max turns/i.test(String(output || ""));
}

function isStatusOnlySource(source) {
  const rawText = typeof source === "string" ? source : JSON.stringify(source || {});
  if (/^\s*(\[(status|team-status|info|fyi|update)\]|status\b|team-status\b|info\s*[:\-]|fyi\s*[:\-]|update\s*[:\-])/i.test(rawText.trim()) && /\b(no action required|no action needed|status only|nur status|keine aktion erforderlich|kein handlungsbedarf)\b/i.test(rawText)) return true;
  const text = typeof source === "string" ? source : JSON.stringify(source || {});
  const trimmed = text.trim();
  if (!/^\s*(\[(status|team-status|info|fyi|update)\]|status\b|team-status\b|info\s*[:\-]|fyi\s*[:\-]|update\s*[:\-])/i.test(trimmed)) return false;
  return !/\b(action required|todo|to do|next action|bitte\s+(fix|change|update|deploy|restart|prüf|pruef|check|mach|baue|implement)|please\s+(fix|change|update|deploy|restart|check|implement|build))\b/i.test(trimmed);
}

function briefMeta(brief) {
  try {
    if (!brief || !brief.meta_json) return {};
    return JSON.parse(brief.meta_json);
  } catch {
    return {};
  }
}

function isMissionConsoleBrief(brief) {
  if (!brief) return false;
  const meta = briefMeta(brief);
  const source = String(meta.source || meta.type || meta.channel || "").toLowerCase();
  const content = String(brief.content || "");
  const contentMarker = String(process.env.MNEMO_CONSOLE_CONTENT_MARKER || "").trim();
  return source.includes("mission-control-agent-console") ||
    source.includes("mission_agent_console") ||
    source.includes("mission-agent-console") ||
    (contentMarker && content.includes(contentMarker));
}

function isTelegramBridgeBrief(brief) {
  if (!brief) return false;
  const meta = briefMeta(brief);
  const source = String(meta.source || meta.type || "").toLowerCase();
  const channel = String(brief.channel || meta.channel || "").toLowerCase();
  return channel === "telegram" ||
    source.includes("telegram-bridge") ||
    source.includes("telegram_bridge") ||
    (meta.execution_required === true && meta.chat_id && meta.message_id);
}

function telegramBridgeReplyProtocol(brief) {
  if (!isTelegramBridgeBrief(brief)) return "";
  return `
Telegram execution bridge protocol:
- This brief came from Telegram and must be handled by the real ${AGENT} loop, not as chat-only text.
- Do real work when the request is executable. If it is unsafe or impossible, prove the blocker with concrete evidence and route the next step.
- Do not produce a long essay for Telegram. The owner needs a short operational reply.
- Your final stdout must include exactly one marker:
TELEGRAM_REPLY:
<short German reply for the Telegram chat>
- In that reply, say what was actually done, what evidence exists, and the next blocker only if one remains.
- Never say "ich mache" unless you actually started or queued the real work.
`;
}

function telegramBridgeReplyText(output, brief, status, fallback) {
  const clean = String(output || "").replace(/\u001b\[[0-9;]*m/g, "");
  const marker = /TELEGRAM_REPLY:\s*/ig;
  let match;
  let last = null;
  while ((match = marker.exec(clean)) !== null) last = match;
  if (last) {
    const reply = fixCommonMojibake(clean.slice(last.index + last[0].length))
      .replace(/\n+tokens used[\s\S]*$/i, "")
      .trim();
    if (reply) {
      const text = reply.slice(0, 3500);
      return status === "done" ? text : `Noch nicht fertig (${status}):\n${text}`;
    }
  }
  const fallbackText = fixCommonMojibake(String(fallback || "").trim())
    .replace(/\n+tokens used[\s\S]*$/i, "")
    .trim();
  if (fallbackText) return fallbackText.slice(0, 3500);
  return `Auftrag #${brief.id} verarbeitet. Status: ${status}.`;
}

function missionConsoleThreadId(brief) {
  const meta = briefMeta(brief);
  return String(meta.thread_id || meta.console_thread_id || `mission-agent-${AGENT}`).trim();
}

function missionConsoleReplyProtocol(brief) {
  if (!isMissionConsoleBrief(brief)) return "";
  const threadId = missionConsoleThreadId(brief);
  return `
${CONSOLE_NAME} console protocol:
- This brief came from the owner's ${CONSOLE_NAME} console. Treat it as an interactive command, not as a fire-and-forget work ticket.
- You must write a short reply back to the owner in Mnemo so the console has a real answer thread.
- Use: mem_brief_drop({agent_name:"${OWNER_AGENT}", source_agent:"${AGENT}", content:"<short concrete reply>", meta:{type:"mission_agent_console_reply", source:"mission-control-agent-console", thread_id:"${threadId}", reply_to_brief_id:${brief.id}, responding_agent:"${AGENT}"}})
- If the command starts real work, reply with an ACK/status first, then continue. At completion, send a final reply with result, evidence, blockers, and next action.
- Keep replies concise and operational. Do not only mark the incoming brief done.
`;
}

async function dropMissionConsoleAutoReply(brief, status, detail, extra = {}) {
  if (DRY_RUN || !isMissionConsoleBrief(brief)) return null;
  const threadId = missionConsoleThreadId(brief);
  const safeDetail = String(detail || "").trim().slice(0, 4500);
  const content = [
    `## ${AGENT} reply`,
    "",
    `Status: ${status}`,
    `Brief: #${brief.id}`,
    safeDetail ? `\n${safeDetail}` : "",
    "",
    `Thread: ${threadId}`
  ].filter(Boolean).join("\n");
  const meta = Object.assign({
    type: "mission_agent_console_reply",
    source: "mission-control-agent-console",
    thread_id: threadId,
    reply_to_brief_id: brief.id,
    responding_agent: AGENT,
    status
  }, extra || {});
  const reply = await callTool("mem_brief_drop", {
    agent_name: OWNER_AGENT,
    source_agent: AGENT,
    content,
    meta
  }).catch((e) => ({ error: String(e.message || e) }));
  await callTool("mem_transcript_log", {
    source: "mission-control",
    channel: `agent-console:${threadId}`,
    direction: "outbound",
    speaker: AGENT,
    content,
    ref_kind: "agent_brief",
    ref_id: String(brief.id),
    meta
  }).catch(() => {});
  return reply;
}

function isNonExecutableBrief(brief) {
  if (!brief) return false;
  const meta = briefMeta(brief);
  const metaStatusOnly = meta && typeof meta === "object" && (
    meta.no_action ||
    meta.status_only ||
    meta.idle_cycle ||
    meta.autonomy_task_id ||
    (meta.type && /^(team_status|deploy_status|status|status_update|info)$/i.test(String(meta.type))) ||
    (meta.status && /^(done|ok|complete|completed|deployed|verified|info|status|update|team_update|team-update)$/i.test(String(meta.status)))
  );
  return !!(metaStatusOnly || isIdleCycle(brief) || isStatusOnlySource(brief.content || ""));
}

function strictCompletionNeeded(kind, source) {
  if (!REQUIRE_COMPLETION_GUARD) return false;
  if (kind === "autonomy") return true;
  if (isStatusOnlySource(source)) return false;
  const text = typeof source === "string" ? source : JSON.stringify(source || {});
  return /\b(code|coding|codieren|program|programmieren|implementation|implement|build|fix|bug|change|update|edit|refactor|deploy|server|config|api|endpoint|backend|frontend|database|db|schema|migration|function|component|route|page|css|html|javascript|typescript|js|ts|react|node|test|lint|typecheck|build)\b/i.test(text);
}

function strictRegressionNeeded(kind, source) {
  if (!REQUIRE_REGRESSION_GUARD) return false;
  if (kind === "autonomy") return true;
  if (isStatusOnlySource(source)) return false;
  const text = typeof source === "string" ? source : JSON.stringify(source || {});
  return /\b(fix|change|update|edit|deploy|live|page|route|link|menu|menue|nav|navigation|header|headder|footer|logo|dark|light|dunkel|hell|theme|css|mobile|mobil|responsive|language|locale|translation|sprache|sprachen|i18n|impressum|privacy|datenschutz|terms|agb|legal|auth|login|signup|pricing|price|preise|checkout|billing|vat|oss|stripe|crossover|frontend|landing)\b/i.test(text);
}

function strictSiteContractNeeded(kind, source) {
  if (!REQUIRE_SITE_CONTRACT_GUARD) return false;
  if (isStatusOnlySource(source)) return false;
  const text = typeof source === "string" ? source : JSON.stringify(source || {});
  return /\b(all pages|alle seiten|site|website|webseite|page|pages|seite|seiten|route|routes|link|links|menu|menue|nav|navigation|header|headder|footer|logo|logos|dark|light|dunkel|hell|style|stil|same header|gleiche?r? header|canonical|contract|crossover|language|locale|sprache|sprachen|i18n|impressum|datenschutz|privacy|terms|agb|legal|mobile|mobil|desktop)\b/i.test(text);
}

function deepDiagnosisLaneNeeded(kind, source) {
  if (isStatusOnlySource(source)) return false;
  const text = typeof source === "string" ? source : JSON.stringify(source || {});
  if (kind === "autonomy" && /\b(code|bug|fix|regression|api|backend|database|db|schema|auth|login|billing|checkout|stripe|deploy|crossover|all pages|alle seiten|portal|route|server)\b/i.test(text)) return true;
  return /\b(large codebase|gro(?:ss|ß)e codebasis|root cause|root-cause|bug|regression|breaks?|kaputt|api|backend|database|db|schema|migration|auth|login|billing|checkout|stripe|webhook|deploy|server|crossover|all portals|alle portale|superadmin|session|cookie|sso)\b/i.test(text);
}

function strictPreWorkNeeded(kind, source) {
  if (!REQUIRE_PRE_WORK_GUARD) return false;
  if (kind === "brief" || kind === "autonomy" || kind === "initiative") return true;
  return strictCompletionNeeded(kind, source) || strictRegressionNeeded(kind, source) || strictSiteContractNeeded(kind, source);
}

function regressionFamilies(source) {
  const text = typeof source === "string" ? source : JSON.stringify(source || {});
  return {
    ui: /\b(page|route|menu|menue|nav|navigation|header|headder|footer|logo|dark|light|dunkel|hell|theme|css|mobile|mobil|responsive|frontend|landing)\b/i.test(text),
    i18n: /\b(language|locale|translation|sprache|sprachen|i18n|impressum|privacy|datenschutz|terms|agb|legal)\b/i.test(text),
    links: /\b(link|route|menu|menue|nav|navigation|header|headder|footer|impressum|privacy|datenschutz|terms|agb)\b/i.test(text),
    theme: /\b(logo|dark|light|dunkel|hell|theme|header|headder)\b/i.test(text),
    crossover: /\b(auth|login|signup|pricing|price|preise|checkout|billing|vat|oss|stripe|crossover|legal|impressum|datenschutz)\b/i.test(text)
  };
}

function extractJsonObject(text, start) {
  const s = String(text || "");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let begin = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (begin < 0) {
      if (ch === "{") {
        begin = i;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return s.slice(begin, i + 1);
  }
  return "";
}

function parsePreWorkGuard(output) {
  const marker = "MNEMO_PRE_WORK_GUARD:";
  const s = String(output || "");
  const idx = s.lastIndexOf(marker);
  if (idx < 0) return null;
  const json = extractJsonObject(s, idx + marker.length);
  if (!json) return { parse_error: "json_object_missing" };
  try {
    return JSON.parse(json);
  } catch (e) {
    return { parse_error: e.message, raw: json.slice(0, 500) };
  }
}

function parseRegressionGuard(output) {
  const marker = "MNEMO_REGRESSION_GUARD:";
  const s = String(output || "");
  const idx = s.lastIndexOf(marker);
  if (idx < 0) return null;
  const json = extractJsonObject(s, idx + marker.length);
  if (!json) return { parse_error: "json_object_missing" };
  try {
    return JSON.parse(json);
  } catch (e) {
    return { parse_error: e.message, raw: json.slice(0, 500) };
  }
}

function parseCompletionGuard(output) {
  const marker = "MNEMO_COMPLETION_GUARD:";
  const s = String(output || "");
  const idx = s.lastIndexOf(marker);
  if (idx < 0) return null;
  const json = extractJsonObject(s, idx + marker.length);
  if (!json) return { parse_error: "json_object_missing" };
  try {
    return JSON.parse(json);
  } catch (e) {
    return { parse_error: e.message, raw: json.slice(0, 500) };
  }
}

function parseSiteContractGuard(output) {
  const marker = "MNEMO_SITE_CONTRACT_GUARD:";
  const s = String(output || "");
  const idx = s.lastIndexOf(marker);
  if (idx < 0) return null;
  const json = extractJsonObject(s, idx + marker.length);
  if (!json) return { parse_error: "json_object_missing" };
  try {
    return JSON.parse(json);
  } catch (e) {
    return { parse_error: e.message, raw: json.slice(0, 500) };
  }
}

function listLen(v) {
  return Array.isArray(v) ? v.filter(x => String(x || "").trim()).length : 0;
}

function evaluatePreWorkGuard(kind, source, output) {
  const strict = strictPreWorkNeeded(kind, source);
  const needsCoding = strictCompletionNeeded(kind, source);
  const needsRegression = strictRegressionNeeded(kind, source);
  const needsSiteContract = strictSiteContractNeeded(kind, source);
  const needsDeepDiagnosis = deepDiagnosisLaneNeeded(kind, source);
  const project = sourceProject(source);
  if (!REQUIRE_PRE_WORK_GUARD) return { guard_kind: "pre_work", required: false, strict, completionAllowed: true, reason: "disabled" };
  const guard = parsePreWorkGuard(output);
  if (!guard) {
    return { guard_kind: "pre_work", required: strict, strict, completionAllowed: !strict, status: "missing", reason: strict ? "missing MNEMO_PRE_WORK_GUARD" : "not required for trivial read-only/status work" };
  }
  if (guard.parse_error) {
    return { guard_kind: "pre_work", required: true, strict, completionAllowed: false, status: "invalid", reason: "invalid MNEMO_PRE_WORK_GUARD JSON: " + guard.parse_error, guard };
  }
  const status = String(guard.status || "").toLowerCase();
  const blockers = [];
  const contextText = Array.isArray(guard.context_to_load) ? guard.context_to_load.join(" ") : String(guard.context_to_load || "");
  const plannedCheckText = Array.isArray(guard.planned_checks) ? guard.planned_checks.join(" ") : String(guard.planned_checks || "");
  const diagnosisPlanText = [
    guard.context_to_load,
    guard.dependencies_to_inspect,
    guard.files_or_modules_to_claim,
    guard.blast_radius,
    guard.planned_checks,
    guard.stop_conditions
  ].map(v => Array.isArray(v) ? v.join(" ") : String(v || "")).join(" ");
  if (!["pass", "blocked", "not_applicable"].includes(status)) blockers.push("status must be pass, blocked, or not_applicable");
  if (strict && status === "not_applicable") blockers.push("not_applicable is forbidden for loop work; write a concrete plan or block");
  if (status === "pass") {
    if (!String(guard.task_summary || "").trim()) blockers.push("task_summary required");
    if (listLen(guard.acceptance_criteria) === 0) blockers.push("acceptance_criteria required");
    if (listLen(guard.context_to_load) === 0) blockers.push("context_to_load required");
    if (project && !hasTimelineReportPlan(contextText)) blockers.push("project work report read required: load mem_project_timeline_report before starting work");
    if (!hasHandoffReadPlan(contextText)) blockers.push("recent handoffs/work reports must be loaded before starting work");
    if (!hasRecentActionsPlan(contextText)) blockers.push("recent actions report must be loaded before starting work");
    if (listLen(guard.dependencies_to_inspect) === 0) blockers.push("dependencies_to_inspect required");
    if (needsCoding && listLen(guard.files_or_modules_to_claim) === 0) blockers.push("files_or_modules_to_claim required for coding/config/deploy work");
    if (needsRegression && listLen(guard.blast_radius) === 0) blockers.push("blast_radius required for change/live/regression-sensitive work");
    if (needsSiteContract && listLen(guard.site_contract_surfaces) === 0) blockers.push("site_contract_surfaces required for website/header/menu/footer/link/logo/language work");
    if (!["low", "medium", "high"].includes(String(guard.risk_level || "").toLowerCase())) blockers.push("risk_level must be low, medium, or high");
    if (listLen(guard.planned_checks) === 0) blockers.push("planned_checks required");
    if (listLen(guard.stop_conditions) === 0) blockers.push("stop_conditions required");
    if (/\b(owner|user|reviewer|team)\b.{0,40}\b(check|pr(?:ue|\u00fc)f|testen|test|schau)\b|\b(user should check|owner should check|check mal)\b/i.test(plannedCheckText)) blockers.push("planned_checks must be agent-run checks, not a request for the owner/team to check manually");
    if (needsDeepDiagnosis && !/\b(agent|diagnosis|diagnose|root.?cause|ursache|dependency|dependenc(?:y|ies)|call.?graph|caller|shared module|code.?outline|code.?unfold|regression perimeter|reviewer|handoff)\b/i.test(diagnosisPlanText)) {
      blockers.push("deep code/regression work must plan the diagnosis lane: root cause, dependency path, shared callers/modules, regression perimeter, and reviewer/handoff evidence");
    }
    if (listLen(guard.blocked_reason) > 0) blockers.push("blocked_reason must be empty for pass");
  }
  if (status === "blocked" && listLen(guard.blocked_reason) === 0) blockers.push("blocked status requires blocked_reason");
  const completionAllowed = blockers.length === 0 && (status === "pass" || (!strict && status === "not_applicable"));
  return {
    guard_kind: "pre_work",
    required: true,
    strict,
    completionAllowed,
    status: status || "invalid",
    reason: blockers.join("; ") || (completionAllowed ? "pre-work guard passed" : "pre-work guard blocked execution"),
    guard
  };
}

function evaluateRegressionGuard(kind, source, output) {
  const strict = strictRegressionNeeded(kind, source);
  const families = regressionFamilies(source);
  if (!REQUIRE_REGRESSION_GUARD) return { guard_kind: "regression", required: false, strict, completionAllowed: true, reason: "disabled" };
  const guard = parseRegressionGuard(output);
  if (!guard) {
    return { guard_kind: "regression", required: strict, strict, completionAllowed: !strict, status: "missing", reason: strict ? "missing MNEMO_REGRESSION_GUARD" : "not required for read-only/status work" };
  }
  if (guard.parse_error) {
    return { guard_kind: "regression", required: true, strict, completionAllowed: false, status: "invalid", reason: "invalid MNEMO_REGRESSION_GUARD JSON: " + guard.parse_error, guard };
  }
  const status = String(guard.status || "").toLowerCase();
  const blockers = [];
  if (!["pass", "blocked", "not_applicable"].includes(status)) blockers.push("status must be pass, blocked, or not_applicable");
  if (strict && status === "not_applicable") blockers.push("not_applicable is forbidden for UI/live/link/i18n/theme/legal/auth/billing/pricing/autonomy work");
  if (status === "pass") {
    if (strict && listLen(guard.baseline_checks) === 0) blockers.push("baseline_checks required before edits for strict work");
    if (listLen(guard.post_change_checks) === 0) blockers.push("post_change_checks required");
    if (listLen(guard.changed_surfaces) === 0 && listLen(guard.changed_files) === 0) blockers.push("changed_surfaces or changed_files required");
    if (strict && listLen(guard.cross_checks) === 0) blockers.push("cross_checks required for strict work");
    if (strict && families.ui && guard.mobile_checked !== true) blockers.push("mobile_checked=true required for UI/site work");
    if (strict && families.ui && guard.desktop_checked !== true) blockers.push("desktop_checked=true required for UI/site work");
    if (strict && families.i18n && listLen(guard.languages_checked) === 0) blockers.push("languages_checked required for language/legal/public page work");
    if (strict && families.links && listLen(guard.links_checked) === 0) blockers.push("links_checked required for route/nav/header/footer/legal link work");
    if (strict && families.theme && listLen(guard.themes_checked) === 0) blockers.push("themes_checked required for logo/header/dark/light work");
    if (strict && families.crossover && listLen(guard.cross_checks) === 0) blockers.push("cross_checks required for crossover/auth/pricing/billing/legal work");
  }
  if (status === "blocked" && listLen(guard.blockers) === 0 && listLen(guard.remaining_risks) === 0) blockers.push("blocked status requires blockers or remaining_risks");
  const completionAllowed = blockers.length === 0 && (status === "pass" || (!strict && status === "not_applicable"));
  return {
    guard_kind: "regression",
    required: true,
    strict,
    completionAllowed,
    status: status || "invalid",
    reason: blockers.join("; ") || (completionAllowed ? "regression guard passed" : "regression guard blocked completion"),
    families,
    guard
  };
}

function evaluateCompletionGuard(kind, source, output) {
  const strict = strictCompletionNeeded(kind, source);
  if (!REQUIRE_COMPLETION_GUARD) return { guard_kind: "completion", required: false, strict, completionAllowed: true, reason: "disabled" };
  const guard = parseCompletionGuard(output);
  if (!guard) {
    return { guard_kind: "completion", required: strict, strict, completionAllowed: !strict, status: "missing", reason: strict ? "missing MNEMO_COMPLETION_GUARD" : "not required for read-only/status work" };
  }
  if (guard.parse_error) {
    return { guard_kind: "completion", required: true, strict, completionAllowed: false, status: "invalid", reason: "invalid MNEMO_COMPLETION_GUARD JSON: " + guard.parse_error, guard };
  }
  const status = String(guard.status || "").toLowerCase();
  const blockers = [];
  if (!["pass", "blocked", "not_applicable"].includes(status)) blockers.push("status must be pass, blocked, or not_applicable");
  if (strict && status === "not_applicable") blockers.push("not_applicable is forbidden for coding/programming/config/deploy/autonomy work");
  if (status === "pass") {
    if (guard.task_understood !== true) blockers.push("task_understood=true required");
    if (listLen(guard.dependencies_checked) === 0) blockers.push("dependencies_checked required");
    if (listLen(guard.acceptance_checks) === 0) blockers.push("acceptance_checks required");
    if (listLen(guard.tests_run) === 0) blockers.push("tests_run or explicit verification commands required");
    if (listLen(guard.self_review) === 0) blockers.push("self_review required");
    if (listLen(guard.unrelated_changes) > 0) blockers.push("unrelated_changes must be empty for pass");
    if (listLen(guard.remaining_work) > 0) blockers.push("remaining_work must be empty for pass");
    if (listLen(guard.blockers) > 0) blockers.push("blockers must be empty for pass");
  }
  if (status === "blocked" && listLen(guard.blockers) === 0 && listLen(guard.remaining_work) === 0) blockers.push("blocked status requires blockers or remaining_work");
  const completionAllowed = blockers.length === 0 && (status === "pass" || (!strict && status === "not_applicable"));
  return {
    guard_kind: "completion",
    required: true,
    strict,
    completionAllowed,
    status: status || "invalid",
    reason: blockers.join("; ") || (completionAllowed ? "completion guard passed" : "completion guard blocked completion"),
    guard
  };
}

function evaluateSiteContractGuard(kind, source, output) {
  const strict = strictSiteContractNeeded(kind, source);
  const families = regressionFamilies(source);
  if (!REQUIRE_SITE_CONTRACT_GUARD) return { guard_kind: "site_contract", required: false, strict, completionAllowed: true, reason: "disabled" };
  const guard = parseSiteContractGuard(output);
  if (!guard) {
    return { guard_kind: "site_contract", required: strict, strict, completionAllowed: !strict, status: "missing", reason: strict ? "missing MNEMO_SITE_CONTRACT_GUARD" : "not required for non-site work" };
  }
  if (guard.parse_error) {
    return { guard_kind: "site_contract", required: true, strict, completionAllowed: false, status: "invalid", reason: "invalid MNEMO_SITE_CONTRACT_GUARD JSON: " + guard.parse_error, guard };
  }
  const status = String(guard.status || "").toLowerCase();
  const blockers = [];
  if (!["pass", "blocked", "not_applicable"].includes(status)) blockers.push("status must be pass, blocked, or not_applicable");
  if (strict && status === "not_applicable") blockers.push("not_applicable is forbidden for website/page/header/menu/footer/link/logo/language/style work");
  if (status === "pass") {
    if (!String(guard.canonical_source || "").trim()) blockers.push("canonical_source required");
    if (listLen(guard.target_urls) === 0) blockers.push("target_urls required");
    if (listLen(guard.pages_checked) === 0) blockers.push("pages_checked required");
    if (guard.header_style_checked !== true && (families.ui || strict)) blockers.push("header_style_checked=true required");
    if (guard.menu_structure_checked !== true && (families.links || families.ui || strict)) blockers.push("menu_structure_checked=true required");
    if (guard.footer_checked !== true && (families.links || families.i18n || strict)) blockers.push("footer_checked=true required");
    if (listLen(guard.links_checked) === 0 && (families.links || strict)) blockers.push("links_checked required");
    if (listLen(guard.locale_routes_checked) === 0 && families.i18n) blockers.push("locale_routes_checked required for language/legal work");
    if (listLen(guard.logos_checked) === 0 && families.theme) blockers.push("logos_checked required for logo/dark/light/header work");
    if (guard.mobile_checked !== true && (families.ui || strict)) blockers.push("mobile_checked=true required");
    if (guard.desktop_checked !== true && (families.ui || strict)) blockers.push("desktop_checked=true required");
    if (guard.visual_quality_checked !== true && (families.ui || strict)) blockers.push("visual_quality_checked=true required for UI/site work");
    if (guard.layout_overflow_checked !== true && (families.ui || strict)) blockers.push("layout_overflow_checked=true required for UI/site work");
    if (listLen(guard.screenshots) === 0 && (families.ui || strict)) blockers.push("screenshots/browser evidence required for UI/site work");
    if (listLen(guard.audit_commands) === 0) blockers.push("audit_commands required");
    if (listLen(guard.forbidden_domain_leaks) > 0) blockers.push("forbidden_domain_leaks must be empty for pass");
    if (listLen(guard.remaining_risks) > 0) blockers.push("remaining_risks must be empty for pass");
    if (listLen(guard.blockers) > 0) blockers.push("blockers must be empty for pass");
  }
  if (status === "blocked" && listLen(guard.blockers) === 0 && listLen(guard.remaining_risks) === 0) blockers.push("blocked status requires blockers or remaining_risks");
  const completionAllowed = blockers.length === 0 && (status === "pass" || (!strict && status === "not_applicable"));
  return {
    guard_kind: "site_contract",
    required: true,
    strict,
    completionAllowed,
    status: status || "invalid",
    reason: blockers.join("; ") || (completionAllowed ? "site contract guard passed" : "site contract guard blocked completion"),
    families,
    guard
  };
}

function guardList(guards) {
  return (Array.isArray(guards) ? guards : [guards]).filter(Boolean);
}

function blockingGuard(guards) {
  return guardList(guards).find(g => g.required && !g.completionAllowed);
}

function guardsAllowCompletion(guards) {
  return !blockingGuard(guards);
}

function guardActionStatus(guards, fallback) {
  const guard = blockingGuard(guards);
  if (!guard) return fallback;
  const prefix = guard.guard_kind || "guard";
  if (guard.status === "missing") return `${prefix}_guard_missing`;
  if (guard.status === "invalid") return `${prefix}_guard_invalid`;
  return `${prefix}_guard_blocked`;
}

function guardedRunStatus(run, guards, ok) {
  if (run.authFailure) return "auth_failed";
  if (run.needsContinuation) return "needs_continuation";
  return guardActionStatus(guards, ok ? "ok" : (run.exitCode === 0 ? "ok" : "failed"));
}

function guardOutcome(outcome, guards) {
  const guard = blockingGuard(guards);
  if (!guard) return outcome;
  const label = guard.guard_kind === "pre_work" ? "Pre-work guard" : (guard.guard_kind === "completion" ? "Completion guard" : (guard.guard_kind === "site_contract" ? "Site contract guard" : "Regression guard"));
  const subject = guard.guard_kind === "pre_work" ? "execution" : "completion";
  return `${label} blocked ${subject}: ${guard.reason}\n\nTail:\n${outcome}`;
}

function summarizeGuard(guard, label) {
  if (!guard) return `${label}: not-run`;
  return `${label}: ${guard.status || "unknown"}${guard.reason ? ` (${guard.reason})` : ""}`;
}

function guardChangedFiles(guards) {
  return uniqueList(guardList(guards).flatMap(g => Array.isArray(g && g.guard && g.guard.changed_files) ? g.guard.changed_files : []));
}

function guardTests(guards) {
  return uniqueList(guardList(guards).flatMap(g => Array.isArray(g && g.guard && g.guard.tests_run) ? g.guard.tests_run : []));
}

function guardRemainingWork(guards) {
  return uniqueList(guardList(guards).flatMap(g => {
    const raw = g && g.guard || {};
    return []
      .concat(Array.isArray(raw.remaining_work) ? raw.remaining_work : [])
      .concat(Array.isArray(raw.blockers) ? raw.blockers : [])
      .concat(Array.isArray(raw.remaining_risks) ? raw.remaining_risks : []);
  }));
}

async function writeAutoWorkReport(kind, target, source, run, status, guards, prework) {
  const project = sourceProject(source) || null;
  const summarySource = typeof source === "string"
    ? source
    : (source && (source.title || source.task || source.summary || source.reason)) || `${kind} ${target}`;
  const changedFiles = guardChangedFiles(guards);
  const tests = guardTests(guards);
  const blockers = guardRemainingWork(guards);
  const nextActions = status === "done"
    ? ["Read this report before follow-up work so the same task is not repeated."]
    : (blockers.length ? blockers.slice(0, 6) : ["Continue from the blocker recorded in this report before starting parallel work."]);
  const summaryLines = [
    `Auto work report: ${AGENT} ${kind} ${target} -> ${status}.`,
    `Task: ${compactLine(summarySource, 220)}`,
    summarizeGuard(prework, "pre_work"),
    summarizeGuard(guards.find(g => g.guard_kind === "site_contract"), "site_contract"),
    summarizeGuard(guards.find(g => g.guard_kind === "regression"), "regression"),
    summarizeGuard(guards.find(g => g.guard_kind === "completion"), "completion"),
    changedFiles.length ? `Changed files: ${changedFiles.join(", ")}` : "Changed files: none reported",
    tests.length ? `Checks: ${tests.join(" | ")}` : "Checks: none reported",
    blockers.length ? `Open blockers: ${blockers.join(" | ")}` : "Open blockers: none"
  ];
  const completedBriefIds = kind === "brief" && status === "done" ? [target] : [];
  const completedTaskIds = kind === "autonomy" && status === "done" ? [target] : [];
  try {
    await callTool("mem_session_handoff", {
      agent_name: AGENT,
      project,
      summary: summaryLines.join("\n"),
      changed_files: changedFiles,
      tests,
      deploys: [],
      blockers,
      next_actions: nextActions,
      release_claims: false,
      completed_brief_ids: completedBriefIds,
      completed_task_ids: completedTaskIds,
      meta: {
        auto_loop_report: true,
        loop_kind: kind,
        loop_target: target,
        loop_status: status,
        loop_engine: ENGINE,
        loop_finished_at: new Date().toISOString(),
        source_brief_id: completedBriefIds[0] || null,
        autonomy_task_id: completedTaskIds[0] || null
      }
    });
  } catch (e) {
    log("auto work report failed", { kind, target, status, error: e.message });
  }
}

function runAgent(prompt, kind, target, options = {}) {
  if (DRY_RUN) {
    log("dry-run: would run agent", { kind, target, engine: ENGINE_LABEL, runner: ENGINE });
    return { exitCode: 0, output: "dry-run" };
  }
  const locked = activeLock();
  if (locked.active) return { exitCode: 2, output: `lock exists: ${LOCK_PATH} (${locked.reason})` };
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ agent: AGENT, kind, target, pid: process.pid, started_at: new Date().toISOString() }));
  try {
    const command = ENGINE === "print-cli" ? EXTERNAL_AGENT_BIN : AGENT_BIN;
    const agentArgs = ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", WORKSPACE, "-"];
    const args = ENGINE === "print-cli"
      ? (options.planOnly
        ? ["--print", "-", "--permission-mode", "plan", "--add-dir", WORKSPACE, "--max-turns", String(PREWORK_MAX_TURNS), "--output-format", "text"]
        : ["--print", "-", "--dangerously-skip-permissions", "--add-dir", WORKSPACE, "--max-turns", String(EXTERNAL_AGENT_MAX_TURNS), "--output-format", "text"])
      : agentArgs;
    log("agent start", { kind, target, workspace: WORKSPACE, engine: ENGINE_LABEL, runner: ENGINE, command, plan_only: !!options.planOnly });
    const res = spawnSync(command, args, {
      input: prompt,
      encoding: "utf8",
      timeout: AGENT_TIMEOUT_MIN * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        MNEMO_URL,
        MNEMO_AGENT: AGENT,
        MNEMO_DEFAULT_AGENT: AGENT,
        MNEMO_PREWORK_PHASE: options.planOnly ? "1" : "0",
        IS_SANDBOX: "1"
      })
    });
    const stderr = res.stderr || "";
    const output = `${res.stdout || ""}${stderr}`;
    const exitCode = res.status == null ? (res.error ? 1 : 0) : res.status;
    log("agent finish", { kind, target, exitCode, engine: ENGINE_LABEL, runner: ENGINE });
    const finalOutput = res.error ? `${output}\n${res.error.message}` : output;
    return { exitCode, output: finalOutput, authFailure: isAuthFailure(finalOutput, exitCode, stderr), needsContinuation: needsContinuation(finalOutput) };
  } finally {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
  }
}

function activeLock() {
  if (!fs.existsSync(LOCK_PATH)) return { active: false };
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")); } catch {}
  const pid = lock && Number(lock.pid);
  const started = lock && lock.started_at ? Date.parse(lock.started_at) : 0;
  const ageMs = started ? Date.now() - started : Number.MAX_SAFE_INTEGER;
  if (pid && Number.isFinite(pid)) {
    try {
      process.kill(pid, 0);
      if (ageMs < AGENT_TIMEOUT_MIN * 60 * 1000 + 5 * 60 * 1000) return { active: true, reason: `pid ${pid} alive` };
    } catch {}
  }
  try { fs.unlinkSync(LOCK_PATH); log("removed stale lock", { path: LOCK_PATH, pid: pid || null }); } catch {}
  return { active: false };
}

function readInitiativeState() {
  try {
    if (!fs.existsSync(INITIATIVE_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(INITIATIVE_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeInitiativeState(patch) {
  try {
    fs.mkdirSync(path.dirname(INITIATIVE_STATE_PATH), { recursive: true });
    const current = readInitiativeState();
    fs.writeFileSync(INITIATIVE_STATE_PATH, JSON.stringify(Object.assign({}, current, patch), null, 2));
  } catch (e) {
    log("initiative state write failed", { error: e.message, path: INITIATIVE_STATE_PATH });
  }
}

function readAutonomySweepState() {
  try {
    if (!fs.existsSync(AUTONOMY_SWEEP_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(AUTONOMY_SWEEP_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeAutonomySweepState(patch) {
  try {
    fs.mkdirSync(path.dirname(AUTONOMY_SWEEP_STATE_PATH), { recursive: true });
    const current = readAutonomySweepState();
    fs.writeFileSync(AUTONOMY_SWEEP_STATE_PATH, JSON.stringify(Object.assign({}, current, patch), null, 2));
  } catch (e) {
    log("autonomy sweep state write failed", { error: e.message, path: AUTONOMY_SWEEP_STATE_PATH });
  }
}

function readEngineState() {
  try {
    if (!fs.existsSync(ENGINE_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(ENGINE_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeEngineState(patch) {
  try {
    fs.mkdirSync(path.dirname(ENGINE_STATE_PATH), { recursive: true });
    const current = readEngineState();
    fs.writeFileSync(ENGINE_STATE_PATH, JSON.stringify(Object.assign({}, current, patch), null, 2));
  } catch (e) {
    log("engine state write failed", { error: e.message, path: ENGINE_STATE_PATH });
  }
}

function engineCooldown() {
  const state = readEngineState();
  const untilMs = Date.parse(state.unavailable_until || "");
  if (!Number.isFinite(untilMs) || Date.now() >= untilMs) return { blocked: false };
  return {
    blocked: true,
    unavailable_until: state.unavailable_until,
    reason: state.reason || "agent engine unavailable",
    last_kind: state.last_kind || null,
    last_target: state.last_target || null
  };
}

function clearRuntimeBlockNotice() {
  lastRuntimeBlockSignature = null;
}

async function reportRuntimeBlock(kind, target, reason, details = {}) {
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) return false;
  const signature = JSON.stringify({
    kind: kind || "runtime",
    target: target || null,
    reason: normalizedReason,
    type: details.type || "runtime_block"
  });
  if (lastRuntimeBlockSignature === signature) return false;
  lastRuntimeBlockSignature = signature;
  const summary = [
    `Runtime block: ${AGENT} cannot execute work.`,
    `Reason: ${normalizedReason}`,
    `Scope: ${kind || "runtime"}${target != null ? ` ${target}` : ""}`,
    `Type: ${details.type || "runtime_block"}`,
    `Engine: ${ENGINE_LABEL}`,
    details.until ? `Retry after: ${details.until}` : null,
    details.tail ? `Tail: ${compactLine(details.tail, 500)}` : null
  ].filter(Boolean).join("\n");
  const nextActions = details.type === "engine_auth"
    ? [
        `Restore ${ENGINE_LABEL} authentication for ${AGENT}.`,
        "Restart the agent loop after auth is healthy."
      ]
    : [
        "Restore Mnemo daemon/MCP connectivity.",
        "Re-run runtime preflight before allowing new work."
      ];
  await callTool("mem_session_handoff", {
    agent_name: AGENT,
    summary,
    changed_files: [],
    tests: [],
    blockers: [normalizedReason],
    next_actions: nextActions
  }).catch(() => {});
  return true;
}

async function markEngineAuthFailure(run, kind, target) {
  const until = new Date(Date.now() + ENGINE_AUTH_COOLDOWN_MIN * 60 * 1000).toISOString();
  const reason = `${ENGINE_LABEL} auth failed; work paused to avoid retry churn`;
  const failureTail = tail(run && run.output, ACTION_TAIL_MAX);
  writeEngineState({
    status: "auth_failed",
    reason,
    unavailable_until: until,
    last_kind: kind,
    last_target: target,
    last_tail: failureTail,
    updated_at: new Date().toISOString()
  });
  await registerHeartbeat("blocked", {
    current_task: `${kind}#${target}`,
    blocked_on: reason,
    engine_blocked: true,
    engine_block_reason: reason,
    engine_unavailable_until: until,
    runtime_preflight: lastRuntimePreflight
  });
  await reportRuntimeBlock(kind, target, reason, {
    type: "engine_auth",
    until,
    tail: failureTail
  });
  log("engine auth cooldown", { kind, target, engine: ENGINE_LABEL, runner: ENGINE, unavailable_until: until });
}

function clearEngineFailure() {
  const state = readEngineState();
  if (state.status) {
    writeEngineState({ status: "ok", reason: null, unavailable_until: null, updated_at: new Date().toISOString() });
  }
  clearRuntimeBlockNotice();
}

function initiativeDue() {
  if (!INITIATIVE_ENABLED) return { due: false, reason: "disabled" };
  if (INITIATIVE_FORCE) return { due: true, reason: "forced" };
  const state = readInitiativeState();
  const lastRaw = state.last_started_at || state.last_finished_at || "";
  const lastMs = Date.parse(lastRaw);
  if (!Number.isFinite(lastMs)) return { due: true, reason: "never_ran" };
  const intervalMs = INITIATIVE_INTERVAL_MIN * 60 * 1000;
  const nextMs = lastMs + intervalMs;
  if (Date.now() >= nextMs) return { due: true, reason: "interval_elapsed", last_at: lastRaw };
  return { due: false, reason: "cooldown", next_at: new Date(nextMs).toISOString(), last_at: lastRaw };
}

function autonomySweepDue(reason) {
  if (NO_AUTONOMY) return { due: false, reason: "autonomy_disabled" };
  if (!AUTONOMY_SWEEP_ENABLED) return { due: false, reason: "disabled" };
  const state = readAutonomySweepState();
  const lastRaw = state.last_started_at || state.last_finished_at || "";
  const lastMs = Date.parse(lastRaw);
  if (!Number.isFinite(lastMs)) return { due: true, reason: reason || "never_ran" };
  const intervalMs = AUTONOMY_SWEEP_INTERVAL_MIN * 60 * 1000;
  const nextMs = lastMs + intervalMs;
  if (Date.now() >= nextMs) return { due: true, reason: reason || "interval_elapsed", last_at: lastRaw };
  return { due: false, reason: "cooldown", next_at: new Date(nextMs).toISOString(), last_at: lastRaw };
}

async function registerHeartbeat(status = "online", meta = {}) {
  const workspaceGit = readGitInfo(WORKSPACE);
  const mnemoGit = readGitInfo(MNEMO_REPO_ROOT);
  const baseMeta = {
    transport: "mnemo-agent-loop",
    loop_version: LOOP_VERSION,
    requested_engine: ENGINE_LABEL,
    engine: ENGINE,
    engine_command: ENGINE === "print-cli" ? EXTERNAL_AGENT_BIN : AGENT_BIN,
    mnemo_repo: MNEMO_REPO_ROOT,
    mnemo_git_commit: mnemoGit.commit,
    mnemo_git_branch: mnemoGit.branch,
    mnemo_dirty: mnemoGit.dirty,
    workspace: WORKSPACE,
    workspace_git_commit: workspaceGit.commit,
    workspace_git_branch: workspaceGit.branch,
    workspace_dirty: workspaceGit.dirty,
    reviewer_agent: REVIEWER_AGENT,
    pre_work_guard: REQUIRE_PRE_WORK_GUARD,
    pre_work_mode: PRE_WORK_MODE,
    last_runtime_preflight: lastRuntimePreflight,
  };
  await callTool("mem_connect_register", {
    agent_name: AGENT,
    display_name: AGENT,
    host: os.hostname(),
    pid: process.pid,
    skills: ["agent", "autonomy", "briefs", "initiative", "review", "deploy", "pre-work-guard"],
    meta: Object.assign({}, baseMeta, meta)
  }).catch(() => {});
  await callTool("mem_connect_heartbeat", {
    agent_name: AGENT,
    status,
    meta: Object.assign({}, baseMeta, { loop: "mnemo-agent-loop" }, meta)
  }).catch(() => {});
  await callTool("mem_agent_status_set", {
    agent_name: AGENT,
    current_task: meta.current_task || null,
    blocked_on: meta.blocked_on || null,
    host: os.hostname(),
    pid: process.pid,
    meta: Object.assign({}, baseMeta, meta)
  }).catch(() => {});
}

async function finishAction(action, status, result) {
  if (!action || !action.id) return false;
  let lastError = null;
  for (let attempt = 1; attempt <= ACTION_FINISH_RETRIES; attempt++) {
    try {
      await callTool("mem_action_finish", { id: action.id, status, result });
      return true;
    } catch (e) {
      lastError = e;
      log("mem_action_finish retry", { id: action.id, attempt, retries: ACTION_FINISH_RETRIES, error: e.message });
      if (attempt < ACTION_FINISH_RETRIES) await sleep(Math.min(10000, attempt * 2000));
    }
  }
  log("mem_action_finish failed", { id: action.id, error: lastError ? lastError.message : "unknown" });
  return false;
}

async function runtimePreflight(cooldown) {
  const started = new Date().toISOString();
  const out = {
    checked_at: started,
    status: "ok",
    reminders: { status: "skipped" },
    media: { status: "skipped" },
    briefs: { status: "skipped" },
    team: { status: "skipped" },
    passport: { status: "skipped" },
    engine: { blocked: !!(cooldown && cooldown.blocked), reason: cooldown && cooldown.reason || null },
  };
  try {
    const due = await callTool("mem_reminder_due", { agent_name: AGENT, limit: 10 });
    out.reminders = { status: "ok", due_count: due && due.count || 0, ids: (due && due.reminders || []).map(r => r.id).slice(0, 10) };
  } catch (e) {
    out.reminders = { status: "error", error: e.message };
  }
  try {
    const media = await callTool("mem_media_recent", { limit: 1 });
    out.media = { status: "ok", available: true, count: media && media.count || 0 };
  } catch (e) {
    out.media = { status: "unavailable", error: e.message };
  }
  if (!NO_BRIEFS) {
    try {
      const peek = await callTool("mem_brief_pull", { agent_name: AGENT, limit: 1, peek: true });
      const brief = peek && peek.briefs && peek.briefs[0];
      out.briefs = { status: "ok", pending: !!brief, next_id: brief && brief.id || null, source_agent: brief && brief.source_agent || null };
    } catch (e) {
      out.briefs = { status: "error", error: e.message };
    }
  }
  try {
    const team = await callTool("mem_team_operating_model", { agent_name: AGENT });
    out.team = {
      status: "ok",
      agent_status: team && team.agent_status || null,
      departments: (team && team.department_coverage || []).map((row) => row.department_name)
    };
    if (team && team.agent_status && team.agent_status !== "active") {
      out.team.status = "blocked";
      out.team.error = `agent_status=${team.agent_status}`;
    }
  } catch (e) {
    out.team = { status: "error", error: e.message };
  }
  try {
    const passportRes = await callTool("mem_agent_pass_get", { agent_name: AGENT });
    const passport = passportRes && passportRes.passport ? passportRes.passport : passportRes;
    out.passport = {
      status: "ok",
      source_kind: passport && passport.source_kind || null,
      passport_status: passport && passport.status || null,
      lane: passport && passport.lane || null,
      approval_class: passport && passport.approval_class || null,
      live_write: !!(passport && passport.live_write),
      review_required: !!(passport && passport.review_required),
    };
    if (passport && passport.status && !["active", "ok"].includes(String(passport.status))) {
      out.passport.status = "blocked";
      out.passport.error = `passport_status=${passport.status}`;
    } else if (passport && passport.source_kind === "manual" && passport.live_write === false && ["read_only", "report_only"].includes(String(passport.approval_class || "").toLowerCase())) {
      out.passport.status = "blocked";
      out.passport.error = `approval_class=${passport.approval_class || "read_only"} live_write=false`;
    }
  } catch (e) {
    out.passport = { status: "error", error: e.message };
  }
  const blockers = [];
  if (out.reminders.status === "error") blockers.push(`mem_reminder_due failed: ${out.reminders.error}`);
  if (!NO_BRIEFS && out.briefs.status === "error") blockers.push(`mem_brief_pull failed: ${out.briefs.error}`);
  if (out.team.status === "error") blockers.push(`mem_team_operating_model failed: ${out.team.error}`);
  if (out.team.status === "blocked") blockers.push(`team operating model blocked: ${out.team.error}`);
  if (out.passport.status === "error") blockers.push(`mem_agent_pass_get failed: ${out.passport.error}`);
  if (out.passport.status === "blocked") blockers.push(`agent passport blocked: ${out.passport.error}`);
  if (blockers.length) {
    out.status = "blocked";
    out.blocked_on = `Mnemo preflight failed: ${blockers.join(" | ")}`;
  } else if (out.media.status === "unavailable") {
    out.status = "degraded";
    out.degraded_on = `mem_media_recent unavailable: ${out.media.error}`;
  }
  out.finished_at = new Date().toISOString();
  lastRuntimePreflight = out;
  return out;
}

async function runPreWorkGuard(kind, target, source) {
  const strict = strictPreWorkNeeded(kind, source);
  if (!REQUIRE_PRE_WORK_GUARD || !strict) {
    return {
      allowed: true,
      guard: { guard_kind: "pre_work", required: false, strict, completionAllowed: true, status: "not_required", reason: REQUIRE_PRE_WORK_GUARD ? "not required for trivial work" : "disabled" }
    };
  }
  if (DRY_RUN) {
    log("dry-run: pre-work guard would run", { kind, target });
    return {
      allowed: true,
      guard: {
        guard_kind: "pre_work",
        required: true,
        strict: true,
        completionAllowed: true,
        status: "pass",
        reason: "dry-run pre-work guard skipped",
        guard: { status: "pass", task_summary: "dry-run", acceptance_criteria: ["dry-run"], context_to_load: ["dry-run"], dependencies_to_inspect: ["dry-run"], files_or_modules_to_claim: [], blast_radius: ["dry-run"], site_contract_surfaces: [], risk_level: "low", planned_checks: ["dry-run"], stop_conditions: ["dry-run"], blocked_reason: [] }
      }
    };
  }

  log("pre-work start", { kind, target });
  const action = await callTool("mem_action_log", {
    agent_name: AGENT,
    action_kind: "pre_work_guard",
    target: `${kind}#${target}`,
    status: "started",
    topic: "agent-loop",
    payload: { kind, target, mode: PRE_WORK_MODE }
  }).catch(() => null);
  const reportBootstrap = await loadMandatoryWorkReports(kind, source).catch(e => ({ ok: false, errors: [{ tool: "mandatory_work_reports", error: String(e.message || e) }] }));
  if (!reportBootstrap.ok) {
    const guard = {
      guard_kind: "pre_work",
      required: true,
      strict: true,
      completionAllowed: false,
      status: "blocked",
      reason: "mandatory work reports could not be loaded before execution",
      guard: {
        status: "blocked",
        task_summary: compactLine(`${kind} ${target}`),
        acceptance_criteria: ["Read recent work reports before starting"],
        context_to_load: ["mem_work_report_feed", "mem_project_timeline_report", "recent handoffs", "mem_actions_recent"],
        dependencies_to_inspect: [],
        files_or_modules_to_claim: [],
        blast_radius: [],
        site_contract_surfaces: [],
        risk_level: "medium",
        planned_checks: [],
        stop_conditions: ["Do not start work without readable reports"],
        blocked_reason: reportBootstrap.errors.map(err => `${err.tool || "report"}: ${err.error}`)
      }
    };
    await finishAction(action, guardActionStatus([guard], "failed"), {
      exit_code: 1,
      tail: compactJson(reportBootstrap, 2400),
      engine: ENGINE,
      pre_work_mode: PRE_WORK_MODE,
      pre_work_guard: guard
    });
    log("pre-work finish", { kind, target, mode: PRE_WORK_MODE, allowed: false, retryable: false, status: guard.reason });
    return {
      allowed: false,
      retryable: false,
      guard,
      reportBootstrap,
      run: { exitCode: 1, output: compactJson(reportBootstrap, 2400) },
      outcome: guardOutcome(compactJson(reportBootstrap, 2400), [guard]),
      actionStatus: guardActionStatus([guard], "failed")
    };
  }

  const run = USE_LLM_PRE_WORK_GUARD
    ? runAgent(`${promptForPreWork(kind, target, source)}\n\nMandatory preloaded reports:\n${compactJson(reportBootstrap, 5200)}\n`, `prework-${kind}`, target, { planOnly: true })
    : { exitCode: 0, output: preWorkMarker(deterministicPreWorkGuard(kind, target, source)), authFailure: false, needsContinuation: false };
  const guard = evaluatePreWorkGuard(kind, source, run.output);
  const allowed = run.exitCode === 0 && guard.completionAllowed;
  const retryable = run.authFailure || run.needsContinuation;
  const actionStatus = allowed ? "ok" : guardActionStatus([guard], run.authFailure ? "auth_failed" : (run.needsContinuation ? "needs_continuation" : "failed"));
  await finishAction(action, actionStatus, {
    exit_code: run.exitCode,
    tail: tail(run.output, ACTION_TAIL_MAX),
    engine: ENGINE,
    pre_work_mode: PRE_WORK_MODE,
    pre_work_guard: guard
  });
  log("pre-work finish", { kind, target, mode: PRE_WORK_MODE, allowed, retryable, status: guard.status || guard.reason });
  return {
    allowed,
    retryable,
    guard,
    reportBootstrap,
    run,
    outcome: guardOutcome(tail(run.output), [guard]),
    actionStatus
  };
}

async function drainNonExecutableBriefs() {
  let drained = 0;
  for (let i = 0; i < DRAIN_IDLE_LIMIT; i++) {
    const peek = await callTool("mem_brief_pull", { agent_name: AGENT, limit: 1, peek: true });
    const brief = peek && peek.briefs && peek.briefs[0];
    if (!brief || !isNonExecutableBrief(brief)) break;
    if (DRY_RUN) {
      log("dry-run: would drain non-executable brief", { id: brief.id });
      break;
    }
    await callTool("mem_brief_done", {
      id: brief.id,
      status: "done",
      outcome: "Acknowledged by agent loop without model execution; brief is status-only, no-action, autonomy-pointer, or idle-cycle."
    });
    drained += 1;
  }
  if (drained) log("drained non-executable briefs", { drained });
}

async function runBriefIfAny() {
  if (NO_BRIEFS) return false;
  await drainNonExecutableBriefs();
  const peek = await callTool("mem_brief_pull", { agent_name: AGENT, limit: 1, peek: true });
  const pending = peek && peek.briefs && peek.briefs[0];
  if (!pending) return false;
  if (isNonExecutableBrief(pending)) return false;
  if (ONLY_MISSION_CONSOLE && !isMissionConsoleBrief(pending)) return false;

  const pulled = DRY_RUN ? peek : await callTool("mem_brief_pull", { agent_name: AGENT, limit: 1, peek: false });
  const brief = pulled && pulled.briefs && pulled.briefs[0];
  if (!brief) return false;

  log("brief start", { id: brief.id, source_agent: brief.source_agent || null });
  const hardPreflight = await runHardAgentPreflight("brief", brief.id, brief);
  if (!hardPreflight.allowed) {
    const status = hardPreflight.retryable ? "pending" : "failed";
    await dropMissionConsoleAutoReply(brief, status, hardPreflight.outcome, {
      phase: "hard_agent_preflight",
      retryable: hardPreflight.retryable,
      preflight_status: hardPreflight.result && hardPreflight.result.status || "unknown"
    });
    if (!DRY_RUN) {
      await callTool("mem_brief_done", { id: brief.id, status, outcome: hardPreflight.outcome }).catch(() => {});
    }
    log("brief finish", { id: brief.id, status, hard_agent_preflight: hardPreflight.result && hardPreflight.result.status || "unknown" });
    return true;
  }
  const prework = await runPreWorkGuard("brief", brief.id, brief);
  if (!prework.allowed) {
    const status = prework.retryable ? "pending" : "failed";
    await dropMissionConsoleAutoReply(brief, status, prework.outcome, {
      phase: "pre_work_guard",
      retryable: prework.retryable,
      guard_status: prework.guard && (prework.guard.status || prework.guard.reason)
    });
    if (!DRY_RUN) {
      await callTool("mem_brief_done", { id: brief.id, status, outcome: prework.outcome }).catch(() => {});
    }
    log("brief finish", { id: brief.id, status, pre_work_guard: prework.guard.status || prework.guard.reason });
    return true;
  }
  if (isNonExecutableBrief(brief)) {
    const action = await callTool("mem_action_log", {
      agent_name: AGENT,
      action_kind: "brief_status_ack",
      target: `brief#${brief.id}`,
      status: "done",
      topic: "agent-loop",
      payload: { source_agent: brief.source_agent || null, status_only: true }
    }).catch(() => null);
    await finishAction(action, "ok", { status_only: true, engine: ENGINE, pre_work_guard: prework.guard, outcome: "Status-only brief acknowledged without model execution." });
    if (!DRY_RUN) {
      await callTool("mem_brief_done", { id: brief.id, status: "done", outcome: "Status-only brief acknowledged by agent loop; no model execution required." }).catch(() => {});
    }
    log("brief finish", { id: brief.id, status: "done", status_only: true, pre_work_guard: prework.guard.status || prework.guard.reason });
    return true;
  }
  if (isMissionConsoleBrief(brief)) {
    const action = await callTool("mem_action_log", {
      agent_name: AGENT,
      action_kind: "mission_console",
      target: `brief#${brief.id}`,
      status: "started",
      topic: "agent-loop",
      payload: { source_agent: brief.source_agent || null, created_at: brief.created_at || null, thread_id: missionConsoleThreadId(brief) }
    }).catch(() => null);
    const memoryContext = await buildRuntimeMemoryContext("brief", brief.id, brief, prework.reportBootstrap || null);
    const run = runAgent(promptForMissionConsoleBrief(brief, prework.guard, memoryContext), "mission-console", brief.id);
    if (run.authFailure) await markEngineAuthFailure(run, "mission-console", brief.id);
    else if (run.exitCode === 0) clearEngineFailure();
    const retryable = run.authFailure || run.needsContinuation;
    const status = run.exitCode === 0 ? "done" : (retryable ? "pending" : "failed");
    const rawTail = tail(run.output, ACTION_TAIL_MAX);
    const outcome = missionConsoleReplyText(run.output, brief, status);
    const actionStatus = run.authFailure ? "auth_failed" : (run.needsContinuation ? "needs_continuation" : (run.exitCode === 0 ? "ok" : "failed"));
    await finishAction(action, actionStatus, { exit_code: run.exitCode, tail: rawTail, reply: outcome, engine: ENGINE, pre_work_guard: prework.guard, mission_console: true });
    await dropMissionConsoleAutoReply(brief, status, outcome, {
      phase: "mission_console",
      action_status: actionStatus,
      exit_code: run.exitCode,
      retryable,
      engine: ENGINE
    });
    if (!DRY_RUN) {
      await callTool("mem_brief_done", { id: brief.id, status, outcome }).catch(() => {});
    }
    log("mission console finish", { id: brief.id, status, retryable, action_status: actionStatus });
    return true;
  }
  const action = await callTool("mem_action_log", {
    agent_name: AGENT,
    action_kind: "brief",
    target: `brief#${brief.id}`,
    status: "started",
    topic: "agent-loop",
    payload: { source_agent: brief.source_agent || null, created_at: brief.created_at || null }
  }).catch(() => null);
  const memoryContext = await buildRuntimeMemoryContext("brief", brief.id, brief, prework.reportBootstrap || null);
  const run = runAgent(promptForBrief(brief, prework.guard, memoryContext), "brief", brief.id);
  if (run.authFailure) await markEngineAuthFailure(run, "brief", brief.id);
  else if (run.exitCode === 0) clearEngineFailure();
  const regression = evaluateRegressionGuard("brief", brief, run.output);
  const completion = evaluateCompletionGuard("brief", brief, run.output);
  const siteContract = evaluateSiteContractGuard("brief", brief, run.output);
  const guards = [siteContract, regression, completion];
  const retryable = run.authFailure || run.needsContinuation;
  const ok = run.exitCode === 0 && guardsAllowCompletion(guards);
  const status = ok ? "done" : (retryable ? "pending" : "failed");
  const rawOutcome = guardOutcome(tail(run.output), guards);
  const outcome = isTelegramBridgeBrief(brief) ? telegramBridgeReplyText(run.output, brief, status, rawOutcome) : rawOutcome;
  const actionStatus = guardedRunStatus(run, guards, ok);
  await finishAction(action, actionStatus, { exit_code: run.exitCode, tail: tail(run.output, ACTION_TAIL_MAX), engine: ENGINE, pre_work_guard: prework.guard, site_contract_guard: siteContract, regression_guard: regression, completion_guard: completion });
  await writeAutoWorkReport("brief", brief.id, brief, run, status, guards, prework.guard);
  await dropMissionConsoleAutoReply(brief, status, outcome, {
    phase: "model_run",
    action_status: actionStatus,
    exit_code: run.exitCode,
    retryable,
    engine: ENGINE
  });
  if (!DRY_RUN) {
    await callTool("mem_brief_done", { id: brief.id, status, outcome }).catch(() => {});
  }
  log("brief finish", { id: brief.id, status, retryable, site_contract_guard: siteContract.status || siteContract.reason, regression_guard: regression.status || regression.reason, completion_guard: completion.status || completion.reason });
  return true;
}

async function runAutonomySweepIfDue(reason) {
  const due = autonomySweepDue(reason);
  if (!due.due) return false;
  if (DRY_RUN) {
    log("dry-run: would run autonomy sweep", { reason: due.reason, interval_min: AUTONOMY_SWEEP_INTERVAL_MIN });
    return false;
  }
  const startedAt = new Date().toISOString();
  writeAutonomySweepState({
    last_started_at: startedAt,
    last_reason: due.reason,
    interval_min: AUTONOMY_SWEEP_INTERVAL_MIN,
    drop_briefs: AUTONOMY_SWEEP_DROP_BRIEFS
  });
  log("autonomy sweep start", { reason: due.reason, interval_min: AUTONOMY_SWEEP_INTERVAL_MIN, drop_briefs: AUTONOMY_SWEEP_DROP_BRIEFS });
  const action = await callTool("mem_action_log", {
    agent_name: AGENT,
    action_kind: "autonomy_scout",
    target: "all-projects",
    status: "started",
    topic: "agent-loop",
    payload: { reason: due.reason, interval_min: AUTONOMY_SWEEP_INTERVAL_MIN, drop_briefs: AUTONOMY_SWEEP_DROP_BRIEFS }
  }).catch(() => null);
  try {
    const result = await callTool("mem_autonomy_sweep", {
      agent_name: AGENT,
      drop_briefs: AUTONOMY_SWEEP_DROP_BRIEFS
    });
    const status = result && result.error ? "failed" : "ok";
    await finishAction(action, status, { result });
    writeAutonomySweepState({
      last_finished_at: new Date().toISOString(),
      last_status: status,
      board: result && result.board || null,
      tasks_count: result && result.tasks_count || 0,
      created_count: result && result.created_count || 0,
      error: result && result.error || null
    });
    log("autonomy sweep finish", { status, tasks_count: result && result.tasks_count, created_count: result && result.created_count });
    return status === "ok";
  } catch (e) {
    await finishAction(action, "failed", { error: e.message });
    writeAutonomySweepState({
      last_finished_at: new Date().toISOString(),
      last_status: "failed",
      error: e.message
    });
    log("autonomy sweep failed", { error: e.message });
    return false;
  }
}

async function runAutonomyIfAny() {
  if (NO_AUTONOMY) return false;
  const nextArgs = { agent_name: AGENT, limit: 1, claim: !DRY_RUN, allow_takeover: true, stale_takeover_minutes: AUTONOMY_TAKEOVER_MINUTES };
  let next = await callTool("mem_autonomy_next", nextArgs);
  let task = next && next.tasks && next.tasks[0];
  if (!task) {
    const swept = await runAutonomySweepIfDue("no_open_task");
    if (swept) {
      next = await callTool("mem_autonomy_next", nextArgs);
      task = next && next.tasks && next.tasks[0];
    }
  }
  if (!task) return false;

  log("autonomy start", { id: task.id, project: task.project, department: task.department_name, severity: task.severity, takeover_eligible: !!task.takeover_eligible, previous_assigned_agent: task.previous_assigned_agent || null });
  const hardPreflight = await runHardAgentPreflight("autonomy", task.id, task);
  if (!hardPreflight.allowed) {
    if (!DRY_RUN) {
      await callTool("mem_autonomy_task_update", {
        id: task.id,
        status: hardPreflight.retryable ? "open" : "blocked",
        assigned_agent: hardPreflight.retryable ? null : AGENT,
        notes: `${hardPreflight.retryable ? "Hard Mnemo preflight unavailable; task reopened without execution." : "Hard Mnemo preflight blocked execution; task is not safe to start."}\n\n${hardPreflight.outcome}`,
        meta: { loop_agent: AGENT, loop_engine: ENGINE, loop_finished_at: new Date().toISOString(), hard_agent_preflight: hardPreflight.result, hard_agent_payload: Object.assign({}, hardPreflight.payload, { text: undefined }) }
      }).catch(() => {});
    }
    log("autonomy finish", { id: task.id, status: hardPreflight.retryable ? "open" : "blocked", hard_agent_preflight: hardPreflight.result && hardPreflight.result.status || "unknown" });
    return true;
  }
  const prework = await runPreWorkGuard("autonomy", task.id, task);
  if (!prework.allowed) {
    if (!DRY_RUN) {
      await callTool("mem_autonomy_task_update", {
        id: task.id,
        status: prework.retryable ? "open" : "blocked",
        assigned_agent: prework.retryable ? null : AGENT,
        notes: `${prework.retryable ? "Pre-work guard needs retry/continuation; task reopened." : "Pre-work guard blocked execution; task is not safe to start."}\n\nTail:\n${prework.outcome}`,
        meta: { loop_agent: AGENT, loop_engine: ENGINE, loop_finished_at: new Date().toISOString(), pre_work_guard: prework.guard }
      }).catch(() => {});
    }
    log("autonomy finish", { id: task.id, status: prework.retryable ? "open" : "blocked", pre_work_guard: prework.guard.status || prework.guard.reason });
    return true;
  }
  const action = await callTool("mem_action_log", {
    agent_name: AGENT,
    action_kind: "autonomy_task",
    target: `task#${task.id}`,
    status: "started",
    topic: "agent-loop",
    payload: { project: task.project, department: task.department_name, severity: task.severity, title: task.title, takeover_eligible: !!task.takeover_eligible, previous_assigned_agent: task.previous_assigned_agent || null }
  }).catch(() => null);
  const memoryContext = await buildRuntimeMemoryContext("autonomy", task.id, task, prework.reportBootstrap || null);
  const run = runAgent(promptForTask(task, prework.guard, memoryContext), "autonomy", task.id);
  if (run.authFailure) await markEngineAuthFailure(run, "autonomy", task.id);
  else if (run.exitCode === 0) clearEngineFailure();
  const regression = evaluateRegressionGuard("autonomy", task, run.output);
  const completion = evaluateCompletionGuard("autonomy", task, run.output);
  const siteContract = evaluateSiteContractGuard("autonomy", task, run.output);
  const guards = [siteContract, regression, completion];
  const outcome = guardOutcome(tail(run.output), guards);
  const ok = run.exitCode === 0 && guardsAllowCompletion(guards);
  const retryable = run.authFailure || run.needsContinuation;
  const actionStatus = guardedRunStatus(run, guards, ok);
  await finishAction(action, actionStatus, { exit_code: run.exitCode, tail: tail(run.output, ACTION_TAIL_MAX), engine: ENGINE, pre_work_guard: prework.guard, site_contract_guard: siteContract, regression_guard: regression, completion_guard: completion });
  await writeAutoWorkReport("autonomy", task.id, task, run, ok ? "done" : (retryable ? "pending" : "failed"), guards, prework.guard);
  if (!DRY_RUN) {
    await callTool("mem_autonomy_task_update", {
      id: task.id,
      status: ok ? "review" : (retryable ? "open" : "blocked"),
      assigned_agent: AGENT,
      notes: `${ok ? "Agent loop completed and moved task to review." : (guardsAllowCompletion(guards) ? (retryable ? "Agent engine needs retry/continuation; task reopened." : "Agent loop failed or timed out.") : "Completion/regression guard blocked review; task is not complete.")}\n\nTail:\n${outcome}`,
      meta: { loop_exit_code: run.exitCode, loop_agent: AGENT, loop_engine: ENGINE, loop_finished_at: new Date().toISOString(), pre_work_guard: prework.guard, site_contract_guard: siteContract, regression_guard: regression, completion_guard: completion, takeover_eligible: !!task.takeover_eligible, previous_assigned_agent: task.previous_assigned_agent || null }
    }).catch(() => {});
  }
  log("autonomy finish", { id: task.id, status: ok ? "review" : "blocked", site_contract_guard: siteContract.status || siteContract.reason, regression_guard: regression.status || regression.reason, completion_guard: completion.status || completion.reason });
  return true;
}

async function runInitiativeIfDue() {
  const due = initiativeDue();
  if (!due.due) return false;

  const startedAt = new Date().toISOString();
  writeInitiativeState({
    agent_name: AGENT,
    last_started_at: startedAt,
    last_reason: due.reason,
    interval_min: INITIATIVE_INTERVAL_MIN
  });
  log("initiative start", { reason: due.reason, interval_min: INITIATIVE_INTERVAL_MIN });

  const prework = await runPreWorkGuard("initiative", AGENT, { reason: due.reason, interval_min: INITIATIVE_INTERVAL_MIN, agent_name: AGENT });
  if (!prework.allowed) {
    const status = prework.retryable ? "open" : guardActionStatus([prework.guard], "failed");
    writeInitiativeState({
      last_finished_at: new Date().toISOString(),
      last_status: status,
      last_tail: tail(prework.outcome, ACTION_TAIL_MAX),
      pre_work_guard: prework.guard
    });
    log("initiative finish", { status, pre_work_guard: prework.guard.status || prework.guard.reason });
    return true;
  }

  const action = await callTool("mem_action_log", {
    agent_name: AGENT,
    action_kind: "initiative_cycle",
    target: `agent:${AGENT}`,
    status: "started",
    topic: "agent-loop",
    payload: { reason: due.reason, interval_min: INITIATIVE_INTERVAL_MIN, reviewer_agent: REVIEWER_AGENT }
  }).catch(() => null);

  const initiativeSource = { reason: due.reason, interval_min: INITIATIVE_INTERVAL_MIN, agent_name: AGENT };
  const memoryContext = await buildRuntimeMemoryContext("initiative", AGENT, initiativeSource, prework.reportBootstrap || null);
  const run = runAgent(promptForInitiative(prework.guard, memoryContext), "initiative", AGENT);
  if (run.authFailure) await markEngineAuthFailure(run, "initiative", AGENT);
  else if (run.exitCode === 0) clearEngineFailure();
  const regression = evaluateRegressionGuard("initiative", "initiative cycle", run.output);
  const completion = evaluateCompletionGuard("initiative", "initiative cycle", run.output);
  const siteContract = evaluateSiteContractGuard("initiative", "initiative cycle", run.output);
  const guards = [siteContract, regression, completion];
  const ok = run.exitCode === 0 && guardsAllowCompletion(guards);
  const status = guardedRunStatus(run, guards, ok);
  await finishAction(action, status, { exit_code: run.exitCode, tail: tail(run.output, ACTION_TAIL_MAX), engine: ENGINE, pre_work_guard: prework.guard, site_contract_guard: siteContract, regression_guard: regression, completion_guard: completion });
  await writeAutoWorkReport("initiative", AGENT, initiativeSource, run, ok ? "done" : (run.authFailure || run.needsContinuation ? "pending" : "failed"), guards, prework.guard);

  writeInitiativeState({
    last_finished_at: new Date().toISOString(),
    last_exit_code: run.exitCode,
    last_status: status,
    last_tail: tail(run.output, ACTION_TAIL_MAX),
    pre_work_guard: prework.guard,
    site_contract_guard: siteContract,
    regression_guard: regression,
    completion_guard: completion
  });
  log("initiative finish", { status, exitCode: run.exitCode });
  return true;
}

async function cycle() {
  const cooldown = engineCooldown();
  const preflight = await runtimePreflight(cooldown).catch(e => ({ checked_at: new Date().toISOString(), status: "error", error: e.message }));
  const runtimeBlocked = preflight && preflight.status === "blocked";
  await registerHeartbeat((cooldown.blocked || runtimeBlocked) ? "blocked" : "online", Object.assign(
    { runtime_preflight: preflight },
    runtimeBlocked ? { mnemo_mcp_blocked: true, blocked_on: preflight.blocked_on || "Mnemo preflight failed" } : {},
    cooldown.blocked ? { engine_blocked: true, engine_block_reason: cooldown.reason, engine_unavailable_until: cooldown.unavailable_until, blocked_on: cooldown.reason } : {}
  ));
  if (!cooldown.blocked && !runtimeBlocked) clearRuntimeBlockNotice();
  if (runtimeBlocked) {
    await reportRuntimeBlock("runtime-preflight", "mnemo", preflight.blocked_on || "Mnemo preflight failed", {
      type: "mnemo_mcp",
      tail: compactJson(preflight, 1200)
    });
    log("runtime preflight blocked", { blocked_on: preflight.blocked_on || null });
    return "blocked";
  }
  if (!NO_BRIEFS) await drainNonExecutableBriefs();
  if (cooldown.blocked) {
    log("engine unavailable cooldown", cooldown);
    await runAutonomySweepIfDue("engine_blocked");
    return "blocked";
  }
  if (await runBriefIfAny()) return "brief";
  if (ONLY_MISSION_CONSOLE) return "idle";
  if (await runAutonomyIfAny()) return "autonomy";
  if (await runInitiativeIfDue()) return "initiative";
  return "idle";
}

function runSelfTest() {
  const cases = [
    ["initiative", AGENT, { reason: "self-test", interval_min: 90, agent_name: AGENT }],
    ["brief", 1, "Fix header links, dark logo, languages, mobile, and footer legal routes across all pages."],
    ["autonomy", 2, { project: "Example Project", department_name: "qa", severity: "M", title: "Verify checkout VAT/OSS crossover before live" }]
  ];
  const results = [];
  for (const [kind, target, source] of cases) {
    const guard = deterministicPreWorkGuard(kind, target, source);
    const evaluated = evaluatePreWorkGuard(kind, source, preWorkMarker(guard));
    results.push({ kind, status: evaluated.status, allowed: evaluated.completionAllowed, reason: evaluated.reason });
    if (!evaluated.completionAllowed) throw new Error(`${kind} pre-work self-test failed: ${evaluated.reason}`);
  }
  const missingDiagnosis = evaluatePreWorkGuard("brief", "Fix auth regression in a large codebase", preWorkMarker({
    status: "pass",
    task_summary: "Fix auth regression",
    acceptance_criteria: ["Auth works"],
    context_to_load: ["mem_work_report_feed({project:\"Example Project\"})", "mem_project_timeline_report({project:\"Example Project\"})", "recent handoffs", "mem_actions_recent", "session brief"],
    dependencies_to_inspect: ["target files"],
    files_or_modules_to_claim: ["auth files"],
    blast_radius: ["login"],
    site_contract_surfaces: [],
    risk_level: "high",
    planned_checks: ["run tests"],
    stop_conditions: ["tests fail"],
    blocked_reason: []
  }));
  if (missingDiagnosis.completionAllowed) throw new Error("deep diagnosis pre-work self-test failed: missing diagnosis lane was allowed");
  const missingReports = evaluatePreWorkGuard("brief", "Project: Example Project\nFix duplicate work around login flow", preWorkMarker({
    status: "pass",
    task_summary: "Fix duplicate work around login flow",
    acceptance_criteria: ["login flow fixed"],
    context_to_load: ["mem_session_brief({agent_name:\"agent\"})"],
    dependencies_to_inspect: ["auth route"],
    files_or_modules_to_claim: ["src/routes/auth.js"],
    blast_radius: ["login page"],
    site_contract_surfaces: [],
    risk_level: "medium",
    planned_checks: ["run auth smoke"],
    stop_conditions: ["smoke fails"],
    blocked_reason: []
  }));
  if (missingReports.completionAllowed) throw new Error("report-read self-test failed: missing timeline/handoff/action report was allowed");
  const authStatus = guardedRunStatus({ authFailure: true, needsContinuation: false, exitCode: 1 }, [{ required: true, completionAllowed: false, guard_kind: "site_contract", status: "missing" }], false);
  if (authStatus !== "auth_failed") throw new Error(`auth status self-test failed: ${authStatus}`);
  const successfulAgentTranscript = "local runtime\nuser\nFix login required copy and auth crossover.\nagent\nDone.";
  if (isAuthFailure(successfulAgentTranscript, 0, "")) {
    throw new Error("auth detector false-positive self-test failed");
  }
  if (isAuthFailure(successfulAgentTranscript, 0, "user asked to fix login required text")) {
    throw new Error("auth detector stderr false-positive self-test failed");
  }
  if (!isAuthFailure("error: not logged in", 1, "error: not logged in")) {
    throw new Error("auth detector true-positive self-test failed");
  }
  const statusSource = "[STATUS] Mnemo agent loop Autonomy Fix deployed. Commit b3d3657 verified.";
  if (strictCompletionNeeded("brief", statusSource) || strictRegressionNeeded("brief", statusSource) || strictSiteContractNeeded("brief", statusSource)) {
    throw new Error("status-only brief self-test failed: status update was treated as executable work");
  }
  if (!isStatusOnlySource("[STATUS] Mnemo agent loop Autonomy final update. No action required.")) {
    throw new Error("status-only no-action self-test failed");
  }
  if (!isNonExecutableBrief({ content: "[IDLE-CYCLE] Pull project_state.", meta_json: "{\"idle_cycle\":true}" })) {
    throw new Error("non-executable brief self-test failed");
  }
  if (!isNonExecutableBrief({ content: "Status Step complete (Hub): diagnostics deployed.", meta_json: "{\"status\":\"deployed\"}" })) {
    throw new Error("status-step deployed brief self-test failed");
  }
  if (!isNonExecutableBrief({ content: "# Autonomy task #81\nStart with mem_autonomy_next({claim:true}).", meta_json: "{\"autonomy_task_id\":81,\"department\":\"frontend\"}" })) {
    throw new Error("autonomy pointer brief self-test failed");
  }
  if (!isNonExecutableBrief({ content: "# Mnemo hardening deployed\nBlocker: auth.", meta_json: "{\"type\":\"team_status\"}" })) {
    throw new Error("team-status brief self-test failed");
  }
  if (!isNonExecutableBrief({ content: "[TEAM-STATUS] Mnemo autonomy hardening deployed on Hub.", meta_json: "{\"status\":\"team_update\"}" })) {
    throw new Error("team-update brief self-test failed");
  }
  const listingPayload = buildHardPreflightPayload("brief", 999, {
    id: 999,
    content: "Rollback listing.example.com to older backup and restore /srv/listing-company/listing_shared_chrome.js from yesterday.",
    meta_json: "{\"source\":\"self-test\"}"
  });
  if (listingPayload.project !== "listing") throw new Error(`hard preflight project inference failed: ${listingPayload.project}`);
  if (!listingPayload.domains.includes("listing.example.com")) throw new Error("hard preflight domain extraction failed");
  if (!listingPayload.files.includes("/srv/listing-company/listing_shared_chrome.js")) throw new Error("hard preflight file extraction failed");
  if (!listingPayload.system_names.includes("listing-company")) throw new Error("hard preflight system inference failed");
  if (!["code_edit", "deploy"].includes(listingPayload.action_type)) throw new Error(`hard preflight action inference failed: ${listingPayload.action_type}`);
  console.log(JSON.stringify({ ok: true, pre_work_mode: "deterministic", results }, null, 2));
}

if (argv.has("--self-test")) {
  try {
    runSelfTest();
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  log("unhandledRejection", { error: String(reason) });
});
process.on("uncaughtException", (err) => {
  log("uncaughtException", { error: err.message, stack: String(err.stack || "").split(String.fromCharCode(10)).slice(0, 6).join(" | ") });
  process.exit(1);
});
process.on("SIGTERM", () => { log("shutdown", { signal: "SIGTERM" }); process.exit(0); });
process.on("SIGINT",  () => { log("shutdown", { signal: "SIGINT" });  process.exit(0); });

(async () => {
  log("loop start", { mnemo_url: MNEMO_URL, workspace: WORKSPACE, engine: ENGINE_LABEL, runner: ENGINE, command: ENGINE === "print-cli" ? EXTERNAL_AGENT_BIN : AGENT_BIN, loop_version: LOOP_VERSION, poll_sec: POLL_SEC, idle_sec: IDLE_SEC, dry_run: DRY_RUN, no_briefs: NO_BRIEFS, no_autonomy: NO_AUTONOMY, only_mission_console: ONLY_MISSION_CONSOLE, autonomy_sweep: AUTONOMY_SWEEP_ENABLED, autonomy_sweep_interval_min: AUTONOMY_SWEEP_INTERVAL_MIN, autonomy_sweep_drop_briefs: AUTONOMY_SWEEP_DROP_BRIEFS, autonomy_takeover_minutes: AUTONOMY_TAKEOVER_MINUTES, initiative: INITIATIVE_ENABLED, initiative_interval_min: INITIATIVE_INTERVAL_MIN, pre_work_guard: REQUIRE_PRE_WORK_GUARD, pre_work_mode: PRE_WORK_MODE, site_contract_guard: REQUIRE_SITE_CONTRACT_GUARD, regression_guard: REQUIRE_REGRESSION_GUARD, completion_guard: REQUIRE_COMPLETION_GUARD, reviewer_agent: REVIEWER_AGENT, once: ONCE });
  while (true) {
    try {
      const result = await cycle();
      if (ONCE) break;
      await sleep((result === "idle" ? IDLE_SEC : POLL_SEC) * 1000);
    } catch (e) {
      log("cycle error", { error: e.message, stack: String(e.stack || "").split(String.fromCharCode(10)).slice(0, 6).join(" | ") });
      if (ONCE) process.exitCode = 1;
      if (ONCE) break;
      await sleep(POLL_SEC * 1000);
    }
  }
})().catch(e => {
  log("fatal", { error: e.message });
  process.exit(1);
});
