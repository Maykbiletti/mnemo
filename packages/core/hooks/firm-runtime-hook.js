#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { stripPrivate } = require("../shared_utils");
const { enqueueToolCall, flushQueue, queueStats } = require("./hook_queue");

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
const REQUIRE_CHAT_CAPTURE = process.env.MNEMO_REQUIRE_CHAT_CAPTURE !== "0";
const REQUIRE_PROMPT_RECALL = process.env.MNEMO_REQUIRE_PROMPT_RECALL !== "0";
const PROMPT_RECALL_LIMIT = Math.max(1, Number(process.env.MNEMO_PROMPT_RECALL_LIMIT || 8));
const TRANSCRIPT_SYNC_LINES = Math.max(20, Number(process.env.MNEMO_TRANSCRIPT_SYNC_LINES || 160));
const TRANSCRIPT_TAIL_BYTES = Math.max(65536, Number(process.env.MNEMO_TRANSCRIPT_TAIL_BYTES || 1048576));
const MAX_CAPTURE_TEXT_CHARS = Math.max(500, Number(process.env.MNEMO_MAX_CAPTURE_TEXT_CHARS || 8000));
const MAX_INJECTED_CONTEXT_CHARS = Math.max(1000, Number(process.env.MNEMO_MAX_INJECTED_CONTEXT_CHARS || 5500));
const MAX_OUTPUT_CONTEXT_PREVIEW_CHARS = Math.max(500, Number(process.env.MNEMO_MAX_OUTPUT_CONTEXT_PREVIEW_CHARS || 1400));
const HOOK_QUEUE_ON_FAILURE = process.env.MNEMO_HOOK_QUEUE_ON_FAILURE !== "0";
const HOOK_FLUSH_ON_EVENT = process.env.MNEMO_HOOK_FLUSH_ON_EVENT !== "0";

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
  if (!res.ok) {
    try {
      const fallback = await callTool("mem_recall", {
        query,
        limit: limit || 8,
        mode: "hybrid",
        include_journal: true,
        journal_scopes: ["transcript", "brief", "event"]
      });
      if (Array.isArray(fallback)) return fallback;
      if (fallback && Array.isArray(fallback.rows)) return fallback.rows;
      if (fallback && Array.isArray(fallback.results)) return fallback.results;
    } catch (fallbackError) {
      throw new Error(`recall ${res.status}: ${text.slice(0, 300)}; mem_recall fallback failed: ${fallbackError.message}`);
    }
    throw new Error(`recall ${res.status}: ${text.slice(0, 300)}; mem_recall fallback returned no rows`);
  }
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.rows)) return json.rows;
  if (json && Array.isArray(json.results)) return json.results;
  return [];
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
    let queued = null;
    if (HOOK_QUEUE_ON_FAILURE) {
      try {
        queued = enqueueToolCall({
          tool_name: name,
          args: args || {},
          error: e.message,
          source: "firm-runtime-hook",
          event: EVENT
        });
      } catch (queueError) {
        queued = { ok: false, error: queueError.message };
      }
    }
    return { ok: false, error: e.message, queued };
  }
}

async function readTool(name, args) {
  try {
    return { ok: true, result: await callTool(name, args) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function flushHookQueue() {
  if (!HOOK_FLUSH_ON_EVENT) return { enabled: false, stats: queueStats() };
  try {
    return await flushQueue(BASE_URL, {});
  } catch (e) {
    return { ok: false, error: e.message, stats: queueStats() };
  }
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20);
}

function truncateText(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return text.slice(0, max - 32) + "\n[truncated by mnemo hook]";
}

function memorySafeText(value) {
  return stripPrivate(String(value || "")).text || "";
}

function memorySafeJson(value, maxChars) {
  try {
    return truncateText(memorySafeText(JSON.stringify(value ?? null, null, 2)), maxChars || 6000);
  } catch {
    return truncateText(memorySafeText(String(value || "")), maxChars || 6000);
  }
}

function compactToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const out = {};
  for (const key of ["ok", "accepted", "inserted", "duplicate", "duplicates", "count", "flushed", "remaining", "id", "hash"]) {
    if (result[key] != null) out[key] = result[key];
  }
  if (Array.isArray(result.results)) out.results_count = result.results.length;
  if (Array.isArray(result.errors)) out.errors_count = result.errors.length;
  if (result.error) out.error = String(result.error).slice(0, 240);
  return Object.keys(out).length ? out : { summary: truncateText(JSON.stringify(result), 400) };
}

function hookSessionId(input) {
  return firstString(input.session_id, input.sessionId, input.thread_id, input.conversation_id);
}

function hookTranscriptPath(input) {
  return firstString(input.transcript_path, input.transcriptPath, input.claude_transcript_path);
}

function promptText(input) {
  const direct = firstString(
    input.user_prompt,
    input.prompt,
    input.message,
    input.text,
    input.lastPrompt,
    input.last_prompt,
    input.summary
  );
  if (direct) return direct;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && (msg.role === "user" || msg.type === "user")) {
      const text = claudeContentText(msg.content || msg.message || msg.text);
      if (text) return text;
    }
  }
  return "";
}

function claudeContentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      return firstString(content.text, content.content, content.message);
    }
    return "";
  }
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").toLowerCase();
    if (type && !["text", "input_text", "output_text"].includes(type)) continue;
    const text = firstString(item.text, item.content, item.message);
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function claudeEntryText(entry) {
  if (!entry || typeof entry !== "object") return { role: "", text: "" };
  if (entry.type === "last-prompt") return { role: "user", text: firstString(entry.lastPrompt, entry.prompt) };
  if (entry.type === "summary") return { role: "system", text: firstString(entry.summary, entry.text) };
  const message = entry.message && typeof entry.message === "object" ? entry.message : entry;
  const role = firstString(message.role, entry.role, entry.type).toLowerCase();
  const text = claudeContentText(message.content || message.text || entry.content || entry.text);
  if (!text) return { role, text: "" };
  if (role.includes("assistant")) return { role: "assistant", text };
  if (role.includes("user")) return { role: "user", text };
  return { role: role || "system", text };
}

function readTranscriptTail(filePath, maxLines) {
  const transcriptPath = String(filePath || "").trim();
  if (!transcriptPath) return { ok: false, error: "transcript_path missing" };
  if (!fs.existsSync(transcriptPath)) return { ok: false, error: "transcript_path not found: " + transcriptPath };
  const stat = fs.statSync(transcriptPath);
  const bytes = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
  const fd = fs.openSync(transcriptPath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes));
    const raw = buffer.toString("utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (stat.size > bytes && lines.length) lines.shift();
    return {
      ok: true,
      transcript_path: transcriptPath,
      total_bytes: stat.size,
      scanned_bytes: bytes,
      lines: lines.slice(-Math.max(1, maxLines || TRANSCRIPT_SYNC_LINES))
    };
  } finally {
    fs.closeSync(fd);
  }
}

function captureItem(input, opts) {
  const sessionId = hookSessionId(input);
  const role = String(opts.role || "").toLowerCase();
  const speaker = firstString(opts.speaker, role === "assistant" ? agentName(input) : OWNER_NAME);
  const safeContent = memorySafeText(opts.content);
  return {
    dedupe_key: opts.dedupe_key,
    source: "claude-code",
    channel: "claude-code",
    direction: opts.direction || (role === "assistant" ? "outbound" : "inbound"),
    actor: speaker,
    speaker,
    event_kind: opts.event_kind || "chat_turn",
    ref_kind: "claude_session",
    ref_id: sessionId || null,
    source_ref: hookTranscriptPath(input) || null,
    thread_id: sessionId || null,
    session_id: sessionId || null,
    status: "captured",
    content: truncateText(safeContent, MAX_CAPTURE_TEXT_CHARS),
    payload: opts.payload || {},
    meta: Object.assign({
      project: opts.project || projectName(input),
      cwd: cwdFrom(input),
      hook_event_name: input.hook_event_name || EVENT,
      role: role || null,
      capture_reason: opts.reason || EVENT
    }, opts.meta || {}),
    occurred_at: opts.occurred_at || new Date().toISOString(),
    promote_transcript: true,
    promote_memory: opts.promote_memory === true,
    remember: opts.remember === true,
    memory_kind: opts.memory_kind || undefined,
    importance: opts.importance || undefined,
    topic: opts.topic || "claude-code"
  };
}

async function capturePromptSubmit(input, agent, project, prompt) {
  if (!REQUIRE_CHAT_CAPTURE) return { enabled: false, ok: true, skipped: "disabled" };
  const text = memorySafeText(prompt).trim();
  if (!text) {
    return {
      enabled: true,
      ok: false,
      blockers: ["user prompt capture failed: hook input did not include user_prompt"],
      warnings: ["UserPromptSubmit did not provide prompt text"]
    };
  }
  const sessionId = hookSessionId(input) || "no-session";
  const item = captureItem(input, {
    project,
    role: "user",
    speaker: OWNER_NAME,
    event_kind: "user_prompt_submit",
    reason: "user-prompt",
    content: text,
    dedupe_key: `claude-user-prompt:${sessionId}:${shortHash(text)}`,
    payload: { prompt: text, private_redacted: text !== String(prompt || "").trim() },
    meta: { agent_name: agent }
  });
  const result = await safeTool("mem_capture_ingest", item);
  if (!result.ok || (result.result && result.result.error)) {
    const error = result.error || result.result.error;
    return {
      enabled: true,
      ok: false,
      blockers: ["user prompt capture failed: " + error],
      warnings: ["user prompt capture failed: " + error]
    };
  }
  return { enabled: true, ok: true, result: compactToolResult(result.result) };
}

