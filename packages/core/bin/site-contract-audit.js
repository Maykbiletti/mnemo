#!/usr/bin/env node
"use strict";

const { URL } = require("url");
const http = require("http");
const https = require("https");

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = {
    paths: ["/"],
    targets: [],
    allowedHosts: [],
    forbiddenHosts: [],
    report: false,
    allowCanonicalHost: false,
    requireDarkLogo: false,
    requireViewport: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--project") { out.project = next; i++; continue; }
    if (a === "--mnemo-url") { out.mnemoUrl = next; i++; continue; }
    if (a === "--report") { out.report = true; continue; }
    if (a === "--canonical") { out.canonical = next; i++; continue; }
    if (a === "--targets") { out.targets = splitList(next); i++; continue; }
    if (a === "--paths") { out.paths = splitList(next).map(p => p.startsWith("/") ? p : "/" + p); i++; continue; }
    if (a === "--allowed-host" || a === "--allowed-hosts") { out.allowedHosts.push(...splitList(next)); i++; continue; }
    if (a === "--forbidden-host" || a === "--forbidden-hosts") { out.forbiddenHosts.push(...splitList(next)); i++; continue; }
    if (a === "--allow-canonical-host") { out.allowCanonicalHost = true; continue; }
    if (a === "--require-dark-logo") { out.requireDarkLogo = true; continue; }
    if (a === "--no-require-viewport") { out.requireViewport = false; continue; }
    if (a === "--help" || a === "-h") { usage(0); }
  }
  return out;
}

function splitList(v) {
  return String(v || "").split(",").map(s => s.trim()).filter(Boolean);
}

function usage(code) {
  console.log(`Usage:
  node packages/core/bin/site-contract-audit.js --canonical https://example.com --targets https://app.example.com,https://site.example.com --paths /,/de,/en --forbidden-host example.com
  node packages/core/bin/site-contract-audit.js --project my-project --report

Checks:
  - fetches canonical + target paths
  - extracts header/nav/footer links and image assets
  - compares canonical header/menu labels against target pages
  - compares same-label menu href targets and catches copied canonical-domain nav
  - flags target internal nav/footer links that leak to forbidden hosts
  - flags locale path prefix loss for internal and legal links
  - checks logo presence and optional dark-logo assets
  - checks viewport meta for mobile readiness
  - reports rough header class/style-token overlap
  - with --project, loads mem_site_contract_get from MNEMO_URL or MNEMO_HUB_URL
  - with --report, writes mem_site_golden_check_report after the run`);
  process.exit(code);
}

function normalizeBase(raw) {
  if (!raw) return "";
  const u = new URL(raw);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  return u.toString().replace(/\/$/, "");
}

function joinUrl(base, p) {
  const b = new URL(base);
  const path = p.startsWith("/") ? p : "/" + p;
  return new URL(path, b.origin).toString();
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

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const attrs = m[1] || "";
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1].trim();
    let absolute = rawHref;
    try { absolute = new URL(rawHref, baseUrl).toString(); } catch {}
    links.push({
      text: stripTags(m[2]).slice(0, 120),
      href: rawHref,
      absolute,
      host: safeHost(absolute)
    });
  }
  return links;
}

function extractImages(html, baseUrl) {
  const imgs = [];
  const re = /<img\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const attrs = m[1] || "";
    const src = attr(attrs, "src");
    if (!src) continue;
    let absolute = src;
    try { absolute = new URL(src, baseUrl).toString(); } catch {}
    imgs.push({ kind: "img", src, absolute, host: safeHost(absolute), alt: attr(attrs, "alt"), class: attr(attrs, "class") });
  }
  return imgs;
}

function extractSourceAssets(html, baseUrl) {
  const assets = [];
  const re = /<source\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const attrs = m[1] || "";
    const srcset = attr(attrs, "srcset");
    if (!srcset) continue;
    const first = srcset.split(",")[0].trim().split(/\s+/)[0];
    if (!first) continue;
    let absolute = first;
    try { absolute = new URL(first, baseUrl).toString(); } catch {}
    assets.push({ kind: "source", src: first, absolute, host: safeHost(absolute), media: attr(attrs, "media"), class: attr(attrs, "class"), alt: "" });
  }
  return assets;
}

function attr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = String(attrs || "").match(re);
  return m ? m[1].trim() : "";
}

