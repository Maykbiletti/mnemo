# MCP Tools

Mnemo exposes the following tools via Model Context Protocol (stdio). Wire it once into any MCP-aware agent client and your agent gets persistent recall, identity awareness, and skill discovery.

## Setup

```bash
node /path/to/mnemo/packages/core/mcp.js
```

Then in your client:

```
> mem_who_am_i()
> mem_recall("what did I say about migrations")
> mem_promise_open()
```

## Tools

### `mem_recall(query, [limit, mode, since, kind, actor])`

Search across all memories. Default `mode: 'hybrid'` blends FTS5 BM25 + semantic cosine via Reciprocal Rank Fusion. Set `mode: 'fts'` for exact-keyword only or `mode: 'semantic'` for vector-only.

If exact/full-text recall returns no useful rows, Mnemo runs a bounded fuzzy
fallback over recent memory, transcript, and journal text. This helps typo-heavy
queries find existing rows without requiring agents to guess exact keywords.

```ts
mem_recall({ query: "stripe webhook timeout", limit: 10 })
mem_recall({ query: "what did the owner say about pricing", since: "2026-04-01", actor: "owner" })
mem_recall({ query: "auth bug", mode: "fts", kind: "scar" })
```

### `mem_autonomy_task_update(id, status, [...])`

Update an autonomy task. The `id` can be the autonomy task ID or a linked
`agent_brief.id` when Mnemo can resolve the relationship. Resolution checks
brief meta, brief content, autonomy task `source_id`, task meta brief links,
checklist links, and memory meta/text references. If the new status is
`blocked`, the update must include a concrete blocker reason in `notes`,
`blocked_reason`, or `meta.blocked_reason`.

```ts
mem_autonomy_task_update({ id: 188, status: "blocked", notes: "blocked: missing API key reference" })
mem_autonomy_task_update({ id: 188, status: "done", evidence: [{ test_step: "smoke", result: "pass" }] })
```

### `mem_brief_requeue_stale([older_than_minutes, agent_stale_sec, dry_run])`

Requeue dispatched briefs that were pulled but never completed because the
target agent is offline, unregistered, or has not heartbeated recently. The
default threshold is 30 minutes for dispatched briefs and 5 minutes for agent
heartbeat staleness.

```ts
mem_brief_requeue_stale({ older_than_minutes: 30, dry_run: true })
mem_brief_requeue_stale({ older_than_minutes: 30 })
```

`mem_brief_pull` and `mem_connect_list` also run this sweep unless
`auto_requeue:false` is passed.

### `mem_connect_channel_list([include_subscribers, active_window_sec])`

List channels with subscriber counts plus live subscriber details. Each
subscriber row includes status, `last_seen_at`, `last_seen_age_sec`, active
boolean, pending/dispatched brief counts, and skills. This removes blind
channel fanout where a channel looks populated but no subscribed agent is
actually alive.

### `mem_project_registry_list([project, limit])`

List known project registry rows. If the structured registry is empty but
Mnemo has candidate project facts in memory, the response includes candidates
and a hint instead of silently returning an empty operational view.

### `mem_quality_finding_list([project, status, limit])`

List quality findings. If no structured findings match but related finding-like
records exist in memory, the response includes candidates and a hint so agents
do not assume "no findings" when the data is simply not normalized yet.

### `mem_who_am_i()`

Snapshot of current self: active core values, top traits, last daily reflection, total memory rows, date range.

### `mem_timeline(from, [to, actor, limit])`

Chronological window of memories on a date or date range.

```ts
mem_timeline({ from: "2026-04-15", to: "2026-04-22", actor: "owner" })
```

### `mem_health()`

Writer-health snapshot: which ingestion sources are alive vs stale vs dead, plus last-24h stats by source.

### `mem_add(kind, text, [source, actor, topic, importance, meta])`

Insert a memory row directly. Use sparingly — most ingestion should go through daemons (Telegram poller, HTTP /ingest, hooks).