async function syncTranscriptTail(input, agent, project, reason, lineLimit) {
  if (!REQUIRE_CHAT_CAPTURE) return { enabled: false, ok: true, skipped: "disabled" };
  let tail;
  try {
    tail = readTranscriptTail(hookTranscriptPath(input), lineLimit || TRANSCRIPT_SYNC_LINES);
  } catch (e) {
    tail = { ok: false, error: e.message };
  }
  if (!tail.ok) {
    return {
      enabled: true,
      ok: false,
      blockers: [`transcript sync failed: ${tail.error}`],
      warnings: [`transcript sync failed: ${tail.error}`]
    };
  }
  const sessionId = hookSessionId(input) || "no-session";
  const items = [];
  for (const raw of tail.lines) {
    let entry = null;
    try { entry = JSON.parse(raw); } catch { continue; }
    const extracted = claudeEntryText(entry);
    if (!extracted.text) continue;
    const role = extracted.role;
    if (!["user", "assistant", "system"].includes(role)) continue;
    const occurredAt = firstString(entry.timestamp, entry.created_at, entry.updated_at, entry.message && entry.message.timestamp);
    items.push(captureItem(input, {
      project,
      role,
      speaker: role === "assistant" ? agent : (role === "user" ? OWNER_NAME : "system"),
      event_kind: "claude_transcript_turn",
      reason,
      content: extracted.text,
      occurred_at: occurredAt || undefined,
      dedupe_key: `claude-jsonl:${sessionId}:${shortHash(raw)}`,
      payload: { role, type: entry.type || null },
      meta: {
        agent_name: agent,
        transcript_hash: shortHash(raw),
        transcript_path: tail.transcript_path
      }
    }));
  }
  if (!items.length) {
    return {
      enabled: true,
      ok: true,
      count: 0,
      transcript_path: tail.transcript_path,
      scanned_lines: tail.lines.length,
      warnings: ["transcript tail had no user/assistant text turns to capture"]
    };
  }

  const batch = await safeTool("mem_capture_ingest_batch", { items, limit: items.length });
  if (batch.ok && batch.result && !batch.result.error) {
    return {
      enabled: true,
      ok: true,
      count: items.length,
      transcript_path: tail.transcript_path,
      scanned_lines: tail.lines.length,
      result: compactToolResult(batch.result)
    };
  }

  const errors = [];
  let captured = 0;
  let duplicate = 0;
  for (const item of items) {
    const one = await safeTool("mem_capture_ingest", item);
    if (!one.ok || (one.result && one.result.error)) {
      errors.push(one.error || one.result.error);
    } else if (one.result && one.result.duplicate) {
      duplicate++;
    } else {
      captured++;
    }
  }
  return {
    enabled: true,
    ok: errors.length === 0,
    count: items.length,
    captured,
    duplicate,
    transcript_path: tail.transcript_path,
    scanned_lines: tail.lines.length,
    blockers: errors.length ? ["transcript sync failed: " + errors.slice(0, 3).join("; ")] : [],
    warnings: errors.slice(0, 5)
  };
}

function toolInputSnapshot(input) {
  return input.tool_input || input.args || (input.tool && input.tool.input) || {};
}

function toolResultSnapshot(input) {
  return input.tool_result || input.result || input.response || input.output || input.error || null;
}

async function captureToolObservation(input, agent, project) {
  if (process.env.MNEMO_CAPTURE_TOOL_OBSERVATION === "0") return { enabled: false, ok: true, skipped: "disabled" };
  const name = toolName(input) || EVENT;
  const toolInput = toolInputSnapshot(input);
  const toolResult = toolResultSnapshot(input);
  const files = filePaths(input);
  const content = [
    "Claude tool observation",
    `agent: ${agent}`,
    `project: ${project}`,
    `tool: ${name}`,
    `cwd: ${cwdFrom(input)}`,
    files.length ? `files: ${files.slice(0, 12).join(", ")}` : "",
    "",
    "input:",
    memorySafeJson(toolInput, 5000),
    "",
    "result:",
    memorySafeJson(toolResult, 5000)
  ].filter((line) => line !== "").join("\n");
  const sessionId = hookSessionId(input) || "no-session";
  const item = captureItem(input, {
    project,
    role: "system",
    speaker: agent,
    event_kind: "claude_tool_observation",
    reason: "post-tool",
    content,
    dedupe_key: `claude-tool:${sessionId}:${name}:${shortHash(content)}`,
    payload: {
      tool_name: name,
      has_input: !!toolInput && Object.keys(Object(toolInput)).length > 0,
      has_result: toolResult != null,
      error: input.error || null,
      files
    },
    meta: { agent_name: agent, tool_name: name }
  });
  const result = await safeTool("mem_capture_ingest", item);
  if (!result.ok || (result.result && result.result.error)) {
    const error = result.error || result.result.error;
    return {
      enabled: true,
      ok: false,
      blockers: [],
      warnings: ["tool observation capture failed: " + error],
      queued: result.queued || null
    };
  }
  return { enabled: true, ok: true, result: result.result };
}

