#!/usr/bin/env node
"use strict";
/**
 * soul_loader.js - read a SOUL.md from disk and seed it as foundational
 * identity entries (importance 10) into a Mnemo tenant.
 *
 * SOUL.md format (suggested):
 *
 *   # Voice
 *   Direct, terse language with the owner. English for investors. No emojis.
 *
 *   # Pace
 *   Ship-without-ask default. 1 self-initiated feature/day minimum.
 *
 *   # Refusals
 *   Never bypass --no-verify hooks. Never delete uncommitted work.
 *
 *   # Tone signals
 *   - "K" / "Ok" / "Ja" -> final, do not ask back
 *   - "Geil" -> strong approval, log + continue
 *   - "Boah ey" -> frustration, slow down + clarify
 *
 * Usage:
 *   node soul_loader.js <path-to-SOUL.md> [--tenant owner]
 */

const fs = require("fs");
const http = require("http");
const path = require("path");

const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function ingest(tenant, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(MNEMO_URL + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": buf.length,
          "X-Tenant-Id": tenant,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => (res.statusCode < 300 ? resolve(JSON.parse(data || "{}")) : reject(new Error(data))));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function parseSections(md) {
  const out = [];
  const lines = md.split(/\n/);
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^#+\s+(.+)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { heading: m[1].trim(), body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) out.push(cur);
  return out
    .map((section) => Object.assign(section, { body: section.body.trim() }))
    .filter((section) => section.body);
}

async function main() {
  const file = path.resolve(process.argv[2] || "");
  const tenant = arg("tenant", "shared");
  if (!file || !fs.existsSync(file)) {
    console.error("usage: soul_loader.js <SOUL.md> [--tenant <name>]");
    process.exit(2);
  }
  const md = fs.readFileSync(file, "utf8");
  const sections = parseSections(md);
  if (!sections.length) {
    console.error("no sections found in", file);
    process.exit(2);
  }

  await ingest(tenant, {
    kind: "identity_soul",
    source: "soul_loader",
    source_ref: file,
    occurred_at: new Date().toISOString(),
    actor: "system",
    topic: "identity",
    importance: 10,
    text: "SOUL.md (full):\n\n" + md.trim(),
    meta_json: JSON.stringify({ sections: sections.map((section) => section.heading), file }),
  });

  for (const section of sections) {
    await ingest(tenant, {
      kind: "identity_soul_section",
      source: "soul_loader",
      source_ref: file + "#" + section.heading,
      occurred_at: new Date().toISOString(),
      actor: "system",
      topic: "identity:" + section.heading.toLowerCase(),
      importance: 9,
      text: "SOUL section [" + section.heading + "]\n\n" + section.body,
    });
  }

  console.log("seeded SOUL.md into tenant=" + tenant + " (1 full + " + sections.length + " sections)");
}

main().catch((error) => {
  console.error("fatal:", error.message);
  process.exit(1);
});