### `mem_link(from_id, to_id, kind, [weight])`

Add a typed edge between two memory rows. Edge `kind`: `replies_to | references | corrects | resolves | partOf | causedBy | similar`.

### `mem_value_get([name])`

List or fetch core values. With no arg: all active values.

### `mem_belief_get([topic])`

List active beliefs. Optional topic filter.

### `mem_trait_get([dimension])`

List traits. Optional dimension filter (`communication | execution | memory | judgment | social`).

### `mem_duration_history(task_type | like)`

Returns historical actual durations for a given task_type. Use this **instead of guessing/projecting fantasy ETAs**. Returns count, min, max, avg, p50, p90 in minutes plus last 5 raw runs.

### `mem_task_start(task_type, description, [scope])`

Begin tracking a task run. Returns `task_run.id` to pass to `mem_task_finish` later.

### `mem_task_finish(id, outcome, [notes])`

Complete a previously-started task run. Computes `duration_min` automatically.

### `mem_reminder_capture(text, [...metadata])`

Capture a future-dated owner request from natural chat text. Common German and
English relative dates are parsed. If the date is ambiguous, Mnemo stores the
row as `status=needs_due_at` instead of dropping it.

```ts
mem_reminder_capture({ text: "erinnere mich naechste Woche an das Meeting", agent_name: "agent" })
```

### `mem_reminder_add(title, due_at, [...metadata])`

Create a reminder when the exact due time is already known.

```ts
mem_reminder_add({ title: "Call customer", due_at: "2026-05-14T09:00:00+02:00" })
```

### `mem_reminder_due([before, agent_name, owner_name])`

Return open reminders due now or before a timestamp. Loop workers should call
this during startup and heartbeat.

### `mem_reminder_list`, `mem_reminder_done`, `mem_reminder_snooze`

List unresolved reminders, mark one done, or move it to a later due time.

### `mem_runtime_health([stale_sec, include_invalid])`

Return agent operations health: loop version, Mnemo commit, dirty state,
heartbeat age, pending briefs, due reminders, recent errors, and the last
runtime preflight state reported by each loop. Invalid registry rows such as
blank names or path-shaped names are excluded from the agent totals and counted
as `summary.invalid_registry_rows`; pass `include_invalid: true` to inspect them.

### External runtime governance

Use these tools when a gateway such as OpenClaw, CodexLink, a browser runtime,
or another local agent runner executes work on behalf of a Mnemo agent.

`mem_runtime_binding_upsert/list` maps external sessions and channels to one
Mnemo agent/project/connector:

```ts
mem_runtime_binding_upsert({
  runtime_name: "openclaw",
  agent_name: "agent-a",
  project: "example-project",
  session_key: "openclaw:telegram:-1001:agent-a",
  channel: "telegram",
  connector_system: "telegram",
  capabilities: ["browser", "toolrun"]
})
```

`mem_runtime_capability_upsert/list/check` registers channel and tool
capabilities with allow/deny, agent allowlists, and preflight/receipt
requirements:

```ts
mem_runtime_capability_upsert({
  runtime_name: "openclaw",
  capability_kind: "tool",
  capability_key: "browser.click",
  allowed_agents: ["agent-a"],
  requires_preflight: true,
  requires_receipt: true
})
```

`mem_runtime_tool_receipt_start` opens a receipt before execution. It calls
`mem_agent_preflight` by default and stores the preflight action id, capability
gate, resources, claims, approvals, and whether evidence is required.

```ts
mem_runtime_tool_receipt_start({
  runtime_name: "openclaw",
  agent_name: "agent-a",
  project: "example-project",
  task: "check settings popup",
  action_type: "code_edit",
  tool_name: "browser.click",
  urls: ["https://app.example.com"],
  files: ["public/index.html"]
})
```

If the response has `allowed:false`, the runtime must not execute the tool.
Finish the same receipt after execution:

