/**
 * Shared pure utilities — single source of truth for helpers used
 * by daemon.js, mcp.js, and timeline_report_tools.js.
 *
 * Usage:
 *   const { parseMaybeJson, deepMergePlain, uniqueIntegers } = require("./shared_utils");
 */

function parseMaybeJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback === undefined ? value : fallback; }
}

function uniqueIntegers(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map(v => parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v > 0)));
}

function deepMergePlain(base, override) {
  const out = Object.assign({}, base || {});
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMergePlain(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Strip memory-private blocks from text before SQLite persist.
function stripPrivate(text) {
  if (typeof text !== "string" || !text) return { text, hadPrivate: false };
  const patterns = [
    { re: /<private\b[^>]*>[\s\S]*?<\/private>/gi, marker: "[private]" },
    { re: /<mnemo-private\b[^>]*>[\s\S]*?<\/mnemo-private>/gi, marker: "[private]" },
    { re: /<memory-private\b[^>]*>[\s\S]*?<\/memory-private>/gi, marker: "[private]" },
    { re: /<no-memory\b[^>]*>[\s\S]*?<\/no-memory>/gi, marker: "[no-memory]" },
    { re: /<nomemory\b[^>]*>[\s\S]*?<\/nomemory>/gi, marker: "[no-memory]" },
    { re: /\[private\][\s\S]*?\[\/private\]/gi, marker: "[private]" },
    { re: /\[no-memory\][\s\S]*?\[\/no-memory\]/gi, marker: "[no-memory]" },
    { re: /<!--\s*(?:mnemo:)?private\s*-->[\s\S]*?<!--\s*\/(?:mnemo:)?private\s*-->/gi, marker: "[private]" },
    { re: /<!--\s*(?:mnemo:)?no-memory\s*-->[\s\S]*?<!--\s*\/(?:mnemo:)?no-memory\s*-->/gi, marker: "[no-memory]" },
  ];
  let out = text;
  let hadPrivate = false;
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(out)) {
      hadPrivate = true;
      pattern.re.lastIndex = 0;
      out = out.replace(pattern.re, pattern.marker);
    }
  }
  return { text: out, hadPrivate };
}

function parseAgentCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeAgentName(name) {
  return String(name || "").trim().toLowerCase();
}

function jsonSafe(value, maxChars = 12000) {
  if (value === undefined) return null;
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (!raw) return null;
    return raw.length > maxChars ? raw.slice(0, maxChars) + "...[truncated]" : raw;
  } catch {
    const raw = String(value);
    return raw.length > maxChars ? raw.slice(0, maxChars) + "...[truncated]" : raw;
  }
}

function compactContent(value, maxChars = 8000) {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : jsonSafe(value, maxChars);
  if (!raw) return null;
  const scrubbed = stripPrivate(raw).text || "";
  return scrubbed.length > maxChars ? scrubbed.slice(0, maxChars) + "...[truncated]" : scrubbed;
}

function parseMetaJson(metaJson) {
  try { return JSON.parse(metaJson || "{}"); } catch { return {}; }
}