function summarizeTranscriptForMemory(input, agent, project, reason) {
  let tail;
  try {
    tail = readTranscriptTail(hookTranscriptPath(input), Math.max(120, TRANSCRIPT_SYNC_LINES));
  } catch (e) {
    tail = { ok: false, error: e.message };
  }
  if (!tail.ok) return { ok: false, warning: tail.error };

  const user = [];
  const assistant = [];
  for (const raw of tail.lines) {
    let entry = null;
    try { entry = JSON.parse(raw); } catch { continue; }
    const extracted = claudeEntryText(entry);
    const text = compactQueryText(memorySafeText(extracted.text));
    if (!text) continue;
    if (extracted.role === "user") user.push(text);
    if (extracted.role === "assistant") assistant.push(text);
  }

  const files = filePaths(input).slice(0, 12);
  const lines = [
    `Session summary for ${agent} on ${project}`,
    `reason: ${reason}`,
    `session_id: ${hookSessionId(input) || "unknown"}`,
    "",
    "Recent user requests:",
    ...(user.slice(-6).map((text) => `- ${truncateText(text, 420)}`)),
    "",
    "Recent assistant work:",
    ...(assistant.slice(-8).map((text) => `- ${truncateText(text, 420)}`)),
    "",
    "Files seen in hook payload:",
    ...(files.length ? files.map((file) => `- ${file}`) : ["- none"])
  ];
  const summary = lines.join("\n").trim();
  if (!user.length && !assistant.length && !files.length) return { ok: false, warning: "no transcript turns or file references found" };
  return {
    ok: true,
    summary: truncateText(summary, MAX_CAPTURE_TEXT_CHARS),
    user_turns: user.length,
    assistant_turns: assistant.length,
    transcript_path: tail.transcript_path,
    scanned_lines: tail.lines.length
  };
}

async function captureSessionSummary(input, agent, project, reason) {
  if (process.env.MNEMO_CAPTURE_SESSION_SUMMARY === "0") return { enabled: false, ok: true, skipped: "disabled" };
  const summary = summarizeTranscriptForMemory(input, agent, project, reason);
  if (!summary.ok) {
    return {
      enabled: true,
      ok: true,
      skipped: "no-summary",
      warnings: summary.warning ? [summary.warning] : []
    };
  }
  const sessionId = hookSessionId(input) || "no-session";
  const item = captureItem(input, {
    project,
    role: "system",
    speaker: agent,
    event_kind: "claude_session_summary",
    reason,
    content: summary.summary,
    dedupe_key: `claude-session-summary:${sessionId}:${reason}:${shortHash(summary.summary)}`,
    payload: {
      reason,
      user_turns: summary.user_turns,
      assistant_turns: summary.assistant_turns,
      scanned_lines: summary.scanned_lines
    },
    meta: {
      agent_name: agent,
      summary_reason: reason,
      transcript_path: summary.transcript_path
    },
    promote_memory: true,
    remember: true,
    memory_kind: "reflection",
    importance: 6,
    topic: "session_summary"
  });
  const result = await safeTool("mem_capture_ingest", item);
  if (!result.ok || (result.result && result.result.error)) {
    const error = result.error || result.result.error;
    return {
      enabled: true,
      ok: false,
      blockers: [],
      warnings: ["session summary capture failed: " + error],
      queued: result.queued || null
    };
  }
  return { enabled: true, ok: true, result: result.result, user_turns: summary.user_turns, assistant_turns: summary.assistant_turns };
}

function compactQueryText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

