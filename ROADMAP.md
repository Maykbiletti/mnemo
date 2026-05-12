# Mnemo Roadmap

## Done

- **Phase 0 - Backbone (2026-05-01):**
  - SQLite schema (memory + memory_fts + memory_embedding + memory_link + writer_health + session)
  - Identity schema (core_value + personality_trait + belief + correction_pattern + scar_event + daily_reflection + self_snapshot + trait_event)
  - HTTP daemon (`/ingest`, `/recall`, `/health`)
  - MCP server (stdio)
  - Channel poller/adapters, URL watcher, auto-scar scanner
  - Skills folder pattern + `mem_skill_search` / `mem_skill_record`
  - Backfill of historical sources (chat exports, session jsonl, notes, markdown memory)

- **Phase 1 - Intelligence (2026-05-01):**
  - sqlite-vec embedding layer (`Xenova/all-MiniLM-L6-v2`, 384-dim)
  - Hybrid `mem_recall` (FTS + semantic via Reciprocal Rank Fusion)
  - Multi-channel adapter pattern
  - Open-loop scanner V2 (promise + fulfillment_signal tables)
  - Declarative export (`SOUL.md`, `AGENTS.md`, `TOOLS.md` from DB)
  - CLI bootstrap wizard

## Next

- **Phase 2 - Distributed agents:**
  - `mnemo-pc` single-file binary for Windows, macOS, and Linux
  - WebSocket-outbound protocol to a central Mnemo dispatcher
  - Pairing-code-based auth + mTLS
  - RPC: screenshot, key_press, mouse_move, file_read/write, shell_exec, browser_open
  - Confirm-layer for sensitive actions
  - Per-device `SOUL.md` / identity snapshot support

- **Phase 3 - Sandboxed skills:**
  - Docker-based runner for `needs_sandbox: true` skills
  - Per-skill allowlist for filesystem + network
  - Signed skill marketplace concept

- **Phase 4 - Personality packs:**
  - `@mnemo/pack-*` npm packages that seed values, traits, correction patterns, and project rules
  - `mnemo pack apply <name>` CLI
  - `packs/example-pack` template for public repos
  - Private personal packs stay outside the public repository

- **Phase 5 - Web dashboard:**
  - Live view of registered agents, recent memories, open loops, briefs, and readiness boards
  - Owner can intervene mid-action, approve risky actions, or pause an agent

- **Phase 6 - Multi-tenant SaaS:**
  - One isolated Mnemo database per tenant
  - Tenant-scoped facts, project rules, audit logs, and agent rosters
  - Deployment templates for self-hosted and managed installs