function isoOrNull(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += "T09:00:00";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseBriefTitle(content) {
  const lines = String(content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => !/^#{1,6}\s*$/.test(line)) || "Brief";
  return first.replace(/^#{1,6}\s*/, "").slice(0, 140) || "Brief";
}

// --- Brief contract constants & helpers ---

const TEAM_BRIEF_ALIASES = new Set(["all", "crew", "everyone", "group", "gruppe", "team"]);
const BRIEF_CONTRACT_VERSION = "firm-brief-v1";
const BRIEF_REQUIRED_HEADINGS = ["## Title", "## Project", "## Request", "## Acceptance", "## Report Back"];

function cleanScope(scope) {
  return String(scope || "default").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "default";
}

function uniqueAgentNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    const cleaned = String(name || "").trim();
    const key = cleaned.toLowerCase();
    if (!cleaned || TEAM_BRIEF_ALIASES.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isTeamBriefTarget(name) {
  return TEAM_BRIEF_ALIASES.has(String(name || "").trim().toLowerCase());
}

function hasCanonicalBriefShape(content) {
  const text = String(content || "");
  return BRIEF_REQUIRED_HEADINGS.filter((heading) => text.includes(heading)).length >= 4;
}

function normalizeBriefMeta(meta, extras = {}) {
  const base = meta && typeof meta === "object" ? { ...meta } : {};
  return {
    ...base,
    ...extras,
    brief_contract_version: BRIEF_CONTRACT_VERSION,
    brief_contract_required: true,
  };
}

function normalizeBriefContent(content, meta, extras = {}) {
  const body = String(content || "").trim();
  const normalizedMeta = normalizeBriefMeta(meta, extras);
  if (!body) return { content: body, meta: normalizedMeta };
  if (hasCanonicalBriefShape(body)) return { content: body, meta: normalizedMeta };
  const project = String(normalizedMeta.project || normalizedMeta.scope || normalizedMeta.portal || "unspecified").trim() || "unspecified";
  const constraints = []
    .concat(Array.isArray(normalizedMeta.constraints) ? normalizedMeta.constraints : [])
    .concat(Array.isArray(normalizedMeta.guardrails) ? normalizedMeta.guardrails : [])
    .filter(Boolean);
  const acceptance = []
    .concat(Array.isArray(normalizedMeta.acceptance) ? normalizedMeta.acceptance : [])
    .concat(Array.isArray(normalizedMeta.acceptance_criteria) ? normalizedMeta.acceptance_criteria : [])
    .filter(Boolean);
  const reportBack = []
    .concat(Array.isArray(normalizedMeta.report_back) ? normalizedMeta.report_back : [])
    .concat(["what changed", "what was checked", "what is still open"]);
  return {
    content: [
      "# Brief",
      "",
      "## Title",
      parseBriefTitle(body),
      "",
      "## Project",
      project,
      "",
      "## Request",
      body,
      "",
      "## Constraints",
      ...(constraints.length ? constraints.map((item) => `- ${item}`) : ["- follow project rules", "- no duplicate work", "- stay in assigned lane"]),
      "",
      "## Acceptance",
      ...(acceptance.length ? acceptance.map((item) => `- ${item}`) : ["- requested outcome is implemented", "- no regressions introduced", "- result is reported in the standard report area"]),
      "",
      "## Report Back",
      ...reportBack.map((item) => `- ${item}`),
    ].join("\n"),
    meta: normalizedMeta,
  };
}

// --- File / media helpers ---

function baseName(p) {
  const raw = String(p || "").split(/[\\/]/).pop() || "";
  return raw.trim();
}

function extensionName(p) {
  const name = baseName(p);
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function inferMediaKind(a, meta, payload, fileName, ext) {
  const eventKind = String(a.event_kind || "").toLowerCase();
  const hinted = String(a.media_kind || meta.media_kind || payload.media_kind || "").toLowerCase();
  if (hinted) return hinted;
  if (eventKind.includes("screenshot")) return "screenshot";
  if (eventKind.includes("photo") || eventKind.includes("image")) return "image";
  if (eventKind.includes("document") || eventKind.includes("pdf")) return "document";
  if (eventKind.includes("file") || eventKind.includes("attachment")) return "file";
  if (["png","jpg","jpeg","webp","gif","bmp"].includes(ext)) return "screenshot";
  if (["pdf","doc","docx","txt","md","rtf","html","htm","csv","tsv","json","jsonl","xml","log"].includes(ext)) return "document";
  if (fileName) return "file";
  return "";
}

function inferMediaType(ext, kind) {
  if (kind === "screenshot" || kind === "image") return "image";
  if (kind === "document") return "document";
  return ext ? "file" : "";
}

function uniqueStrings(list) {
  return Array.from(new Set((Array.isArray(list) ? list : [list]).map(x => String(x || "").trim()).filter(Boolean)));
}

function compactTitleText(value, max = 90) {
  const raw = String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  return raw.length > max ? raw.slice(0, max - 1).trim() + "…" : raw;
}

function captureSourceLabel(source, channel) {
  const s = String(source || "").toLowerCase();
  const c = String(channel || "").toLowerCase();
  if (s.includes("telegram") || c.includes("telegram") || c.includes("chat")) return "Chat";
  if (s.includes("email") || c.includes("mail")) return "Email";
  if (s.includes("browser")) return "Browser";
  if (s.includes("brief")) return "Brief";
  if (s.includes("manual")) return "Manual";
  return source ? String(source).replace(/[-_]+/g, " ").replace(/\b\w/g, m => m.toUpperCase()) : "Capture";
}

function formatCaptureDisplayTime(value) {
  const d = value ? new Date(value) : new Date();
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCaptureFileTime(value) {
  const d = value ? new Date(value) : new Date();
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function slugFilePart(value, max = 96) {
  const s = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "media";
}

function buildMediaTitle(input = {}) {
  const explicit = input.title || input.meta && input.meta.title || input.payload && input.payload.title;
  if (explicit) return compactTitleText(explicit, 160);
  const sourceLabel = captureSourceLabel(input.source, input.channel);
  const stamp = formatCaptureDisplayTime(input.occurred_at);
  const context = compactTitleText(
    input.context_text || input.content || input.text ||
    input.meta && (input.meta.context_text || input.meta.caption || input.meta.message_text || input.meta.notes) ||
    input.payload && (input.payload.context_text || input.payload.caption || input.payload.message_text || input.payload.notes) ||
    "",
    100
  );
  const fallback = compactTitleText([input.project, input.media_kind, input.route, input.page_url, input.file_name].filter(Boolean).join(" "), 100);
  return [sourceLabel, stamp, context || fallback].filter(Boolean).join(" ").trim();
}

function buildCanonicalMediaFileName(input = {}) {
  const ext = String(input.file_ext || extensionName(input.file_name || input.media_path) || "asset").toLowerCase();
  const title = input.title || buildMediaTitle(input);
  const stamp = formatCaptureFileTime(input.occurred_at);
  const label = captureSourceLabel(input.source, input.channel);
  const source = slugFilePart(label, 24);
  const body = slugFilePart(title.replace(formatCaptureDisplayTime(input.occurred_at), "").replace(new RegExp("^" + label + "\\s*", "i"), ""), 100);
  const base = [source, stamp, body].filter(Boolean).join("-");
  return `${base || "media"}${ext ? "." + ext.replace(/^\./, "") : ""}`;
}

// --- Contract validation constants ---

const AUTH_CONTRACT_REQUIRED_FIELDS = ["status", "mode", "provider", "canonical_project", "canonical_login_url", "shared_identity_scope", "shared_accounts"];
const UI_CONTRACT_REQUIRED_FIELDS = [
  "status",
  "canonical_brand_project",
  "canonical_header_project",
  "canonical_button_project",
  "canonical_font_source_project",
  "canonical_font_display",
  "canonical_font_body",
  "canonical_logo_light_asset",
  "canonical_logo_dark_asset",
  "canonical_logo_size_rule",
  "canonical_button_size_rule",
  "light_mode_required",
  "dark_mode_required",
  "shared_ui_family",
  "no_local_ui_interpretation"
];

// --- Sensitivity detectors ---

function authSensitiveTask(input) {
  const text = [
    input && input.task,
    input && input.summary,
    Array.isArray(input && input.topics) ? input.topics.join(" ") : "",
    Array.isArray(input && input.files) ? input.files.join(" ") : "",
    input && input.action_type
  ].filter(Boolean).join(" ");
  return /\b(auth|login|sso|signup|signin|sign-in|session|cookie|oauth|password|reset|forgot|verify|onboarding|account)\b/i.test(text);
}

function uiSensitiveTask(input) {
  const text = [
    input && input.task,
    input && input.summary,
    Array.isArray(input && input.topics) ? input.topics.join(" ") : "",
    Array.isArray(input && input.files) ? input.files.join(" ") : "",
    input && input.action_type
  ].filter(Boolean).join(" ");
  return /\b(ui|frontend|header|headder|footer|menu|menue|nav|navigation|button|buttons|theme|light|dark|logo|style|design|layout|mobile|responsive|landing)\b/i.test(text);
}

// --- Contract report builders ---
// These take an ensureTables callback so callers wire in their own schema bootstrap.

function authContractReport(tdb, project, ensureTables) {
  if (ensureTables) ensureTables(tdb);
  if (!project) return { error: "project required" };
  const row = tdb.prepare("SELECT project, auth_matrix, updated_at, updated_by FROM project_rules WHERE project=?").get(project);
  if (!row) return { error: "project_rules_missing", project, blockers: ["project rules missing"], hint: "Set auth_matrix in mem_project_rules_set before auth/login work." };
  const contract = parseMaybeJson(row.auth_matrix, {}) || {};
  const missing = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    missing.push("auth_matrix");
  } else {
    for (const field of AUTH_CONTRACT_REQUIRED_FIELDS) {
      const value = contract[field];
      if (value === undefined || value === null || value === "" || value === "unknown") missing.push(field);
    }
  }
  const canonicalProject = contract.canonical_project || project;
  const identityScope = contract.shared_identity_scope || null;
  const peers = [];
  const mismatches = [];
  const rows = tdb.prepare("SELECT project, auth_matrix FROM project_rules WHERE auth_matrix IS NOT NULL").all();
  for (const peerRow of rows) {
    const peer = parseMaybeJson(peerRow.auth_matrix, {}) || {};
    if (!peer || typeof peer !== "object" || Array.isArray(peer)) continue;
    const sameCanonical = (peer.canonical_project || peerRow.project) === canonicalProject;
    const sameScope = identityScope && peer.shared_identity_scope && peer.shared_identity_scope === identityScope;
    const linkedPortal = Array.isArray(contract.portals) && contract.portals.includes(peerRow.project);
    if (!(sameCanonical || sameScope || linkedPortal || peerRow.project === project)) continue;
    peers.push({
      project: peerRow.project,
      provider: peer.provider || null,
      canonical_login_url: peer.canonical_login_url || null,
      shared_identity_scope: peer.shared_identity_scope || null,
      session_cookie_scope: peer.session_cookie_scope || null,
      shared_accounts: peer.shared_accounts
    });
    if (peerRow.project === project) continue;
    for (const field of ["provider", "canonical_login_url", "shared_identity_scope", "session_cookie_scope", "shared_accounts"]) {
      const here = contract[field];
      const there = peer[field];
      if (here !== undefined && there !== undefined && here !== null && there !== null && JSON.stringify(here) !== JSON.stringify(there)) {
        mismatches.push({ peer_project: peerRow.project, field, expected: here, actual: there });
      }
    }
  }
  const blockers = [];
  if (contract.status === "unknown" || contract.status === "draft" || contract.status == null) blockers.push("auth contract status is not active");
  if (missing.length) blockers.push("auth contract missing required fields: " + missing.join(", "));
  if (mismatches.length) blockers.push("auth contract mismatch across linked portals: " + mismatches.map(m => `${m.peer_project}.${m.field}`).join(", "));
  return {
    ok: blockers.length === 0,
    status: blockers.length ? "block" : "ok",
    project,
    canonical_project: canonicalProject,
    contract,
    missing,
    mismatches,
    peers,
    blockers,
    hint: blockers.length ? "Do not change login/SSO until the canonical auth contract matches across linked portals." : "Canonical auth contract is consistent."
  };
}

function uiContractReport(tdb, project, ensureTables) {
  if (ensureTables) ensureTables(tdb);
  if (!project) return { error: "project required" };
  const row = tdb.prepare("SELECT project, canonical_nav, design_rules, updated_at, updated_by FROM project_rules WHERE project=?").get(project);
  if (!row) return { error: "project_rules_missing", project, blockers: ["project rules missing"], hint: "Set canonical_nav + design_rules before frontend/header/button work." };
  const design = parseMaybeJson(row.design_rules, {}) || {};
  const nav = parseMaybeJson(row.canonical_nav, null);
  const missing = [];
  if (!design || typeof design !== "object" || Array.isArray(design)) {
    missing.push("design_rules");
  } else {
    for (const field of UI_CONTRACT_REQUIRED_FIELDS) {
      const value = design[field];
      if (value === undefined || value === null || value === "" || value === "unknown") missing.push(field);
    }
  }
  const navItems = Array.isArray(nav) ? nav : [nav?.primary, nav?.items, nav?.menu, nav?.links].find(items => Array.isArray(items)) || [];
  if (navItems.length === 0) missing.push("canonical_nav");
  const family = design.shared_ui_family || null;
  const peers = [];
  const mismatches = [];
  const rows = tdb.prepare("SELECT project, design_rules, canonical_nav FROM project_rules WHERE design_rules IS NOT NULL").all();
  for (const peerRow of rows) {
    const peerDesign = parseMaybeJson(peerRow.design_rules, {}) || {};
    if (!peerDesign || typeof peerDesign !== "object" || Array.isArray(peerDesign)) continue;
    const sameFamily = family && peerDesign.shared_ui_family === family;
    const linkedPortal = Array.isArray(design.portals) && design.portals.includes(peerRow.project);
    if (!(sameFamily || linkedPortal || peerRow.project === project)) continue;
    peers.push({
      project: peerRow.project,
      canonical_header_project: peerDesign.canonical_header_project || null,
      canonical_button_project: peerDesign.canonical_button_project || null,
      canonical_brand_project: peerDesign.canonical_brand_project || null,
      canonical_font_source_project: peerDesign.canonical_font_source_project || null,
      canonical_font_display: peerDesign.canonical_font_display || null,
      canonical_font_body: peerDesign.canonical_font_body || null,
      canonical_logo_light_asset: peerDesign.canonical_logo_light_asset || null,
      canonical_logo_dark_asset: peerDesign.canonical_logo_dark_asset || null,
      canonical_logo_size_rule: peerDesign.canonical_logo_size_rule || null,
      canonical_button_size_rule: peerDesign.canonical_button_size_rule || null,
      light_mode_required: peerDesign.light_mode_required,
      dark_mode_required: peerDesign.dark_mode_required,
      shared_ui_family: peerDesign.shared_ui_family || null,
      no_local_ui_interpretation: peerDesign.no_local_ui_interpretation
    });
    if (peerRow.project === project) continue;
    for (const field of [
      "canonical_brand_project",
      "canonical_header_project",
      "canonical_button_project",
      "canonical_font_source_project",
      "canonical_font_display",
      "canonical_font_body",
      "canonical_logo_light_asset",
      "canonical_logo_dark_asset",
      "canonical_logo_size_rule",
      "canonical_button_size_rule",
      "light_mode_required",
      "dark_mode_required",
      "shared_ui_family",
      "no_local_ui_interpretation"
    ]) {
      const here = design[field];
      const there = peerDesign[field];
      if (here !== undefined && there !== undefined && here !== null && there !== null && JSON.stringify(here) !== JSON.stringify(there)) {
        mismatches.push({ peer_project: peerRow.project, field, expected: here, actual: there });
      }
    }
  }
  const blockers = [];
  if (design.status === "unknown" || design.status === "draft" || design.status == null) blockers.push("ui contract status is not active");
  if (missing.length) blockers.push("ui contract missing required fields: " + missing.join(", "));
  if (mismatches.length) blockers.push("ui contract mismatch across linked portals: " + mismatches.map(m => `${m.peer_project}.${m.field}`).join(", "));
  if (design.no_local_ui_interpretation !== true) blockers.push("ui contract must explicitly forbid local reinterpretation");
  return {
    ok: blockers.length === 0,
    status: blockers.length ? "block" : "ok",
    project,
    contract: design,
    nav_items_count: navItems.length,
    missing,
    mismatches,
    peers,
    blockers,
    hint: blockers.length ? "Do not change header/buttons/theme until the canonical UI contract matches blun.ai across linked portals." : "Canonical UI contract is consistent."
  };
}

// --- Reminder pure helpers ---

function normalizeReminderText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
}

function parseReminderTime(norm) {
  let m = norm.match(/\b(?:um\s*)?(\d{1,2})[:.](\d{2})\b/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute, explicit: true };
  }
  m = norm.match(/\bum\s+(\d{1,2})(?:\s*uhr)?(?:\s*(\d{1,2}))?\b/) || norm.match(/\b(\d{1,2})\s*uhr(?:\s*(\d{1,2}))?\b/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = m[2] != null ? parseInt(m[2], 10) : 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute, explicit: true };
  }
  return { hour: 9, minute: 0, explicit: false };
}

function applyReminderTime(date, time) {
  const d = new Date(date.getTime());
  d.setHours(time.hour, time.minute, 0, 0);
  return d;
}

function parseReminderDue(text, baseTime) {
  const raw = String(text || "");
  const norm = normalizeReminderText(raw);
  const base = baseTime ? new Date(baseTime) : new Date();
  const start = Number.isNaN(base.getTime()) ? new Date() : base;
  const time = parseReminderTime(norm);
  const finish = (date, dueText, precision) => ({
    due_at: applyReminderTime(date, time).toISOString(),
    due_text: dueText,
    due_precision: time.explicit ? "datetime" : precision,
    confidence: precision === "unknown" ? "low" : (precision === "week" ? "medium" : "high"),
  });
  let m = raw.match(/\b(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2})(?::(\d{2}))?)?\b/);
  if (m) {
    const d = new Date(m[1] + "T00:00:00");
    const t = m[2] ? { hour: parseInt(m[2], 10), minute: m[3] ? parseInt(m[3], 10) : 0, explicit: true } : time;
    return { due_at: applyReminderTime(d, t).toISOString(), due_text: m[0], due_precision: t.explicit ? "datetime" : "date", confidence: "high" };
  }
  m = norm.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/);
  if (m) {
    let year = m[3] ? parseInt(m[3], 10) : start.getFullYear();
    if (year < 100) year += 2000;
    let d = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    if (!m[3] && d.getTime() < start.getTime() - 86400000) d = new Date(year + 1, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    if (!Number.isNaN(d.getTime())) return finish(d, m[0], "date");
  }
  m = norm.match(/\bin\s+(\d+)\s*(minuten?|mins?|stunden?|hours?|tage?|days?|wochen?|weeks?)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const d = new Date(start.getTime());
    if (/min/.test(unit)) d.setMinutes(d.getMinutes() + n);
    else if (/stund|hour/.test(unit)) d.setHours(d.getHours() + n);
    else if (/tag|day/.test(unit)) d.setDate(d.getDate() + n);
    else d.setDate(d.getDate() + n * 7);
    return { due_at: d.toISOString(), due_text: m[0], due_precision: "relative", confidence: "high" };
  }
  if (/\bubermorgen\b/.test(norm)) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + 2);
    return finish(d, "ubermorgen", "day");
  }
  if (/\bmorgen\b/.test(norm)) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + 1);
    return finish(d, "morgen", "day");
  }
  if (/\bheute\b/.test(norm)) return finish(start, "heute", "day");
  const weekdays = [
    { day: 0, names: ["sonntag", "sunday"] },
    { day: 1, names: ["montag", "monday"] },
    { day: 2, names: ["dienstag", "tuesday"] },
    { day: 3, names: ["mittwoch", "wednesday"] },
    { day: 4, names: ["donnerstag", "thursday"] },
    { day: 5, names: ["freitag", "friday"] },
    { day: 6, names: ["samstag", "saturday"] },
  ];
  for (const w of weekdays) {
    const name = w.names.find((n) => new RegExp("\\b" + n + "\\b").test(norm));
    if (!name) continue;
    let delta = (w.day - start.getDay() + 7) % 7;
    if (delta === 0 || /\b(nachste|naechste|next)\b/.test(norm)) delta += 7;
    const d = new Date(start.getTime());
    d.setDate(d.getDate() + delta);
    return finish(d, name, /\bwoche|week\b/.test(norm) ? "week" : "day");
  }
  if (/\b(nachste|naechste|next)\s+woche\b/.test(norm)) {
    const d = new Date(start.getTime());
    let delta = (1 - start.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return finish(d, "nachste woche", "week");
  }
  return { due_at: null, due_text: null, due_precision: "unknown", confidence: "low" };
}

