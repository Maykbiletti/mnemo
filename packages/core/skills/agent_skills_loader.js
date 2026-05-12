#!/usr/bin/env node
"use strict";
/**
 * agent_skills_loader.js — read any folder of agentskills.io-compatible skills
 * and ingest them into Mnemo as kind="skill" memory entries with importance 8.
 *
 * Compatible with both the Mnemo native SKILL.md frontmatter and the
 * minimal agentskills.io spec (name + description required, body = instructions).
 *
 * Usage:
 *   node agent_skills_loader.js <path-to-skills-dir> [--tenant <name>] [--dry-run]
 *
 * Example:
 *   node agent_skills_loader.js ~/external-skills --tenant dieter
 *   node agent_skills_loader.js ./vendor/community-skills --dry-run
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

function parseArgs(argv) {
  const out = { dir: null, tenant: "shared", dryRun: false, mnemoUrl: process.env.MNEMO_URL || "http://127.0.0.1:7117" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") out.tenant = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--mnemo") out.mnemoUrl = argv[++i];
    else if (!out.dir && !a.startsWith("--")) out.dir = a;
  }
  return out;
}

function parseFrontmatter(text) {
  const meta = {};
  let body = text;
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
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    } else if (val === "true" || val === "false") {
      val = val === "true";
    } else if (/^[0-9]+$/.test(val)) {
      val = parseInt(val, 10);
    } else if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body };
}

function findSkillFiles(root) {
  const out = [];
  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && /^skill\.md$/i.test(ent.name)) out.push(full);
    }
  }
  walk(root, 0);
  return out;
}

function ingestToMnemo(mnemoUrl, tenant, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(mnemoUrl + "/ingest");
    const buf = Buffer.from(JSON.stringify(body));
    const req = http.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": buf.length,
        "X-Tenant-Id": tenant,
      },
    }, (res) => {
      let chunks = "";
      res.on("data", c => chunks += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(chunks)); } catch (_) { resolve({ ok: true }); }
        } else reject(new Error("HTTP " + res.statusCode + ": " + chunks.slice(0, 200)));
      });
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.dir) {
    console.error("usage: agent_skills_loader.js <path-to-skills-dir> [--tenant <name>] [--dry-run] [--mnemo <url>]");
    process.exit(2);
  }
  const root = path.resolve(args.dir);
  if (!fs.existsSync(root)) {
    console.error("not found:", root);
    process.exit(2);
  }

  const files = findSkillFiles(root);
  if (!files.length) {
    console.error("no SKILL.md files under", root);
    process.exit(1);
  }
  console.log("found", files.length, "SKILL.md file(s) under", root);

  let okCount = 0, failCount = 0, skipped = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || path.basename(path.dirname(file));
    const description = meta.description || "(no description)";
    if (!name) { skipped++; continue; }

    const skillFolder = path.dirname(file);
    const hasScripts = fs.existsSync(path.join(skillFolder, "scripts"));
    const hasReferences = fs.existsSync(path.join(skillFolder, "references"));
    const hasAssets = fs.existsSync(path.join(skillFolder, "assets"));
    const hasRunJs = fs.existsSync(path.join(skillFolder, "run.js"));

    const text_payload = "skill:" + name + "\n\n" + description + "\n\nINSTRUCTIONS:\n" + body.trim();
    const ingest = {
      kind: "skill",
      source: "agent_skills_loader",
      source_ref: file,
      occurred_at: new Date().toISOString(),
      actor: "system",
      topic: "skill-registry",
      importance: 8,
      text: text_payload,
      meta_json: JSON.stringify({
        skill_name: name,
        description,
        trigger_phrases: meta.trigger_phrases || meta.triggers || [],
        sandbox: meta.sandbox || "none",
        requires_confirmation: meta.requires_confirmation === true,
        sensitive_data: meta.sensitive_data || [],
        status: meta.status || "external",
        source_path: skillFolder,
        has_scripts: hasScripts,
        has_references: hasReferences,
        has_assets: hasAssets,
        has_run_js: hasRunJs,
        tenant: args.tenant,
      }),
    };

    if (args.dryRun) {
      console.log("[dry-run]", name, "→", description.slice(0, 80));
      okCount++;
      continue;
    }
    try {
      await ingestToMnemo(args.mnemoUrl, args.tenant, ingest);
      okCount++;
      console.log("ok:", name);
    } catch (e) {
      failCount++;
      console.error("fail:", name, "-", e.message);
    }
  }

  console.log("\nDONE  ok=" + okCount + "  fail=" + failCount + "  skipped=" + skipped + "  tenant=" + args.tenant + (args.dryRun ? "  (dry-run)" : ""));
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
