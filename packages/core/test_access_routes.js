"use strict";

const assert = require("assert");
const Database = require("better-sqlite3");
const {
  ensureAccessRouteSchema,
  upsertAccessRoute,
  listAccessRoutes,
  resolveAccessRoute,
  preflightAccessRoute,
} = require("./access_routes");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function setupDb() {
  const db = new Database(":memory:");
  ensureAccessRouteSchema(db);
  return db;
}

test("jump routes block direct attempts and return canonical command", () => {
  const db = setupDb();
  const created = upsertAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    entrypoint: "176.internal",
    account_hint: "root",
    route_kind: "jump",
    direct_allowed: false,
    jump_host: "65.example.org",
    jump_user: "root",
    secret_ref: "ssh-key-prod",
    updated_by: "alfred",
  });
  assert.strictEqual(created.ok, true);

  const blocked = preflightAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    agent_name: "alfred",
    intended_command: "ssh root@176.internal",
  });

  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error, "direct_access_blocked_use_canonical_route");
  assert.strictEqual(blocked.must_use.canonical_command, "ssh -J root@65.example.org root@176.internal");
  assert.strictEqual(blocked.route.direct_allowed, false);
  assert.strictEqual(blocked.preflight_logged, true);
});

test("jump routes allow canonical jump attempts", () => {
  const db = setupDb();
  upsertAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    entrypoint: "176.internal",
    account_hint: "root",
    route_kind: "jump",
    direct_allowed: false,
    jump_host: "65.example.org",
    jump_user: "root",
    updated_by: "alfred",
  });

  const allowed = preflightAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    agent_name: "alfred",
    intended_command: "ssh -J root@65.example.org root@176.internal",
  });

  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.must_use.route_kind, "jump");
  assert.strictEqual(allowed.must_use.canonical_command, "ssh -J root@65.example.org root@176.internal");
});

test("allowed_agents blocks unauthorized agents", () => {
  const db = setupDb();
  upsertAccessRoute(db, {
    system_name: "billing-admin",
    access_kind: "dashboard",
    entrypoint: "https://billing.example.org",
    route_kind: "direct",
    allowed_agents: ["alfred"],
    updated_by: "alfred",
  });

  const blocked = resolveAccessRoute(db, {
    system_name: "billing-admin",
    access_kind: "dashboard",
    agent_name: "otto",
  });

  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error, "agent_not_allowed_for_access_route");
});

test("missing routes block instead of allowing improvisation", () => {
  const db = setupDb();
  const missing = resolveAccessRoute(db, {
    system_name: "unknown-server",
    access_kind: "ssh",
    agent_name: "dieter",
  });

  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, "access_route_missing");
  assert.ok(missing.next_step.includes("mem_access_upsert"));
});

test("listAccessRoutes returns route policy fields", () => {
  const db = setupDb();
  upsertAccessRoute(db, {
    system_name: "api",
    access_kind: "api",
    entrypoint: "https://api.example.org",
    route_kind: "direct",
    direct_allowed: true,
    updated_by: "alfred",
  });
  const listed = listAccessRoutes(db, { system_name: "api" });
  assert.strictEqual(listed.count, 1);
  assert.strictEqual(listed.access[0].route_kind, "direct");
  assert.strictEqual(listed.access[0].direct_allowed, true);
});

test("legacy updates do not erase stored jump policy", () => {
  const db = setupDb();
  upsertAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    entrypoint: "176.internal",
    account_hint: "root",
    route_kind: "jump",
    direct_allowed: false,
    jump_host: "65.example.org",
    jump_user: "root",
    updated_by: "alfred",
  });

  upsertAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    entrypoint: "176.internal",
    account_hint: "root",
    notes: "legacy note update",
    updated_by: "dieter",
  });

  const route = resolveAccessRoute(db, {
    system_name: "prod-176",
    access_kind: "ssh",
    agent_name: "dieter",
  });

  assert.strictEqual(route.ok, true);
  assert.strictEqual(route.route.route_kind, "jump");
  assert.strictEqual(route.route.direct_allowed, false);
  assert.strictEqual(route.route.jump_host, "65.example.org");
});

if (failed) {
  console.error(`access route tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`access route tests: ${passed} passed`);
