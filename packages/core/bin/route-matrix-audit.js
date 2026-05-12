#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { URL } = require("url");

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    sites: [],
    sitePaths: {},
    paths: ["/"],
    locales: [],
    legal: ["impressum", "datenschutz", "agb"],
    allowedExternalHosts: [],
    forbiddenHosts: [],
    checkCtaTargets: true,
    maxCtaChecks: 80,
    timeoutMs: 12000,
    concurrency: 12,
    output: "",
    fail: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--site") { out.sites.push(parseSite(next)); i++; continue; }
    if (a === "--sites") { out.sites.push(...splitList(next).map(parseSite)); i++; continue; }
    if (a === "--base" || a === "--bases") { out.sites.push(...splitList(next).map(parseSite)); i++; continue; }
    if (a === "--paths") { out.paths = splitList(next).map(normalizePath); i++; continue; }
    if (a === "--site-paths") { addSitePaths(out.sitePaths, next); i++; continue; }
    if (a === "--locales") { out.locales = splitList(next); i++; continue; }
    if (a === "--legal") { out.legal = splitList(next); i++; continue; }
    if (a === "--allowed-external-hosts" || a === "--allowed-hosts") { out.allowedExternalHosts.push(...splitList(next).map(normalizeHost)); i++; continue; }
    if (a === "--forbidden-hosts" || a === "--forbidden-host") { out.forbiddenHosts.push(...splitList(next).map(normalizeHost)); i++; continue; }
    if (a === "--no-check-cta-targets") { out.checkCtaTargets = false; continue; }
    if (a === "--max-cta-checks") { out.maxCtaChecks = positiveInt(next, out.maxCtaChecks); i++; continue; }
    if (a === "--timeout-ms") { out.timeoutMs = positiveInt(next, out.timeoutMs); i++; continue; }
    if (a === "--concurrency") { out.concurrency = positiveInt(next, out.concurrency); i++; continue; }
    if (a === "--output") { out.output = next; i++; continue; }
    if (a === "--fail") { out.fail = true; continue; }
    if (a === "--help" || a === "-h") usage(0);
  }
  if (!out.sites.length) usage(1);
  out.sites = out.sites.filter(Boolean);
  if (!out.sites.length) usage(1);
  return out;
}

function usage(code) {
  console.log(`Usage:
  node packages/core/bin/route-matrix-audit.js --site main=https://example.com --site app=https://app.example.com --paths /,/login,/pricing --locales de,en --legal impressum,datenschutz,agb

Checks:
  - route status and redirect location
  - html lang vs locale prefix
  - header/footer/nav/viewport presence
  - footer legal labels
  - header/footer host leaks and forbidden hosts
  - CTA links and optional CTA target status
  - query loss on first redirect, useful for plan/next/login flows

Options:
  --site label=https://host          repeatable
  --bases https://a.com,https://b.com
  --paths /,/login,/pricing
  --site-paths main=/,/mission,/mission/
  --locales de,en,fr                 also adds /<locale> and /<locale>/<legal>
  --allowed-external-hosts host1,host2
  --forbidden-hosts host1,host2
  --no-check-cta-targets
  --output report.json
  --fail                             exit 1 when high severity findings exist`);
  process.exit(code);
}

