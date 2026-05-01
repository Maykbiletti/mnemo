# Architecture

This document explains how Mnemo's parts fit together so you can extend, replace, or audit any of them.

## One file, one source of truth

Everything lives in a single SQLite file (`mnemo.db`). FTS5 indexes for keyword search and a `vec_memory` virtual table (sqlite-vec) for semantic search are co-located in the same DB. There is no separate vector store, no Redis, no Elasticsearch.

If you ever want to back up or move a Mnemo instance, copy the `.db` file. That's it.

## Tables

| table | purpose |
|---|---|
| `memory` | every event: messages, tool calls, edits, scars, dreams, markdown notes, web fetches |
| `memory_fts` | FTS5 mirror of `memory.text` for BM25 search |
| `memory_embedding` | float32 vectors (per row), one row per embedding |
| `vec_memory` | sqlite-vec virtual table indexing the same vectors for fast cosine search |
| `memory_link` | typed edges: `replies_to`, `references`, `corrects`, `resolves`, `partOf`, `causedBy`, `similar` |
| `core_value` | hard-coded principles (the agent's non-negotiable rules) |
| `personality_trait` | weighted dimensions, mutable from feedback |
| `belief` | assumptions about the world, with evidence-for/against, can be falsified |
| `correction_pattern` | regex patterns + classifier (correction/praise/promise/scar) for auto-detection |
| `scar_event` | recorded mistakes — auto-emitted when correction patterns match |
| `trait_event` | log of every trait-weight change, why, by which memory |
| `daily_reflection` | nightly rollup: corrections + praises + drift summary |
| `self_snapshot` | frozen "who I was on date X" for replay |
| `promise` | discovered commitments (from owner or agent), with status |
| `fulfillment_signal` | evidence that a promise was kept — keyword + (later) embedding match |
| `outbound_queue` | messages to send via channel adapters (sleep-protected) |
| `tracked_url` | URLs to monitor for status / availability |
| `task_run` | started/completed task tracking with actual durations |
| `session` | chat-session metadata (jsonl path, agent, message count) |
| `backfill_run` | ledger so the same source isn't re-imported twice |
| `writer_health` | per-writer last-seen / row-count / status |

## Writers (daemon.js)

`daemon.js` is an always-on process (PM2-managed in prod). It runs:

- HTTP server (`/health`, `/ingest`, `/recall`)
- Telegram poller (long-poll, optional, requires `TELEGRAM_BOT_TOKEN`)
- URL watcher (every 5 min, HEAD-checks `tracked_url`, queues `next_action` after 3 consecutive failures)
- Auto-scar scanner (every 30s, matches `correction_pattern` regexes against new memory rows, dedup window 30 min)
- Outbound flusher (every 60s, dispatches `outbound_queue` rows via channel registry, sleep-protected)
- Daily reflection cron (23:00 local-time, emits `daily_reflection` row)

Each writer updates its row in `writer_health` so `mem_health()` shows you what's alive vs stale vs dead.

## Reader (mcp.js)

`mcp.js` is the MCP stdio server. It loads the same DB as the daemon (WAL mode lets multiple processes read/write concurrently). It exposes 13 tools — see [`mcp-tools.md`](./mcp-tools.md).

Both processes can run side-by-side: the daemon ingests, the MCP server serves recall + analytics + writes.

## Embeddings

- Model: `Xenova/all-MiniLM-L6-v2` (default), 384-dim, ONNX, runs in pure JS via `@xenova/transformers`.
- Quantized weights, ~30 MB, downloaded once on first use into `MNEMO_MODEL_CACHE` (default `./.models`).
- Backfill via `node embedding_writer.js` — picks up rows where `embedding_id IS NULL` AND `importance >= MNEMO_EMBED_MIN_IMPORTANCE` (default 5).
- Cron `*/10 * * * *` recommended to keep new rows embedded.

To swap models, set `MNEMO_EMBED_MODEL` and update `DIM` in `embeddings.js` accordingly. Other Xenova models work, OpenAI text-embedding-3-* requires a tiny adapter.

## Hybrid recall

`mem_recall(query, mode)`:

- `mode: 'fts'` → FTS5 BM25 only
- `mode: 'semantic'` → sqlite-vec cosine only (requires embeddings)
- `mode: 'hybrid'` (default) → both, fused via Reciprocal Rank Fusion (RRF) with `k=60`

RRF gives you a single ranked list weighted toward "rows that show up in both methods." Useful when keyword and semantic similarity disagree.

## Channels

Channel adapters in `channels/` implement `BaseChannel`. The registry in `channels/index.js` is what daemon's outbound flusher dispatches against. Each adapter is responsible for `send(to, text, opts)` plus optional `react`, `download`. Telegram is implemented; WhatsApp + Email are stubs awaiting credentials.

Add a new channel by writing `channels/<name>.js`, exporting a class extending `BaseChannel`, and registering it in `channels/index.js`.

## Open-loop scanner

`loop_scanner_v2.js` runs every 15 min (cron) or on-demand. It:

1. Scans recent agent messages (last 14 days) for promise-phrases.
2. Inserts into `promise` table.
3. For each open promise, scans subsequent messages for fulfillment language.
4. Scores each candidate, inserts to `fulfillment_signal`.
5. Marks `promise.status='fulfilled'` when total signal-score >= 0.85 OR ≥2 independent signals.

Use `mem_promise_open()` to see currently-open commitments.

## Declarative export

`export_declarative.js` regenerates `exports/SOUL.md`, `exports/AGENTS.md`, `exports/TOOLS.md` from DB state. These files are the agent's grounding documents — load them in your agent's system prompt or pre-task ritual. Cron `15 6 * * *` recommended.

## Future

See [`../ROADMAP.md`](../ROADMAP.md) for Phase 2+ (multi-PC remote, sandboxed skills, personality packs).