```ts
mem_runtime_tool_receipt_finish({
  receipt_id: "rt-...",
  status: "done",
  result_summary: "Popup checked and fixed",
  evidence: [{ url: "https://app.example.com", test_step: "open settings", result: "pass" }]
})
```

Write/deploy/external-communication receipts require evidence before they can
finish as `done`.

### `mem_agent_memory_health([agent_name, stale_minutes, window_minutes])`

Mission Control status for memory usage. Shows, per agent, the latest
`SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostToolUse`, `Stop`, and
`SessionEnd` hook status, whether transcript sync passed, whether prompt capture
passed, and whether prior recall ran before the response. Pair this with
`mnemo-hook-doctor` on the agent machine to check local hook wiring, queue
backlog, hub health, and queued-write replay.

```ts
mem_agent_memory_health({ stale_minutes: 1440 })
mem_agent_memory_health({ agent_name: "angel" })
```

### `mem_skill_search(query)`

Search the local `skills/` folder by trigger-phrase or name. Returns matching `SKILL.md` descriptors. **Use BEFORE attempting any new task** — if a recipe exists, follow it.

### `mem_skill_record(name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, recipe_steps, first_invocation_outcome)`

Record a newly-learned skill into `skills/`. Use **after** successfully completing a previously-unknown task.

### `mem_context_preview(agent_name, [project, task, files, topics, token_budget, max_items])`

Return a token-budgeted context plan before broad memory loading. The response
lists selected and deferred sections such as session brief, project rules, site
contract, training rules, open findings, claims, handoffs, decisions, pending
briefs, memory snippets, and smart-code-read calls. Recent handoffs/work
reports should be read from this plan before new work starts.

```ts
mem_context_preview({ agent_name: "agent", project: "Example Project", task: "fix header links", token_budget: 1800 })
```

### `mem_loop_doctor([agent_name, stale_minutes, recent_hours, include_recent])`

Diagnose autonomous agent health from Mnemo state: registry heartbeat, live
status, engine-blocked hints, pending/dispatched briefs, stale started actions,
recent failures, autonomy tasks, and last handoff. Use it when a loop looks
online but no work is moving.

```ts
mem_loop_doctor({ stale_minutes: 30, recent_hours: 24 })
mem_loop_doctor({ agent_name: "agent", include_recent: true })
```

### `mem_agent_name_migrate(from_agent, to_agent, [dry_run])`

Dry-run or apply a safe consolidation from a stale agent-name variant into the
canonical lowercase ID across briefs, actions, handoffs, claims, proposals, and
status tables. Unique identity rows are skipped if the target already exists.

```ts
mem_agent_name_migrate({ from_agent: "AgentOne", to_agent: "agentone" })
mem_agent_name_migrate({ from_agent: "AgentOne", to_agent: "agentone", dry_run: false })
```

### `mem_brief_requeue_stale([agent_name, older_than_minutes, limit, dry_run])`

Dry-run or move stale `dispatched` briefs back to `pending`. Use after
`mem_loop_doctor` reports a stale dispatched queue. The default is dry-run so
agents can inspect exactly which briefs would move.

```ts
mem_brief_requeue_stale({ agent_name: "agentone", older_than_minutes: 60 })
mem_brief_requeue_stale({ agent_name: "agentone", older_than_minutes: 60, dry_run: false })
```

Agent queue and heartbeat tools treat `agent_name` as a lowercase stable ID.
Display names can keep their casing, but tool calls should not create separate
`AgentOne` and `agentone` queues.

### Agent loop backlog scout

`packages/core/agent_loop_worker.js` runs `mem_autonomy_sweep` when
`mem_autonomy_next` has no task for the agent. The sweep creates durable
department-owned tasks from readiness gaps and findings, then optionally drops
briefs to the assigned agents. Useful env:

