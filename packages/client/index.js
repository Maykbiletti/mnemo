"use strict";
/**
 * @mnemo/client — minimal Node client for Mnemo.
 *
 * Drop into any service. Lazy: zero deps, native fetch (Node 18+).
 *
 * Usage:
 *   const { MnemoClient } = require("@mnemo/client");
 *   const m = new MnemoClient({ url: "http://127.0.0.1:7117", tenant: "tenant-42" });
 *
 *   // log an event
 *   await m.ingest({
 *     kind: "message",
 *     source: "blun-chat",
 *     actor: "user-123",
 *     text: "hey, can you remember I prefer SI units",
 *     importance: 7
 *   });
 *
 *   // recall related context before LLM call
 *   const ctx = await m.recall({ query: "user preferences for units", limit: 5 });
 *
 *   // surface open commitments at the start of any conversation
 *   const due = await m.commitmentDue({ horizon_hours: 24 });
 */

class MnemoClient {
  constructor(opts = {}) {
    this.url = (opts.url || process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
    this.tenant = opts.tenant || null;
    this.token = opts.token || null;
    this.timeout = opts.timeoutMs || 5000;
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.tenant) h["X-Tenant-Id"] = this.tenant;
    if (this.token) h["Authorization"] = "Bearer " + this.token;
    return h;
  }

  async _post(path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const r = await fetch(this.url + path, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`mnemo ${path} ${r.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally { clearTimeout(t); }
  }

  async _get(path, params) {
    const url = new URL(this.url + path);
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const r = await fetch(url, { headers: this._headers(), signal: ctrl.signal });
      const text = await r.text();
      if (!r.ok) throw new Error(`mnemo ${path} ${r.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally { clearTimeout(t); }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Log a memory event. Returns { accepted, inserted, results }. */
  ingest(event) {
    return this._post("/ingest", event);
  }

  /** Recall — keyword + optional semantic. Returns array of { id, kind, actor, occurred_at, preview }. */
  recall({ query, limit = 10 } = {}) {
    return this._get("/recall", { q: query, limit });
  }

  /** Get health of the underlying daemon (writers + counts). */
  health() {
    return this._get("/health");
  }

  /** Tenant-aware fetch wrapper for any future endpoint. */
  raw({ method = "GET", path, body }) {
    if (method === "POST") return this._post(path, body);
    return this._get(path);
  }
}

module.exports = { MnemoClient };
