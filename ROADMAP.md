# Mnemo Roadmap

## Done

- **Phase 0 — Backbone (2026-05-01):**
  - SQLite schema (memory + memory_fts + memory_embedding + memory_link + writer_health + session)
  - Identity schema (core_value + personality_trait + belief + correction_pattern + scar_event + daily_reflection + self_snapshot + trait_event)
  - HTTP daemon (`/ingest`, `/recall`, `/health`)
  - MCP server (13 tools, stdio)
  - Telegram poller, URL watcher, auto-scar scanner
  - Skills folder pattern + `mem_skill_search` / `mem_skill_record`
  - Backfill of historical sources (chat exports, session jsonl, dream notes, markdown memory)

- **Phase 1 — Intelligence (2026-05-01):**
  - sqlite-vec embedding layer (`Xenova/all-MiniLM-L6-v2`, 384-dim)
  - Hybrid `mem_recall` (FTS + semantic via Reciprocal Rank Fusion)
  - Multi-channel adapter (Telegram live, WhatsApp/Email stubs)
  - Open-loop scanner V2 (promise + fulfillment_signal tables)
  - Declarative export (`SOUL.md`, `AGENTS.md`, `TOOLS.md` from DB)
  - CLI bootstrap wizard

## Next

- **Phase 2 — Multi-PC (BLUN Agent OS):**
  - `mnemo-pc` Go binary, single-file exe for Win/Mac/Linux
  - WebSocket-outbound protocol to a central Mnemo dispatcher
  - Pairing-code-based auth + mTLS
  - RPC: screenshot, key_press, mouse_move, file_read/write, shell_exec, browser_open
  - Confirm-layer (push-to-owner) for sensitive actions
  - Per-PC SOUL.md (per-machine persona)

- **Phase 3 — Sandboxed skills:**
  - Docker-based runner for `needs_sandbox: true` skills
  - Per-skill allowlist for filesystem + network
  - Skill marketplace concept (signed skills, reviewed)

- **Phase 4 — Personality packs:**
  - `@mnemo/pack-*` npm packages that seed values + traits + correction patterns
  - `mnemo pack apply <name>` CLI
  - Examples: `pack-dieter` (the original), `pack-helper`, `pack-coder`

- **Phase 5 — Web dashboard:**
  - Live view of all PC-Agents, recent memories, open loops
  - Owner can intervene mid-action ("rewrite that prompt", "abort")

- **Phase 6 — Multi-tenant SaaS:**
  - One Mnemo per tenant, isolated DBs
  - SaaS deployment via BLUN platform
