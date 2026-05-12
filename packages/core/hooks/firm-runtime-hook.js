#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const EVENT = String(process.argv[2] || process.env.MNEMO_HOOK_EVENT || "pre-tool").toLowerCase();
const BASE_URL = String(process.env.MNEMO_HUB_URL || process.env.MNEMO_HOST || "http://127.0.0.1:7117").replace(/\/+$/, "");
const BLOCK_ON_PREFLIGHT = process.env.MNEMO_HOOK_BLOCK !== "0";
const STRICT = process.env.MNEMO_HOOK_STRICT === "1";
const ENFORCE_CLEAN_WORK = process.env.MNEMO_ENFORCE_CLEAN_WORK !== "0";
const REQUIRE_PROJECT = process.env.MNEMO_REQUIRE_PROJECT !== "0";
const REQUIRE_TASK = process.env.MNEMO_REQUIRE_TASK !== "0";
const REQUIRE_FILES_FOR_EDIT = process.env.MNEMO_REQUIRE_FILES_FOR_EDIT !== "0";
const AUTO_CLAIM_ENABLED = process.env.MNEMO_AUTO_CLAIM !== "0";
const REQUIRE_AUTO_CLAIM = process.env.MNEMO_REQUIRE_AUTO_CLAIM !== "0";
const BLOCK_DIRTY_DEPLOY = process.env.MNEMO_BLOCK_DIRTY_DEPLOY !== "0";
const INCLUDE_UNTRACKED_DIRTY = process.env.MNEMO_DIRTY_INCLUDE_UNTRACKED === "1";
const ALLOW_DESTRUCTIVE = process.env.MNEMO_ALLOW_DESTRUCTIVE === "1";
const REQUIRE_REMAINING_CHECK = process.env.MNEMO_REQUIRE_REMAINING_CHECK !== "0";
const BLOCK_STOP_WITHOUT_REMAINING = process.env.MNEMO_BLOCK_STOP_WITHOUT_REMAINING !== "0";
const REQUIRE_STOP_SUMMARY = process.env.MNEMO_REQUIRE_STOP_SUMMARY !== "0";
const REQUIRE_STOP_NEXT_ACTIONS = process.env.MNEMO_REQUIRE_STOP_NEXT_ACTIONS !== "0";
const REQUIRE_OWNER_TASTE_CHECK = process.env.MNEMO_REQUIRE_OWNER_TASTE_CHECK !== "0";
const BLOCK_WITHOUT_OWNER_TASTE = process.env.MNEMO_BLOCK_WITHOUT_OWNER_TASTE !== "0";
const ALLOW_AUTONOMOUS_LOW_RISK_IDEAS = process.env.MNEMO_ALLOW_AUTONOMOUS_LOW_RISK_IDEAS !== "0";
const OWNER_NAME = process.env.MNEMO_OWNER_NAME || process.env.OWNER_NAME || "owner";
const DEFAULT_SCOPE = process.env.MNEMO_DEFAULT_SCOPE || "default";
const REQUIRE_IDENTITY_CHECK = process.env.MNEMO_REQUIRE_IDENTITY_CHECK !== "0";
const REQUIRE_TOKEN_EFFICIENT_MEMORY = process.env.MNEMO_REQUIRE_TOKEN_EFFICIENT_MEMORY !== "0";
const MAX_MEMORY_FETCH_IDS = Math.max(1, Number(process.env.MNEMO_MAX_MEMORY_FETCH_IDS || 8));
const REQUIRE_SMART_CODE_READ = process.env.MNEMO_REQUIRE_SMART_CODE_READ !== "0";
const SMART_CODE_READ_MIN_BYTES = Math.max(1024, Number(process.env.MNEMO_SMART_CODE_READ_MIN_BYTES || 20000));

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    return { _parse_error: e.message };
  }
}

async function callTool(name, args) {
  const res = await fetch(`${BASE_URL}/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args || {})
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 300)}`);
  return json && typeof json === "object" && "result" in json ? json.result : json;
}

