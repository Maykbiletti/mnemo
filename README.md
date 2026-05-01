# Mnemo

[![CI](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml/badge.svg)](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](.nvmrc)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](./ROADMAP.md)

**Persistent memory + identity engine for personal and team agents.** A SQLite-backed memory layer with FTS5, vector embeddings (via sqlite-vec), an MCP server, and a multi-channel adapter — so your AI agent never starts a conversation at zero.

> If you've ever told Claude/ChatGPT/Codex the same thing twice, Mnemo is the layer that keeps everything you said and lets it find what matters again. Locally. Yours. MIT-licensed.

## What it gives you

- **Persistent memory**: every message, edit, decision, scar, dream-note, or markdown-doc lives in one SQLite file (`mnemo.db`). FTS5 + sqlite-vec on top.
- **Identity layer**: hard-coded values, mutable traits, evolving beliefs. Your agent's personality is data, not a system prompt.
- **MCP server** (`mcp.js`): exposes `mem_recall`, `mem_who_am_i`, `mem_timeline`, `mem_promise_open`, etc. Plug into Claude Code, Cursor, or any MCP-aware client.
- **Daemon** (`daemon.js`): always-on HTTP `/ingest`, Telegram poller, URL watcher, auto-scar scanner from configurable correction patterns.
- **Multi-channel** (`channels/`): Telegram works out-of-the-box; WhatsApp/Email stubs ready for credentials.
- **Open-loop scanner** (`loop_scanner_v2.js`): finds promises you made and never delivered.
- **Declarative export** (`export_declarative.js`): generates `SOUL.md`, `AGENTS.md`, `TOOLS.md` from DB state — plug them into any agent's prompt.

## Quick start

```bash
npm install -g @mnemo/core
mnemo init       # interactive wizard: name, channels, owner identity
mnemo start      # boots the daemon (HTTP :7117)
mnemo mcp        # stdio MCP server (run from your client)
```

Or clone:

```bash
git clone https://github.com/Maykbiletti/mnemo.git
cd mnemo/packages/core
npm install
node bin/mnemo.js init
node daemon.js &
```

## Wiring into Claude Code

```bash
claude mcp add mnemo --transport stdio -- node /path/to/mnemo/packages/core/mcp.js
```

Then in Claude:

```
mem_recall("what did I say about the migration")
mem_who_am_i()
mem_promise_open()
```

## Why this exists

Every existing "memory layer" for LLMs (LangChain, MemGPT, Letta, etc.) is an **SDK**. You bring your own loop. Mnemo is opinionated: there is **one place** memory lives (SQLite), **one set** of channels, **one** evolving identity. You install it once and your agent grows over time. That's the bet.

## Architecture

```
                    +------------------+
[Telegram]----->----|                  |
[HTTP /ingest]----->|   mnemo daemon   |---->[SQLite mnemo.db]
[URL watcher]----->-|                  |          |
[Skills folder]---->|                  |          |
                    +------------------+          |
                                                  |
                       +-------------+            |
                       |   mcp.js    |<-----------+
                       | (MCP stdio) |
                       +-------------+
                              |
                              v
                    [Claude Code | Cursor | any MCP client]
```

## Personality packs

Mnemo ships **without seeded values or traits**. If you want to start with a known personality, install a pack:

```bash
npm install @mnemo/pack-dieter   # the pack the original author runs
mnemo pack apply pack-dieter
```

Or define your own via the bootstrap wizard.

## Status

This repo is in active early development. Core memory + FTS + embeddings + MCP work today. Multi-PC remote (`mnemo-pc.exe`), sandbox runner, and a couple of advanced features are on the roadmap. See [`ROADMAP.md`](./ROADMAP.md).

## License

MIT. See [`LICENSE`](./LICENSE).

## Author

Built by [Mayk Biletti](https://github.com/Maykbiletti) and the BLUN team.