function classTokens(html) {
  const tokens = new Set();
  const re = /\bclass\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    for (const t of m[1].split(/\s+/)) {
      const token = t.trim();
      if (token && token.length <= 80) tokens.add(token);
    }
  }
  return Array.from(tokens);
}

function safeHost(raw) {
  try { return new URL(raw).host; } catch { return ""; }
}

function localePrefix(p) {
  const m = String(p || "").match(/^\/([a-z]{2})(?:\/|$)/i);
  return m ? "/" + m[1].toLowerCase() : "";
}

function extractHtmlLang(html) {
  const m = String(html || "").match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].trim().toLowerCase() : "";
}

function hasViewportMeta(html) {
  return /<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i.test(String(html || ""));
}

function looksLogo(asset) {
  const text = [asset.src, asset.absolute, asset.alt, asset.class].filter(Boolean).join(" ").toLowerCase();
  return /\b(logo|brand|mark|wordmark|logotype)\b/.test(text);
}

function darkLogoAssets(html, assets) {
  const found = [];
  for (const asset of assets || []) {
    const text = [asset.src, asset.absolute, asset.alt, asset.class, asset.media].filter(Boolean).join(" ").toLowerCase();
    if (/\b(dark|darkmode|dark-mode|inverse|negative)\b/.test(text) || /prefers-color-scheme\s*:\s*dark/i.test(text)) found.push(asset);
  }
  if (/prefers-color-scheme\s*:\s*dark/i.test(String(html || "")) && !found.length) {
    found.push({ kind: "css", src: "prefers-color-scheme: dark" });
  }
  return found;
}

function looksLegalLink(link) {
  const text = [link.text, link.href, link.absolute].filter(Boolean).join(" ").toLowerCase();
  return /\b(impressum|datenschutz|privacy|terms|agb|legal|cookies?|widerruf|refund|policy)\b/.test(text);
}

function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedPath(raw) {
  try {
    const u = new URL(raw);
    return normalizePathname(u.pathname);
  } catch {
    return normalizePathname(raw);
  }
}

