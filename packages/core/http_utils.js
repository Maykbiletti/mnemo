/**
 * Shared HTTP helpers for Mnemo entry points.
 *
 * Usage:
 *   const { collectBody, readBody } = require("./http_utils");
 */

const MAX_BODY_BYTES = parseInt(process.env.MNEMO_MAX_BODY_BYTES || String(10 * 1024 * 1024), 10); // 10 MB default

/**
 * Callback-style body collector with size guard.
 * Auto-replies 400 on stream error, 413 on oversize. Calls cb(body) on success.
 */
function collectBody(req, res, cb) {
  let body = "";
  let aborted = false;
  req.on("error", () => { aborted = true; if (!res.headersSent) { res.writeHead(400); res.end(); } });
  req.on("data", c => { if (aborted) return; body += c; if (Buffer.byteLength(body) > MAX_BODY_BYTES) { aborted = true; req.destroy(); if (!res.headersSent) { res.writeHead(413); res.end("payload too large"); } } });
  req.on("end", () => { if (!aborted) cb(body); });
}

/**
 * Promise-style body reader with size guard.
 * Rejects with Error("payload too large") on oversize.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    req.on("data", c => { bytes += c.length; if (bytes > MAX_BODY_BYTES) { req.destroy(new Error("payload too large")); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

module.exports = { collectBody, readBody, MAX_BODY_BYTES };
