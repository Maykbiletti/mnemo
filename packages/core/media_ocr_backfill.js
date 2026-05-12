#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const repoDbPath = path.resolve(__dirname, "..", "..", "mnemo.db");
const DB_PATH = process.env.MNEMO_DB || (fs.existsSync(repoDbPath) ? repoDbPath : path.join(__dirname, "mnemo.db"));
const IMAGE_OCR_LANG = process.env.MNEMO_IMAGE_OCR_LANG || "eng+deu";

function parseArgs(argv) {
  const out = { commit: false, limit: 500, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--commit") out.commit = true;
    else if (a === "--dry-run") out.commit = false;
    else if (a === "--force") out.force = true;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10) || out.limit;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error("unknown arg: " + a);
  }
  return out;
}

function help() {
  return `
Usage:
  node media_ocr_backfill.js --dry-run --limit 50
  node media_ocr_backfill.js --commit --limit 500

Scans memory rows with meta_json.media_path, runs OCR when possible, and writes
ocr_status/ocr_text/visual_summary back into meta_json. Existing OCR is skipped
unless --force is provided.
`;
}

function commandAvailable(cmd) {
  try {
    return spawnSync("sh", ["-lc", "command -v " + String(cmd).replace(/[^a-zA-Z0-9._-]/g, "")], { encoding: "utf8", timeout: 3000 }).status === 0;
  } catch { return false; }
}

function runImageOcr(mediaPath) {
  if (!mediaPath || !fs.existsSync(mediaPath)) return { status: "no_media_path", text: "" };
  if (!/\.(png|jpe?g|webp|tiff?|bmp)$/i.test(mediaPath)) return { status: "not_image", text: "" };
  if (!commandAvailable("tesseract")) return { status: "tesseract_unavailable", text: "" };
  try {
    const out = spawnSync("tesseract", [mediaPath, "stdout", "-l", IMAGE_OCR_LANG], {
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(out.stdout || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (out.status === 0) return { status: text ? "ok" : "empty", text: text.slice(0, 6000) };
    return { status: "error", text: "", error: String(out.stderr || "").slice(0, 500) };
  } catch (error) {
    return { status: "error", text: "", error: String(error.message || error).slice(0, 500) };
  }
}

function tagsFor(text, meta) {
  const haystack = [text, meta.ocr_text, meta.file_name, meta.mime_type, meta.media_path].filter(Boolean).join(" ").toLowerCase();
  const tags = [];
  if (/screenshot|screen shot|bildschirm|capture|darkmode|mobile|header|footer|logo|menu|menü|impressum|checkout|login|error|bug|fehler|kaputt|404|500|overflow/.test(haystack)) tags.push("visual-evidence");
  if (/error|bug|fehler|kaputt|404|500|exception|broken|falsch|wrong/.test(haystack)) tags.push("issue-evidence");
  if (/header|menu|menü|footer|logo|darkmode|mobile|overflow|layout/.test(haystack)) tags.push("site-contract");
  return Array.from(new Set(tags));
}

function appendOcr(text, ocr) {
  let out = String(text || "");
  if (ocr.text && !out.includes(ocr.text.slice(0, Math.min(80, ocr.text.length)))) {
    out += (out ? "\n\n" : "") + "ocr: " + ocr.text;
  } else if (ocr.status && ocr.status !== "ok" && !/ocr_status:/i.test(out)) {
    out += (out ? "\n\n" : "") + "ocr_status: " + ocr.status;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(help().trim());
    return;
  }
  const db = new Database(DB_PATH);
  const rows = db.prepare(`
    SELECT id, text, meta_json
    FROM memory
    WHERE meta_json LIKE '%media_path%'
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(opts.limit);
  const update = db.prepare("UPDATE memory SET text=?, meta_json=? WHERE id=?");
  let seen = 0, updated = 0, skipped = 0, missing = 0;
  const samples = [];
  for (const row of rows) {
    seen += 1;
    let meta;
    try { meta = JSON.parse(row.meta_json || "{}"); } catch { skipped += 1; continue; }
    if (!meta.media_path) { missing += 1; continue; }
    if (meta.ocr_status && !opts.force) { skipped += 1; continue; }
    const ocr = runImageOcr(meta.media_path);
    meta.ocr_status = ocr.status;
    meta.ocr_text = ocr.text || null;
    meta.ocr_error = ocr.error || null;
    meta.visual_summary = meta.visual_summary || (ocr.text ? "OCR text captured from media attachment" : `Media attachment captured; OCR ${ocr.status}`);
    meta.evidence_tags = Array.from(new Set([].concat(meta.evidence_tags || [], tagsFor(row.text, meta))));
    const text = appendOcr(row.text, ocr);
    if (opts.commit) update.run(text, JSON.stringify(meta), row.id);
    updated += 1;
    if (samples.length < 5) samples.push({ id: row.id, media_path: meta.media_path, ocr_status: ocr.status, chars: ocr.text ? ocr.text.length : 0 });
  }
  console.log(JSON.stringify({ ok: true, mode: opts.commit ? "commit" : "dry-run", seen, updated, skipped, missing, samples }, null, 2));
}

main();
