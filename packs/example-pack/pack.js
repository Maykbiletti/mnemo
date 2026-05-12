#!/usr/bin/env node
"use strict";
const path = require("path");
const Database = require("better-sqlite3");

const repoRoot = path.resolve(__dirname, "..", "..");
const dbPath = process.env.MNEMO_DB || path.join(repoRoot, "packages", "core", "mnemo.db");
const ownerName = process.env.MNEMO_OWNER_NAME || "owner";
const agentName = process.env.MNEMO_AGENT || process.env.MNEMO_DEFAULT_AGENT || "agent";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const value = db.prepare(`
  INSERT OR IGNORE INTO core_value (name, statement, scope, rationale)
  VALUES (?,?,?,?)
`);

value.run(
  "example_pack_installed",
  "This instance installed the public example pack. Replace it with a private pack for real preferences and project rules.",
  "all",
  "Public template pack."
);
value.run(
  "identity_reload_required",
  `${agentName} must reload ${ownerName}'s identity, preferences, open promises, and project rules before meaningful work.`,
  "all",
  "Keeps agent identity stable across sessions."
);
value.run(
  "token_efficient_memory",
  "Use compact search IDs and timelines before fetching full memory rows.",
  "all",
  "Keeps memory useful without wasting context."
);

db.close();
console.log(`Applied example pack to ${dbPath}`);