function normalizePathname(pathname) {
  const path = String(pathname || "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  return path.toLowerCase();
}

function canonicalLeakHosts(canonicalHost, targetHost, opts) {
  const hosts = new Set((opts.forbiddenHosts || []).map(h => String(h || "").toLowerCase()).filter(Boolean));
  if (canonicalHost && targetHost && canonicalHost.toLowerCase() !== targetHost.toLowerCase() && !opts.allowCanonicalHost) {
    hosts.add(canonicalHost.toLowerCase());
  }
  return hosts;
}

function allowedHosts(opts, targetHost) {
  const hosts = new Set((opts.allowedHosts || []).map(h => String(h || "").toLowerCase()).filter(Boolean));
  if (targetHost) hosts.add(String(targetHost).toLowerCase());
  return hosts;
}

function unique(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function mnemoUrl() {
  const raw = args.mnemoUrl || process.env.MNEMO_URL || process.env.MNEMO_HUB_URL || "";
  return String(raw).replace(/\/+$/, "");
}

async function callMnemoTool(tool, payload) {
  const base = mnemoUrl();
  if (!base) throw new Error("MNEMO_URL or MNEMO_HUB_URL required for --project/--report");
  const res = await fetch(`${base}/tool/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  if (!res.ok) throw new Error(`${tool} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return body && typeof body === "object" && "result" in body ? body.result : body;
}

async function loadProjectContract() {
  if (!args.project || (args.canonical && args.targets.length)) return;
  const contract = await callMnemoTool("mem_site_contract_get", { project: args.project });
  if (contract.error) throw new Error(contract.error);
  args.contract = contract;
  args.canonical = args.canonical || contract.canonical_url;
  args.targets = args.targets.length ? args.targets : (Array.isArray(contract.target_urls) ? contract.target_urls : []);
  args.paths = args.paths && args.paths.length && args.paths[0] !== "/" ? args.paths : (Array.isArray(contract.paths) && contract.paths.length ? contract.paths : args.paths);
  args.forbiddenHosts = args.forbiddenHosts.length ? args.forbiddenHosts : (Array.isArray(contract.forbidden_hosts) ? contract.forbidden_hosts : []);
  const allowedFromRules = contract.project_rules_hint && Array.isArray(contract.project_rules_hint.allowed_domains) ? contract.project_rules_hint.allowed_domains : [];
  if (!args.allowedHosts.length && allowedFromRules.length) args.allowedHosts = allowedFromRules;
  const logo = contract.logo_rules || {};
  if (logo.require_dark_logo || logo.dark_logo_required || logo.dark_mode === true) args.requireDarkLogo = true;
}

async function fetchPage(url) {
  return fetchWithRedirect(url, 0);
}

function fetchWithRedirect(rawUrl, depth) {
  if (depth > 5) return Promise.reject(new Error("too many redirects: " + rawUrl));
  const target = new URL(rawUrl);
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method: "GET",
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      headers: { "user-agent": "mnemo-site-contract-audit/0.1" },
      timeout: 30000
    }, res => {
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
        res.resume();
        const next = new URL(loc, target).toString();
        resolve(fetchWithRedirect(next, depth + 1));
        return;
      }
      let html = "";
      res.setEncoding("utf8");
      res.on("data", c => html += c);
      res.on("end", () => {
        const status = res.statusCode || 0;
        resolve({ url: rawUrl, status, ok: status >= 200 && status < 300, final_url: rawUrl, html });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout: " + rawUrl)));
    req.on("error", reject);
    req.end();
  });
}

function analyzePage(page) {
  const head = section(page.html, "header");
  const nav = section(page.html, "nav") || head;
  const foot = section(page.html, "footer");
  const headerHtml = head || nav;
  const headerLinks = extractLinks(head || nav, page.final_url || page.url);
  const navLinks = extractLinks(nav, page.final_url || page.url);
  const footerLinks = extractLinks(foot, page.final_url || page.url);
  const allLinks = extractLinks(page.html, page.final_url || page.url);
  const headerImages = extractImages(headerHtml, page.final_url || page.url);
  const allImages = extractImages(page.html, page.final_url || page.url);
  const sourceAssets = extractSourceAssets(page.html, page.final_url || page.url);
  const assets = uniqueAssets([...headerImages, ...allImages, ...sourceAssets]);
  const logoImages = assets.filter(looksLogo);
  return {
    url: page.url,
    final_url: page.final_url,
    status: page.status,
    ok: page.ok,
    html_lang: extractHtmlLang(page.html),
    viewport_meta: hasViewportMeta(page.html),
    header_present: Boolean(head || nav),
    footer_present: Boolean(foot),
    header_text: stripTags(head || nav).slice(0, 1000),
    header_links: headerLinks.length ? headerLinks : navLinks,
    footer_links: footerLinks,
    all_links: allLinks,
    legal_links: footerLinks.filter(looksLegalLink),
    images: assets,
    logo_images: logoImages,
    dark_logo_assets: darkLogoAssets(page.html, assets.filter(looksLogo)),
    header_tokens: classTokens(head || nav)
  };
}

function uniqueAssets(assets) {
  const seen = new Set();
  const out = [];
  for (const asset of assets) {
    const key = [asset.kind, asset.absolute || asset.src, asset.media || "", asset.class || "", asset.alt || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

function compare(canonical, target, opts) {
  const findings = [];
  const targetHost = safeHost(target.final_url || target.url);
  const canonicalHost = safeHost(canonical.final_url || canonical.url);
  const forbidden = canonicalLeakHosts(canonicalHost, targetHost, opts);
  const allowed = allowedHosts(opts, targetHost);
  const canonicalLabels = unique(canonical.header_links.map(l => l.text).filter(t => t && t.length > 1));
  const targetLabels = unique(target.header_links.map(l => l.text).filter(t => t && t.length > 1));
  const missingLabels = canonicalLabels.filter(label => !targetLabels.some(t => t.toLowerCase() === label.toLowerCase()));
  for (const label of missingLabels) findings.push({ severity: "M", category: "nav", type: "missing_header_label", label, url: target.url });

  const canonicalByLabel = linkMapByLabel(canonical.header_links);
  const targetByLabel = linkMapByLabel(target.header_links);
  for (const [label, canonicalLink] of canonicalByLabel) {
    const targetLink = targetByLabel.get(label);
    if (!targetLink) continue;
    const targetLinkHost = String(targetLink.host || "").toLowerCase();
    const canonicalLinkPath = normalizedPath(canonicalLink.absolute || canonicalLink.href);
    const targetLinkPath = normalizedPath(targetLink.absolute || targetLink.href);
    if (forbidden.has(targetLinkHost) && targetLinkHost !== String(targetHost).toLowerCase()) {
      findings.push({ severity: "H", category: "nav", type: "menu_canonical_domain_leak", label: canonicalLink.text, href: targetLink.absolute, expected_host: targetHost, actual_host: targetLink.host, url: target.url });
    }
    if (targetLinkHost === String(targetHost).toLowerCase() && canonicalLinkPath !== "/" && targetLinkPath !== canonicalLinkPath) {
      findings.push({ severity: "M", category: "nav", type: "menu_href_mismatch", label: canonicalLink.text, expected_path: canonicalLinkPath, actual_path: targetLinkPath, href: targetLink.absolute, url: target.url });
    }
  }

  const targetTokens = new Set(target.header_tokens);
  const common = canonical.header_tokens.filter(t => targetTokens.has(t));
  const styleOverlap = canonical.header_tokens.length ? common.length / canonical.header_tokens.length : 0;
  if (canonical.header_tokens.length >= 4 && styleOverlap < 0.35) {
    findings.push({ severity: "M", category: "header_footer", type: "low_header_style_token_overlap", url: target.url, overlap: Number(styleOverlap.toFixed(2)) });
  }

  for (const link of [...target.header_links, ...target.footer_links]) {
    const host = String(link.host || "").toLowerCase();
    if (!host || allowed.has(host)) continue;
    if (forbidden.has(host) && host !== String(targetHost).toLowerCase()) {
      findings.push({ severity: "H", category: "links", type: "forbidden_domain_leak", text: link.text, href: link.absolute, expected_host: targetHost, actual_host: link.host, url: target.url });
    } else {
      findings.push({ severity: "M", category: "links", type: "unexpected_external_header_footer_link", text: link.text, href: link.absolute, expected_host: targetHost, actual_host: link.host, url: target.url });
    }
  }

  const loc = localePrefix(new URL(target.url).pathname);
  if (loc) {
    for (const link of [...target.header_links, ...target.footer_links]) {
      let u = null;
      try { u = new URL(link.absolute); } catch { continue; }
      if (u.host !== targetHost) continue;
      if (u.pathname === "/" || /^\/[a-z]{2}(?:\/|$)/i.test(u.pathname) || /^\/(api|assets|static|favicon|robots)/i.test(u.pathname)) continue;
      findings.push({ severity: "M", category: "i18n", type: "locale_prefix_missing", locale: loc, text: link.text, href: link.absolute, url: target.url });
    }
    for (const link of target.legal_links) {
      let u = null;
      try { u = new URL(link.absolute); } catch { continue; }
      if (u.host === targetHost && u.pathname !== "/" && !u.pathname.toLowerCase().startsWith(loc + "/") && normalizePathname(u.pathname) !== loc) {
        findings.push({ severity: "H", category: "legal", type: "legal_locale_prefix_missing", locale: loc, text: link.text, href: link.absolute, url: target.url });
      }
    }
  }

  const canonicalLegalLabels = unique(canonical.legal_links.map(l => l.text).filter(t => t && t.length > 1));
  const targetLegalLabels = unique(target.legal_links.map(l => l.text).filter(t => t && t.length > 1));
  for (const label of canonicalLegalLabels) {
    if (!targetLegalLabels.some(t => normalizeLabel(t) === normalizeLabel(label))) {
      findings.push({ severity: "M", category: "legal", type: "missing_footer_legal_label", label, url: target.url });
    }
  }

  const expectedLocale = localePrefix(new URL(target.url).pathname).replace("/", "");
  if (expectedLocale && target.html_lang && !target.html_lang.startsWith(expectedLocale)) {
    findings.push({ severity: "H", category: "i18n", type: "html_lang_locale_mismatch", url: target.url, expected_lang: expectedLocale, actual_lang: target.html_lang });
  }

  if (opts.requireViewport && !target.viewport_meta) findings.push({ severity: "M", category: "mobile", type: "viewport_meta_missing", url: target.url });
  if (canonical.logo_images.length && !target.logo_images.length) findings.push({ severity: "H", category: "brand", type: "logo_missing", url: target.url });
  if ((opts.requireDarkLogo || canonical.dark_logo_assets.length) && !target.dark_logo_assets.length) findings.push({ severity: "M", category: "brand", type: "dark_logo_missing", url: target.url });
  if (!target.footer_present) findings.push({ severity: "M", category: "header_footer", type: "footer_missing", url: target.url });
  if (!target.header_present) findings.push({ severity: "H", category: "header_footer", type: "header_missing", url: target.url });
  return {
    style_overlap: Number(styleOverlap.toFixed(2)),
    missing_labels: missingLabels,
    canonical_host: canonicalHost,
    target_host: targetHost,
    target_logo_count: target.logo_images.length,
    target_dark_logo_count: target.dark_logo_assets.length,
    viewport_meta: target.viewport_meta,
    html_lang: target.html_lang,
    findings
  };
}

function linkMapByLabel(links) {
  const map = new Map();
  for (const link of links || []) {
    const label = normalizeLabel(link.text);
    if (!label || map.has(label)) continue;
    map.set(label, link);
  }
  return map;
}

(async () => {
  await loadProjectContract();
  if (!args.canonical || !args.targets.length) usage(1);
  const canonicalBase = normalizeBase(args.canonical);
  const targetBases = args.targets.map(normalizeBase);
  const pages = [];
  const findings = [];
  const canonicalByPath = new Map();

  for (const p of args.paths) {
    const url = joinUrl(canonicalBase, p);
    const page = analyzePage(await fetchPage(url));
    canonicalByPath.set(p, page);
    pages.push({ role: "canonical", path: p, analysis: page });
    if (!page.ok) findings.push({ severity: "H", category: "links", type: "canonical_fetch_failed", url, status: page.status });
  }

  const comparisons = [];
  for (const targetBase of targetBases) {
    for (const p of args.paths) {
      const url = joinUrl(targetBase, p);
      const page = analyzePage(await fetchPage(url));
      pages.push({ role: "target", path: p, analysis: page });
      if (!page.ok) findings.push({ severity: "H", category: "links", type: "target_fetch_failed", url, status: page.status });
      const canonical = canonicalByPath.get(p) || canonicalByPath.get("/") || Array.from(canonicalByPath.values())[0];
      const cmp = compare(canonical, page, args);
      comparisons.push({
        target: url,
        canonical: canonical.url,
        canonical_host: cmp.canonical_host,
        target_host: cmp.target_host,
        style_overlap: cmp.style_overlap,
        missing_labels: cmp.missing_labels,
        target_logo_count: cmp.target_logo_count,
        target_dark_logo_count: cmp.target_dark_logo_count,
        viewport_meta: cmp.viewport_meta,
        html_lang: cmp.html_lang
      });
      findings.push(...cmp.findings);
    }
  }

  const result = {
    status: findings.some(f => f.severity === "H") ? "fail" : (findings.length ? "warn" : "pass"),
    canonical: canonicalBase,
    targets: targetBases,
    paths: args.paths,
    summary: {
      pages_checked: pages.length,
      comparisons: comparisons.length,
      findings: findings.length,
      high: findings.filter(f => f.severity === "H").length,
      medium: findings.filter(f => f.severity === "M").length
    },
    finding_counts: {
      by_type: countBy(findings, "type"),
      by_category: countBy(findings, "category"),
      by_severity: countBy(findings, "severity")
    },
    comparisons,
    findings
  };
  if (args.report && args.project) {
    try {
      result.mnemo_report = await callMnemoTool("mem_site_golden_check_report", {
        project: args.project,
        agent_name: process.env.MNEMO_AGENT || process.env.MNEMO_DEFAULT_AGENT || "site-contract-audit",
        status: result.status,
        command: process.argv.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(" "),
        summary: `${result.summary.pages_checked} pages checked, ${result.summary.findings} findings, ${result.summary.high} high`,
        evidence: { comparisons: result.comparisons, summary: result.summary },
        findings: result.findings,
        create_findings: true
      });
    } catch (e) {
      result.mnemo_report_error = e.message;
    }
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "fail" ? 2 : 0);
})().catch(e => {
  console.error(JSON.stringify({ status: "error", error: e.message }, null, 2));
  process.exit(1);
});

function countBy(items, key) {
  const out = {};
  for (const item of items || []) {
    const value = item && item[key] ? String(item[key]) : "unknown";
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}
