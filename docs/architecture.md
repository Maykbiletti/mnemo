# Architecture

Mnemo is a local-first memory and coordination system for AI agents. The core
runtime is a SQLite database, an HTTP daemon, an MCP stdio server, and optional
worker loops/hooks that turn memory into coordinated action.

## One File, One Source Of Truth

Everything durable lives in `mnemo.db`. Keyword search uses SQLite FTS5.
Semantic search uses sqlite-vec in the same database. There is no separate
vector store, Redis, Elasticsearch, or hosted memory service required.

Back up or move an instance by copying the database and any private facts or
pack files you use.

## Main Tables

| table | purpose |
|---|---|
| `memory` | semantic memory rows: facts, messages, scars, decisions, notes |
| `memory_fts` | FTS5 mirror of `memory.text` |
| `memory_embedding` | embedding vectors for memory rows |
| `vec_memory` | sqlite-vec virtual table for cosine search |
| `memory_link` | typed relationships between memory rows |
| `core_value` | owner-set and agent operating principles |
| `personality_trait` | weighted identity traits |
| `belief` | assumptions with evidence and confidence |
| `correction_pattern` | reusable correction/praise/promise classifiers |
| `scar_event` | recorded mistakes and durable lessons |
| `trait_event` | trait changes with rationale |
| `daily_reflection` | periodic rollups |
| `self_snapshot` | frozen identity snapshots |
| `promise` | commitments discovered in chat or work logs |
| `fulfillment_signal` | evidence that a promise was fulfilled |
| `outbound_queue` | messages waiting for channel delivery |
| `tracked_url` | URLs monitored by the daemon |
| `task_run` | basic started/finished task records |
| `session` | imported or active session metadata |
| `backfill_run` | import ledger |
| `writer_health` | source health and writer heartbeat rows |
| `mnemo_event_journal` | raw event receipts for bridges, tools, loops, commands, imports, and audits |
| `capture_receipt` | idempotent universal-capture ledger with source refs, hashes, seen counts, and metadata |
| `transcript` | conversational rows separated from semantic memory volume |
| `agent_brief` | assignment inbox and team fanout queue |
| `agent_action` | work lifecycle, verification, blockers, and handoffs |
| `project_registry` | project facts, surfaces, ownership, and readiness metadata |
| `project_rules` | deploy, auth, legal, language, checkout, UI, and quality rules |
| `work_claim` | TTL locks for files or modules |
| `quality_finding` | defects, regressions, risks, and review findings |

## Daemon

`packages/core/daemon.js` is the always-on process. It runs:

- HTTP server: `/health`, `/ingest`, `/recall`, `/tool/<name>`
- optional Telegram long-poll ingest and send
- URL watcher
- outbound queue flusher
- auto-scar scanner
- daily reflection
- universal capture frontdoor
- loop and source health reporting

Each writer updates health state so agents can tell the difference between
"online" and "actually writing data."

## MCP Server

`packages/core/mcp.js` is the stdio MCP server. It loads the same database as
the daemon and exposes the memory, identity, project, capture, brief, action,
hook, and audit tool surface documented in [`mcp-tools.md`](mcp-tools.md).

The daemon and MCP server can run side by side. WAL mode allows concurrent
reads and writes.

## Universal Capture

`mem_capture_ingest` and `mem_capture_ingest_batch` are the no-loss write
frontdoor. Importers write a raw receipt first, then optionally promote the
event into transcript and semantic memory.

Duplicate events are not silently ignored. They update
`capture_receipt.seen_count` and write a `capture_duplicate` audit event. This
makes "already seen" observable.

`universal_backfill.js` replays historical sources:

- Telegram exports
- local CLI session logs
- local agent session roots
- PM2 logs

Use `mem_capture_recent` and `mem_source_coverage` to verify source health.

## Agent Loop Worker

`agent_loop_worker.js` turns coordination state into work. It can:

- poll briefs
- acknowledge pure status briefs without model execution
- run pre-work planning before execution
- claim autonomy tasks when the inbox is empty
- run initiative cycles when no assigned work exists
- respect auth cooldowns instead of retrying broken engines
- enforce completion, regression, site-contract, token-efficiency, and smart
  code-read guards
- write handoffs and action logs before stopping

`bin/agent-loop-start.js` starts or repairs PM2 workers with stable
agent/workspace arguments and guard defaults.

## Runtime Hook

`hooks/firm-runtime-hook.js` can be wired into agent lifecycle events:

- `session-start`
- `pre-tool`
- `post-tool`
- `stop`

The hook can require project context, task context, project rules, work claims,
clean git state, identity checks, owner preference checks, token-efficient
memory use, smart code reads, remaining-work checks, and handoffs.

## Embeddings

Default model: `Xenova/all-MiniLM-L6-v2`, 384 dimensions, pure JS through
`@xenova/transformers`. Weights are cached in `MNEMO_MODEL_CACHE`.

`embedding_writer.js` embeds rows where `embedding_id IS NULL` and importance is
high enough for the configured threshold.

## Hybrid Recall

`mem_recall` supports:

- `fts`: FTS5 BM25
- `semantic`: sqlite-vec cosine
- `hybrid`: both, fused with Reciprocal Rank Fusion

Agents should usually search compactly first, fetch IDs, inspect timelines or
neighbors, and only then load full rows.

## Channels

Channel adapters live under `packages/core/channels/`. Telegram is implemented.
Other channels can be added by implementing the same adapter shape and routing
incoming messages through universal capture.

## Public Facts And Packs

The public repo ships only examples:

- `packages/core/facts/example.json`
- `packages/core/facts/example-project-rules.json`
- `packs/example-pack/`

Real owner identity, company facts, customer data, prices, legal details,
server paths, chat IDs, and personas belong in ignored local files or private
packs.
