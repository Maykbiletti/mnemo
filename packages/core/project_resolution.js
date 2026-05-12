"use strict";

const fs = require("fs");
const path = require("path");

function normalizeProjectKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s/_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addAlias(map, from, to) {
  const key = normalizeProjectKey(from);
  const target = String(to || "").trim();
  if (key && target && !map.has(key)) map.set(key, target);
}

function addAliases(map, raw) {
  const text = String(raw || "").trim();
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [from, to] of Object.entries(parsed)) addAlias(map, from, to);
      return;
    }
  } catch {}
  for (const part of text.split(/[;\n,]/)) {
    const idx = part.indexOf("=");
    if (idx > 0) addAlias(map, part.slice(0, idx), part.slice(idx + 1));
  }
}

function loadAliasMap() {
  const map = new Map();
  addAliases(map, process.env.MNEMO_PROJECT_ALIASES || "");
  const file = String(process.env.MNEMO_PROJECT_ALIASES_FILE || "").trim();
  if (file && fs.existsSync(file)) {
    try { addAliases(map, fs.readFileSync(file, "utf8")); } catch {}
  }
  return map;
}

function repoBasename(repo) {
  const value = String(repo || "").trim();
  if (!value) return "";
  try {
    return path.basename(value.replace(/[\\/]+$/, ""));
  } catch {
    return "";
  }
}

function urlBasenames(urlValue) {
  const text = String(urlValue || "").trim();
  if (!text) return [];
  try {
    const url = new URL(text);
    return url.pathname.split("/").map((part) => part.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function projectNameRows(db) {
  const rows = new Map();
  const add = (name, meta) => {
    const key = String(name || "").trim();
    if (!key) return;
    if (!rows.has(key)) rows.set(key, { name: key, repo: "", live_url: "", domain: "" });
    Object.assign(rows.get(key), meta || {});
  };
  try {
    for (const row of db.prepare("SELECT name, repo, live_url, domain FROM project_registry").all()) add(row.name, row);
  } catch {}
  try {
    for (const row of db.prepare("SELECT project FROM project_rules").all()) add(row.project, {});
  } catch {}
  try {
    for (const row of db.prepare("SELECT project FROM site_contract").all()) add(row.project, {});
  } catch {}
  return Array.from(rows.values());
}

function aliasKeysForRow(row) {
  const keys = new Set();
  if (!row) return keys;
  const add = (value) => {
    const key = normalizeProjectKey(value);
    if (key) keys.add(key);
  };
  add(row.name);
  add(repoBasename(row.repo));
  for (const segment of urlBasenames(row.live_url)) add(segment);
  add(row.domain);
  return keys;
}

function resolveProjectName(db, input) {
  const raw = String(input || "").trim();
  if (!raw) return { input: raw, project: raw, resolved: false, matched_by: null };
  const aliasKey = normalizeProjectKey(raw);
  const aliases = loadAliasMap();
  const aliasTarget = aliases.get(aliasKey);
  if (aliasTarget) return { input: raw, project: aliasTarget, resolved: aliasTarget !== raw, matched_by: "env_alias" };

  const rows = projectNameRows(db);
  const exact = rows.find((row) => normalizeProjectKey(row.name) === aliasKey);
  if (exact) return { input: raw, project: exact.name, resolved: exact.name !== raw, matched_by: "exact_name" };

  let aliasMatch = null;
  for (const row of rows) {
    if (aliasKeysForRow(row).has(aliasKey)) {
      if (aliasMatch && aliasMatch !== row.name) {
        aliasMatch = null;
        break;
      }
      aliasMatch = row.name;
    }
  }
  if (aliasMatch) return { input: raw, project: aliasMatch, resolved: aliasMatch !== raw, matched_by: "derived_alias" };

  const prefixMatches = rows
    .map((row) => ({ row, key: normalizeProjectKey(row.name) }))
    .filter(({ key }) => key && (key.startsWith(aliasKey + " ") || key === aliasKey));
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0].row.name;
    return { input: raw, project: match, resolved: match !== raw, matched_by: "name_prefix" };
  }

  return { input: raw, project: raw, resolved: false, matched_by: null };
}

function projectNameVariants(db, input) {
  const resolved = resolveProjectName(db, input);
  const rows = projectNameRows(db);
  const row = rows.find((item) => item.name === resolved.project) || null;
  const variants = new Set();
  if (String(input || "").trim()) variants.add(String(input).trim());
  if (resolved.project) variants.add(resolved.project);
  if (row) {
    variants.add(row.name);
    const repoName = repoBasename(row.repo);
    if (repoName) variants.add(repoName);
    for (const segment of urlBasenames(row.live_url)) variants.add(segment);
  }
  return Array.from(variants).filter(Boolean);
}

function selectProjectRegistry(db, project) {
  const resolved = resolveProjectName(db, project);
  let row = null;
  try {
    row = db.prepare("SELECT * FROM project_registry WHERE lower(name)=lower(?) LIMIT 1").get(resolved.project) || null;
  } catch {}
  return { row, resolved };
}

function selectProjectRules(db, project) {
  const resolved = resolveProjectName(db, project);
  let row = null;
  try {
    row = db.prepare("SELECT * FROM project_rules WHERE lower(project)=lower(?) LIMIT 1").get(resolved.project) || null;
  } catch {}
  return { row, resolved };
}

function selectSiteContract(db, project) {
  const resolved = resolveProjectName(db, project);
  let row = null;
  try {
    row = db.prepare("SELECT * FROM site_contract WHERE lower(project)=lower(?) LIMIT 1").get(resolved.project) || null;
  } catch {}
  return { row, resolved };
}

module.exports = {
  normalizeProjectKey,
  projectNameVariants,
  resolveProjectName,
  selectProjectRegistry,
  selectProjectRules,
  selectSiteContract,
};
