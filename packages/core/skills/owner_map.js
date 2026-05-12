#!/usr/bin/env node
"use strict";
/**
 * owner_map.js - cross-platform owner identity resolver.
 *
 * Maps platform-specific actor IDs (telegram chat id, slack user id, discord
 * user id, whatsapp number) to a single unified owner_id.
 *
 * Storage: simple JSON file at /root/mnemo/.owner_map.json.
 * Each entry: { owner_id, platform, external_id, display_name, added_at }
 *
 * Usage:
 *   node owner_map.js add --owner owner --platform telegram --id 123 --name "Owner"
 *   node owner_map.js add --owner owner --platform slack --id U0123ABCD
 *   node owner_map.js add --owner owner --platform discord --id 9876543210
 *   node owner_map.js lookup --platform telegram --id 123
 *   node owner_map.js list [--owner owner]
 *   node owner_map.js remove --platform slack --id U0123ABCD
 */

const fs = require("fs");

const FILE = process.env.MNEMO_OWNER_MAP || "/root/mnemo/.owner_map.json";

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (_) {
    return { entries: [] };
  }
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const action = process.argv[2];

if (action === "add") {
  const owner = arg("owner");
  const platform = arg("platform");
  const id = arg("id");
  const name = arg("name") || "";
  if (!owner || !platform || !id) {
    console.error("--owner --platform --id required");
    process.exit(2);
  }
  const state = load();
  const idx = state.entries.findIndex((entry) => entry.platform === platform && entry.external_id === String(id));
  if (idx >= 0) {
    state.entries[idx] = Object.assign({}, state.entries[idx], {
      owner_id: owner,
      display_name: name,
      updated_at: new Date().toISOString(),
    });
    console.log("updated", platform, id, "->", owner);
  } else {
    state.entries.push({
      owner_id: owner,
      platform,
      external_id: String(id),
      display_name: name,
      added_at: new Date().toISOString(),
    });
    console.log("added", platform, id, "->", owner);
  }
  save(state);
} else if (action === "lookup") {
  const platform = arg("platform");
  const id = arg("id");
  if (!platform || !id) {
    console.error("--platform --id required");
    process.exit(2);
  }
  const entry = load().entries.find((row) => row.platform === platform && row.external_id === String(id));
  if (!entry) {
    console.log(JSON.stringify({ found: false }));
    process.exit(1);
  }
  console.log(JSON.stringify({ found: true, owner_id: entry.owner_id, display_name: entry.display_name }, null, 2));
} else if (action === "list") {
  const owner = arg("owner");
  const items = load().entries.filter((entry) => !owner || entry.owner_id === owner);
  if (!items.length) {
    console.log("(none)");
  }
  for (const entry of items) {
    console.log(
      entry.owner_id.padEnd(12),
      "|",
      entry.platform.padEnd(10),
      "|",
      entry.external_id.padEnd(20),
      "|",
      entry.display_name || ""
    );
  }
} else if (action === "remove") {
  const platform = arg("platform");
  const id = arg("id");
  const state = load();
  const before = state.entries.length;
  state.entries = state.entries.filter((entry) => !(entry.platform === platform && entry.external_id === String(id)));
  save(state);
  console.log("removed", before - state.entries.length, "entry(s)");
} else {
  console.log(`usage:
  owner_map.js add --owner <id> --platform <name> --id <ext-id> [--name "<display>"]
  owner_map.js lookup --platform <name> --id <ext-id>
  owner_map.js list [--owner <id>]
  owner_map.js remove --platform <name> --id <ext-id>`);
}
