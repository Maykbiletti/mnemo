# Firm-OS QA Extension — Autonomous Cross-Project Quality Guard

**Brief**: #1973 (Follow-up zu #1969)
**Author**: alfred
**Date**: 2026-05-08
**Status**: Implemented (Phase 1), ready for review

---

## Problem

Mayk wants an autonomous agent firm that crawls all BLUN projects, detects errors against canonical rules, and repairs them — without waiting for manual page checks. The existing Mnemo data model (project_rules, quality_finding, autonomy_task, departments) provides the **governance layer** but lacked the **execution layer**: no crawler, no drift detection, no crawl scheduling.

## What Was Built

### 1. New Database Tables (mcp.js)

| Table | Purpose |
|-------|---------|
| `crawl_run` | Tracks each crawl execution (project, agent, kind, pass/fail counts, timestamps) |
| `crawl_check` | Individual check results within a run (category, URL, check_name, status, expected vs actual) |
| `drift_incident` | Detected deviations from canonical rules (links to finding + brief + autonomy_task) |
| `crawl_schedule` | Per-project crawl schedules with cron expressions |

### 2. New MCP Tools (11 tools)

| Tool | Purpose |
|------|---------|
| `mem_crawl_run_start` | Begin a new crawl run |
| `mem_crawl_check_log` | Log check results (batch), auto-creates quality_finding on fail |
| `mem_crawl_run_finish` | Finish run, compute totals, update schedule |
| `mem_crawl_run_list` | List recent crawl runs |
| `mem_crawl_checks_list` | Query individual check results |
| `mem_drift_detect` | Compare actuals against canonical rules, create drift_incidents |
| `mem_drift_list` | List open/resolved drift incidents |
| `mem_drift_resolve` | Close a drift incident after fix |
| `mem_crawl_schedule_set` | Create/update crawl schedule |
| `mem_crawl_schedule_list` | List all schedules |
| `mem_qa_dashboard` | Aggregate QA health: findings, drifts, crawls, blocked gates, repair tasks |

### 3. Site Crawler Skill (skills/site_crawler.js)

HTTP-based crawler that checks 7 categories per project:

- **nav** — Canonical nav links exist and resolve (no 404, no wrong domain)
- **links** — All hrefs on homepage resolve (dead link check, capped at 50)
- **header_footer** — No foreign product chrome leaks into product pages
- **auth** — Login/register/forgot pages exist and respond
- **language** — All required language versions accessible
- **pricing** — Pricing page exists, expected plan names visible
- **legal** — At least one legal page (impressum/privacy/terms) exists

Usage:
```bash
node packages/core/skills/site_crawler.js --project "BLUN Listings"
node packages/core/skills/site_crawler.js --all
node packages/core/skills/site_crawler.js --schedule
```

## How the 10 Requirements Map

| # | Requirement | Solution |
|---|-------------|----------|
| 1 | Cross-Project QA | `site_crawler.js --all` + `crawl_schedule` + `mem_qa_dashboard` |
| 2 | Header/Footer/Menu Guard | `checkHeaderFooter()` checks for foreign nav leakage |
| 3 | Auth Crossover | `checkAuth()` validates required auth pages per project |
| 4 | Link Graph | `checkLinks()` crawls homepage hrefs, checks allowed domains |
| 5 | Language Parity | `checkLanguage()` tests language_matrix.minimum_public |
| 6 | Pricing/VAT/Checkout Guard | `checkPricing()` validates visible plans; VAT/checkout via project_rules gates |
| 7 | Deploy/Live Readiness | `mem_firm_readiness_board` + `mem_project_live_check` (existing) + `mem_qa_dashboard` |
| 8 | Autonomous Repair Loop | crawl fail -> quality_finding -> `mem_autonomy_sweep` -> department task -> agent claims -> fixes -> handoff |
| 9 | Drift Detection | `mem_drift_detect` compares crawl results against canonical rules, creates incidents + briefs |
| 10 | Duplicate Work Guard | `mem_work_claim` + `mem_agent_preflight` (existing) |

## Autonomous Repair Loop Flow

```
crawl_schedule (cron)
  -> site_crawler.js --schedule
    -> crawl each project
      -> log checks (mem_crawl_check_log)
        -> auto-create quality_finding on fail
      -> finish run (mem_crawl_run_finish)
      -> drift detection (mem_drift_detect)
        -> create drift_incident
        -> auto-brief QA department lead
      -> autonomy_sweep
        -> create department-owned tasks from open findings
        -> agents claim tasks (mem_autonomy_next)
        -> fix + test + deploy or escalate
        -> handoff (mem_session_handoff)
```

## Next Steps (Phase 2)

1. **Playwright deep checks**: Add actual browser rendering for mobile viewport, JS-rendered pages, visual regression
2. **Checkout flow smoke**: Playwright-based checkout flow testing (Stripe test mode)
3. **Auth SSO crossover test**: Automated login on one domain, verify session on another
4. **Pricing/Stripe cross-verify**: Compare pricing page against Stripe product catalog API
5. **Cron integration**: Wire `crawl_schedule` into daemon.js daily cycle (currently manual `--schedule`)
6. **Dashboard UI**: Mission Control view for `mem_qa_dashboard` data
7. **Auto-repair for common patterns**: Dead links -> redirect rules, missing legal pages -> template generation

## Risk Assessment

- **Low risk**: All new tables use IF NOT EXISTS, all tools are additive, no schema migrations needed
- **Crawler is read-only**: Only fetches pages, doesn't modify anything
- **Auto-finding dedup**: Uses INSERT OR IGNORE to prevent duplicate findings
- **Drift dedup**: UNIQUE constraint on (project, category, rule_key, status)