async function priorContextCheck(input, project, topics, prompt) {
  if (!REQUIRE_PROMPT_RECALL) return { enabled: false, ok: true, skipped: "disabled" };
  const task = compactQueryText(memorySafeText(prompt || taskText(input)));
  const files = filePaths(input).slice(0, 8);
  const queries = [];
  if (task) queries.push(task);
  if (project && project !== "unknown" && task) queries.push(`${project} ${task}`);
  if (project && project !== "unknown") queries.push(`${project} current work open blockers decisions`);
  if (topics && topics.length) queries.push(`${project} ${topics.join(" ")} rules decisions no-touch`);
  if (files.length) queries.push(`${project} ${files.join(" ")}`);
  if (!queries.length) queries.push(`${project || "unknown"} recent conversation solution`);

  const seen = new Set();
  const memories = [];
  try {
    for (const query of Array.from(new Set(queries)).slice(0, 6)) {
      const rows = await recallQuery(query, PROMPT_RECALL_LIMIT);
      for (const row of rows) {
        const key = row && (row.id || `${row.kind}:${row.occurred_at}:${row.preview}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        memories.push({
          id: row.id || null,
          kind: row.kind || null,
          actor: row.actor || row.speaker || null,
          occurred_at: row.occurred_at || null,
          preview: truncateText(row.preview || row.content || row.text || "", 360)
        });
        if (memories.length >= PROMPT_RECALL_LIMIT) break;
      }
      if (memories.length >= PROMPT_RECALL_LIMIT) break;
    }
    return { enabled: true, ok: true, queries: Array.from(new Set(queries)).slice(0, 6), count: memories.length, memories };
  } catch (e) {
    return {
      enabled: true,
      ok: false,
      queries: Array.from(new Set(queries)).slice(0, 6),
      blockers: ["prior conversation recall failed: " + e.message],
      warnings: ["prior conversation recall failed: " + e.message]
    };
  }
}

async function pendingBriefContext(agent) {
  const pulled = await readTool("mem_brief_pull", { agent_name: agent, peek: true, limit: 5 });
  if (!pulled.ok || (pulled.result && pulled.result.error)) {
    return { ok: false, count: 0, briefs: [], error: pulled.error || pulled.result.error };
  }
  const briefs = Array.isArray(pulled.result && pulled.result.briefs) ? pulled.result.briefs : [];
  return {
    ok: true,
    count: Number((pulled.result && pulled.result.count) || briefs.length || 0),
    briefs: briefs.slice(0, 5).map((brief) => ({
      id: brief.id || null,
      source_agent: brief.source_agent || null,
      created_at: brief.created_at || null,
      preview: truncateText(brief.content || brief.preview || "", 280)
    }))
  };
}

function contextOutputPreview(context) {
  return truncateText(context, MAX_OUTPUT_CONTEXT_PREVIEW_CHARS);
}

function hookCriticalSummary(data) {
  const pending = data.pending_briefs || {};
  const prior = data.prior_context || {};
  const blockers = asArray(data.blockers);
  const warnings = asArray(data.warnings);
  return {
    pending_briefs: Number(pending.count || 0),
    pending_brief_ids: (pending.briefs || []).map((brief) => brief.id).filter(Boolean),
    prior_hits: Number(prior.count || 0),
    blockers: blockers.slice(0, 5),
    warnings: warnings.slice(0, 5)
  };
}

function injectedContextText(kind, data) {
  const lines = [
    "MNEMO AUTO-CONTEXT",
    `Event: ${kind}`,
    `Project: ${data.project_info ? data.project_info.name : "unknown"}`,
    "",
    "Mandatory protocol:",
    "- Treat Mnemo as the source of truth before answering or editing.",
    "- Check the prior-context hits below for existing discussions, no-touch rules, decisions, and partial solutions.",
    "- If hits conflict with the short chat context, pause and verify in Mnemo instead of guessing.",
    "- If the task touches auth, billing, live infra, design lock, or protected pages, run the matching Mnemo preflight/claims before edits.",
    "- Keep identity from Mnemo/session brief; do not rewrite your role from compacted chat noise."
  ];

  if (data.pending_briefs && data.pending_briefs.ok) {
    lines.push("", `Pending briefs: ${data.pending_briefs.count || 0}`);
    for (const brief of (data.pending_briefs.briefs || []).slice(0, 5)) {
      lines.push(`- #${brief.id || "?"} from ${brief.source_agent || "?"}: ${brief.preview || ""}`.trim());
    }
  } else if (data.pending_briefs && !data.pending_briefs.ok) {
    lines.push("", "Pending brief check failed: " + data.pending_briefs.error);
  }

  if (data.session_start && data.session_start.ok) {
    lines.push("", "Session bundle:");
    lines.push(truncateText(JSON.stringify(data.session_start.result || data.session_start, null, 2), 1200));
  } else if (data.session_start && !data.session_start.ok) {
    lines.push("", "Session bundle failed: " + data.session_start.error);
  }

  if (data.prior_context && data.prior_context.enabled) {
    lines.push("", `Prior Mnemo hits: ${data.prior_context.count || 0}`);
    for (const mem of (data.prior_context.memories || []).slice(0, PROMPT_RECALL_LIMIT)) {
      const head = [mem.id ? `#${mem.id}` : null, mem.kind, mem.actor, mem.occurred_at].filter(Boolean).join(" ");
      lines.push(`- ${head}: ${mem.preview || ""}`.trim());
    }
    if (!(data.prior_context.memories || []).length) lines.push("- No prior hit found; still record new facts/evidence as work proceeds.");
  }

  if (data.prompt_capture && !data.prompt_capture.ok) {
    lines.push("", "Prompt capture warning: " + (data.prompt_capture.warnings || []).join("; "));
  }
  if (data.transcript_sync && !data.transcript_sync.ok) {
    lines.push("", "Transcript sync warning: " + (data.transcript_sync.warnings || []).join("; "));
  }

  return truncateText(lines.join("\n"), MAX_INJECTED_CONTEXT_CHARS);
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

function compactHookPayload(data) {
  const sync = data.transcript_sync || {};
  const prior = data.prior_context || {};
  const prompt = data.prompt_capture || {};
  const session = data.session_start || data.result || {};
  const queue = data.queue_flush || {};
  return {
    hook_event: data.hook_event,
    project: data.project,
    ok: data.ok,
    prompt_capture_ok: prompt.ok == null ? null : !!prompt.ok,
    transcript_sync_ok: sync.ok == null ? null : !!sync.ok,
    transcript_count: sync.count == null ? null : Number(sync.count || 0),
    transcript_scanned_lines: sync.scanned_lines == null ? null : Number(sync.scanned_lines || 0),
    prior_recall_ok: prior.ok == null ? null : !!prior.ok,
    prior_count: prior.count == null ? null : Number(prior.count || 0),
    session_start_ok: session.ok == null ? null : !!session.ok,
    queue_flush_ok: queue.ok == null ? null : !!queue.ok,
    queue_flushed: queue.flushed == null ? null : Number(queue.flushed || 0),
    queue_remaining: queue.remaining == null ? null : Number(queue.remaining || 0),
    blockers: asArray(data.blockers).slice(0, 8),
    warnings: [
      ...asArray(prompt.warnings),
      ...asArray(sync.warnings),
      ...asArray(prior.warnings)
    ].slice(0, 8)
  };
}

async function logHookStatus(input, agent, project, hookEvent, ok, data) {
  const payload = compactHookPayload(Object.assign({}, data || {}, {
    hook_event: hookEvent,
    project,
    ok: !!ok
  }));
  return safeTool("mem_action_log", {
    agent_name: agent,
    action_kind: "mnemo_runtime_hook",
    target: hookEvent,
    status: ok ? "ok" : "error",
    topic: "runtime_hook",
    session_id: hookSessionId(input) || null,
    payload,
    meta: {
      hook: "firm-runtime-hook",
      event: EVENT,
      cwd: cwdFrom(input),
      transcript_path: hookTranscriptPath(input) || null
    }
  });
}

async function sessionStart(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
  const result = await safeTool("mem_session_start", {
    agent_name: agent,
    project: project_info.name,
    task: taskText(input)
  });
  const transcript_sync = await syncTranscriptTail(input, agent, project, "session-start", Math.max(80, TRANSCRIPT_SYNC_LINES));
  const prior_context = await priorContextCheck(input, project, inferTopics(input), promptText(input) || taskText(input));
  const pending_briefs = await pendingBriefContext(agent);
  const context = injectedContextText("SessionStart", { project_info, session_start: result, transcript_sync, prior_context, pending_briefs });
  const ok = result.ok && transcript_sync.ok && prior_context.ok;
  const hook_status = await logHookStatus(input, agent, project, "SessionStart", ok, { result, transcript_sync, prior_context, pending_briefs, queue_flush });
  print({
    ok,
    event: "session-start",
    critical_context: hookCriticalSummary({ pending_briefs, prior_context }),
    project_info,
    result: result.ok ? compactToolResult(result.result) : { error: result.error },
    transcript_sync,
    prior_context,
    pending_briefs,
    queue_flush,
    hook_status,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context
    },
    additional_context: contextOutputPreview(context),
    additional_context_chars: context.length
  });
}

async function userPromptSubmit(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
  const prompt = promptText(input);
  const topics = Array.from(new Set([...inferTopics(input), ...inferTopics(Object.assign({}, input, { prompt }))]));
  const prompt_capture = await capturePromptSubmit(input, agent, project, prompt);
  const transcript_sync = await syncTranscriptTail(input, agent, project, "user-prompt", TRANSCRIPT_SYNC_LINES);
  const prior_context = await priorContextCheck(input, project, topics, prompt);
  const session_start = await safeTool("mem_session_start", { agent_name: agent, project, task: prompt || taskText(input) });
  const pending_briefs = await pendingBriefContext(agent);
  const blockers = [
    ...((prompt_capture && prompt_capture.blockers) || []),
    ...((transcript_sync && transcript_sync.blockers) || []),
    ...((prior_context && prior_context.blockers) || [])
  ];
  const context = injectedContextText("UserPromptSubmit", {
    project_info,
    session_start,
    prompt_capture,
    transcript_sync,
    prior_context,
    pending_briefs
  });

  if (blockers.length && BLOCK_ON_PREFLIGHT) {
    const reason = blockers.join("; ");
    const hook_status = await logHookStatus(input, agent, project, "UserPromptSubmit", false, { prompt_capture, transcript_sync, prior_context, pending_briefs, queue_flush, blockers });
    print({
      ok: false,
      event: "user-prompt",
      decision: "block",
      reason,
      critical_context: hookCriticalSummary({ pending_briefs, prior_context, blockers }),
      project_info,
      prompt_capture,
      transcript_sync,
      prior_context,
      pending_briefs,
      queue_flush,
      hook_status,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context
      },
      additional_context: contextOutputPreview(context),
      additional_context_chars: context.length
    });
    process.exitCode = 2;
    return;
  }

  const ok = prompt_capture.ok && transcript_sync.ok && prior_context.ok;
  const hook_status = await logHookStatus(input, agent, project, "UserPromptSubmit", ok, { prompt_capture, transcript_sync, prior_context, pending_briefs, session_start, queue_flush });
  print({
    ok,
    event: "user-prompt",
    critical_context: hookCriticalSummary({ pending_briefs, prior_context }),
    project_info,
    prompt_capture,
    transcript_sync,
    prior_context,
    pending_briefs,
    queue_flush,
    hook_status,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    },
    additional_context: contextOutputPreview(context),
    additional_context_chars: context.length
  });
}