```bash
AUTONOMY_SWEEP_INTERVAL_MIN=15
LOOP_AUTONOMY_SWEEP_DROP_BRIEFS=1
AUTONOMY_TAKEOVER_MINUTES=20 # idle agents may take stale open tasks from another lane
LOOP_NO_AUTONOMY_SWEEP=1 # disable only for debugging
```

`mem_autonomy_next({agent_name, claim:true, allow_takeover:true,
stale_takeover_minutes:20})` first prefers the agent's own and unassigned work.
If another assigned task is still open past the timeout, it is returned with
`takeover_eligible:true` and `previous_assigned_agent` so the worker can finish
it and brief the original owner instead of waiting.

### `mem_project_timeline_report(project, [agent_name, days, token_budget, max_items, live_focus, include_doc])`

Render a token-budgeted project dossier for "what happened, what is still open,
and what blocks live". It combines the project registry, rules, site contract,
golden-check history, open findings, active claims, autonomy tasks, pending
briefs, handoffs, decisions, actions, and memory snippets into a compact report
with concrete next actions. This is the primary "what was already done / what
is still open" report and should be read before starting new project work.

```ts
mem_project_timeline_report({ project: "Example Project", agent_name: "agent", days: 30, token_budget: 3000 })
```

### `mem_work_report_feed([project, agent_name, limit, include_blocked])`

Unified report + completed-task area. It returns recent `session_handoff`
reports and completed autonomy tasks in one chronological feed so agents can
see what is already done before they start new work.

Use this before any new implementation. If the same surface already appears in
the feed as completed, do not redo it.

```ts
mem_work_report_feed({ project: "Example Project", agent_name: "agent", limit: 12 })
```

### Brief Contract

All brief write paths now normalize to one contract: `firm-brief-v1`.

If a dropped brief does not already contain the canonical structure, Mnemo wraps
it automatically with:

- `## Title`
- `## Project`
- `## Request`
- `## Constraints`
- `## Acceptance`
- `## Report Back`

This applies to:

- `mem_brief_drop`
- `mem_brief_drop_batch`
- `mem_brief_drop_multi`
- `mem_brief_drop_from_template`
- `mem_connect_channel_post`

Agents should stop inventing their own brief layouts. One contract in, one
contract out.

### `mem_auth_contract_get/check(project)`

Hard source of truth for login/SSO. Reads `project_rules.auth_matrix`, checks
required fields like canonical login URL, provider, shared identity scope, and
shared-account policy, then compares linked portals for drift.

Use `mem_auth_contract_check` before any login, SSO, signup, session, or
account-auth change. If it blocks, agents must not invent a new login flow.

```ts
mem_auth_contract_check({ project: "Example Project" })
```

### `mem_ui_contract_get/check(project)`

Hard source of truth for portal UI consistency. Reads `project_rules.design_rules`
plus `canonical_nav` and checks that linked portals inherit the same header
structure, button system, font system, logo assets, logo sizing, and light/dark
behavior from the configured canonical brand surface.

Use this before header, menu, button, theme, logo, or general frontend changes.
If it blocks, agents must not improvise a new visual variant.

```ts
mem_ui_contract_check({ project: "brand.example" })
```

For multi-portal product families, this is treated as a top directive:
- `account.example` is the canonical login/auth source for every public portal
- `admin.example` is the separate internal admin surface for cross-portal/customer oversight
- `brand.example` is the canonical header/button/light-dark source
- language and theme switching belong in account/settings surfaces, not in shared public header chrome
- language defaults to the browser unless the central account surface stores an explicit override
- no local reinterpretation is allowed once the canonical source is set
- display/body fonts, font sizing, light-logo PNG, dark-logo PNG, logo size, button size, and header spacing must match the canonical source

### `mem_media_capture/recent/search/get`

Captured screenshots, photos, PDFs, and documents are stored as first-class
media assets with:

- human-readable title
- canonical file name
- original file name
- optional copied storage path under `MNEMO_MEDIA_DIR`
- labels
- project
- route/page URL
- source/channel/thread
- file name/path

Use:

```ts
mem_media_capture({
  media_path: "/tmp/screenshot.png",
  source: "telegram",
  channel: "telegram-chat:-100123",
  actor: "mayk",
  content: "Hier ein Screenshot vom Admin Design",
  project: "admin",
  occurred_at: "2026-02-22T13:45:00"
})
mem_media_recent({ project: "Example Project", media_kind: "screenshot", limit: 20 })
mem_media_search({ query: "dark logo pricing page", project: "Example Project" })
mem_media_get({ id: 42 })
```

`mem_capture_ingest` now auto-indexes media when `media_path`, `file_path`,
`file_name`, or media-like event metadata is present. If `MNEMO_MEDIA_STORE`
is not `0` and the path is local, Mnemo also copies the file into the media
store with a contextual safe name, for example:

`chat-2026-02-22-13-45-hier-ein-screenshot-vom-admin-design.png`

The searchable title stays human-readable:

`Chat 22.02.2026 13:45 Hier ein Screenshot vom Admin Design`

### `mem_session_handoff(agent_name, summary, [...])`

Mandatory session-stop report. Besides summary, changed files, tests, blockers,
and next actions, it can now also close linked work:

- `completed_brief_ids`: mark one or more briefs as done when this handoff
  finishes the work from those briefs
- `completed_task_ids`: mark one or more autonomy tasks as done from the same
  handoff

That keeps the unified report feed and the brief/task state in sync.

### `mem_code_outline(file_path, [workspace, query, max_symbols])`

Return a token-efficient outline for a source or text file: imports, markdown
headings, symbols, line ranges, rough full-file token estimate, and the next
recommended read action. Use this before opening large code files.

```ts
mem_code_outline({ file_path: "packages/core/agent_loop_worker.js", query: "prework", max_symbols: 25 })
```

### `mem_code_unfold(file_path, symbol | start_line/end_line, [context_lines, max_lines])`

Return only the selected symbol or bounded line range, with optional surrounding
context and line numbers. Use this after `mem_code_outline` instead of dumping a
whole file into the model.

```ts
mem_code_unfold({ file_path: "packages/core/agent_loop_worker.js", symbol: "runPreWorkGuard" })
mem_code_unfold({ file_path: "packages/core/agent_loop_worker.js", start_line: 1000, end_line: 1080 })
```

### `mem_promise_open([actor])`

Returns currently-open promises the agent has made. Use during CTO self-checks.

### `mem_site_contract_set/get` and `mem_site_golden_check_plan/report/history`

Store and enforce website contracts for canonical header/menu/footer, target
domains, locale routes, legal links, logo rules, and mobile/desktop evidence.
Use `mem_site_golden_check_plan` before website work, run the emitted
`site-contract-audit` command, then persist real evidence with
`mem_site_golden_check_report`.

The audit helper checks same-label menu hrefs, canonical-domain leaks,
forbidden hosts, locale-preserving legal links, logo/dark-logo assets, viewport
meta, and rough header style-token overlap. HTTP 200 alone is never evidence.
For UI/style work, browser or screenshot evidence is mandatory; agents must
check for clipped text, overflow, broken controls, missing logos/icons, wrong
theme assets, and unfinished-looking sections before claiming pass.

For route, CTA, login, pricing, and locale regression checks across several
sites, use the route matrix helper:

```bash
node packages/core/bin/route-matrix-audit.js \
  --site main=https://example.com \
  --site app=https://app.example.com \
  --paths /,/login,/pricing,/account/billing \
  --locales de,en \
  --allowed-external-hosts api.example.com \
  --forbidden-hosts example.com \
  --output route-matrix.json
```

It checks route status, first redirect location, query loss on login/checkout
redirects, `html lang` vs locale prefix, header/footer/viewport presence, legal
labels, header/footer host leaks, CTA links, and CTA target status. Use
`--site-paths label=/,/custom` when one site has a different route set.

### `mem_reflect([date])`