async function recallQuery(query, limit) {
  const url = `${BASE_URL}/recall?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit || 8))}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`recall ${res.status}: ${text.slice(0, 300)}`);
  return Array.isArray(json) ? json : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeAliasKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\\/_]+/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
}

function addProjectAlias(map, from, to) {
  const key = normalizeAliasKey(from);
  const target = String(to || "").trim();
  if (key && target) map.set(key, target);
}

function projectAliasMap() {
  const aliases = new Map();

  const raw = String(process.env.MNEMO_PROJECT_ALIASES || "").trim();
  if (raw) addProjectAliases(aliases, raw);

  const aliasFile = String(process.env.MNEMO_PROJECT_ALIASES_FILE || "").trim();
  if (aliasFile && fs.existsSync(aliasFile)) {
    try { addProjectAliases(aliases, fs.readFileSync(aliasFile, "utf8")); } catch {}
  }

  return aliases;
}

function addProjectAliases(aliases, raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [from, to] of Object.entries(parsed)) addProjectAlias(aliases, from, to);
      return;
    }
  } catch {}

  for (const part of raw.split(/[;\n,]/)) {
    const idx = part.indexOf("=");
    if (idx > 0) addProjectAlias(aliases, part.slice(0, idx), part.slice(idx + 1));
  }
}

function cwdProjectCandidate(cwd) {
  const value = firstString(cwd);
  if (!value) return "";
  try {
    const root = execFileSync("git", ["-C", value, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.basename(root);
  } catch {
    return path.basename(value);
  }
}

function agentName(input) {
  return firstString(
    process.env.MNEMO_AGENT,
    input.agent_name,
    input.agent,
    input.user,
    os.userInfo().username,
    "unknown"
  ).toLowerCase();
}

function projectInfo(input) {
  const candidates = [
    ["env", process.env.MNEMO_PROJECT],
    ["input.project", input.project],
    ["input.workspace", input.workspace],
    ["input.cwd", cwdProjectCandidate(input.cwd || (input.tool_input && input.tool_input.cwd))],
    ["process.cwd", cwdProjectCandidate(process.cwd())],
    ["fallback", "unknown"]
  ];
  const picked = candidates.find(([, value]) => typeof value === "string" && value.trim()) || ["fallback", "unknown"];
  const raw = String(picked[1]).trim();
  const key = normalizeAliasKey(raw);
  const aliases = projectAliasMap();
  const name = aliases.get(key) || raw || "unknown";
  return {
    name,
    raw,
    source: picked[0],
    alias_applied: name !== raw,
    alias_key: key || null
  };
}

function projectName(input) {
  return projectInfo(input).name;
}

function runtimeScope() {
  return firstString(process.env.MNEMO_SCOPE, process.env.MNEMO_DEFAULT_SCOPE, DEFAULT_SCOPE).toLowerCase().replace(/[^a-z0-9_-]/g, "") || "default";
}

function toolName(input) {
  return firstString(
    input.tool_name,
    input.tool && input.tool.name,
    input.name,
    input.event_tool,
    EVENT
  );
}

function eventText(input) {
  const pieces = [
    EVENT,
    toolName(input),
    input.prompt,
    input.summary,
    input.command,
    input.tool_input && input.tool_input.command,
    input.args && input.args.command,
    input.cwd
  ];
  return pieces.filter(Boolean).map(String).join("\n");
}

function cwdFrom(input) {
  return firstString(input.cwd, input.tool_input && input.tool_input.cwd, process.cwd());
}

function gitState(input) {
  const cwd = cwdFrom(input);
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const args = ["-C", root, "status", "--porcelain=v1"];
    if (!INCLUDE_UNTRACKED_DIRTY) args.push("--untracked-files=no");
    const raw = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return {
      ok: true,
      root,
      dirty: lines.length > 0,
      dirty_count: lines.length,
      include_untracked: INCLUDE_UNTRACKED_DIRTY,
      entries: lines.slice(0, 25)
    };
  } catch (e) {
    return { ok: false, dirty: false, error: e.message };
  }
}

function collectPaths(value, out, depth, keyName) {
  if (!value || depth > 8) return;
  if (/^(cwd|workdir|working_directory)$/i.test(String(keyName || ""))) return;
  if (typeof value === "string") {
    if (/^[A-Za-z]:\\/.test(value) || value.includes("/") || value.includes("\\")) {
      if (!/^https?:\/\//i.test(value) && !value.includes("\n")) out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1, keyName);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^(file|file_path|filepath|path|old_path|new_path|target_file|filename|absolute_path)$/i.test(k) && typeof v === "string") {
        if (!/^https?:\/\//i.test(v)) out.add(v);
      }
      collectPaths(v, out, depth + 1, k);
    }
  }
}

function filePaths(input) {
  const out = new Set();
  collectPaths(input, out, 0, "");
  return Array.from(out).filter(Boolean).slice(0, 25);
}

function codeLikePath(file) {
  const ext = path.extname(String(file || "").toLowerCase());
  return [
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
    ".py", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".cs",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".hh", ".php", ".rb",
    ".css", ".scss", ".sass", ".less", ".html", ".htm", ".svelte",
    ".vue", ".json", ".jsonc", ".yml", ".yaml", ".sql", ".sh",
    ".bash", ".zsh", ".ps1"
  ].includes(ext);
}

function resolvePathForHook(input, file) {
  const raw = String(file || "").trim();
  if (!raw || /^https?:\/\//i.test(raw)) return "";
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const base = cwdFrom(input);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(base, expanded));
}

function commandText(input) {
  return firstString(input.command, input.tool_input && input.tool_input.command, input.args && input.args.command);
}

function commandReadPaths(input) {
  const command = commandText(input);
  if (!command) return [];
  const exts = "jsx|mjs|cjs|tsx|mts|cts|jsonc|scss|sass|less|html|svelte|yaml|bash|zsh|ps1|java|scala|cpp|hpp|php|css|htm|vue|json|yml|sql|js|ts|py|go|rs|kt|cs|cc|hh|rb|sh|c|h";
  const re = new RegExp(`(?:"([^"]+\\.(${exts}))"|'([^']+\\.(${exts}))'|([^\\s;|&<>]+\\.(${exts})))(?=$|[\\s;|&<>)])`, "gi");
  const out = new Set();
  let match;
  while ((match = re.exec(command)) !== null) {
    const value = match[1] || match[3] || match[5] || "";
    if (value) out.add(value.replace(/[),]+$/, ""));
  }
  return Array.from(out);
}

