<h1 align="center">Mnemo</h1>

<p align="center">
  <strong>Persistent memory, identity, and coordination for AI agent teams.</strong>
</p>

[![CI](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml/badge.svg)](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1a1a1a?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-1a1a1a?style=flat-square)](.nvmrc)
[![Status](https://img.shields.io/badge/status-alpha-22D3EE?style=flat-square)](./ROADMAP.md)
[![Powered by BLUN](https://img.shields.io/badge/Powered%20by-BLUN-00c9ff?style=flat-square)](https://blun.ai)


Mnemo gives agents a durable operating layer: searchable memory, identity,
briefs, work claims, project rules, quality findings, and autonomous loop
discipline in one local-first SQLite system.

It is built for the practical problem every long-running agent setup hits:
sessions end, context gets compacted, multiple agents duplicate work, and nobody
can prove what changed, who did it, or which project gates are still open.

## What Mnemo Does

- Stores conversations, actions, decisions, corrections, handoffs, and source
  receipts in SQLite.
- Exposes memory and coordination through MCP, HTTP, CLI tools, and a lightweight
  frontdoor endpoint.
- Keeps agent identity, owner preferences, project rules, and team roles as data
  instead of prompt text.
- Coordinates multiple agents with briefs, departments, work claims, file
  ownership, readiness boards, and stale-work recovery.
- Enforces safer work loops with pre-work, regression, site-contract,
  completion, and token-efficiency guards.
- Captures messages and actions from channels, local sessions, PM2 logs, and
  historical exports through an idempotent universal capture pipeline.
- Keeps public installs generic: private facts, companies, servers, prices,
  channels, customers, and personas live in ignored local files or private packs.

## New In The Current Public Core

- **Universal Capture Frontdoor.** `mem_capture_ingest` and
  `mem_capture_ingest_batch` write raw receipts, duplicate receipts, optional
  transcript rows, and optional semantic memory rows through one idempotent API.
- **Backfill Importer.** `mnemo-backfill-universal` replays Telegram exports,
  local CLI session logs, local agent session roots, and PM2 logs. It defaults to
  dry-run, supports batching, skips malformed exports with warnings, and keeps
  dedup receipts.
- **Capture Receipts.** `capture_receipt` records source, source reference,
  content hash, first/last seen timestamps, seen count, status, and metadata.
- **Reminder Memory.** `mem_reminder_capture`, `mem_reminder_add`, and
  `mem_reminder_due` turn future-dated owner requests into durable reminders
  instead of loose chat memories.
- **Runtime Health.** `mem_runtime_health` shows each agent's loop version,
  Mnemo commit, dirty state, heartbeat age, pending briefs, due reminders, and
  recent errors. Broken registry rows are counted separately so dashboards do
  not treat stale path values as real offline agents.
- **Autonomous Agent Loop.** `mnemo-agent-loop` polls briefs, runs initiative
  cycles when idle, claims safe work, respects auth cooldowns, and writes
  handoffs instead of silently stopping.
- **Runtime Hook.** `mnemo-firm-hook` can enforce session start, project/task
  preflight, file claims, clean work, token discipline, site contracts, tool
  observation capture, queued-write replay, session summaries, and completion
  handoffs. `mnemo-hook-doctor` checks local hook wiring and hub health.
- **Hub Operations Hardening.** Blocked autonomy-review briefs now carry a
  concrete blocker reason and batch position, autonomy task updates can resolve
  linked brief IDs, recall has a fuzzy fallback when exact search misses, and
  hook queue output is rotated into ASCII-safe JSONL.
- **Brief Coordination Hardening.** Dispatched briefs assigned to offline or
  non-heartbeating agents are auto-requeued after a configurable timeout,
  channel lists expose active/offline subscriber heartbeat state, and autonomy
  task updates can resolve linked brief IDs through meta, content, source, and
  reverse-link records.
- **Canonical Access Routes.** `mem_access_preflight` and
  `mem_access_route_resolve` make agents resolve SSH/API/admin/database routes
  before access. Jump/proxy routes can set `direct_allowed=false`, returning the
  required canonical command instead of letting agents try direct access first.
- **Agent Company Organization.** `mem_resource_upsert`,
  `mem_resource_acl_grant`, `mem_approval_request`, and
  `mem_claim_request_access` add owned resources, ACLs, approval queues,
  claim-access grants/transfers, and audit logs. `mem_agent_preflight` now blocks
  write/deploy work on managed resources unless the agent is owner, has ACL, or
  has approval.
- **External Runtime Governance.** OpenClaw-like gateways can register runtime
  bindings, channel/tool capabilities, and per-tool receipts through
  `mem_runtime_binding_upsert`, `mem_runtime_capability_upsert`, and
  `mem_runtime_tool_receipt_start/finish`. Mnemo remains the source of truth for
  identity, preflight, claims, approvals, and evidence.
- **Memory Consolidation And REM.** OpenClaw-style daily/REM memory is now
  represented inside Mnemo with `mem_memory_layer_status`,
  `mem_memory_rem_plan/run`, `mem_department_journal_add`,
  `mem_agent_sleep_note_add`, `mem_memory_promotion_propose/decide`, and
  `mem_company_rem_brief`. REM produces reviewable proposals; it does not
  silently rewrite company truth.
- **Work Orders And Capability Tokens.** Risky work is no longer just a prompt
  instruction. `mem_work_order_create` defines the assignment and
  `mem_capability_token_check` deterministically gates write/exec/deploy/auth/
  billing/external-send actions by agent, scope, tools, expiry, approvals, and
  evidence requirements. `mem_work_order_create_from_template`,
  `mem_quality_gate_run`, and `mem_context_snapshot_create` add agent-neutral
  workflow contracts so Claude, GPT/Codex, OpenClaw, CodexLink, and other
  runtimes all follow the same Mnemo gates even though their local prompts and
  tool names differ.
- **Protected Scope Gates.** `mem_protected_scope_check` protects auth, billing,
  production infra, final artifacts, shared portal design, translations, chat
  runtime, and Mnemo coordination surfaces. Owner approval and active claims are
  enforced before write/deploy actions.
- **Memory Frontdoor.** Hub deployments can expose `POST /mnemo/memory-tool`
  for file-like memory reads such as `/memories/top.md`, `/memories/today.md`,
  and project registry views, while keeping private facts outside the public
  repo.
- **Smart Code Read.** `mem_code_outline` and `mem_code_unfold` let agents
  inspect symbols and bounded ranges before spending tokens on whole files.
- **Context Preview.** `mem_context_preview` gives agents a token-budgeted fetch
  plan before they load memory.
- **Site And Route Audits.** `mnemo-site-contract-audit` and
  `mnemo-route-matrix-audit` help verify navigation, auth, language, theme,
  header/footer, and route surfaces.
- **Public Pack Structure.** The repo ships only `packs/example-pack`; real
  preferences and project facts belong in private packs.

## Quick Start

```bash
git clone https://github.com/Maykbiletti/mnemo.git
cd mnemo/packages/core
npm install
npm run bootstrap
npm run daemon
```

The bootstrap asks for owner name, scope name, agent names, and first project
context. It creates ignored local files for facts, hook env, aliases, and local
runtime state. Nothing private has to be committed.

Wire the MCP server into an MCP-aware agent client:

```bash
node /path/to/mnemo/packages/core/mcp.js
```

Start a session:

```text
mem_session_start({agent_name:"agent-a", project:"example-project", task:"first run"})
mem_context_preview({agent_name:"agent-a", project:"example-project", task:"first run", token_budget:1200})
mem_session_brief({agent_name:"agent-a", project:"example-project", token_budget:250})
mem_recall("what did we decide about migrations")
mem_promise_open()
```

## Hub HTTP Frontdoors

Mnemo can run as a central hub behind a reverse proxy. The recommended public
shape is:

- `POST /mnemo/tool/<tool_name>` for structured MCP-style HTTP tools.
- `POST /mnemo/memory-tool` for file-like memory reads and listings.
- `GET /mnemo/health` for daemon health checks used by hook doctors.

Useful memory paths include:

- `/memories/top.md`
- `/memories/today.md`
- `/memories/inbox.md`
- `/memories/projects/<project>/registry.md`
- `/memories/projects/<project>/live-check.md`
- `/memories/projects/<project>/rules.md`
- `/memories/projects/<project>/findings.md`

Example:

```bash
curl -s https://your-mnemo.example/mnemo/memory-tool \
  -H 'content-type: application/json' \
  -d '{"command":"view","path":"/memories/top.md","agent":"agent-a","project":"example-project"}'
```

See [`docs/hub-operations.md`](docs/hub-operations.md).

## Agent Company Controls

Mnemo's hard organization layer models work like a company:

- `org_resource`: canonical files, routes, domains, systems, services, and
  project surfaces with owners and departments.
- `resource_acl`: explicit read/write/execute/deploy/approve/own grants.
- `approval_request`: owner-routed approval inbox.
- `resource_audit_log`: durable record of access changes, decisions, claim
  grants, and transfers.
- `protected_scope_rule`: high-risk or shared surfaces that require owner/claim
  gates before edits.
- `runtime_binding`, `runtime_capability`, and `runtime_tool_receipt`: external
  runtime/session/channel mappings plus toolrun receipts that link preflight,
  claims, approvals, and evidence.
- `department_journal`, `agent_sleep_note`, `memory_consolidation_run`, and
  `memory_promotion_proposal`: REM memory layers for department diaries,
  personal agent sleep notes, draft consolidation, and explicit promotion
  review.
- `work_order`, `capability_token`, `capability_token_audit`,
  `department_charter`, `intent_route`, and `autonomy_score_snapshot`: company
  operations contracts, temporary execution rights, deterministic token audits,
  department rules, intent routing, and fact-based autonomy scoring.

See [`docs/memory-consolidation.md`](docs/memory-consolidation.md) for the
Company Ledger / Department Journal / Agent Sleep Notes model.
See [`docs/work-orders-capability-tokens.md`](docs/work-orders-capability-tokens.md)
for the Work Order / Capability Token gate.
See [`docs/agent-neutral-workflows.md`](docs/agent-neutral-workflows.md) for
template-based Work Orders, quality gates, context snapshots, and the runtime
adapter contract.

Useful calls:

```text
mem_resource_upsert({project:"account", resource_kind:"file", resource_key:"packages/account/auth.js", owner_agent:"alfred"})
mem_resource_acl_grant({project:"account", resource_kind:"file", resource_key:"packages/account/auth.js", agent_name:"otto", permission:"write", granted_by:"alfred", reason:"handoff"})
mem_approval_request({project:"account", resource_kind:"route", resource_key:"/auth/google/callback", requester_agent:"otto", permission:"write", reason:"chat login crossover"})
mem_claim_request_access({claim_id:17, requester_agent:"alfred", reason:"auth crossover repair"})
mem_runtime_tool_receipt_start({runtime_name:"openclaw", agent_name:"alfred", project:"chat", task:"check settings popup", tool_name:"browser.click", urls:["https://chat.example"]})
mem_resource_audit_list({project:"account"})
```

See [`docs/agent-company-organization.md`](docs/agent-company-organization.md),
[`docs/protected-scope-gates.md`](docs/protected-scope-gates.md), and
[`docs/external-runtime-governance.md`](docs/external-runtime-governance.md).

## Start An Agent Loop

After PM2 is installed, an agent can start or repair its own worker loop:

```bash
cd /path/to/mnemo/packages/core
npm run agent-loop:start -- agent-a /path/to/workspace --engine agent
```

The helper starts `agent-loop-agent-a`, saves PM2 state, and enables the
pre-work, completion, regression, site-contract, token-efficiency, and smart
code-read guards by default.

For a print-mode external CLI, use `--engine print-cli` and set
`EXTERNAL_AGENT_BIN` to the binary name. The public core does not require a
specific runtime.

## Universal Capture

Use the capture frontdoor for every bridge, bot, console, webhook, loop, and
historical import:

```bash
mnemo-backfill-universal --source auto --dry-run
mnemo-backfill-universal --source telegram --path "./ChatExport/result.json" --commit --batch-size 100
mnemo-backfill-universal --source agent --path "$HOME/.agent-sessions" --commit
mnemo-backfill-universal --source local-agent --agent-root "/path/to/agent-root" --commit
```

Rules:

- Every source gets a stable `conversation_id`.
- Every message/action gets a stable `source_ref`.
- Burst messages must not be dropped.
- Duplicate-looking messages still leave a duplicate receipt.
- Attachments should be indexed with `meta.media_path` when a local file exists.
- Future requests like "remind me tomorrow" must become `reminder` rows through
  `mem_reminder_capture`; ambiguous dates are kept as `status=needs_due_at`.
- Bad export files are reported and skipped, not allowed to stop the whole run.

See [`docs/universal-capture.md`](docs/universal-capture.md).

## Firm-OS Layer

Mnemo can run a small agent organization, not just a memory database:

- **Project registry:** domains, repos, services, admin routes, auth, checkout,
  VAT, languages, deployment state, and readiness gates.
- **Departments:** review, frontend, backend, billing, QA, deploy-ops,
  content/legal, or your own lanes.
- **Brief inboxes:** one agent or team fanout with status and handoff records.
- **Work claims:** TTL locks on files/modules before edits.
- **Quality findings:** owner-visible bugs, regressions, and missing gates.
- **Readiness board:** project state that turns gaps into autonomy tasks.
- **Loop doctor:** heartbeats, blocked workers, stale actions, auth failures,
  and stale briefs.
- **Completion guard:** no "done" without dependency checks, tests/smokes, and
  remaining-work status.

Read [`AGENTS.md`](AGENTS.md) before using Mnemo inside an local runtime.

## Public Release Hygiene

This repository is intentionally neutral.

Committed files must not contain:

- real company/customer facts
- private chat IDs or phone numbers
- server IPs, SSH commands, tokens, credentials, or key paths
- pricing, legal, billing, or VAT facts for a real business
- private personas, family data, internal project names, or support channels
- copied provenance notes from another project

Use these local/private locations instead:

- `.env.local`
- `.mnemo-hook.env`
- `.mnemo-project-aliases.json`
- `packages/core/facts/<scope>.json`
- `packages/core/facts/<scope>-project-rules.json`
- `packs/<name>-personal-pack/`
- your password manager or vault, referenced by `secret_ref`

The repo includes `packages/core/facts/example.json` and
`packs/example-pack/` as templates only.

## Packages

| package | purpose |
|---|---|
| `@mnemo/core` | daemon, MCP server, schema, hooks, agent loop, capture, backfill, skills, audits |
| `@mnemo/client` | zero-dependency Node client for tenant-aware ingest and recall |
| `packages/connect` | distributed agent and machine connection helpers |
| `mnemo-pc` | Go-based desktop helper for paired machines |
| `packs/example-pack` | public template for private packs |

## Docs

- [`AGENTS.md`](AGENTS.md) - operating guide for agents
- [`docs/architecture.md`](docs/architecture.md) - system architecture
- [`docs/deployment.md`](docs/deployment.md) - server, PM2, env, proxy
- [`docs/hub-operations.md`](docs/hub-operations.md) - hub routes, memory frontdoor, ops hardening
- [`docs/agent-operating-dna.md`](docs/agent-operating-dna.md) - where agents read and store operational truth
- [`docs/external-runtime-governance.md`](docs/external-runtime-governance.md) - OpenClaw-style runtime bindings and tool receipts
- [`docs/runtime-guard-integration.md`](docs/runtime-guard-integration.md) - mandatory adapter-side guard contract for CodexLink/OpenClaw/Claude tool execution
- [`docs/mcp-tools.md`](docs/mcp-tools.md) - tool surface
- [`docs/universal-capture.md`](docs/universal-capture.md) - capture and backfill
- [`docs/public-release-hygiene.md`](docs/public-release-hygiene.md) - keeping private data out of the public repo
- [`docs/UPDATE-AGENT.md`](docs/UPDATE-AGENT.md) - updating local installs
- [`examples/agent-runtime-config.md`](examples/agent-runtime-config.md) - hook wiring

## Security

Mnemo is local-first and stores private memory in plaintext SQLite by default.
Protect `mnemo.db` like a private key. Do not expose the HTTP daemon directly to
the internet without authentication at the proxy layer. Store secrets in a vault
and put only `secret_ref` labels in Mnemo.

See [`SECURITY.md`](SECURITY.md).

## Status

Alpha. The core memory, MCP, daemon, agent loop, runtime hook, universal capture,
backfill, and public pack structure are usable today. APIs may still change.

## License

MIT. See [`LICENSE`](LICENSE).


## Mission Control

Mnemo ships a web-based operator panel. Features: live agent status, brief CRUD, task board, signature registry, 10s auto-refresh.

## Channels and Gateways

email_gateway (IMAP+SMTP), multi_gateway (fan-out), mnemo_remote_mcp (HTTP MCP for remote sessions). Managed by ecosystem.config.js.

## Skill Runtime

skills/ directory: nl_cron, approval_queue, subagent_pool, skill_runner, skills_watcher, live_check_sweep, agent_auto_resume, execute_code, trajectory_export.

---

<p align="center">
  <strong>Get it done. With <a href="https://blun.ai">BLUN</a>.</strong><br>
  Powered by <a href="https://blun.ai">BLUN</a> - Built with Mnemo
</p>