Run reflection cycle for a date — counts corrections/praises in messages, generates a summary, writes `daily_reflection` row. Default date: today.

### `mem_memory_layer_status({ project?, agent_name?, days? })`

Shows the canonical Mnemo memory layers: company ledger, department journal,
agent sleep notes, session layer, daily layer, long-term layer, recall layer,
and REM layer. Use before adding any OpenClaw-like memory path so no second
truth appears outside Mnemo.

### `mem_memory_rem_plan({ project?, agent_name?, days?, date? })`

Returns due consolidation phases and exact next tool calls. The phases are
`light`, `daily`, `deep`, and `rem`. This tool is read-only.

### `mem_memory_rem_run({ phase, project?, agent_name?, days?, date? })`

Runs deterministic draft consolidation. It writes a
`memory_consolidation_run` row and, by default, a semantic
`memory_consolidation` memory row with selected source refs. It never deletes or
rewrites old facts. Concrete truth still needs promotion or the dedicated
project/access/rules APIs.

### `mem_department_journal_add/list`

Department diary for progress, blockers, risks, open questions, dependencies,
and foreign-scope requests. Journal rows explain work history but do not become
official truth until promoted.

### `mem_agent_sleep_note_add/list`

Personal REM notes per agent: lessons, uncertainty, repeated errors, needed
context, and improvement ideas. These notes must not be treated as policy or
project truth by themselves.

### `mem_memory_promotion_propose/list/decide`

Review queue for REM findings that may become official truth. Proposal kinds:
`decision`, `rule`, `project_memory`, `risk`, `owner_question`, `scar`, and
`runbook`. `decide` requires reviewer attribution and can approve, reject, or
promote.

### `mem_company_rem_brief({ project?, days?, write_brief?, coordinator_agent? })`

Generates a coordinator morning brief from department journals, sleep notes,
pending promotion proposals, active/stale claims, pending approvals, and REM
state. With `write_brief:true`, it writes the brief to the coordinator's Mnemo
brief inbox.

### `mem_access_preflight({ system_name?, project?, access_kind?, intended_command?, intended_entrypoint?, agent_name? })`

Mandatory gate before touching SSH, dashboards, APIs, databases, providers, or
shared infra. It resolves the canonical route, logs an allowed/blocked access
event, and returns `canonical_command` plus `route_steps`.

If an access route is stored as `route_kind: "jump"` or `route_kind: "proxy"`
with `direct_allowed: false`, direct attempts are blocked and the returned
canonical route must be used.

```json
{
  "system_name": "example-production",
  "access_kind": "ssh",
  "agent_name": "dieter",
  "intended_command": "ssh root@example.org"
}
```

### `mem_access_route_resolve({ system_name?, project?, access_kind?, entrypoint?, intended_route_kind?, agent_name? })`

Non-mutating resolver for the same canonical access policy. Use this when an
agent needs to plan or explain the route without logging a live preflight event.

### `mem_access_guide({ project?, system_name?, scope?, status?, limit? })`

Fixed access front door. Reads the access inventory plus matching project
registry rows and returns a grouped guide for "how do I get there?" questions:
domain, repo, server, PM2, nginx, admin URL, access kind, entrypoint,
account_hint, `route_kind`, `direct_allowed`, jump/proxy details,
`canonical_command`, and `secret_ref`.

Use this before asking where a project lives or before creating a duplicate
access note. If the route does not exist yet, write it with
`mem_access_upsert`, then mark it verified via `mem_access_event_log`.

Example route with a jump host:

```json
{
  "system_name": "example-production",
  "access_kind": "ssh",
  "entrypoint": "example.org",
  "account_hint": "root",
  "route_kind": "jump",
  "direct_allowed": false,
  "jump_host": "jump.example.org",
  "jump_user": "root",
  "canonical_command": "ssh -J root@jump.example.org root@example.org",
  "secret_ref": "SSH key label",
  "updated_by": "agent-name"
}
```
