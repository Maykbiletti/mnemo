# MCP Tools

Mnemo exposes the following tools via Model Context Protocol (stdio). Wire it once into Claude Code (or any MCP client) and your agent gets persistent recall, identity awareness, and skill discovery.

## Setup

```bash
claude mcp add mnemo --transport stdio -- node /path/to/mnemo/packages/core/mcp.js
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

```ts
mem_recall({ query: "stripe webhook timeout", limit: 10 })
mem_recall({ query: "what did Mayk say about pricing", since: "2026-04-01", actor: "Mayk" })
mem_recall({ query: "auth bug", mode: "fts", kind: "scar" })
```

### `mem_who_am_i()`

Snapshot of current self: active core values, top traits, last daily reflection, total memory rows, date range.

### `mem_timeline(from, [to, actor, limit])`

Chronological window of memories on a date or date range.

```ts
mem_timeline({ from: "2026-04-15", to: "2026-04-22", actor: "Mayk" })
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

### `mem_skill_search(query)`

Search the local `skills/` folder by trigger-phrase or name. Returns matching `SKILL.md` descriptors. **Use BEFORE attempting any new task** — if a recipe exists, follow it.

### `mem_skill_record(name, description, trigger_phrases, sandbox, requires_confirmation, sensitive_data, recipe_steps, first_invocation_outcome)`

Record a newly-learned skill into `skills/`. Use **after** successfully completing a previously-unknown task.

### `mem_promise_open([actor])`

Returns currently-open promises the agent has made. Use during CTO self-checks.

### `mem_reflect([date])`

Run reflection cycle for a date — counts corrections/praises in messages, generates a summary, writes `daily_reflection` row. Default date: today.
