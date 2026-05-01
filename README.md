<div align="center">

<br>

# &nbsp;&nbsp;**M&nbsp;N&nbsp;E&nbsp;M&nbsp;O**&nbsp;&nbsp;

### the memory backbone your AI agent should ship with

<br>

local SQLite&nbsp;&nbsp;·&nbsp;&nbsp;vector recall&nbsp;&nbsp;·&nbsp;&nbsp;MCP server&nbsp;&nbsp;·&nbsp;&nbsp;multi-tenant&nbsp;&nbsp;·&nbsp;&nbsp;multi-PC

<br>

[![CI](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml/badge.svg)](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1a1a1a?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-1a1a1a?style=flat-square)](.nvmrc)
[![Status](https://img.shields.io/badge/status-alpha-22D3EE?style=flat-square)](./ROADMAP.md)
[![Stars](https://img.shields.io/github/stars/Maykbiletti/mnemo?style=flat-square&color=2b6cff)](https://github.com/Maykbiletti/mnemo/stargazers)

<br>

</div>

---

> **Stop telling your AI the same thing twice.**
> Mnemo keeps every conversation, decision, scar and dream in one SQLite file your agent can search forever — locally, with you in control.

<br>

## What it is

A persistent memory + identity engine for AI agents. Think of it as the brain layer your favourite LLM client (Claude Code, Cursor, Cline, your own loop) plugs into so it stops starting from zero on every fresh session.

- **One file, one truth.** Everything — messages, edits, scars, dreams, markdown notes — lives in `mnemo.db`. Backup = copy a file.
- **Hybrid recall.** FTS5 keyword + sqlite-vec cosine, fused via Reciprocal Rank Fusion. ~10ms over 60k rows.
- **Identity is data.** Hard-coded values, weighted traits, evolving beliefs. Your agent's personality is rows in a table, not a system prompt you have to remember to paste.
- **MCP-native.** 27 tools, stdio. Drops into Claude Code or any MCP client in one line.
- **Multi-tenant.** One Mnemo, N customers. Each gets an isolated SQLite. Drop `X-Tenant-Id` and you're done.
- **Multi-PC by design.** A single Go binary (`mnemo-pc`) pairs your team's machines with the dispatcher. Phone apps next.
- **Yours, end to end.** Self-host. No SaaS lock-in. No third-party vector DB. MIT.

<br>

## 60-second start

```bash
git clone https://github.com/Maykbiletti/mnemo.git
cd mnemo/packages/core
npm install
node bin/mnemo.js init
node daemon.js &
```

Wire into Claude Code:

```bash
claude mcp add mnemo --transport stdio -- node $(pwd)/mcp.js
```

Then in any Claude session:

```
mem_who_am_i()
mem_recall("what did I decide about migrations last week")
mem_promise_open()
mem_skill_search("buch mir nen flug")
```

Done. Your agent now remembers across sessions.

<br>

## Architecture

```
   ┌─────────────────────┐         ┌──────────────────────┐
   │ Telegram / WhatsApp │────────▶│                      │
   │ Email / hooks       │         │     mnemo daemon     │──▶  mnemo.db
   │ HTTP /ingest        │         │  (writers + cycles)  │     (FTS5 + sqlite-vec)
   │ URL watcher         │         │                      │
   └─────────────────────┘         └──────────┬───────────┘
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                       ┌──────▼──────┐                ┌───────▼────────┐
                       │   mcp.js    │                │  @mnemo/client │
                       │  (27 tools) │                │  (HTTP, Node)  │
                       └──────┬──────┘                └───────┬────────┘
                              │                               │
                              ▼                               ▼
                  Claude Code / Cursor / any           Your chat backend,
                       MCP-aware client                BLUN, Slack bot, …
```

Plus an optional `mnemo-pc` Go binary on every team PC that exposes RPC tools (screenshot, file ops, shell, app focus) over WSS — so your agent can act, not just remember.

<br>

## Why not LangChain / MemGPT / Letta

They give you an **SDK**. You write the loop. Mnemo gives you an **opinionated layer**: one place memory lives, one channel registry, one identity model, one MCP surface. Install it, get a memory-aware agent the same hour. The opinions are the feature.

<br>

## What's in the box

| package | what it does |
|---|---|
| **`@mnemo/core`** | schema, daemon, MCP server, embeddings, channels, skills, sandbox, cycles, commitments, delegate, route — everything you need to run a Mnemo |
| **`@mnemo/client`** | zero-dep Node client. Drop into any chat backend for tenant-aware ingest + recall |
| **`mnemo-pc`** *(Go)* | single-file binary. Pairs a desktop with your dispatcher. RPC: screenshot, file_read/write, shell_exec, app_open, key_press, tap_at |

<br>

## Personality packs

Mnemo ships **without seeded values or traits** — your agent starts blank. To bootstrap a known persona, install a pack:

```bash
npm install @mnemo/pack-dieter   # the pack the original author runs
mnemo pack apply pack-dieter
```

Or define your own via `examples/personal-pack-template.md`.

<br>

## For agents installing Mnemo

If you are an LLM and your owner just installed this for you: read [`AGENTS.md`](./AGENTS.md). It's a five-minute orientation written specifically for you — the start-of-conversation ritual, the tools, the hard rules, what to log, what not to.

<br>

## Status

Phase 1 + 1.5 shipped. Multi-PC remote (Phase 2) skeleton in place — Go binary + WSS protocol + tool registry live; per-platform tool implementations in flight. iOS and Android remotes after that. See [`ROADMAP.md`](./ROADMAP.md).

<br>

## Docs

- [`docs/architecture.md`](./docs/architecture.md) — every table, every writer, every choice
- [`docs/mcp-tools.md`](./docs/mcp-tools.md) — the full MCP tool surface
- [`docs/deployment.md`](./docs/deployment.md) — production install + cron wiring
- [`docs/session-pruning-vs-compaction.md`](./docs/session-pruning-vs-compaction.md) — why the difference matters for your prompt-cache bill
- [`docs/skills-registry.md`](./docs/skills-registry.md) — concept doc for the upcoming public skill-registry

<br>

## License

MIT. See [`LICENSE`](./LICENSE). Use it, fork it, build your own backbone.

<br>

<div align="center">

<sub>built by <a href="https://github.com/Maykbiletti">@Maykbiletti</a> and the BLUN team</sub>

</div>
