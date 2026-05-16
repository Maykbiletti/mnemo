"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const { spawn } = require("child_process");
const { mkdtempSync, readFileSync, rmSync } = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const tempDir = mkdtempSync(path.join(os.tmpdir(), "mnemo-mcp-runtime-token-"));
const dbPath = path.join(tempDir, "mnemo.db");
const setupDb = new Database(dbPath);
setupDb.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
setupDb.close();
const child = spawn(process.execPath, ["mcp.js"], {
  cwd: __dirname,
  env: Object.assign({}, process.env, {
    MNEMO_DB: dbPath,
    MNEMO_HUB_URL: "",
    MNEMO_HUB_PRIMARY: "0",
    MNEMO_DEFAULT_AGENT: "alfred",
    MNEMO_AGENT: "alfred",
  }),
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stderr = "";
const pending = new Map();
const rl = readline.createInterface({ input: child.stdout });

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) {
    return;
  }
  pending.delete(message.id);
  if (message.error) {
    waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
  } else {
    waiter.resolve(message.result);
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.on("exit", (code, signal) => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`mcp exited code=${code} signal=${signal} stderr=${stderr.slice(-1000)}`));
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (!pending.has(id)) {
        return;
      }
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-1000)}`));
    }, 10000).unref();
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return promise;
}

function stopChild() {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.stdin.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
  });
}

function cleanupTemp() {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function callTool(name, args) {
  const result = await request("tools/call", { name, arguments: args || {} });
  const text = result && result.content && result.content[0] && result.content[0].text;
  assert(text, `tool ${name} returned no text content`);
  return JSON.parse(text);
}

async function main() {
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mnemo-test", version: "0" } });

  const departments = await callTool("mem_department_seed_defaults", {
    agent_map: { backend: "alfred", review: "alfred" },
    updated_by: "alfred",
  });
  assert.strictEqual(departments.ok, true);

  const pass = await callTool("mem_agent_pass_set", {
    agent_name: "alfred",
    department_name: "engineering",
    lane: "engineering",
    allowed_projects: ["mnemo"],
    live_write: true,
    can_deploy: false,
    can_touch_auth: false,
    can_touch_billing: false,
    can_manage_production: false,
    updated_by: "alfred",
  });
  assert.strictEqual(pass.ok, true);

  const workOrder = await callTool("mem_work_order_create", {
    project: "mnemo",
    title: "MCP runtime token pass-through smoke",
    objective: "Allow one scoped runtime code edit through mem_runtime_tool_receipt_start.",
    department_name: "engineering",
    assigned_agent: "alfred",
    owner_agent: "alfred",
    risk_class: "normal",
    action_type: "code_edit",
    files: ["packages/core/*"],
    allowed_tools: ["apply_patch"],
    required_evidence: ["mcp runtime token smoke"],
    ttl_minutes: 30,
    created_by: "alfred",
  });
  assert.strictEqual(workOrder.ok, true);
  assert(workOrder.token && workOrder.token.token_id);

  const receipt = await callTool("mem_runtime_tool_receipt_start", {
    runtime_name: "codexlink",
    agent_name: "alfred",
    project: "mnemo",
    task: "Runtime receipt smoke",
    tool_name: "apply_patch",
    files: ["packages/core/mcp.js"],
    work_order_id: workOrder.work_order.id,
    token_id: workOrder.token.token_id,
    require_project_rules: false,
  });

  assert.strictEqual(receipt.ok, true);
  assert.strictEqual(receipt.allowed, true, JSON.stringify(receipt.blockers || []));
  assert.strictEqual(receipt.status, "started");
  assert.strictEqual(receipt.preflight_status, "ok");
  assert(receipt.preflight_action_id, "preflight action id should be recorded");

  const rows = await callTool("mem_runtime_tool_receipt_list", {
    runtime_name: "codexlink",
    limit: 5,
  });
  assert.strictEqual(rows.count, 1);
  assert.strictEqual(rows.receipts[0].allowed, true);
  assert.strictEqual(rows.receipts[0].preflight.status, "ok");
  const capabilityCheck = (rows.receipts[0].preflight.checks || []).find((check) => check.name === "capability_token");
  assert(capabilityCheck, "preflight should include capability_token check");
  assert.strictEqual(capabilityCheck.result, "ok");
  assert.strictEqual(capabilityCheck.token_id, workOrder.token.token_id);
  assert.strictEqual(Number(capabilityCheck.work_order_id), Number(workOrder.work_order.id));
}

main()
  .then(async () => {
    await stopChild();
    cleanupTemp();
    console.log("test_mcp_runtime_receipt_token ok");
  })
  .catch(async (error) => {
    await stopChild();
    cleanupTemp();
    console.error(error && error.stack || error);
    process.exit(1);
  });
