"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const http = require("http");
const { PassThrough } = require("stream");
const { attachStreamCapture } = require("./event_log");

const HUB = "http://127.0.0.1:7117";

function runBackfill(args) {
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
}

function postTool(name, payload) {
  const url = new URL(`/tool/${name}`, HUB);
  const body = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}");
          resolve(parsed.result || parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-capture-"));
  const exportRoot = path.join(tmpRoot, "ChatExport_1");
  const photoDir = path.join(exportRoot, "photos");
  fs.mkdirSync(photoDir, { recursive: true });
  const photoPath = path.join(photoDir, "photo_1.jpg");
  fs.writeFileSync(photoPath, "fake-image");
  const exportFile = path.join(exportRoot, "result.json");
  const chatId = -1 * (4307000 + Math.floor(Date.now() / 1000));
  const data = {
    id: chatId,
    name: "Burst Capture Test",
    type: "group",
    messages: [
      { id: 1, date: "2026-05-09T07:10:00", date_unixtime: "1778310600", from: "Owner", from_id: "user_owner_1", text: "burst-one" },
      { id: 2, date: "2026-05-09T07:10:00", date_unixtime: "1778310600", from: "Owner", from_id: "user_owner_1", text: "burst-two" },
      { id: 3, date: "2026-05-09T07:10:00", date_unixtime: "1778310600", from: "Owner", from_id: "user_owner_1", text: "burst-three" },
      { id: 4, date: "2026-05-09T07:10:00", date_unixtime: "1778310600", from: "Owner", from_id: "user_owner_1", text: "burst-four" },
      { id: 5, date: "2026-05-09T07:10:00", date_unixtime: "1778310600", from: "Owner", from_id: "user_owner_1", text: "burst-five" },
      { id: 6, date: "2026-05-09T07:10:01", date_unixtime: "1778310601", from: "Owner", from_id: "user_owner_1", text: "", photo: "photos/photo_1.jpg", photo_file_size: 9, width: 100, height: 50 },
    ],
  };
  fs.writeFileSync(exportFile, JSON.stringify(data, null, 2));

  const script = path.join(__dirname, "universal_backfill.js");
  const commonArgs = [script, "--source", "telegram", "--path", exportFile, "--commit", "--hub-url", HUB, "--batch-size", "10", "--owner-name", "Owner", "--owner-id", "user_owner_1"];

  const first = runBackfill(commonArgs);
  assert.equal(first.captured, 6, `expected 6 captured on first run, got ${first.captured}`);
  assert.equal(first.duplicate, 0, `expected 0 duplicates on first run, got ${first.duplicate}`);

  const second = runBackfill(commonArgs);
  assert.equal(second.captured, 0, `expected 0 captured on second run, got ${second.captured}`);
  assert.equal(second.duplicate, 6, `expected 6 duplicates on second run, got ${second.duplicate}`);

  const channel = `telegram:${data.id}`;
  const receipts = await postTool("mem_capture_recent", { source: "telegram", channel, limit: 20 });
  const matching = receipts.receipts.filter((row) => String(row.ref_id || "").startsWith(`tg:${data.id}:`));
  assert.equal(matching.length, 6, `expected 6 matching receipts, got ${matching.length}`);
  const messageReceipts = matching.filter((row) => String(row.ref_kind) === "telegram_message");
  assert.equal(new Set(messageReceipts.map((row) => row.occurred_at)).size, 5, "expected burst telegram messages to have unique millisecond occurred_at values");

  const attachment = matching.find((row) => String(row.ref_kind) === "telegram_attachment");
  assert(attachment, "expected one telegram_attachment receipt");

  assert(attachment.memory_id, "expected attachment receipt to reference a memory row");
  const memories = await postTool("mem_get", { ids: [attachment.memory_id] });
  assert(Array.isArray(memories) && memories.some((row) => String(row.text || "").includes("[telegram photo]")), "expected attachment memory row");
  assert(Array.isArray(memories) && memories.some((row) => String(row.text || "").includes("ocr_status:")), "expected attachment OCR status in memory row");

  const processSource = `process:test-universal-capture-${Date.now()}`;
  const pass = new PassThrough();
  attachStreamCapture(pass, processSource.replace(/^process:/, ""), { hubUrl: HUB });
  pass.write("stdout one\nstdout two\n");
  pass.end();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const processEvents = await postTool("mem_event_recent", { source: processSource, event_kind: "process_stdout", limit: 10 });
  assert(processEvents.count >= 2, `expected at least 2 process stdout events, got ${processEvents.count}`);

  console.log(JSON.stringify({
    ok: true,
    channel,
    first,
    second,
    receipts: matching.length,
    burst_unique_occurred_at: new Set(messageReceipts.map((row) => row.occurred_at)).size,
    process_stdout_events: processEvents.count,
    attachment_ref: attachment.ref_id,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
