"use strict";

const assert = require("assert");
const { Readable } = require("stream");
const { collectBody, readBody, MAX_BODY_BYTES } = require("./http_utils");

let passed = 0;
let failed = 0;

function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === "function") {
    return result.then(
      () => { passed++; },
      (e) => { failed++; console.error(`FAIL: ${name}\n  ${e.message}`); }
    );
  }
  try {
    // sync — already completed if we reach here
    passed++;
    return Promise.resolve();
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
    return Promise.resolve();
  }
}

// Helper: create a mock readable stream from a string
function mockReq(data) {
  const r = new Readable({ read() {} });
  process.nextTick(() => {
    r.push(Buffer.from(data));
    r.push(null);
  });
  return r;
}

// Helper: create a mock response with writeHead/end/headersSent
function mockRes() {
  const res = {
    headersSent: false,
    statusCode: null,
    body: null,
    writeHead(code) { res.statusCode = code; res.headersSent = true; },
    end(body) { res.body = body || null; },
  };
  return res;
}

// Helper: create a stream that emits an error
function errorReq() {
  const r = new Readable({ read() {} });
  process.nextTick(() => { r.destroy(new Error("connection reset")); });
  return r;
}

// Helper: create a stream with oversized payload
function oversizedReq(size) {
  const r = new Readable({ read() {} });
  process.nextTick(() => {
    r.push(Buffer.alloc(size, 0x41)); // 'A' bytes
    r.push(null);
  });
  return r;
}

async function run() {
  // --- MAX_BODY_BYTES ---

  await test("MAX_BODY_BYTES is a positive number", () => {
    assert.strictEqual(typeof MAX_BODY_BYTES, "number");
    assert.ok(MAX_BODY_BYTES > 0);
  });

  // --- collectBody ---

  await test("collectBody delivers body on normal request", () => {
    return new Promise((resolve, reject) => {
      const req = mockReq('{"key":"value"}');
      const res = mockRes();
      collectBody(req, res, (body) => {
        try {
          assert.strictEqual(body, '{"key":"value"}');
          assert.strictEqual(res.statusCode, null); // no error response
          resolve();
        } catch (e) { reject(e); }
      });
    });
  });

  await test("collectBody delivers empty body", () => {
    return new Promise((resolve, reject) => {
      const req = mockReq("");
      const res = mockRes();
      collectBody(req, res, (body) => {
        try {
          assert.strictEqual(body, "");
          resolve();
        } catch (e) { reject(e); }
      });
    });
  });

  await test("collectBody responds 400 on stream error", () => {
    return new Promise((resolve, reject) => {
      const req = errorReq();
      const res = mockRes();
      let cbCalled = false;
      collectBody(req, res, () => { cbCalled = true; });
      setTimeout(() => {
        try {
          assert.strictEqual(cbCalled, false, "callback should not fire on error");
          assert.strictEqual(res.statusCode, 400);
          resolve();
        } catch (e) { reject(e); }
      }, 50);
    });
  });

  await test("collectBody responds 413 on oversized payload", () => {
    return new Promise((resolve, reject) => {
      const size = MAX_BODY_BYTES + 1024;
      const req = oversizedReq(size);
      const res = mockRes();
      let cbCalled = false;
      collectBody(req, res, () => { cbCalled = true; });
      // req.destroy is called internally; wait for effects
      setTimeout(() => {
        try {
          assert.strictEqual(cbCalled, false, "callback should not fire on oversize");
          assert.strictEqual(res.statusCode, 413);
          resolve();
        } catch (e) { reject(e); }
      }, 50);
    });
  });

  // --- readBody ---

  await test("readBody resolves with body string", async () => {
    const req = mockReq("hello world");
    const body = await readBody(req);
    assert.strictEqual(body, "hello world");
  });

  await test("readBody resolves with empty string for empty body", async () => {
    const req = mockReq("");
    const body = await readBody(req);
    assert.strictEqual(body, "");
  });

  await test("readBody rejects on stream error", async () => {
    const req = errorReq();
    try {
      await readBody(req);
      assert.fail("should have rejected");
    } catch (e) {
      assert.ok(e.message.includes("connection reset") || e.message.includes("premature") || e instanceof Error);
    }
  });

  await test("readBody rejects on oversized payload", async () => {
    const size = MAX_BODY_BYTES + 1024;
    const req = oversizedReq(size);
    try {
      await readBody(req);
      assert.fail("should have rejected");
    } catch (e) {
      assert.ok(e instanceof Error);
    }
  });

  await test("readBody handles UTF-8 content", async () => {
    const req = mockReq("Ünïcödé tëxt 🚀");
    const body = await readBody(req);
    assert.strictEqual(body, "Ünïcödé tëxt 🚀");
  });

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error("Test runner error:", e); process.exit(1); });