function splitList(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function addSitePaths(target, value) {
  const raw = String(value || "").trim();
  const eq = raw.indexOf("=");
  if (eq <= 0) return;
  const label = raw.slice(0, eq).trim();
  const paths = splitList(raw.slice(eq + 1)).map(normalizePath);
  if (label && paths.length) target[label] = paths;
}

function positiveInt(value, fallback) {
  const n = parseInt(value || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseSite(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const eq = raw.indexOf("=");
  if (eq > 0) return { label: raw.slice(0, eq).trim(), base: normalizeBase(raw.slice(eq + 1).trim()) };
  const base = normalizeBase(raw);
  return { label: safeHost(base) || base, base };
}

function normalizeBase(raw) {
  const u = new URL(raw);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString().replace(/\/$/, "");
}

function normalizePath(p) {
  const s = String(p || "/").trim();
  return s.startsWith("/") ? s : "/" + s;
}

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function safeHost(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

function urlFor(base, path) {
  const b = new URL(base);
  return new URL(path, b.origin).toString();
}

function buildPaths(basePaths, locales, legal) {
  const set = new Set(basePaths.map(normalizePath));
  for (const locale of locales) {
    set.add("/" + locale);
    for (const item of legal) set.add("/" + locale + "/" + item);
  }
  return Array.from(set);
}

function pathsForSite(site) {
  const base = args.sitePaths[site.label] || args.paths;
  return buildPaths(base, args.locales, args.legal);
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function section(html, name) {
  const re = new RegExp(`<${name}\\b[\\s\\S]*?<\\/${name}>`, "i");
  const m = String(html || "").match(re);
  return m ? m[0] : "";
}

function attr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i");
  const m = String(attrs || "").match(re);
  return m ? m[1] : "";
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const attrs = m[1] || "";
    const href = attr(attrs, "href").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    let absolute = href;
    try { absolute = new URL(href, baseUrl).toString(); } catch {}
    links.push({
      text: stripTags(m[2]).slice(0, 120),
      href,
      absolute,
      host: safeHost(absolute),
    });
  }
  return links;
}

function titleOf(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).slice(0, 160) : "";
}

function htmlLang(html) {
  const m = String(html || "").match(/<html[^>]*\blang=["']([^"']+)/i);
  return m ? m[1].trim() : "";
}

function expectedLocale(path) {
  const m = String(path || "").match(/^\/(?:lang\/)?([a-z]{2})(?:\/|$)/i);
  return m ? m[1].toLowerCase() : "";
}

function hasViewport(html) {
  return /<meta\b[^>]*\bname=["']viewport["']/i.test(String(html || ""));
}

function ctaLinks(links) {
  const re = /(checkout|stripe|buy|kaufen|subscribe|billing|cart|price|pricing|plans|plan=|register|signup|sign-up|login|start|try|kostenlos|upgrade|all-access|all_access)/i;
  return links.filter(l => re.test(`${l.href} ${l.text}`));
}

async function fetchPage(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: ac.signal,
      headers: { "user-agent": "mnemo-route-matrix-audit/0.1" },
    });
    const type = res.headers.get("content-type") || "";
    let html = "";
    if (type.includes("text/html")) html = await res.text();
    return {
      url,
      status: res.status,
      location: res.headers.get("location") || "",
      content_type: type,
      html,
    };
  } catch (e) {
    return { url, error: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return out;
}

function queryKeys(url) {
  try { return Array.from(new URL(url).searchParams.keys()).sort(); } catch { return []; }
}

function redirectLosesQuery(sourceUrl, location) {
  const keys = queryKeys(sourceUrl);
  if (!keys.length || !location) return false;
  let target = location;
  try { target = new URL(location, sourceUrl).toString(); } catch {}
  const targetKeys = new Set(queryKeys(target));
  return keys.some(k => !targetKeys.has(k));
}

function linkSummary(links) {
  return links.map(l => ({ text: l.text, href: l.href, absolute: l.absolute, host: l.host }));
}

function classifyFindings(row, site, cfg) {
  const findings = [];
  const add = (severity, type, message, evidence) => findings.push({ severity, type, message, evidence });
  if (row.error) add("H", "fetch_failed", row.error, { url: row.url });
  if (row.status >= 400) add("H", "route_error", `route returned ${row.status}`, { url: row.url, status: row.status });
  if (row.redirect_query_lost) add("H", "redirect_query_lost", "first redirect dropped query parameters", { url: row.url, location: row.location });
  if (row.status === 200 && !row.header_present) add("M", "header_missing", "no header element found", { url: row.url });
  if (row.status === 200 && !row.footer_present) add("M", "footer_missing", "no footer element found", { url: row.url });
  if (row.status === 200 && !row.viewport) add("M", "viewport_missing", "viewport meta missing", { url: row.url });
  if (row.locale_expected && row.html_lang && !row.html_lang.toLowerCase().startsWith(row.locale_expected)) {
    add("H", "locale_mismatch", `html lang ${row.html_lang} does not match ${row.locale_expected}`, { url: row.url });
  }
  for (const leak of row.header_footer_external_links) {
    const forbidden = cfg.forbiddenHosts.includes(leak.host);
    add(forbidden ? "H" : "M", forbidden ? "forbidden_host_link" : "external_header_footer_link", "header/footer link points to external host", leak);
  }
  if (cfg.legal.length && row.status === 200 && row.footer_present) {
    const missing = cfg.legal.filter(item => !row.footer_text.toLowerCase().includes(item.toLowerCase()));
    if (missing.length) add("M", "footer_legal_missing", "footer is missing legal labels", { missing });
  }
  for (const cta of row.cta_target_checks || []) {
    if (cta.error) add("M", "cta_check_failed", "CTA target could not be checked", cta);
    else if (cta.status >= 400) add("H", "cta_target_error", `CTA target returned ${cta.status}`, cta);
    else if (cta.redirect_query_lost) add("H", "cta_redirect_query_lost", "CTA redirect dropped query parameters", cta);
  }
  return findings;
}

async function audit() {
  const cfg = Object.assign({}, args, { forbiddenHosts: args.forbiddenHosts.map(normalizeHost), legal: args.legal });
  const pageJobs = [];
  for (const site of args.sites) {
    for (const path of pathsForSite(site)) pageJobs.push({ site, path, url: urlFor(site.base, path) });
  }

  const rows = await mapLimit(pageJobs, args.concurrency, async job => {
    const page = await fetchPage(job.url, args.timeoutMs);
    const html = page.html || "";
    const header = section(html, "header");
    const footer = section(html, "footer");
    const links = extractLinks(html, job.url);
    const headerFooterLinks = extractLinks(`${header}\n${footer}`, job.url);
    const siteHost = safeHost(job.site.base);
    const allowedForSite = new Set(args.allowedExternalHosts.map(normalizeHost));
    allowedForSite.add(siteHost);
    const external = headerFooterLinks
      .filter(l => l.host && l.host !== siteHost && (!allowedForSite.has(l.host) || cfg.forbiddenHosts.includes(l.host)))
      .map(l => ({ text: l.text, href: l.href, absolute: l.absolute, host: l.host }));
    const ctas = ctaLinks(links).slice(0, args.maxCtaChecks);
    const row = {
      site: job.site.label,
      base: job.site.base,
      host: siteHost,
      path: job.path,
      url: job.url,
      status: page.status || null,
      location: page.location || "",
      redirect_query_lost: redirectLosesQuery(job.url, page.location),
      error: page.error || "",
      title: titleOf(html),
      html_lang: htmlLang(html),
      locale_expected: expectedLocale(job.path),
      header_present: /<header\b/i.test(html),
      nav_present: /<nav\b/i.test(html),
      footer_present: /<footer\b/i.test(html),
      viewport: hasViewport(html),
      footer_text: stripTags(footer).slice(0, 500),
      header_footer_links: linkSummary(headerFooterLinks).slice(0, 80),
      header_footer_external_links: external,
      cta_links: linkSummary(ctas),
      cta_target_checks: [],
    };
    return row;
  });

  if (args.checkCtaTargets) {
    const seen = new Set();
    const ctaJobs = [];
    for (const row of rows) {
      for (const link of row.cta_links) {
        if (!/^https?:\/\//i.test(link.absolute)) continue;
        const key = `${row.site}|${link.absolute}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ctaJobs.push({ row, link });
      }
    }
    const checks = await mapLimit(ctaJobs.slice(0, args.maxCtaChecks), args.concurrency, async job => {
      const page = await fetchPage(job.link.absolute, args.timeoutMs);
      return {
        site: job.row.site,
        source_url: job.row.url,
        text: job.link.text,
        href: job.link.href,
        absolute: job.link.absolute,
        status: page.status || null,
        location: page.location || "",
        error: page.error || "",
        redirect_query_lost: redirectLosesQuery(job.link.absolute, page.location),
      };
    });
    const bySource = new Map();
    for (const c of checks) {
      const list = bySource.get(c.source_url) || [];
      list.push(c);
      bySource.set(c.source_url, list);
    }
    for (const row of rows) row.cta_target_checks = bySource.get(row.url) || [];
  }

  const allFindings = [];
  for (const row of rows) {
    row.findings = classifyFindings(row, row.site, cfg);
    for (const f of row.findings) allFindings.push(Object.assign({ site: row.site, path: row.path, url: row.url }, f));
  }
  const summary = {};
  for (const site of args.sites) {
    const siteRows = rows.filter(r => r.site === site.label);
    const findings = allFindings.filter(f => f.site === site.label);
    summary[site.label] = {
      base: site.base,
      routes: siteRows.length,
      ok_2xx: siteRows.filter(r => r.status >= 200 && r.status < 300).length,
      redirects_3xx: siteRows.filter(r => r.status >= 300 && r.status < 400).length,
      errors_4xx_5xx: siteRows.filter(r => r.status >= 400 || r.error).length,
      high_findings: findings.filter(f => f.severity === "H").length,
      medium_findings: findings.filter(f => f.severity === "M").length,
      cta_errors: findings.filter(f => /^cta_/.test(f.type)).length,
      locale_mismatches: findings.filter(f => f.type === "locale_mismatch").length,
      external_header_footer_links: findings.filter(f => f.type === "external_header_footer_link" || f.type === "forbidden_host_link").length,
    };
  }

  const report = {
    generated_at: new Date().toISOString(),
    config: {
      sites: args.sites,
      paths: args.paths,
      site_paths: args.sitePaths,
      locales: args.locales,
      legal: args.legal,
      allowed_external_hosts: args.allowedExternalHosts.map(normalizeHost),
      forbidden_hosts: cfg.forbiddenHosts,
      check_cta_targets: args.checkCtaTargets,
    },
    summary,
    findings: allFindings,
    rows,
  };
  if (args.output) fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (args.fail && allFindings.some(f => f.severity === "H")) process.exit(1);
}

audit().catch(e => {
  console.error(String(e.stack || e.message || e));
  process.exit(1);
});
