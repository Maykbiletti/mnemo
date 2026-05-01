# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned (Phase 2)
- `mnemo-pc` — Go binary for Win/Mac/Linux multi-PC remote
- WebSocket-outbound dispatcher protocol
- Pairing-code-based auth + mTLS
- iOS / Android Mnemo Remote apps
- Sandbox runner for `needs_sandbox` skills (Docker)

## [0.1.0] — 2026-05-01

Initial public release.

### Added

- SQLite schema (memory + memory_fts + memory_embedding + memory_link + writer_health + session + backfill_run)
- Identity schema (core_value + personality_trait + belief + correction_pattern + scar_event + daily_reflection + self_snapshot + trait_event)
- HTTP daemon (`/ingest`, `/recall`, `/health`)
- MCP stdio server with 13 tools: `mem_recall` (FTS+semantic+hybrid), `mem_who_am_i`, `mem_timeline`, `mem_health`, `mem_add`, `mem_link`, `mem_value_get`, `mem_belief_get`, `mem_trait_get`, `mem_duration_history`, `mem_task_start`, `mem_task_finish`, `mem_skill_search`, `mem_skill_record`, `mem_promise_open`, `mem_reflect`
- Telegram poller (long-poll, configurable per chat)
- URL watcher (HEAD-checks every 5 min)
- Auto-scar scanner (regex-based correction/praise classification, 30-min dedup)
- Embeddings layer: sqlite-vec + `Xenova/all-MiniLM-L6-v2` (384-dim, ONNX, no Python)
- Hybrid recall via Reciprocal Rank Fusion of FTS + cosine
- Multi-channel adapter (`BaseChannel` + Telegram + WhatsApp/Email stubs)
- Outbound queue with sleep-protection
- Open-loop scanner V2 (promise + fulfillment_signal tables, keyword scoring)
- Declarative export (`SOUL.md`, `AGENTS.md`, `TOOLS.md` from DB state)
- CLI bootstrap wizard (`node bin/mnemo.js init`)
- Backfill script for chat exports + jsonl streams + markdown memories
- Skills folder convention with SKILL.md frontmatter
- Two example skill stubs: `book_flight`, `pay_invoice`