async function preCompact(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
  const transcript_sync = await syncTranscriptTail(input, agent, project, "pre-compact", Math.max(240, TRANSCRIPT_SYNC_LINES));
  const snapshot = await safeTool("mem_capture_ingest", captureItem(input, {
    project,
    role: "system",
    speaker: "system",
    event_kind: "claude_precompact_snapshot",
    reason: "pre-compact",
    content: `Claude Code PreCompact fired for ${agent} on ${project}. Reason: ${firstString(input.reason, input.trigger, "context compaction")}`,
    dedupe_key: `claude-precompact:${hookSessionId(input) || "no-session"}:${Date.now()}`,
    payload: { reason: input.reason || null, trigger: input.trigger || null },
    meta: { agent_name: agent }
  }));
  const blockers = [
    ...((transcript_sync && transcript_sync.blockers) || []),
    ...((snapshot.ok && !(snapshot.result && snapshot.result.error)) ? [] : ["pre-compact snapshot failed: " + (snapshot.error || (snapshot.result && snapshot.result.error) || "unknown")])
  ];
  const context = injectedContextText("PreCompact", { project_info, transcript_sync });
  if (blockers.length && BLOCK_ON_PREFLIGHT) {
    const reason = blockers.join("; ");
    const hook_status = await logHookStatus(input, agent, project, "PreCompact", false, { transcript_sync, snapshot, queue_flush, blockers });
    print({
      ok: false,
      event: "pre-compact",
      decision: "block",
      reason,
      project_info,
      transcript_sync,
      queue_flush,
      snapshot: snapshot.ok ? compactToolResult(snapshot.result) : snapshot,
      hook_status,
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: context
      },
      additional_context: contextOutputPreview(context),
      additional_context_chars: context.length
    });
    process.exitCode = 2;
    return;
  }
  const ok = transcript_sync.ok && snapshot.ok;
  const hook_status = await logHookStatus(input, agent, project, "PreCompact", ok, { transcript_sync, snapshot, queue_flush });
  print({
    ok,
    event: "pre-compact",
    project_info,
    transcript_sync,
    queue_flush,
    snapshot: snapshot.ok ? compactToolResult(snapshot.result) : { error: snapshot.error },
    hook_status,
    hookSpecificOutput: {
      hookEventName: "PreCompact",
      additionalContext: context
    },
    additional_context: contextOutputPreview(context),
    additional_context_chars: context.length
  });
}

