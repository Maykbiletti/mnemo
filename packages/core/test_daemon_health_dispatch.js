"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemo-daemon-health-"));
const dbPath = path.join(tempDir, "mnemo.db");
const port = 18117 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["daemon.js"], {
  cwd: __dirname,
  env: Object.assign({}, process.env, {
    MNEMO_DB: dbPath,
    MNEMO_HTTP_PORT: String(port),
    MNEMO_HTTP_HOST: "127.0.0.1",
    MNEMO_TELEGRAM_POLL_ENABLED: "0",
    MNEMO_HUB_URL: "",
    MNEMO_DEFAULT_AGENT: "alfred-test",
  }),
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function stop() {
  if (child.exitCode === null) {
    try { child.kill("SIGTERM"); } catch {}
    await wait(250);
    try { child.kill("SIGKILL"); } catch {}
  }
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main() {
  let health = null;
  for (let i = 0; i < 30; i++) {
    try {
      health = await fetchJson(`http://127.0.0.1:${port}/health`);
      if (health.status === 200) break;
    } catch {}
    await wait(200);
  }
  assert(health && health.status === 200, `daemon did not start stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);

  const memHealth = await fetchJson(`http://127.0.0.1:${port}/tool/mem_health`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.strictEqual(memHealth.status, 200);
  assert(memHealth.body && memHealth.body.result, "mem_health result missing");
  assert(Array.isArray(memHealth.body.result.writers), "mem_health should return writers array");
  const journalWriter = memHealth.body.result.writers.find((row) => row.writer === "event_journal");
  assert(journalWriter, "mem_health should include event_journal writer");
  assert.strictEqual(journalWriter.status, "alive");
  assert.strictEqual(journalWriter.healthy, true);

  const watchdog = await fetchJson(`http://127.0.0.1:${port}/tool/mem_watchdog_list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.strictEqual(watchdog.status, 200);
  assert(watchdog.body.result.count >= 1, "default watchdog should be seeded");
}

main()
  .then(async () => {
    await stop();
    console.log("test_daemon_health_dispatch ok");
  })
  .catch(async (error) => {
    await stop();
    console.error(error && error.stack || error);
    process.exit(1);
  });
