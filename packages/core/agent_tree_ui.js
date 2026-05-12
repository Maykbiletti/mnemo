#!/usr/bin/env node
"use strict";
const http = require("http");
const Database = require("better-sqlite3");
const PORT = 7125;
const DB_PATH = "/root/mnemo/mnemo.db";

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma("journal_mode = WAL");

function callMnemoTool(tool, args) {
  return new Promise(resolve => {
    const body = Buffer.from(JSON.stringify(args || {}));
    const req = http.request({
      method: "POST", hostname: "127.0.0.1", port: 7117,
      path: "/tool/" + tool,
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(body); req.end();
  });
}

const PERSONAS = {
  mayk:           { role:"Founder",   tier:0, color:"#f5b942", short:"MK", label:"Mayk", img:"https://autoflasher.de/wp-content/uploads/2025/02/photo-team-member1-mayk.jpg" },
  florin:         { role:"CEO",       tier:1, color:"#fbbf24", short:"FL", label:"Florin", parent:"mayk", human:true, img:"https://autoflasher.de/wp-content/uploads/2025/02/photo-team-member2.jpg" },
  dieter:         { role:"CTO",       tier:2, color:"#22d3ee", short:"DT", label:"Dieter", parent:"florin", img:"https://api.dicebear.com/9.x/avataaars/svg?seed=DieterCTO&topType=ShortHairShortFlat&facialHairType=BeardLight&clothingColor=22d3ee&backgroundColor=22d3ee&hairColor=2c1810" },
  fredrik:        { role:"Strategy & Network", tier:1, color:"#fbbf24", short:"FM", label:"Fredrik Moeller", parent:"mayk", human:true, img:"https://api.dicebear.com/9.x/personas/svg?seed=FredrikMoeller&backgroundColor=fbbf24" },
  richard:        { role:"Relationships", tier:2, color:"#fbbf24", short:"RI", label:"Richard", parent:"florin", human:true, img:"https://api.dicebear.com/9.x/personas/svg?seed=Richard&backgroundColor=fbbf24" },
  dominik:        { role:"Developer", tier:2, color:"#fbbf24", short:"DO", label:"Dominik", parent:"florin", human:true, img:"https://autoflasher.de/wp-content/uploads/2025/02/photo-team-member3.jpg" },
  markus:         { role:"Support",   tier:2, color:"#fbbf24", short:"MA", label:"Markus", parent:"florin", human:true, img:"https://autoflasher.de/wp-content/uploads/elementor/thumbs/Markus-neu-scaled-1-rdhrzu58j9owmyibqfflbum0xqfkt66s2df1eqk2g2.jpg" },
  angel:          { role:"Designer",  tier:3, color:"#a78bfa", short:"AN", label:"Angel", parent:"dieter", img:"https://api.dicebear.com/9.x/personas/svg?seed=Angel&backgroundColor=a78bfa" },
  otto:           { role:"Backend",   tier:3, color:"#34d399", short:"OT", label:"Otto", parent:"dieter" },
  frida:          { role:"Frontend",  tier:3, color:"#f472b6", short:"FR", label:"Frida", parent:"dieter" },
  "send-content": { role:"Copywriter",tier:4, color:"#fbbf24", short:"PU", label:"Pulse", parent:"dieter", img:"https://api.dicebear.com/9.x/personas/svg?seed=Pulse&backgroundColor=fbbf24" },
  "send-deliver": { role:"Delivery",  tier:4, color:"#fb7185", short:"BO", label:"Boris", parent:"dieter", img:"https://api.dicebear.com/9.x/personas/svg?seed=Boris&backgroundColor=fb7185" },
  "send-analytics":{role:"Analytics", tier:4, color:"#60a5fa", short:"TA", label:"Tally", parent:"dieter", img:"https://api.dicebear.com/9.x/personas/svg?seed=Tally&backgroundColor=60a5fa" },
  "send-import":  { role:"Importer",  tier:4, color:"#4ade80", short:"IN", label:"Inga",  parent:"dieter", img:"https://api.dicebear.com/9.x/personas/svg?seed=Inga&backgroundColor=4ade80" },
  ida:            { role:"Data",      tier:4, color:"#a78bfa", short:"ID", label:"Ida",   parent:"angel", img:"https://api.dicebear.com/9.x/personas/svg?seed=IdaAngel&backgroundColor=a78bfa" },
  nora:           { role:"Admin-UI",  tier:4, color:"#a78bfa", short:"NO", label:"Nora",  parent:"angel", img:"https://api.dicebear.com/9.x/personas/svg?seed=Nora&backgroundColor=a78bfa" },
  mio:            { role:"Brand",     tier:4, color:"#a78bfa", short:"MI", label:"Mio",   parent:"angel", img:"https://api.dicebear.com/9.x/personas/svg?seed=Mio&backgroundColor=a78bfa" },
  lyra:           { role:"Landing",   tier:4, color:"#a78bfa", short:"LY", label:"Lyra",  parent:"angel", img:"https://api.dicebear.com/9.x/personas/svg?seed=Lyra&backgroundColor=a78bfa" },
  vera:           { role:"Legal",     tier:4, color:"#a78bfa", short:"VE", label:"Vera",  parent:"angel", img:"https://api.dicebear.com/9.x/personas/svg?seed=Vera&backgroundColor=a78bfa" },
};

function persona(id) {
  const k = id.toLowerCase();
  if (PERSONAS[k]) return PERSONAS[k];
  return { role: "Worker", tier: 3, color: "#94a3b8", short: id.slice(0,2).toUpperCase(), label: id };
}

function cleanLabel(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*/g, "").trim();
}

async function buildGraph() {
  const list = await callMnemoTool("mem_connect_list", {});
  const agents = (list && list.result && list.result.agents) || [];
  const briefs = db.prepare(
    "SELECT source_agent, agent_name, COUNT(*) as cnt, MAX(created_at) as last_at " +
    "FROM agent_brief WHERE source_agent IS NOT NULL AND agent_name IS NOT NULL " +
    "GROUP BY LOWER(source_agent), LOWER(agent_name)"
  ).all();

  const byId = new Map();
  byId.set("mayk", { id:"mayk", ...persona("mayk"), status:"human", host:"owner", skills:["vision","direction"], last_seen:null });
  for (const id of ["fredrik","florin","markus","dominik","richard"]) {
    const p = persona(id);
    byId.set(id, { id, label:p.label, role:p.role, color:p.color, short:p.short, tier:p.tier, parent:p.parent, img:p.img, status:"human", skills:[], host:"network", last_seen:null });
  }

  for (const a of agents) {
    if (!a.agent_name) continue;
    const id = a.agent_name.toLowerCase();
    const p = persona(id);
    const label = PERSONAS[id] ? p.label : cleanLabel(a.display_name) || a.agent_name;
    const existing = byId.get(id);
    // Prefer online over offline; if both same status, prefer newer last_seen
    if (existing && existing.status === "online" && a.status !== "online") continue;
    if (existing && existing.last_seen && a.last_seen_at && existing.last_seen > a.last_seen_at && existing.status === a.status) continue;
    byId.set(id, {
      id, label, role: p.role, color: p.color, short: p.short, tier: p.tier, parent: p.parent, img: p.img,
      status: a.status, host: a.host || "?",
      skills: a.skills || [], last_seen: a.last_seen_at, registered_at: a.registered_at,
    });
  }
  for (const b of briefs) {
    for (const id of [b.source_agent.toLowerCase(), b.agent_name.toLowerCase()]) {
      if (!byId.has(id)) {
        const p = persona(id);
        byId.set(id, { id, label: p.label, role: p.role, color: p.color, short: p.short, tier: p.tier, status:"external", skills:[], host:"?", last_seen:null });
      }
    }
  }

  const nodes = [...byId.values()];
  const linkMap = new Map();
  for (const b of briefs) {
    const s = b.source_agent.toLowerCase();
    const t = b.agent_name.toLowerCase();
    if (s === t) continue;
    const k = s + "→" + t;
    const cur = linkMap.get(k) || { source: s, target: t, count: 0, last_at: null };
    cur.count += b.cnt;
    if (!cur.last_at || b.last_at > cur.last_at) cur.last_at = b.last_at;
    linkMap.set(k, cur);
  }
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent) && !linkMap.has(n.parent + "→" + n.id)) {
      linkMap.set(n.parent + "→" + n.id, { source:n.parent, target:n.id, count:0, last_at:null, implicit:true });
    }
  }
  const links = [...linkMap.values()];
  for (const n of nodes) {
    n.briefed_out = links.filter(l => l.source === n.id && !l.implicit).reduce((s,l)=>s+l.count,0);
    n.briefed_in  = links.filter(l => l.target === n.id && !l.implicit).reduce((s,l)=>s+l.count,0);
  }
  return { nodes, links, totals: {
    agents: nodes.length,
    online: nodes.filter(n => n.status === "online").length,
    briefs: links.reduce((s,l)=>s+l.count,0),
  }};
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Stammbaum · Mnemo</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#1a1612;color:#e8e1d4;font:14px/1.5 -apple-system,Inter,"SF Pro Display",system-ui,sans-serif;-webkit-font-smoothing:antialiased;color-scheme:dark}
.app{display:grid;grid-template-rows:auto 1fr auto;height:100%}
header{display:flex;align-items:center;gap:18px;padding:0 28px;min-height:72px;border-bottom:1px solid rgba(217,170,110,.12);background:rgba(26,22,18,.88);backdrop-filter:blur(20px)}
.brand{display:flex;align-items:center;gap:12px;font:600 14px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:.01em;color:#f8fafc;text-decoration:none}
.brand-mark{display:inline-flex;align-items:center;gap:10px}
.brand-copy{display:flex;flex-direction:column;gap:3px}
.brand-copy strong{font-size:15px;font-weight:700;letter-spacing:-.01em}
.brand-copy span{color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.12em}
.lc-nav-logo{height:22px;width:auto;object-fit:contain}
.lc-nav-logo-light{display:none}
.lc-nav-logo-dark{display:inline-block}
.stats{display:flex;gap:10px;margin-left:auto;font-size:13px;color:#94a3b8;align-items:center}
.stats b{color:#e2e8f0;font-weight:600;margin-right:4px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid rgba(255,255,255,.08);border-radius:999px;background:rgba(255,255,255,.02);font-size:12px}
.pill .live{width:6px;height:6px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
button.refresh{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#cbd5e1;padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:500}
button.refresh:hover{background:rgba(255,255,255,.08);border-color:rgba(34,211,238,.3)}
.nav-links{display:flex;gap:6px;align-items:center;font:500 13px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.nav-links a{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 14px;border:1px solid transparent;border-radius:999px;color:#94a3b8;font-size:13px;font-weight:500;text-decoration:none;transition:border-color .18s,background .18s,color .18s,transform .18s}
.nav-links a:hover,.nav-links a:focus-visible{color:#fff;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);transform:translateY(-1px);outline:none}
.nav-links a.active{color:#fff;border-color:rgba(43,108,255,.35);background:linear-gradient(135deg,rgba(43,108,255,.26),rgba(99,91,255,.22));box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
main{display:grid;grid-template-columns:1fr 320px;overflow:hidden;height:100%}
.canvas{position:relative;overflow:auto;background:radial-gradient(circle at 50% 0%,rgba(217,170,110,.08) 0,transparent 50%),#1a1612}
.tree{padding:48px 32px 80px;min-width:1100px;position:relative}
.tier{display:flex;justify-content:center;gap:24px;margin-bottom:64px;flex-wrap:wrap;position:relative}
.tier-label{position:absolute;left:16px;top:-22px;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#475569;font-weight:600}
.card{position:relative;width:140px;background:linear-gradient(180deg,rgba(40,32,24,.95),rgba(28,22,16,.95));border:1px solid rgba(217,170,110,.2);border-radius:14px;padding:14px 12px 12px;cursor:pointer;transition:all .18s ease;z-index:2;text-align:center;box-shadow:0 0 0 1px rgba(217,170,110,.06),0 4px 16px rgba(0,0,0,.4);outline:none}
.card:focus-visible{border-color:rgba(217,170,110,.55);box-shadow:0 0 0 2px rgba(217,170,110,.5),0 8px 24px rgba(0,0,0,.5)}
.card:hover{border-color:rgba(217,170,110,.55);transform:translateY(-2px);box-shadow:0 0 0 1px rgba(217,170,110,.25),0 8px 24px rgba(0,0,0,.5)}
.card.selected{border-color:rgba(217,170,110,.7);box-shadow:0 0 0 1px rgba(217,170,110,.5),0 8px 24px rgba(217,170,110,.15)}
.card.core{width:160px;border-color:rgba(245,185,66,.45);box-shadow:0 0 0 1px rgba(245,185,66,.2),0 6px 20px rgba(245,185,66,.1)}
.card-head{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:6px}
.avatar{width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#1a1612;letter-spacing:-.02em;flex-shrink:0;box-shadow:0 0 0 2px rgba(217,170,110,.3),0 4px 12px rgba(0,0,0,.4);background-size:cover;background-position:center}
.name{font-weight:600;font-size:14px;color:#f1ead8;letter-spacing:-.01em}
.role{font-size:9px;color:#a89178;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:2px}
.status{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600}
.status.online{background:rgba(52,211,153,.12);color:#34d399}
.status.offline{background:rgba(148,163,184,.1);color:#94a3b8}
.status.external{background:rgba(167,139,250,.12);color:#a78bfa}
.status.human{background:rgba(245,185,66,.12);color:#f5b942}
.status .dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.status.online .dot{box-shadow:0 0 6px currentColor;animation:pulse 2s infinite}
.skills{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}
.chip{font-size:10px;padding:2px 7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.05);color:#94a3b8;border-radius:5px;font-weight:500}
.metrics{display:flex;gap:14px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.05);font-size:11px;color:#64748b}
.metrics b{color:#cbd5e1;font-weight:600}
.metrics span{display:inline-flex;align-items:center;gap:4px}
svg.edges{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1}
aside{border-left:1px solid rgba(255,255,255,.08);background:rgba(15,23,38,.6);padding:28px;overflow:auto}
aside h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#475569;font-weight:600;margin-bottom:16px}
.detail .big{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.detail .big .avatar{width:48px;height:48px;border-radius:13px;font-size:16px}
.detail .big h3{font-size:18px;font-weight:600;margin-bottom:4px}
.detail .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:13px}
.detail .row .k{color:#64748b}
.detail .row .v{color:#e2e8f0;font-weight:500;text-align:right;max-width:60%;word-break:break-word}
.detail .section{margin-top:20px}
.detail .section h4{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#475569;font-weight:600;margin-bottom:10px}
.empty{color:#475569;font-size:13px;text-align:center;padding:40px 0}
.tree-footer{border-top:1px solid rgba(217,170,110,.12);background:rgba(6,10,20,.92);padding:22px 28px 28px}
.tree-footer-grid{display:grid;grid-template-columns:minmax(0,1.3fr) repeat(2,minmax(180px,.8fr));gap:20px;max-width:1240px;margin:0 auto}
.tree-footer-brand{display:grid;gap:10px}
.tree-footer-brand p,.tree-footer-col a,.tree-footer-bottom{font:500 12px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#94a3b8}
.tree-footer-col h3{margin:0 0 10px;color:#fff;font:700 11px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase}
.tree-footer-links{display:grid;gap:8px}
.tree-footer-col a{text-decoration:none}
.tree-footer-col a:hover,.tree-footer-col a:focus-visible{color:#fff;outline:none}
.tree-footer-bottom{margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.04);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;max-width:1240px;margin-left:auto;margin-right:auto}
@media(max-width:900px){main{grid-template-columns:1fr}aside{position:fixed;inset:auto 0 0 0;z-index:50;max-height:70vh;border-left:none;border-top:1px solid rgba(217,170,110,.25);border-radius:18px 18px 0 0;background:rgba(15,23,38,.97);backdrop-filter:blur(16px);transform:translateY(100%);transition:transform .25s ease;overflow-y:auto;padding:20px 20px 28px}aside.open{transform:translateY(0)}aside .mobile-close{display:flex;justify-content:center;padding:0 0 12px;cursor:pointer}aside .mobile-close span{width:36px;height:4px;border-radius:4px;background:rgba(255,255,255,.18)}.tree{min-width:0;padding:24px 12px 48px}.tier{gap:12px;margin-bottom:36px}.card{width:120px}.card.core{width:130px}.avatar{width:42px;height:42px;font-size:14px}header{padding:0 14px;gap:12px;flex-wrap:wrap}.stats{gap:6px;font-size:12px}.brand{width:100%}.brand-copy strong{font-size:14px}.nav-links{width:100%;gap:8px}.nav-links a{flex:1 1 calc(50% - 8px);justify-content:center}svg.edges{display:none}.tree-footer-grid{grid-template-columns:1fr}.tree-footer-bottom{flex-direction:column}}
aside .mobile-close{display:none}
</style></head><body>
<div class="app">
<header>
  <a class="brand" href="/tree/" aria-label="BLUN Agent Stammbaum">
    <span class="brand-mark">
      <img class="lc-nav-logo lc-nav-logo-light" src="https://blun.ai/brand/blun-logo-light.png" alt="BLUN">
      <img class="lc-nav-logo lc-nav-logo-dark" src="https://blun.ai/brand/blun-logo-dark.png" alt="BLUN">
    </span>
    <span class="brand-copy">
      <strong>Agent Stammbaum</strong>
      <span>BLUN internal team topology</span>
    </span>
  </a>
  <nav class="nav-links" aria-label="Mnemo product">
    <a class="active" href="/tree/">Agent Tree</a>
    <a href="/mnemo/">Inspector</a>
    <a href="/memory-tool">Memory Tool</a>
    <a href="/login">BLUN Login</a>
  </nav>
  <div class="stats">
    <span class="pill"><span class="live"></span><b id="onl">0</b>online</span>
    <span class="pill"><b id="agc">0</b>agents</span>
    <span class="pill"><b id="brc">0</b>briefs</span>
    <span id="upd" style="color:#475569;font-size:12px">—</span>
    <button class="refresh" onclick="load()">Refresh</button>
  </div>
</header>
<main>
  <div class="canvas" style="height:100%"><div class="tree" id="tree"><svg class="edges" id="edges"></svg></div></div>
  <aside id="detail"><div class="empty">Select an agent to see details</div></aside>
</main>
<footer class="tree-footer">
  <div class="tree-footer-grid">
    <div class="tree-footer-brand">
      <a class="brand" href="/tree/" aria-label="BLUN Mnemo">
        <span class="brand-mark">
          <img class="lc-nav-logo lc-nav-logo-light" src="https://blun.ai/brand/blun-logo-light.png" alt="BLUN">
          <img class="lc-nav-logo lc-nav-logo-dark" src="https://blun.ai/brand/blun-logo-dark.png" alt="BLUN">
        </span>
        <span class="brand-copy">
          <strong>Mnemo Firm-OS</strong>
          <span>Internal memory and coordination layer</span>
        </span>
      </a>
      <p>Operational access only. Public routes must not expose private memory, but the shell still follows BLUN product chrome and legal wiring.</p>
    </div>
    <div class="tree-footer-col">
      <h3>Product</h3>
      <div class="tree-footer-links">
        <a href="/tree/">Agent Tree</a>
        <a href="/mnemo/">Inspector</a>
        <a href="/memory-tool">Memory Tool</a>
      </div>
    </div>
    <div class="tree-footer-col">
      <h3>Legal</h3>
      <div class="tree-footer-links">
        <a href="/en/impressum">Impressum</a>
        <a href="/en/datenschutz">Datenschutz</a>
        <a href="/en/agb">AGB</a>
      </div>
    </div>
  </div>
  <div class="tree-footer-bottom">
    <div>BLUN &middot; Agent Stammbaum on listing.blun.ai</div>
    <div>Made for internal agent operations with shared BLUN identity.</div>
  </div>
</footer>
</div>
<script>
let DATA=null,SELECTED=null;
async function load(){
  const r=await fetch("api/graph");DATA=await r.json();
  document.getElementById("agc").textContent=DATA.totals.agents;
  document.getElementById("onl").textContent=DATA.totals.online;
  document.getElementById("brc").textContent=DATA.totals.briefs;
  document.getElementById("upd").textContent="updated "+new Date().toLocaleTimeString();
  render();
}
function render(){
  const tree=document.getElementById("tree");
  [...tree.children].forEach(c=>{if(c.tagName!=="svg"&&c.tagName!=="SVG")c.remove()});
  const tiers={0:[],1:[],2:[],3:[],4:[]};
  const ALWAYS=new Set(["mayk","florin","dieter","angel","fredrik","richard","dominik","markus"]);
  const active=DATA.nodes.filter(n=>n.status==="online"||n.status==="human"||ALWAYS.has(n.id));
  for(const n of active)(tiers[n.tier]||tiers[4]).push(n);
  for(const t of [0,1,2,3,4])tiers[t].sort((a,b)=>(b.status==="online")-(a.status==="online")||a.label.localeCompare(b.label));
  // Mayk first in tier 0
  tiers[0].sort((a,b)=>a.id==="mayk"?-1:b.id==="mayk"?1:0);
  const labels={0:"Founder",1:"CEO",2:"Leadership",3:"Team",4:"Workers"};
  for(const t of [0,1,2,3,4]){
    if(!tiers[t].length)continue;
    const tier=document.createElement("div");tier.className="tier";
    const lab=document.createElement("div");lab.className="tier-label";lab.textContent=labels[t];
    tier.appendChild(lab);
    for(const n of tiers[t])tier.appendChild(card(n));
    tree.appendChild(tier);
  }
  requestAnimationFrame(drawEdges);
}
function card(n){
  const el=document.createElement("div");
  el.className="card"+(n.tier===0?" core":"")+(SELECTED===n.id?" selected":"");
  el.dataset.id=n.id;
  const avStyle=n.img?\`background-image:url('\${esc(n.img)}');background-color:#2a1f15\`:\`background:linear-gradient(135deg,\${n.color},\${shade(n.color,-30)})\`;
  const hasMetrics=n.briefed_in||n.briefed_out;
  el.innerHTML=\`
    <div class="card-head">
      <div class="avatar" style="\${avStyle}">\${n.img?'':n.short}</div>
      <div class="name">\${esc(n.label)}</div>
      <div class="role">\${esc(n.role)}</div>
      <span class="status \${n.status}"><span class="dot"></span>\${n.status}</span>
    </div>\${hasMetrics?\`<div class="metrics"><span>↑ <b>\${n.briefed_out}</b></span><span>↓ <b>\${n.briefed_in}</b></span></div>\`:''}\`;
  el.setAttribute("tabindex","0");el.setAttribute("role","button");el.setAttribute("aria-label",n.label+" — "+n.role);
  const activate=()=>{SELECTED=n.id;render();showDetail(n.id)};
  el.onclick=activate;el.onkeydown=(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();activate()}};
  return el;
}
function drawEdges(){
  const svg=document.getElementById("edges");
  const tree=document.getElementById("tree");
  const W=tree.scrollWidth,H=tree.scrollHeight;
  svg.setAttribute("width",W);svg.setAttribute("height",H);
  svg.innerHTML='<defs><marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#22d3ee" opacity=".6"/></marker></defs>';
  const pos={};
  tree.querySelectorAll(".card").forEach(c=>{
    const r=c.getBoundingClientRect(),tr=tree.getBoundingClientRect();
    pos[c.dataset.id]={x:r.left-tr.left+r.width/2,top:r.top-tr.top,bot:r.bottom-tr.top};
  });
  // Group by parent for org-chart bus-bar connectors (Maike-style)
  const groups={};
  for(const l of DATA.links){
    if(!pos[l.source]||!pos[l.target])continue;
    (groups[l.source]=groups[l.source]||[]).push(l);
  }
  for(const src in groups){
    const a=pos[src];
    const ch=groups[src].map(l=>({l,b:pos[l.target]})).sort((x,y)=>x.b.x-y.b.x);
    const childTop=Math.min(...ch.map(c=>c.b.top));
    const busY=a.bot+(childTop-a.bot)*0.55;
    const minX=Math.min(...ch.map(c=>c.b.x)), maxX=Math.max(...ch.map(c=>c.b.x));
    const recent=ch.some(c=>c.l.last_at&&(Date.now()-new Date(c.l.last_at).getTime()<3600*1000));
    const stroke=recent?"rgba(245,185,66,.7)":"rgba(217,170,110,.4)";
    const make=(d)=>{const p=document.createElementNS("http://www.w3.org/2000/svg","path");p.setAttribute("d",d);p.setAttribute("fill","none");p.setAttribute("stroke",stroke);p.setAttribute("stroke-width",1);p.setAttribute("stroke-linecap","round");svg.appendChild(p)};
    make(\`M \${a.x} \${a.bot} L \${a.x} \${busY}\`);
    if(ch.length>1)make(\`M \${minX} \${busY} L \${maxX} \${busY}\`);
    for(const c of ch)make(\`M \${c.b.x} \${busY} L \${c.b.x} \${c.b.top}\`);
  }
}
function showDetail(id){
  const n=DATA.nodes.find(x=>x.id===id);if(!n)return;
  const inLinks=DATA.links.filter(l=>l.target===id&&l.count>0);
  const outLinks=DATA.links.filter(l=>l.source===id&&l.count>0);
  const last=n.last_seen?new Date(n.last_seen).toLocaleString():"—";
  const reg=n.registered_at?new Date(n.registered_at).toLocaleString():"—";
  const el=document.getElementById("detail");el.className="detail";
  el.classList.add("open");
  el.innerHTML=\`
    <div class="mobile-close" role="button" tabindex="0" aria-label="Close detail panel" onclick="document.getElementById('detail').classList.remove('open')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('detail').classList.remove('open')}"><span></span></div>
    <div class="big">
      <div class="avatar" style="\${n.img?\`background-image:url('\${esc(n.img)}');background-size:cover;background-position:center;background-color:#2a1f15\`:\`background:linear-gradient(135deg,\${n.color},\${shade(n.color,-30)})\`}">\${n.img?'':n.short}</div>
      <div><h3>\${esc(n.label)}</h3><span class="status \${n.status}"><span class="dot"></span>\${n.status}</span></div>
    </div>
    <div class="row"><span class="k">Role</span><span class="v">\${esc(n.role)}</span></div>
    <div class="row"><span class="k">ID</span><span class="v" style="font-family:ui-monospace,monospace;font-size:12px">\${esc(n.id)}</span></div>
    <div class="row"><span class="k">Host</span><span class="v">\${esc(n.host||"—")}</span></div>
    <div class="row"><span class="k">Last seen</span><span class="v">\${last}</span></div>
    <div class="row"><span class="k">Registered</span><span class="v">\${reg}</span></div>
    \${n.skills&&n.skills.length?\`<div class="section"><h4>Skills</h4><div class="skills">\${n.skills.map(s=>'<span class="chip">'+esc(s)+'</span>').join("")}</div></div>\`:''}
    \${outLinks.length?\`<div class="section"><h4>Briefed → \${outLinks.length}</h4>\${outLinks.map(l=>\`<div class="row"><span class="k">\${esc(l.target)}</span><span class="v">\${l.count}</span></div>\`).join("")}</div>\`:''}
    \${inLinks.length?\`<div class="section"><h4>Briefed by ← \${inLinks.length}</h4>\${inLinks.map(l=>\`<div class="row"><span class="k">\${esc(l.source)}</span><span class="v">\${l.count}</span></div>\`).join("")}</div>\`:''}
  \`;
}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function shade(hex,p){const n=parseInt(hex.slice(1),16),f=p<0?0:255,t=Math.abs(p)/100;const R=n>>16,G=(n>>8)&0xff,B=n&0xff;return"#"+(0x1000000+(Math.round((f-R)*t)+R)*0x10000+(Math.round((f-G)*t)+G)*0x100+(Math.round((f-B)*t)+B)).toString(16).slice(1)}
load();setInterval(load,3000);
window.addEventListener("resize",()=>requestAnimationFrame(drawEdges));
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") return res.end(JSON.stringify({ ok:true, tree:true, port:PORT }));
  if (req.url === "/api/graph") {
    try { const g = await buildGraph(); res.setHeader("Content-Type","application/json"); return res.end(JSON.stringify(g)); }
    catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error:e.message })); }
  }
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.end(HTML);
});
server.listen(PORT, "127.0.0.1", () => console.log("[agent-tree-ui] listening on", PORT));

function shutdown(signal) {
  console.log(`[agent-tree-ui] ${signal} received, closing server…`);
  server.close(() => {
    console.log("[agent-tree-ui] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.error("[agent-tree-ui] forced exit after timeout"); process.exit(1); }, 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[agent-tree-ui] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[agent-tree-ui] uncaughtException:", err);
  shutdown("uncaughtException");
});

// Keep dieter+angel alive in registry (they don't run continuous workers)
function hb(name) {
  const b = Buffer.from(JSON.stringify({ agent_name: name, status: "online" }));
  const r = http.request({ method:"POST", hostname:"127.0.0.1", port:7117, path:"/tool/mem_connect_heartbeat", headers:{ "Content-Type":"application/json", "Content-Length":b.length }});
  r.on("error", () => {}); r.write(b); r.end();
}
function tick() { ["dieter","angel"].forEach(hb); }
tick(); setInterval(tick, 30000);