async function preTool(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
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
    const hook_status = await logHookStatus(input, agent, project, "PreToolUse", false, { queue_flush, blockers, prior_context: { ok: true, count: 0 }, transcript_sync: { ok: true, count: 0 } });
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
      queue_flush,
      hook_status,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    });
    process.exitCode = 2;
    return;
  }
  const hook_status = await logHookStatus(input, agent, project, "PreToolUse", true, { queue_flush, transcript_sync: { ok: true, count: 0 }, prior_context: { ok: true, count: 0 } });
  print({ ok: true, event: "pre-tool", file_echo, project_info, preflight, hard_rules, owner_taste, identity, token_efficiency, smart_code_read, autonomy, queue_flush, hook_status });
}

async function postTool(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
  const files = filePaths(input);
  const transcript_sync = await syncTranscriptTail(input, agent, project, "post-tool", Math.max(40, Math.floor(TRANSCRIPT_SYNC_LINES / 2)));
  const ownership = [];
  if (isEditLike(input)) {
    for (const f of files) {
      ownership.push(await safeTool("mem_file_owner_set", {
        file_path: f,
        host: os.hostname(),
        primary_agent: agent,
        last_edit_agent: agent,
        last_commit_sha: process.env.GIT_COMMIT || null
      }));
    }
  }
  const action = await safeTool("mem_action_log", {
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
  const tool_observation = await captureToolObservation(input, agent, project);
  const ok = !input.error && transcript_sync.ok && tool_observation.ok && action.ok;
  const hook_status = await logHookStatus(input, agent, project, "PostToolUse", ok, { transcript_sync, queue_flush, tool_observation, blockers: input.error ? [String(input.error)] : [] });
  print({ ok, event: "post-tool", project_info, ownership, action, transcript_sync, tool_observation, queue_flush, hook_status });
}

async function stop(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
  const files = filePaths(input);
  const transcript_sync = await syncTranscriptTail(input, agent, project, "stop", Math.max(240, TRANSCRIPT_SYNC_LINES));
  const remaining = await remainingWorkCheck(input, agent, project);
  if (remaining.enabled && remaining.blockers.length && BLOCK_STOP_WITHOUT_REMAINING) {
    const reason = remaining.blockers.join("; ");
    const hook_status = await logHookStatus(input, agent, project, "Stop", false, { transcript_sync, queue_flush, blockers: remaining.blockers });
    print({
      ok: false,
      event: "stop",
      decision: "block",
      reason,
      project_info,
      remaining_work_check: remaining,
      queue_flush,
      hook_status,
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
  const result = await safeTool("mem_session_handoff", {
    agent_name: agent,
    project,
    summary: stopSummaryText(input) || taskText(input) || "Session stopped.",
    changed_files: files,
    tests: asArray(input.tests),
    deploys: asArray(input.deploys),
    blockers: handoffBlockers,
    next_actions: asArray(input.next_actions),
    release_claims: process.env.MNEMO_RELEASE_CLAIMS_ON_STOP !== "0",
    meta: Object.assign({}, input.meta || {}, { event: EVENT, hook: "firm-runtime-hook", project_info, remaining_work_check: remaining, transcript_sync })
  });
  const summary_capture = await captureSessionSummary(input, agent, project, "stop");
  const ok = result.ok && !(result.result && result.result.error) && transcript_sync.ok && summary_capture.ok;
  const hook_status = await logHookStatus(input, agent, project, "Stop", ok, { transcript_sync, result, summary_capture, queue_flush });
  print({ ok, event: "stop", project_info, remaining_work_check: remaining, transcript_sync, summary_capture, queue_flush, result, hook_status });
}

async function sessionEnd(input) {
  const agent = agentName(input);
  const project_info = projectInfo(input);
  const project = project_info.name;
  const queue_flush = await flushHookQueue();
  const transcript_sync = await syncTranscriptTail(input, agent, project, "session-end", Math.max(240, TRANSCRIPT_SYNC_LINES));
  const snapshot = await safeTool("mem_capture_ingest", captureItem(input, {
    project,
    role: "system",
    speaker: "system",
    event_kind: "claude_session_end_snapshot",
    reason: "session-end",
    content: `Claude Code SessionEnd fired for ${agent} on ${project}. Reason: ${firstString(input.reason, input.source, "session ended")}`,
    dedupe_key: `claude-session-end:${hookSessionId(input) || "no-session"}:${Date.now()}`,
    payload: { reason: input.reason || null, source: input.source || null },
    meta: { agent_name: agent }
  }));
  const summary_capture = await captureSessionSummary(input, agent, project, "session-end");
  const ok = transcript_sync.ok && snapshot.ok && summary_capture.ok;
  const hook_status = await logHookStatus(input, agent, project, "SessionEnd", ok, { transcript_sync, snapshot, summary_capture, queue_flush });
  print({
    ok,
    event: "session-end",
    project_info,
    transcript_sync,
    summary_capture,
    queue_flush,
    snapshot: snapshot.ok ? snapshot.result : { error: snapshot.error },
    hook_status
  });
}

async function main() {
  const input = readStdin();
  if (EVENT === "session-start" || EVENT === "sessionstart" || EVENT === "start") return sessionStart(input);
  if (EVENT === "user-prompt" || EVENT === "userpromptsubmit" || EVENT === "prompt") return userPromptSubmit(input);
  if (EVENT === "pre-compact" || EVENT === "precompact" || EVENT === "compact") return preCompact(input);
  if (EVENT === "pre-tool" || EVENT === "pretooluse" || EVENT === "pre") return preTool(input);
  if (EVENT === "post-tool" || EVENT === "posttooluse" || EVENT === "post") return postTool(input);
  if (EVENT === "session-end" || EVENT === "sessionend" || EVENT === "end") return sessionEnd(input);
  if (EVENT === "stop") return stop(input);
  print({ ok: false, error: "unknown hook event", event: EVENT });
  process.exitCode = 2;
}

main().catch((e) => {
  print({ ok: false, event: EVENT, error: e.message });
  if (STRICT) process.exit(2);
});