function smartCodeReadCheck(input, action_type, files) {
  const blockers = [];
  const warnings = [];
  if (!REQUIRE_SMART_CODE_READ) return { enabled: false, blockers, warnings };

  const name = toolName(input).toLowerCase();
  const text = eventText(input);
  const isDirectReadTool = action_type === "code_read" && /\bread\b|\bopen\b/.test(name);
  const isFullShellDump = /\b(cat|type|Get-Content|gc)\b/i.test(text)
    && !/(\b-Tail\b|\b-TotalCount\b|\b-Head\b|\bFirst\b|\bLast\b|Select-String|\brg\b|\bfindstr\b)/i.test(text);
  if (!isDirectReadTool && !isFullShellDump) {
    return {
      enabled: true,
      min_bytes: SMART_CODE_READ_MIN_BYTES,
      blockers,
      warnings,
      protocol: ["mem_code_outline first", "mem_code_unfold for symbol or bounded range", "full read only for small files or justified global context"]
    };
  }

  const candidates = Array.from(new Set([...(files || []), ...(isFullShellDump ? commandReadPaths(input) : [])]));
  for (const file of candidates) {
    if (!codeLikePath(file)) continue;
    const resolved = resolvePathForHook(input, file);
    if (!resolved) continue;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile() && stat.size >= SMART_CODE_READ_MIN_BYTES) {
        blockers.push(`direct full read blocked for large source file (${stat.size} bytes): ${file}; use mem_code_outline then mem_code_unfold`);
      }
    } catch {
      warnings.push(`smart code-read guard could not stat ${file}; use mem_code_outline before full reads`);
    }
  }

  return {
    enabled: true,
    min_bytes: SMART_CODE_READ_MIN_BYTES,
    blockers,
    warnings,
    protocol: ["mem_code_outline first", "mem_code_unfold for symbol or bounded range", "full read only for small files or justified global context"]
  };
}

