#!/usr/bin/env node
"use strict";
/**
 * inspector_ui.js — live debug view for any agent's recent activity.
 *
 * Polls the Mnemo daemon every few seconds, renders a small dashboard:
 * recent memories grouped by tenant, by kind, by importance.
 *
 * Endpoints:
 *   GET /                  — HTML dashboard
 *   GET /api/feed          — JSON feed (tenant filter via ?tenant=, limit via ?limit=)
 *   GET /healthz           — liveness
 *
 * Default port 7119. Reads from MNEMO_URL.
 */

const http = require("http");

const PORT = parseInt(process.env.MNEMO_INSPECTOR_PORT || "7119", 10);
const MNEMO_URL = (process.env.MNEMO_URL || "http://127.0.0.1:7117").replace(/\/$/, "");
const REFRESH_MS = parseInt(process.env.MNEMO_INSPECTOR_REFRESH_MS || "4000", 10);

function fetchJson(u, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(u);
    const req = http.request({
      method: "GET", hostname: parsed.hostname, port: parsed.port || 80,
      path: parsed.pathname + parsed.search, headers: headers || {},
      timeout: 5000,
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d || "[]")); } catch (e) { resolve([]); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function renderDashboard() {
  const css = `
    * { box-sizing: border-box; }
    :root {
      color-scheme: dark;
      --page-bg: #0a0e1a;
      --panel-bg: rgba(255,255,255,.03);
      --panel-line: rgba(255,255,255,.06);
      --panel-line-soft: rgba(255,255,255,.04);
      --text-main: #cbd5e1;
      --text-soft: #94a3b8;
      --text-faint: #64748b;
      --brand-line: rgba(217,170,110,.12);
      --brand-accent: #d9aa6e;
      --brand-accent-soft: rgba(217,170,110,.16);
      --brand-bg: rgba(10,14,26,.86);
      --brand-card: rgba(255,255,255,.04);
      --brand-card-border: rgba(255,255,255,.08);
    }
    html, body { margin: 0; min-height: 100%; background: var(--page-bg); color: var(--text-main); }
    body {
      font: 13px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
      background:
        radial-gradient(1200px 520px at 10% -10%, rgba(43,108,255,.14), transparent 55%),
        radial-gradient(900px 420px at 100% 0%, rgba(217,170,110,.12), transparent 58%),
        linear-gradient(180deg, #0b1222 0%, #0a0e1a 58%, #090d18 100%);
    }
    a { color: inherit; text-decoration: none; }
    .page { min-height: 100vh; display: flex; flex-direction: column; }
    .shell { width: min(1240px, calc(100% - 32px)); margin: 0 auto; }
    .mnemo-header {
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(20px);
      background: var(--brand-bg);
      border-bottom: 1px solid var(--brand-line);
    }
    .mnemo-header-inner {
      display: flex;
      align-items: center;
      gap: 18px;
      min-height: 72px;
      padding: 16px 0;
      flex-wrap: wrap;
    }
    .mnemo-brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font: 600 14px/1.2 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      letter-spacing: .01em;
      color: #f8fafc;
    }
    .mnemo-brand-mark {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .mnemo-brand-copy {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .mnemo-brand-copy strong {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -.01em;
    }
    .mnemo-brand-copy span {
      color: var(--text-soft);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .12em;
    }
    .lc-nav-logo { height: 22px; width: auto; object-fit: contain; }
    .lc-nav-logo-light { display: none; }
    .lc-nav-logo-dark { display: inline-block; }
    .mnemo-nav {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-left: auto;
      font: 500 13px/1.2 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .mnemo-nav-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      padding: 0 14px;
      border-radius: 999px;
      color: var(--text-soft);
      border: 1px solid transparent;
      transition: border-color .18s ease, background .18s ease, color .18s ease, transform .18s ease;
    }
    .mnemo-nav-link:hover,
    .mnemo-nav-link:focus-visible {
      color: #fff;
      border-color: var(--brand-card-border);
      background: var(--brand-card);
      transform: translateY(-1px);
      outline: none;
    }
    .mnemo-nav-link.primary {
      color: #fff;
      border-color: rgba(43,108,255,.35);
      background: linear-gradient(135deg, rgba(43,108,255,.26), rgba(99,91,255,.22));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
    }
    .mnemo-main {
      flex: 1;
      padding: 28px 0 36px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr);
      gap: 18px;
      margin-bottom: 18px;
    }
    .hero-card,
    .rail-card,
    .workspace {
      background: var(--panel-bg);
      border: 1px solid var(--panel-line);
      border-radius: 18px;
      box-shadow: 0 12px 32px rgba(2,6,23,.24);
    }
    .hero-card {
      padding: 22px;
      position: relative;
      overflow: hidden;
    }
    .hero-card::after {
      content: "";
      position: absolute;
      inset: auto -10% -35% auto;
      width: 300px;
      height: 300px;
      background: radial-gradient(circle, rgba(43,108,255,.22) 0, rgba(43,108,255,0) 70%);
      pointer-events: none;
    }
    .hero-kicker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--brand-accent-soft);
      color: #f5d7af;
      background: rgba(217,170,110,.08);
      font: 700 10px/1.2 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    .hero-card h1 {
      margin: 16px 0 12px;
      color: #fff;
      font: 700 clamp(28px, 4vw, 42px)/1.03 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      letter-spacing: -.04em;
    }
    .hero-card p {
      max-width: 56ch;
      margin: 0;
      color: var(--text-soft);
      font: 500 15px/1.65 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .hero-meta {
      margin-top: 18px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .hero-meta span {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.06);
      color: var(--text-soft);
      font: 600 12px/1.2 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .rail-card {
      padding: 18px;
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .rail-card h2 {
      margin: 0;
      color: #fff;
      font: 700 18px/1.2 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      letter-spacing: -.02em;
    }
    .rail-card p {
      margin: 0;
      color: var(--text-soft);
      font: 500 13px/1.6 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .rail-list {
      display: grid;
      gap: 10px;
      margin: 2px 0 0;
      padding: 0;
      list-style: none;
    }
    .rail-list li {
      padding: 11px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.06);
      background: rgba(255,255,255,.03);
      color: var(--text-main);
      font: 500 12px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .rail-list strong {
      display: block;
      color: #fff;
      margin-bottom: 3px;
      font-size: 12px;
    }
    .workspace {
      padding: 18px;
    }
    h1 { color: #fff; font-weight: 600; margin: 0 0 6px; font-size: 18px; }
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 12px; flex-wrap: wrap; }
    .head .controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .pill { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.10); padding: 4px 10px; border-radius: 999px; font-size: 11px; }
    .pill.live { background: #16a34a; border-color: #16a34a; color: #fff; }
    select, input { background: #1e293b; border: 1px solid #334155; color: #cbd5e1; padding: 6px 10px; border-radius: 6px; font: inherit; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 200px 1fr; gap: 18px; }
    .side { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06); border-radius: 8px; padding: 12px; }
    .side h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin: 14px 0 6px; font-weight: 600; }
    .side h3:first-child { margin-top: 0; }
    .side .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
    .feed { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06); border-radius: 8px; padding: 0; max-height: 80vh; overflow-y: auto; }
    .item { padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,.04); }
    .item:last-child { border-bottom: 0; }
    .item .meta { display: flex; gap: 8px; font-size: 11px; color: #64748b; margin-bottom: 4px; flex-wrap: wrap; }
    .item .actor { color: #22d3ee; }
    .item .kind { background: rgba(99,91,255,.18); color: #a5b4fc; padding: 1px 6px; border-radius: 4px; }
    .item .imp { background: rgba(255,255,255,.06); padding: 1px 6px; border-radius: 4px; }
    .item .imp.high { background: rgba(245,158,11,.18); color: #fbbf24; }
    .item .imp.foundational { background: rgba(220,38,38,.20); color: #fca5a5; }
    .item .text { color: #cbd5e1; white-space: pre-wrap; word-wrap: break-word; max-height: 8em; overflow: hidden; }
    .item .text:hover { max-height: none; }
    .empty { padding: 60px; text-align: center; color: #475569; }
    .live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #22c55e; margin-right: 6px; animation: pulse 1.6s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .mnemo-footer {
      border-top: 1px solid var(--brand-line);
      background: rgba(6,10,20,.92);
      padding: 22px 0 28px;
    }
    .mnemo-footer-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) repeat(2, minmax(180px, .8fr));
      gap: 20px;
    }
    .mnemo-footer-brand {
      display: grid;
      gap: 10px;
    }
    .mnemo-footer-brand p,
    .mnemo-footer-col a,
    .mnemo-footer-bottom {
      font: 500 12px/1.65 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      color: var(--text-soft);
    }
    .mnemo-footer-col h3 {
      margin: 0 0 10px;
      color: #fff;
      font: 700 11px/1.2 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .mnemo-footer-links {
      display: grid;
      gap: 8px;
    }
    .mnemo-footer-col a:hover,
    .mnemo-footer-col a:focus-visible {
      color: #fff;
      outline: none;
    }
    .mnemo-footer-bottom {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid var(--panel-line-soft);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    @media (max-width: 960px) {
      .hero { grid-template-columns: 1fr; }
      .mnemo-header-inner { align-items: flex-start; }
      .mnemo-nav { width: 100%; margin-left: 0; }
      .mnemo-footer-grid { grid-template-columns: 1fr; }
      .mnemo-footer-bottom { flex-direction: column; }
    }
    @media (max-width: 720px) {
      .shell { width: min(100% - 20px, 1240px); }
      .mnemo-main { padding-top: 18px; }
      .hero-card,
      .rail-card,
      .workspace { padding: 16px; border-radius: 16px; }
      .mnemo-brand { width: 100%; }
      .mnemo-brand-copy strong { font-size: 14px; }
      .mnemo-nav { gap: 8px; }
      .mnemo-nav-link { flex: 1 1 calc(50% - 8px); justify-content: center; }
      .head { align-items: stretch; }
      .head .controls { width: 100%; }
      .head .controls > * { flex: 1 1 140px; }
      .grid { grid-template-columns: 1fr; }
      .feed { max-height: none; min-height: 420px; }
    }
  `;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLUN · Mnemo Inspector</title><style>${css}</style></head><body>
<div class="page">
<header class="mnemo-header">
  <div class="shell mnemo-header-inner">
    <a class="mnemo-brand" href="/mnemo/" aria-label="BLUN Mnemo Inspector">
      <span class="mnemo-brand-mark">
        <img class="lc-nav-logo lc-nav-logo-light" src="https://blun.ai/brand/blun-logo-light.png" alt="BLUN">
        <img class="lc-nav-logo lc-nav-logo-dark" src="https://blun.ai/brand/blun-logo-dark.png" alt="BLUN">
      </span>
      <span class="mnemo-brand-copy">
        <strong>Mnemo Inspector</strong>
        <span>BLUN internal memory operations</span>
      </span>
    </a>
    <nav class="mnemo-nav" aria-label="Mnemo product">
      <a class="mnemo-nav-link" href="/tree/">Agent Tree</a>
      <a class="mnemo-nav-link primary" href="/mnemo/">Inspector</a>
      <a class="mnemo-nav-link" href="/memory-tool">Memory Tool</a>
      <a class="mnemo-nav-link" href="/login">BLUN Login</a>
    </nav>
  </div>
</header>
<main class="mnemo-main">
<div class="shell">
<section class="hero" aria-label="Mnemo overview">
  <article class="hero-card">
    <span class="hero-kicker">Internal coordination surface</span>
    <h1>Inspect the live Mnemo stream without leaving the BLUN product shell.</h1>
    <p>Recent memories, agent activity, and tenant filters stay in one product-specific console so reviewer and operator work can happen on the same route the firm already uses.</p>
    <div class="hero-meta">
      <span>Live feed</span>
      <span>Shared BLUN identity</span>
      <span>Route-safe under <code>/mnemo/</code></span>
    </div>
  </article>
  <aside class="rail-card">
    <h2>Surface scope</h2>
    <p>This page is intentionally product-specific. It exposes Mnemo operations, not the public Listings navigation.</p>
    <ul class="rail-list">
      <li><strong>Inspector</strong>Stream recent memory items by tenant, kind, and importance.</li>
      <li><strong>Memory Tool</strong>Open the frontdoor route used by agents that speak filesystem-style memory.</li>
      <li><strong>Agent Tree</strong>Check live routing and delegation links across the active team.</li>
    </ul>
  </aside>
</section>
<section class="workspace" aria-label="Inspector workspace">
<div class="head">
  <h1><span class="live-dot"></span>Mnemo Inspector</h1>
  <div class="controls">
    <span class="pill live" id="connState">connecting…</span>
    <select id="tenant"><option value="">all tenants</option></select>
    <input id="search" placeholder="filter text…" />
    <select id="limit"><option>50</option><option>100</option><option>250</option></select>
  </div>
</div>
<div class="grid">
  <div class="side">
    <h3>By tenant</h3><div id="byTenant"></div>
    <h3>By kind</h3><div id="byKind"></div>
    <h3>By importance</h3><div id="byImp"></div>
  </div>
  <div class="feed" id="feed"><div class="empty">loading…</div></div>
</div>
</section>
</div>
</main>
<footer class="mnemo-footer">
  <div class="shell">
    <div class="mnemo-footer-grid">
      <div class="mnemo-footer-brand">
        <a class="mnemo-brand" href="/mnemo/" aria-label="BLUN Mnemo">
          <span class="mnemo-brand-mark">
            <img class="lc-nav-logo lc-nav-logo-light" src="https://blun.ai/brand/blun-logo-light.png" alt="BLUN">
            <img class="lc-nav-logo lc-nav-logo-dark" src="https://blun.ai/brand/blun-logo-dark.png" alt="BLUN">
          </span>
          <span class="mnemo-brand-copy">
            <strong>Mnemo Firm-OS</strong>
            <span>Internal memory and coordination layer</span>
          </span>
        </a>
        <p>Operational access only. Public routes must not expose private memory, but the shell still follows BLUN product chrome and legal wiring.</p>
      </div>
      <div class="mnemo-footer-col">
        <h3>Product</h3>
        <div class="mnemo-footer-links">
          <a href="/tree/">Agent Tree</a>
          <a href="/mnemo/">Inspector</a>
          <a href="/memory-tool">Memory Tool</a>
        </div>
      </div>
      <div class="mnemo-footer-col">
        <h3>Legal</h3>
        <div class="mnemo-footer-links">
          <a href="/en/impressum">Impressum</a>
          <a href="/en/datenschutz">Datenschutz</a>
          <a href="/en/agb">AGB</a>
        </div>
      </div>
    </div>
    <div class="mnemo-footer-bottom">
      <div>BLUN · Mnemo on listing.blun.ai</div>
      <div>Made for internal agent operations with shared BLUN identity.</div>
    </div>
  </div>
</footer>
</div>
<script>
const $ = (s) => document.querySelector(s);
const refresh = ${REFRESH_MS};
const feedUrl = new URL("api/feed", window.location.href);
async function tick() {
  try {
    const tenant = $('#tenant').value;
    const limit = $('#limit').value;
    feedUrl.search = '?limit=' + encodeURIComponent(limit) + (tenant ? '&tenant=' + encodeURIComponent(tenant) : '');
    const r = await fetch(feedUrl.toString(), { cache: 'no-store' });
    const data = await r.json();
    $('#connState').textContent = 'connected · ' + data.length;
    const search = $('#search').value.toLowerCase();
    const filtered = search ? data.filter(d => (d.text || d.preview || '').toLowerCase().includes(search)) : data;
    const byTenant = {}, byKind = {}, byImp = {};
    for (const d of data) {
      byTenant[d.tenant || '?'] = (byTenant[d.tenant || '?'] || 0) + 1;
      byKind[d.kind || '?'] = (byKind[d.kind || '?'] || 0) + 1;
      const imp = d.importance || 5;
      const lbl = imp >= 9 ? 'foundational (9-10)' : imp >= 7 ? 'high (7-8)' : 'normal (≤6)';
      byImp[lbl] = (byImp[lbl] || 0) + 1;
    }
    function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
    function sideRows(obj) { return Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<div class="row"><span>'+esc(k)+'</span><span>'+v+'</span></div>').join(''); }
    $('#byTenant').innerHTML = sideRows(byTenant);
    $('#byKind').innerHTML = sideRows(byKind);
    $('#byImp').innerHTML = sideRows(byImp);
    if (!Object.keys(byTenant).length) $('#tenant').innerHTML = '<option value="">all tenants</option>';
    else {
      const cur = $('#tenant').value;
      $('#tenant').innerHTML = '<option value="">all tenants</option>' + Object.keys(byTenant).map(t => '<option value="' + esc(t) + '"' + (t===cur?' selected':'') + '>' + esc(t) + '</option>').join('');
    }
    $('#feed').innerHTML = filtered.length ? filtered.map(d => {
      const text = (d.text || d.preview || '').slice(0, 1200);
      const imp = d.importance || 5;
      const impCls = imp >= 9 ? 'imp foundational' : imp >= 7 ? 'imp high' : 'imp';
      return '<div class="item"><div class="meta"><span class="kind">' + esc(d.kind || '?') + '</span><span class="actor">' + esc(d.actor || '?') + '</span><span>' + esc(d.tenant || '') + '</span><span>' + esc((d.occurred_at || '').slice(11, 19)) + '</span><span class="' + impCls + '">imp=' + imp + '</span></div><div class="text">' + esc(text) + '</div></div>';
    }).join('') : '<div class="empty">no entries match.</div>';
  } catch (e) {
    $('#connState').textContent = 'offline';
  }
}
tick();
setInterval(tick, refresh);
$('#search').addEventListener('input', tick);
$('#tenant').addEventListener('change', tick);
$('#limit').addEventListener('change', tick);
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  if (parsed.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, inspector: true, port: PORT }));
  }
  if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderDashboard());
  }
  if (parsed.pathname === "/api/feed") {
    const tenant = parsed.searchParams.get("tenant") || "";
    const limit = Math.min(500, parseInt(parsed.searchParams.get("limit") || "100", 10));
    const headers = tenant ? { "X-Tenant-Id": tenant } : {};
    try {
      // Use /recall with empty query as a "recent" proxy; if it returns nothing, try /health for sanity
      const q = parsed.searchParams.get("q") || "a";
      const data = await fetchJson(MNEMO_URL + "/recall?q=" + encodeURIComponent(q) + "&limit=" + limit, headers);
      const out = (Array.isArray(data) ? data : []).map(d => ({
        id: d.id, kind: d.kind, actor: d.actor, occurred_at: d.occurred_at,
        importance: d.importance, text: d.preview || d.text || "",
        tenant: tenant || "shared",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, () => console.log("[inspector] listening on", PORT, "→", MNEMO_URL, "refresh=" + REFRESH_MS + "ms"));

function shutdown(signal) {
  console.log(`[inspector] ${signal} received, closing server…`);
  server.close(() => {
    console.log("[inspector] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.error("[inspector] forced exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[inspector] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[inspector] uncaughtException:", err);
  shutdown("uncaughtException");
});