function reminderTitleFromText(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 180) : "Reminder";
}

function reminderRow(row) {
  if (!row) return null;
  return Object.assign({}, row, { meta: parseMetaJson(row.meta_json) });
}

// --- Readiness / flag helpers ---

function boolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function isoAgeDays(isoText) {
  const ms = Date.parse(String(isoText || ""));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function freshnessFromAgeDays(ageDays, warnDays, criticalDays) {
  if (ageDays == null) return "unknown";
  if (ageDays >= criticalDays) return "critical";
  if (ageDays >= warnDays) return "stale";
  return "fresh";
}

function capabilityMatrixForDepartments(departments) {
  const set = new Set((departments || []).map((name) => String(name || "").toLowerCase()));
  return {
    read: true,
    report: true,
    edit: set.size > 0,
    deploy: set.has("deploy-ops") || set.has("strategy-review"),
    billing: set.has("billing") || set.has("strategy-review"),
    auth: set.has("backend") || set.has("strategy-review"),
    production: set.has("deploy-ops") || set.has("strategy-review"),
  };
}

module.exports = {
  parseMaybeJson, deepMergePlain, uniqueIntegers,
  stripPrivate, parseAgentCsv, normalizeAgentName,
  jsonSafe, compactContent, parseMetaJson, isoOrNull, parseBriefTitle,
  // Brief contract
  TEAM_BRIEF_ALIASES, BRIEF_CONTRACT_VERSION, BRIEF_REQUIRED_HEADINGS,
  cleanScope, uniqueAgentNames, isTeamBriefTarget,
  hasCanonicalBriefShape, normalizeBriefMeta, normalizeBriefContent,
  // File / media
  baseName, extensionName, inferMediaKind, inferMediaType, uniqueStrings, compactTitleText, captureSourceLabel, formatCaptureDisplayTime, formatCaptureFileTime, slugFilePart, buildMediaTitle, buildCanonicalMediaFileName,
  // Readiness / flags
  boolFlag, isoAgeDays, freshnessFromAgeDays, capabilityMatrixForDepartments,
  // Contract validation
  AUTH_CONTRACT_REQUIRED_FIELDS, UI_CONTRACT_REQUIRED_FIELDS,
  authSensitiveTask, uiSensitiveTask,
  authContractReport, uiContractReport,
  // Reminder helpers
  normalizeReminderText, parseReminderTime, applyReminderTime,
  parseReminderDue, reminderTitleFromText, reminderRow,
};