function inferTopics(input) {
  const text = eventText(input).toLowerCase();
  const topics = [];
  const checks = [
    ["auth", /\bauth|login|session|cookie|2fa|impersonat/],
    ["pricing", /\bpricing|price|tier|plan|catalog/],
    ["billing", /\bbilling|invoice|subscription|stripe|refund|pause|upgrade|downgrade/],
    ["checkout", /\bcheckout|setup-intent|payment|webhook/],
    ["vat", /\bvat|oss|vies|tax/],
    ["legal", /\blegal|impressum|privacy|terms|gdpr/],
    ["brand", /\bbrand|header|footer|menu|nav|color|button/],
    ["products", /\bproduct|portal|listing|send|shop|taskora|mission/]
  ];
  for (const [topic, re] of checks) if (re.test(text)) topics.push(topic);
  return Array.from(new Set(topics));
}

function inferActionType(input) {
  const name = toolName(input).toLowerCase();
  const text = eventText(input).toLowerCase();
  if (/deploy|pm2|nginx|systemctl|git push|restart/.test(text)) return "deploy";
  if (/edit|write|patch|multiedit|apply_patch/.test(name) || /edit|write|patch|apply_patch/.test(text)) return "code_edit";
  if (/read|open|grep|rg|search/.test(name)) return "code_read";
  if (/mail|telegram|brief|post|publish/.test(text)) return "external_comm";
  return "tool_call";
}

function riskyTopics(topics) {
  const risky = new Set(["auth", "pricing", "billing", "checkout", "vat", "legal"]);
  return (topics || []).filter(t => risky.has(t));
}

function autonomousPolicy(action_type, topics) {
  const risky = riskyTopics(topics);
  const canAct = ALLOW_AUTONOMOUS_LOW_RISK_IDEAS && risky.length === 0 && action_type !== "deploy" && action_type !== "external_comm";
  return {
    enabled: ALLOW_AUTONOMOUS_LOW_RISK_IDEAS,
    mode: canAct ? "autonomous_low_risk_ok" : "gate_required",
    can_implement_without_owner_ok: canAct,
    risky_topics: risky,
    rules: [
      "good low-risk ideas should be implemented directly",
      "read owner taste/no-go memories before acting",
      "preserve identity: reload owner identity, agent role, core values, open promises, and project rules",
      "work token-efficiently: search compact IDs/timelines first, fetch full rows only for selected IDs",
      "record idea with mem_propose when it is not already an explicit task",
      "ship without owner OK only when project rules pass, no high findings block it, cost is low, and no risky topics are touched",
      "use complementary lanes, not engine rivalry: large code bugs/regressions need a deep diagnosis lane; visual QA, coordination, and owner communication stay with their owning lanes",
      "if a finding belongs to another lane, brief the responsible agent/reviewer with exact evidence instead of guessing or stopping",
      "ask/brief before destructive, live, legal, pricing, checkout, billing, auth, VAT, customer-data, or large visual identity changes",
      "after autonomous shipping, log decision/proposal shipped and brief the coordinator/team"
    ]
  };
}

