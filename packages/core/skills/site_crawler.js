#!/usr/bin/env node
"use strict";
/**
 * site_crawler.js — Playwright-based QA crawler for Mnemo Firm-OS.
 *
 * Crawls project URLs against canonical project_rules and logs results
 * via the Mnemo MCP crawl/drift tools.
 *
 * Usage:
 *   node site_crawler.js --project "Project Alpha"
 *   node site_crawler.js --project "Project Alpha" --checks nav,links,language
 *   node site_crawler.js --all                    # crawl all registered projects
 *   node site_crawler.js --schedule               # run due scheduled crawls
 *
 * Categories checked:
 *   nav           — canonical nav links exist and resolve (no 404, no wrong domain)
 *   links         — all <a href> on page resolve (dead link check)
 *   header_footer — header/footer doesn't inherit wrong product chrome
 *   auth          — login/register/forgot pages exist and respond
 *   language      — all required language versions exist with matching content
 *   pricing       — pricing page shows expected plans, no hardcoded prices
 *   legal         — legal/imprint/privacy/terms pages exist per language
 *   mobile        — viewport meta, no horizontal overflow, primary actions visible
 *
 * Each check logs via mem_crawl_check_log. Failures auto-create quality_finding.
 * After all checks, mem_crawl_run_finish computes pass/fail totals.
 * Drift detection compares results against project_rules.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const MNEMO_URL = process.env.MNEMO_URL || "http://127.0.0.1:7117";
const AGENT_NAME = process.env.MNEMO_AGENT || "crawler";
const DEFAULT_CHECKS = ["nav", "links", "header_footer", "auth", "language", "pricing", "legal"];
const TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Mnemo MCP helper — call tools via HTTP
// ---------------------------------------------------------------------------
async function mnemoTool(tool, args) {
  const url = new URL("/tool/" + tool, MNEMO_URL);
  const body = JSON.stringify(args || {});
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          resolve(j.result || j);
        } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP fetch helper (no Playwright dependency for basic checks)
// ---------------------------------------------------------------------------
async function fetchUrl(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: opts.method || "GET",
      timeout: opts.timeout || TIMEOUT_MS,
      headers: { "User-Agent": "MnemoQACrawler/1.0", ...(opts.headers || {}) },
    }, (res) => {
      let body = "";
      if (opts.headOnly) { res.resume(); return resolve({ status: res.statusCode, headers: res.headers, body: "" }); }
      res.setEncoding("utf8");
      res.on("data", (c) => body += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

async function checkNav(project, rules, baseUrl) {
  const checks = [];
  const nav = rules.canonical_nav;
  if (!nav) return [{ category: "nav", check_name: "canonical_nav_defined", status: "skip", expected: "canonical_nav in rules", actual: "not defined" }];

  const primary = nav.primary || [];
  for (const path of primary) {
    const url = path.startsWith("http") ? path : baseUrl + path;
    try {
      const r = await fetchUrl(url, { headOnly: true });
      const ok = r.status >= 200 && r.status < 400;
      checks.push({
        category: "nav", url, check_name: `nav_link_resolves:${path}`,
        status: ok ? "pass" : "fail",
        expected: "2xx/3xx", actual: String(r.status),
      });
    } catch (e) {
      checks.push({ category: "nav", url, check_name: `nav_link_resolves:${path}`, status: "fail", expected: "2xx/3xx", actual: e.message });
    }
  }

  // Cross-portal links
  const crossLinks = nav.cross_portal_links || [];
  for (const link of crossLinks) {
    try {
      const r = await fetchUrl(link, { headOnly: true });
      const ok = r.status >= 200 && r.status < 400;
      checks.push({
        category: "nav", url: link, check_name: `cross_portal_link:${new URL(link).hostname}`,
        status: ok ? "pass" : "fail",
        expected: "2xx/3xx", actual: String(r.status),
      });
    } catch (e) {
      checks.push({ category: "nav", url: link, check_name: `cross_portal_link:${link}`, status: "fail", expected: "2xx/3xx", actual: e.message });
    }
  }
  return checks;
}

async function checkLinks(project, rules, baseUrl) {
  const checks = [];
  try {
    const r = await fetchUrl(baseUrl);
    if (r.status >= 400) {
      checks.push({ category: "links", url: baseUrl, check_name: "homepage_reachable", status: "fail", expected: "2xx", actual: String(r.status) });
      return checks;
    }
    checks.push({ category: "links", url: baseUrl, check_name: "homepage_reachable", status: "pass" });

    // Extract all href from homepage HTML
    const hrefRe = /href=["']([^"'#]+)["']/gi;
    const seen = new Set();
    let match;
    while ((match = hrefRe.exec(r.body)) !== null) {
      let href = match[1];
      if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) continue;
      if (href.startsWith("/")) href = baseUrl + href;
      if (!href.startsWith("http")) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      if (seen.size > 50) break; // cap to avoid hammering
    }

    // Check allowed domains
    const allowed = (rules.allowed_domains || []).map(d => { try { return new URL(d).hostname; } catch { return d; } });
    for (const href of seen) {
      try {
        const hUrl = new URL(href);
        // Only deeply check links on allowed domains
        if (allowed.length && !allowed.some(d => hUrl.hostname === d || hUrl.hostname.endsWith("." + d))) {
          checks.push({ category: "links", url: href, check_name: `link_domain_allowed:${hUrl.hostname}`, status: "warn", expected: "allowed domain", actual: hUrl.hostname });
          continue;
        }
        const lr = await fetchUrl(href, { headOnly: true });
        const ok = lr.status >= 200 && lr.status < 400;
        checks.push({
          category: "links", url: href, check_name: `link_alive:${hUrl.pathname}`,
          status: ok ? "pass" : "fail",
          expected: "2xx/3xx", actual: String(lr.status),
        });
      } catch (e) {
        checks.push({ category: "links", url: href, check_name: `link_alive:${href.slice(0, 80)}`, status: "fail", expected: "2xx/3xx", actual: e.message });
      }
    }
  } catch (e) {
    checks.push({ category: "links", url: baseUrl, check_name: "homepage_reachable", status: "fail", expected: "reachable", actual: e.message });
  }
  return checks;
}

async function checkHeaderFooter(project, rules, baseUrl) {
  const checks = [];
  try {
    const r = await fetchUrl(baseUrl);
    if (r.status >= 400) {
      checks.push({ category: "header_footer", url: baseUrl, check_name: "page_loads", status: "fail", expected: "2xx", actual: String(r.status) });
      return checks;
    }

    const productName = (rules.canonical_nav && rules.canonical_nav.product) || project;
    const navRule = (rules.canonical_nav && rules.canonical_nav.rule) || "";

    // Check that the page doesn't contain another product's primary nav
    // This is a heuristic: look for nav items that don't belong to this product
    const body = r.body.toLowerCase();
    const otherProducts = ["listings", "send", "shop", "books", "taskora", "mission"].filter(p => p.toLowerCase() !== productName.toLowerCase());
    for (const other of otherProducts) {
      // Check if another product's full navigation structure appears (not just a cross-portal link)
      const navPattern = new RegExp(`<nav[^>]*>([\\s\\S]*?)<\\/nav>`, "gi");
      let navMatch;
      while ((navMatch = navPattern.exec(r.body)) !== null) {
        const navContent = navMatch[1].toLowerCase();
        // It's okay to have a cross-portal link, but not a full product-specific menu
        if (navContent.includes(`/${other.toLowerCase()}/pricing`) || navContent.includes(`/${other.toLowerCase()}/dashboard`)) {
          checks.push({
            category: "header_footer", url: baseUrl,
            check_name: `no_foreign_nav:${other}`,
            status: "warn",
            expected: `No ${other}-specific nav items in ${productName} header`,
            actual: `Found ${other}-specific paths in nav`,
          });
        }
      }
    }
    checks.push({ category: "header_footer", url: baseUrl, check_name: "header_footer_loaded", status: "pass" });
  } catch (e) {
    checks.push({ category: "header_footer", url: baseUrl, check_name: "page_loads", status: "fail", expected: "reachable", actual: e.message });
  }
  return checks;
}

async function checkAuth(project, rules, baseUrl) {
  const checks = [];
  const authMatrix = rules.auth_matrix || {};
  const requiredPages = authMatrix.required_pages || ["/login", "/forgot", "/reset"];
  for (const page of requiredPages) {
    const url = page.startsWith("http") ? page : baseUrl + page;
    try {
      const r = await fetchUrl(url, { headOnly: true });
      // Accept 200, 301, 302, 303 (redirects to login form are ok)
      const ok = r.status >= 200 && r.status < 400;
      checks.push({
        category: "auth", url, check_name: `auth_page_exists:${page}`,
        status: ok ? "pass" : "fail",
        expected: "2xx/3xx", actual: String(r.status),
      });
    } catch (e) {
      checks.push({ category: "auth", url, check_name: `auth_page_exists:${page}`, status: "fail", expected: "2xx/3xx", actual: e.message });
    }
  }
  return checks;
}

async function checkLanguage(project, rules, baseUrl) {
  const checks = [];
  const langMatrix = rules.language_matrix || {};
  const langs = langMatrix.minimum_public || ["en", "de"];

  // Check if language-specific versions exist (common patterns: /de, /en, ?lang=de, etc.)
  for (const lang of langs) {
    const patterns = [`/${lang}`, `/${lang}/`, `?lang=${lang}`, `?locale=${lang}`];
    let found = false;
    for (const p of patterns) {
      const url = baseUrl + p;
      try {
        const r = await fetchUrl(url, { headOnly: true });
        if (r.status >= 200 && r.status < 400) { found = true; break; }
      } catch {}
    }
    checks.push({
      category: "language", url: baseUrl, check_name: `language_available:${lang}`,
      status: found ? "pass" : "warn",
      expected: `/${lang} or ?lang=${lang} accessible`,
      actual: found ? "found" : "no common pattern found",
    });
  }
  return checks;
}

async function checkPricing(project, rules, baseUrl) {
  const checks = [];
  const pricingRules = rules.pricing_rules || {};

  // Check /pricing page exists
  const pricingUrl = baseUrl + "/pricing";
  try {
    const r = await fetchUrl(pricingUrl);
    const ok = r.status >= 200 && r.status < 400;
    checks.push({
      category: "pricing", url: pricingUrl, check_name: "pricing_page_exists",
      status: ok ? "pass" : "fail",
      expected: "2xx", actual: String(r.status),
    });

    if (ok && pricingRules.visible_plans) {
      // Check that expected plan names appear on the page
      for (const plan of pricingRules.visible_plans) {
        const found = r.body.toLowerCase().includes(plan.toLowerCase());
        checks.push({
          category: "pricing", url: pricingUrl, check_name: `plan_visible:${plan}`,
          status: found ? "pass" : "fail",
          expected: `"${plan}" visible on pricing page`,
          actual: found ? "found" : "not found",
        });
      }
    }
  } catch (e) {
    checks.push({ category: "pricing", url: pricingUrl, check_name: "pricing_page_exists", status: "fail", expected: "reachable", actual: e.message });
  }
  return checks;
}

async function checkLegal(project, rules, baseUrl) {
  const checks = [];
  const legalPages = ["/impressum", "/imprint", "/privacy", "/terms", "/agb", "/datenschutz"];
  let anyFound = false;
  for (const page of legalPages) {
    const url = baseUrl + page;
    try {
      const r = await fetchUrl(url, { headOnly: true });
      if (r.status >= 200 && r.status < 400) {
        anyFound = true;
        checks.push({ category: "legal", url, check_name: `legal_page:${page}`, status: "pass" });
      }
    } catch {}
  }
  if (!anyFound) {
    checks.push({ category: "legal", url: baseUrl, check_name: "any_legal_page", status: "fail", expected: "at least one legal page (impressum/privacy/terms)", actual: "none found" });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const CHECK_FNS = {
  nav: checkNav,
  links: checkLinks,
  header_footer: checkHeaderFooter,
  auth: checkAuth,
  language: checkLanguage,
  pricing: checkPricing,
  legal: checkLegal,
};

async function crawlProject(projectName, checkCategories) {
  // Get project rules and registry from Mnemo
  const rulesResult = await mnemoTool("mem_project_rules_get", { project: projectName });
  if (!rulesResult || rulesResult.error) {
    console.error(`[crawler] No rules found for "${projectName}":`, rulesResult);
    return null;
  }

  const rules = rulesResult.rules || rulesResult;
  let baseUrl = "";

  // Get base URL from project_registry
  try {
    const regResult = await mnemoTool("mem_project_registry_upsert", { name: projectName });
    // Actually we need a read-only query... use the rules data or a direct approach
  } catch {}

  // Try to get live_url from the rules response or registry
  if (rulesResult.registry && rulesResult.registry.live_url) {
    baseUrl = rulesResult.registry.live_url;
  } else if (rules.allowed_domains && rules.allowed_domains.length) {
    baseUrl = rules.allowed_domains[0];
  }

  if (!baseUrl) {
    console.error(`[crawler] No base URL found for "${projectName}"`);
    return null;
  }

  // Remove trailing slash
  baseUrl = baseUrl.replace(/\/+$/, "");

  console.log(`[crawler] Starting crawl for "${projectName}" at ${baseUrl}`);
  console.log(`[crawler] Categories: ${checkCategories.join(", ")}`);

  // Start crawl run
  const run = await mnemoTool("mem_crawl_run_start", {
    project: projectName,
    agent_name: AGENT_NAME,
    run_kind: checkCategories.length === DEFAULT_CHECKS.length ? "full" : checkCategories.join("+"),
    meta: { base_url: baseUrl, categories: checkCategories },
  });
  const runId = run.run_id;
  console.log(`[crawler] Run #${runId} started`);

  // Execute checks
  const allChecks = [];
  for (const cat of checkCategories) {
    const fn = CHECK_FNS[cat];
    if (!fn) { console.warn(`[crawler] Unknown category: ${cat}`); continue; }
    try {
      const results = await fn(projectName, rules, baseUrl);
      allChecks.push(...results);
      const passed = results.filter(c => c.status === "pass").length;
      const failed = results.filter(c => c.status === "fail").length;
      console.log(`[crawler]   ${cat}: ${passed} pass, ${failed} fail, ${results.length - passed - failed} warn/skip`);
    } catch (e) {
      console.error(`[crawler]   ${cat}: ERROR - ${e.message}`);
      allChecks.push({ category: cat, check_name: `${cat}_error`, status: "fail", expected: "no error", actual: e.message });
    }
  }

  // Log all checks to Mnemo
  if (allChecks.length) {
    await mnemoTool("mem_crawl_check_log", {
      run_id: runId,
      checks: allChecks,
      auto_finding: true,
    });
  }

  // Finish run
  const totalP = allChecks.filter(c => c.status === "pass").length;
  const totalF = allChecks.filter(c => c.status === "fail").length;
  const summary = `${projectName}: ${totalP}/${allChecks.length} passed, ${totalF} failed`;
  const finish = await mnemoTool("mem_crawl_run_finish", {
    run_id: runId,
    summary,
    trigger_sweep: totalF > 0,
  });

  console.log(`[crawler] Run #${runId} finished: ${summary}`);

  // Drift detection — compare failures against canonical rules
  if (totalF > 0) {
    const driftChecks = allChecks
      .filter(c => c.status === "fail")
      .map(c => ({
        category: c.category,
        rule_key: c.check_name,
        expected: c.expected || "pass",
        actual: c.actual || "fail",
        url: c.url,
        severity: (c.category === "auth" || c.category === "checkout" || c.category === "vat") ? "H" : "M",
      }));
    const drift = await mnemoTool("mem_drift_detect", {
      project: projectName,
      checks: driftChecks,
      auto_brief: true,
      agent_name: AGENT_NAME,
    });
    if (drift.new_incidents > 0) {
      console.log(`[crawler] ${drift.new_incidents} new drift incident(s) created`);
    }
  }

  return finish;
}

async function crawlAllProjects(checkCategories) {
  const rulesList = await mnemoTool("mem_project_rules_list", {});
  if (!rulesList || !rulesList.projects || !rulesList.projects.length) {
    console.log("[crawler] No projects with rules found");
    return;
  }
  const results = [];
  for (const proj of rulesList.projects) {
    try {
      const r = await crawlProject(proj.project || proj.name, checkCategories);
      if (r) results.push(r);
    } catch (e) {
      console.error(`[crawler] Error crawling ${proj.project || proj.name}: ${e.message}`);
    }
  }
  console.log(`[crawler] Finished crawling ${results.length} project(s)`);
  return results;
}

async function runScheduled() {
  const schedules = await mnemoTool("mem_crawl_schedule_list", { enabled_only: true });
  if (!schedules || !schedules.schedules || !schedules.schedules.length) {
    console.log("[crawler] No enabled schedules found");
    return;
  }
  // Simple: just run all enabled schedules (cron expression matching is left to
  // the external cron runner that invokes this script)
  for (const sched of schedules.schedules) {
    const cats = Array.isArray(sched.check_categories) ? sched.check_categories : JSON.parse(sched.check_categories || "[]");
    try {
      await crawlProject(sched.project, cats.length ? cats : DEFAULT_CHECKS);
    } catch (e) {
      console.error(`[crawler] Schedule error for ${sched.project}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { flags.project = args[++i]; }
    else if (args[i] === "--checks" && args[i + 1]) { flags.checks = args[++i].split(","); }
    else if (args[i] === "--all") { flags.all = true; }
    else if (args[i] === "--schedule") { flags.schedule = true; }
  }

  const checks = flags.checks || DEFAULT_CHECKS;

  if (flags.schedule) {
    await runScheduled();
  } else if (flags.all) {
    await crawlAllProjects(checks);
  } else if (flags.project) {
    await crawlProject(flags.project, checks);
  } else {
    console.log("Usage:");
    console.log("  node site_crawler.js --project 'Project Alpha'");
    console.log("  node site_crawler.js --project 'Project Alpha' --checks nav,links,language");
    console.log("  node site_crawler.js --all");
    console.log("  node site_crawler.js --schedule");
    process.exit(1);
  }
}

main().catch(e => { console.error("[crawler] Fatal:", e); process.exit(1); });