function tokenEfficiencyCheck(input, action_type) {
  const blockers = [];
  const warnings = [];
  const name = toolName(input).toLowerCase();
  const toolInput = input.tool_input || input.args || {};
  if (!REQUIRE_TOKEN_EFFICIENT_MEMORY) return { enabled: false, blockers, warnings };

  if (/mem_recall$|mem_recall\(|recall/.test(name) && Number(toolInput.limit || input.limit || 10) > 10) {
    blockers.push("memory recall limit too high; use compact mem_recall_ids/search first and keep limit <= 10");
  }
  if (/mem_get$|mem_get\(/.test(name)) {
    const ids = Array.isArray(toolInput.ids) ? toolInput.ids : Array.isArray(input.ids) ? input.ids : [];
    if (ids.length > MAX_MEMORY_FETCH_IDS) blockers.push(`mem_get batch too large (${ids.length}); fetch at most ${MAX_MEMORY_FETCH_IDS} selected ids`);
  }
  if (["code_edit", "deploy", "external_comm"].includes(action_type)) {
    warnings.push("token protocol: mem_session_brief -> mem_recall_ids/search -> timeline/neighbors -> mem_get selected ids only");
  }
  if (["code_read", "code_edit"].includes(action_type)) {
    warnings.push("code-read protocol: mem_code_outline -> mem_code_unfold selected symbol/range -> full read only if small or justified");
  }
  return {
    enabled: true,
    max_memory_fetch_ids: MAX_MEMORY_FETCH_IDS,
    blockers,
    warnings,
    protocol: [
      "start with compact session brief",
      "search IDs/snippets before full memory rows",
      "use timeline/neighbors for context around selected IDs",
      "fetch full rows only for selected IDs",
      "use mem_code_outline and mem_code_unfold before large code reads",
      "summarize findings into handoff instead of dumping raw context"
    ]
  };
}

function destructiveCommandReason(input) {
  if (ALLOW_DESTRUCTIVE) return "";
  const text = eventText(input);
  const patterns = [
    ["git reset --hard", /\bgit\s+reset\s+--hard\b/i],
    ["git checkout --", /\bgit\s+checkout\s+--\s+\S+/i],
    ["git clean -fd", /\bgit\s+clean\s+-[a-z]*f[a-z]*d/i],
    ["recursive forced remove", /\bRemove-Item\b[\s\S]*\b-Recurse\b[\s\S]*\b-Force\b/i],
    ["rm -rf destructive target", /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(\/|~|\*|\.{1,2}(?:\s|$)|\$[A-Za-z_])/i]
  ];
  for (const [label, re] of patterns) {
    if (re.test(text)) return "destructive command blocked by clean-work rules: " + label;
  }
  return "";
}

function isEditLike(input) {
  const name = toolName(input).toLowerCase();
  const text = eventText(input).toLowerCase();
  return /edit|write|patch|multiedit|apply_patch/.test(name) || /apply_patch|set-content|write/.test(text);
}

function taskText(input) {
  return firstString(
    process.env.MNEMO_TASK,
    input.task,
    input.prompt,
    input.summary,
    input.tool_input && input.tool_input.command,
    input.command,
    toolName(input)
  ).slice(0, 500);
}

function stopSummaryText(input) {
  return firstString(
    process.env.MNEMO_TASK,
    input.summary,
    input.task,
    input.prompt
  ).slice(0, 500);
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(v => v !== null && v !== undefined && String(v).trim()).map(v => typeof v === "string" ? v.trim() : v);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function hardRuleCheck(input, action_type, files, project, task) {
  const blockers = [];
  const warnings = [];
  const git = gitState(input);
  const dangerous = destructiveCommandReason(input);
  if (!ENFORCE_CLEAN_WORK) return { enforced: false, blockers, warnings, git };

  if (dangerous) blockers.push(dangerous);
  if (REQUIRE_TASK && ["code_edit", "deploy", "external_comm"].includes(action_type) && !task) {
    blockers.push("task summary required before tracked work");
  }
  if (REQUIRE_PROJECT && ["code_edit", "deploy", "external_comm"].includes(action_type) && (!project || project === "unknown")) {
    blockers.push("explicit project required before tracked work");
  }
  if (REQUIRE_FILES_FOR_EDIT && action_type === "code_edit" && files.length === 0) {
    blockers.push("edited file path required before code edit");
  }
  if (REQUIRE_AUTO_CLAIM && action_type === "code_edit" && !AUTO_CLAIM_ENABLED) {
    blockers.push("auto-claim required before code edit; enable MNEMO_AUTO_CLAIM or disable MNEMO_REQUIRE_AUTO_CLAIM explicitly");
  }
  if (BLOCK_DIRTY_DEPLOY && action_type === "deploy" && git.ok && git.dirty) {
    blockers.push("dirty tracked git tree blocks deploy/live action: " + git.entries.join("; "));
  }
  if (action_type === "code_edit" && git.ok && git.dirty) {
    warnings.push("tracked git tree already dirty; read the diff and avoid overwriting teammate/user work");
  }
  if (!git.ok && ["code_edit", "deploy"].includes(action_type)) {
    warnings.push("git state unavailable; clean-work rules could not inspect tracked changes");
  }

  return {
    enforced: true,
    protocol: [
      "session-start before work",
      "identity brief before meaningful work",
      "read memory/project rules before edits",
      "use compact memory search before fetching full rows",
      "preflight before code/deploy/external actions",
      "claim files before edits",
      "block dirty deploys",
      "block destructive commands unless explicitly allowed",
      "verify before resolving findings",
      "handoff before stop"
    ],
    blockers,
    warnings,
    git
  };
}

async function ownerTasteCheck(input, project, topics, action_type) {
  const needsCheck = REQUIRE_OWNER_TASTE_CHECK && ["code_edit", "deploy", "external_comm"].includes(action_type);
  if (!needsCheck) return { enabled: false, blockers: [], warnings: [] };
  const task = taskText(input);
  const topicText = (topics || []).join(" ");
  const queries = [
    `${OWNER_NAME} likes`,
    `${OWNER_NAME} dislikes`,
    `${OWNER_NAME} no-go`,
    `${OWNER_NAME} correction`,
    `${OWNER_NAME} prefers`,
    `${OWNER_NAME} mag`,
    `${OWNER_NAME} nicht mag`,
    `${OWNER_NAME} Korrektur`,
    [project, OWNER_NAME].filter(Boolean).join(" "),
    [project, topicText, OWNER_NAME].filter(Boolean).join(" "),
    [task, OWNER_NAME].filter(Boolean).join(" ")
  ].map(q => q.trim()).filter(Boolean).slice(0, 10);
  try {
    const seen = new Set();
    const rows = [];
    for (const q of queries) {
      const found = await recallQuery(q, 4);
      for (const row of found) {
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
        if (rows.length >= 10) break;
      }
      if (rows.length >= 10) break;
    }
    return {
      enabled: true,
      ok: true,
      queries,
      count: rows.length,
      memories: rows.map(r => ({
        id: r.id,
        kind: r.kind,
        actor: r.actor,
        occurred_at: r.occurred_at,
        preview: r.preview
      }))
    };
  } catch (e) {
    return {
      enabled: true,
      ok: false,
      queries,
      blockers: BLOCK_WITHOUT_OWNER_TASTE ? ["owner taste/no-go memory check failed: " + e.message] : [],
      warnings: ["owner taste/no-go memory check failed: " + e.message]
    };
  }
}

async function identityCheck(agent, project, action_type) {
  const needsCheck = REQUIRE_IDENTITY_CHECK && ["code_edit", "deploy", "external_comm"].includes(action_type);
  if (!needsCheck) return { enabled: false, blockers: [], warnings: [] };
  const brief = await safeTool("mem_session_brief", { agent_name: agent, project, token_budget: 250 });
  const blockers = [];
  if (!brief.ok) blockers.push("identity/session brief failed: " + brief.error);
  return {
    enabled: true,
    ok: brief.ok,
    blockers,
    warnings: brief.ok ? [] : ["identity state unavailable; do not continue blindly"],
    owner_name: OWNER_NAME,
    protocol: [
      "reload owner identity",
      "reload agent role",
      "reload core values and hard no-gos",
      "reload open promises and current project rules",
      "do not invent or overwrite identity from short-term chat context"
    ],
    summary: brief.ok ? brief.result : null
  };
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj || {}, null, 2) + "\n");
}

async function safeTool(name, args) {
  try {
    return { ok: true, result: await callTool(name, args) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function remainingWorkCheck(input, agent, project) {
  if (!REQUIRE_REMAINING_CHECK) return { enabled: false, blockers: [], auto_blockers: [], warnings: [] };
  const scope = runtimeScope();
  const knownProject = project && project !== "unknown";
  const summary = stopSummaryText(input);
  const nextActions = asArray(input.next_actions);
  const explicitBlockers = asArray(input.blockers);
  const checks = await Promise.all([
    safeTool("mem_work_active", { agent_name: agent, limit: 50 }),
    knownProject ? safeTool("mem_quality_finding_list", { project, status: "open", limit: 50 }) : Promise.resolve({ ok: true, result: { count: 0, findings: [] } }),
    safeTool("mem_firm_readiness_board", { scope, agent_name: agent })
  ]);
  const [work, findings, board] = checks;
  const activeClaims = work.ok ? Number(work.result.count || (work.result.claims || []).length || 0) : null;
  const openProjectFindings = findings.ok ? Number(findings.result.count || (findings.result.findings || []).length || 0) : null;
  const boardSummary = board.ok ? (board.result.summary || {}) : {};
  const firmBlocks = board.ok ? Number(boardSummary.block || 0) : null;
  const firmOpenFindings = board.ok ? Number(boardSummary.open_findings || 0) : null;
  const blockers = [];
  const autoBlockers = [];
  const warnings = [];

  if (REQUIRE_STOP_SUMMARY && !summary) blockers.push("handoff summary required before stop");
  if (REQUIRE_PROJECT && (!knownProject)) blockers.push("explicit project required before stop handoff");
  if (!work.ok) blockers.push("remaining-work check failed: mem_work_active: " + work.error);
  if (!findings.ok) blockers.push("remaining-work check failed: mem_quality_finding_list: " + findings.error);
  if (!board.ok) blockers.push("remaining-work check failed: mem_firm_readiness_board: " + board.error);

  if (activeClaims > 0) autoBlockers.push(activeClaims + " active agent claims visible before stop release");
  if (openProjectFindings > 0) autoBlockers.push(openProjectFindings + " open findings remain for " + project);
  if (firmBlocks > 0) autoBlockers.push(firmBlocks + " firm projects are blocked on readiness");
  if (firmOpenFindings > 0) warnings.push(firmOpenFindings + " open firm findings remain");

  const remainingExists = autoBlockers.length > 0 || explicitBlockers.length > 0;
  if (REQUIRE_STOP_NEXT_ACTIONS && remainingExists && nextActions.length === 0) {
    blockers.push("next_actions required because remaining work exists");
  }

  return {
    enabled: true,
    ok: blockers.length === 0,
    scope,
    project,
    summary_present: Boolean(summary),
    next_actions_count: nextActions.length,
    explicit_blockers_count: explicitBlockers.length,
    counts: {
      active_claims: activeClaims,
      open_project_findings: openProjectFindings,
      firm_blocks: firmBlocks,
      firm_open_findings: firmOpenFindings
    },
    blockers,
    auto_blockers: autoBlockers,
    warnings,
    protocol: [
      "read active claims before stop",
      "read open project findings before stop",
      "read firm readiness board before stop",
      "write next_actions when anything remains",
      "handoff changed files/tests/deploys/blockers",
      "release claims unless explicitly keeping them"
    ]
  };
}

async function sessionStart(input) {
  const project_info = projectInfo(input);
  const result = await callTool("mem_session_start", {
    agent_name: agentName(input),
    project: project_info.name,
    task: taskText(input)
  });
  print({ ok: !result.error, event: "session-start", project_info, result });
}

async function preTool(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const files = filePaths(input);
  const topics = inferTopics(input);
  const action_type = inferActionType(input);
  const task = taskText(input);
  const file_echo = [];
  for (const f of files.slice(0, 10)) {
    try { file_echo.push(await callTool("mem_file_echo", { file_path: f, limit: 5 })); } catch (e) { file_echo.push({ file_path: f, error: e.message }); }
  }
  let preflight = await safeTool("mem_agent_preflight", {
    agent_name: agent,
    project,
    task,
    files,
    action_type,
    topics,
    scope: runtimeScope(),
    auto_claim: isEditLike(input) && AUTO_CLAIM_ENABLED,
    require_project_rules: process.env.MNEMO_REQUIRE_PROJECT_RULES !== "0",
    block_on_high_findings: process.env.MNEMO_BLOCK_HIGH_FINDINGS !== "0"
  });
  if (preflight && preflight.ok && preflight.result) {
    preflight = preflight.result;
  } else if (preflight && preflight.error) {
    preflight = {
      status: BLOCK_ON_PREFLIGHT ? "block" : "warn",
      error: preflight.error,
      blockers: BLOCK_ON_PREFLIGHT ? ["preflight tool failed: " + preflight.error] : [],
      warnings: ["preflight tool failed: " + preflight.error]
    };
  }
  const hard_rules = hardRuleCheck(input, action_type, files, project, task);
  const owner_taste = await ownerTasteCheck(input, project, topics, action_type);
  const identity = await identityCheck(agent, project, action_type);
  const token_efficiency = tokenEfficiencyCheck(input, action_type);
  const smart_code_read = smartCodeReadCheck(input, action_type, files);
  const autonomy = autonomousPolicy(action_type, topics);
  const blockers = [
    ...((preflight && preflight.blockers) || []),
    ...(hard_rules.blockers || []),
    ...((owner_taste && owner_taste.blockers) || []),
    ...((identity && identity.blockers) || []),
    ...((token_efficiency && token_efficiency.blockers) || []),
    ...((smart_code_read && smart_code_read.blockers) || [])
  ];
  if ((preflight.status === "block" || blockers.length) && BLOCK_ON_PREFLIGHT) {
    const reason = blockers.join("; ") || "Mnemo preflight blocked this action.";
    print({
      ok: false,
      event: "pre-tool",
      decision: "block",
      reason,
      file_echo,
      project_info,
      preflight,
      hard_rules,
      owner_taste,
      identity,
      token_efficiency,
      smart_code_read,
      autonomy,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    });
    process.exitCode = 2;
    return;
  }
  print({ ok: true, event: "pre-tool", file_echo, project_info, preflight, hard_rules, owner_taste, identity, token_efficiency, smart_code_read, autonomy });
}

async function postTool(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const files = filePaths(input);
  const ownership = [];
  if (isEditLike(input)) {
    for (const f of files) {
      ownership.push(await callTool("mem_file_owner_set", {
        file_path: f,
        host: os.hostname(),
        primary_agent: agent,
        last_edit_agent: agent,
        last_commit_sha: process.env.GIT_COMMIT || null
      }));
    }
  }
  const action = await callTool("mem_action_log", {
    agent_name: agent,
    action_kind: "runtime_hook_post_tool",
    target: toolName(input),
    status: input.error ? "error" : "ok",
    topic: "runtime_hook",
    payload: {
      project,
      project_info,
      files,
      event: EVENT,
      tool: toolName(input)
    }
  });
  print({ ok: true, event: "post-tool", project_info, ownership, action });
}

async function stop(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const files = filePaths(input);
  const remaining = await remainingWorkCheck(input, agent, project);
  if (remaining.enabled && remaining.blockers.length && BLOCK_STOP_WITHOUT_REMAINING) {
    const reason = remaining.blockers.join("; ");
    print({
      ok: false,
      event: "stop",
      decision: "block",
      reason,
      project_info,
      remaining_work_check: remaining,
      hookSpecificOutput: {
        hookEventName: "Stop",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    });
    process.exitCode = 2;
    return;
  }
  const handoffBlockers = Array.from(new Set([...asArray(input.blockers), ...((remaining && remaining.auto_blockers) || [])]));
  const result = await callTool("mem_session_handoff", {
    agent_name: agent,
    project,
    summary: stopSummaryText(input) || taskText(input) || "Session stopped.",
    changed_files: files,
    tests: asArray(input.tests),
    deploys: asArray(input.deploys),
    blockers: handoffBlockers,
    next_actions: asArray(input.next_actions),
    release_claims: process.env.MNEMO_RELEASE_CLAIMS_ON_STOP !== "0",
    meta: Object.assign({}, input.meta || {}, { event: EVENT, hook: "firm-runtime-hook", project_info, remaining_work_check: remaining })
  });
  print({ ok: !result.error, event: "stop", project_info, remaining_work_check: remaining, result });
}

async function main() {
  const input = readStdin();
  if (EVENT === "session-start" || EVENT === "sessionstart" || EVENT === "start") return sessionStart(input);
  if (EVENT === "pre-tool" || EVENT === "pretooluse" || EVENT === "pre") return preTool(input);
  if (EVENT === "post-tool" || EVENT === "posttooluse" || EVENT === "post") return postTool(input);
  if (EVENT === "stop" || EVENT === "session-end" || EVENT === "sessionend") return stop(input);
  print({ ok: false, error: "unknown hook event", event: EVENT });
  process.exitCode = 2;
}

main().catch((e) => {
  print({ ok: false, event: EVENT, error: e.message });
  if (STRICT) process.exit(2);
});
