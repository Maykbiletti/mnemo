<div align="center">

<br>

# &nbsp;&nbsp;**M&nbsp;N&nbsp;E&nbsp;M&nbsp;O**&nbsp;&nbsp;

### the memory backbone — and coordination layer — your AI agent should ship with

<br>

local SQLite&nbsp;&nbsp;·&nbsp;&nbsp;vector recall&nbsp;&nbsp;·&nbsp;&nbsp;MCP server&nbsp;&nbsp;·&nbsp;&nbsp;multi-tenant&nbsp;&nbsp;·&nbsp;&nbsp;**Mnemo Connect: distributed agents across N PCs**

<br>

[![CI](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml/badge.svg)](https://github.com/Maykbiletti/mnemo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1a1a1a?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-1a1a1a?style=flat-square)](.nvmrc)
[![Status](https://img.shields.io/badge/status-alpha-22D3EE?style=flat-square)](./ROADMAP.md)
[![Stars](https://img.shields.io/github/stars/Maykbiletti/mnemo?style=flat-square&color=2b6cff)](https://github.com/Maykbiletti/mnemo/stargazers)

<br>

</div>

---

> **Stop telling your AI the same thing twice. Stop coordinating your AI workforce by hand.**
> Mnemo keeps every conversation, decision, scar and dream in one SQLite file your agent can search forever — locally, with you in control.
> **Mnemo Connect** turns that same SQLite into the coordination layer for a distributed agent team: register N agents across N machines, post one brief to a channel, the hub fans it out by skill. One owner, many agents, shared memory. See [`packages/connect/`](packages/connect/).

<br>

## Why this is a big deal

You already know the problem. The specific moments that hurt:

- **Your session got compacted.** Claude Code, Cursor, ChatGPT all do it. The window hits its limit, the assistant rewrites the older half into a "summary," and the nuance you spent twenty minutes establishing — the architectural choice, the bug you finally pinned, the thing the user said about their database — turns into one-line lossy prose. Twenty minutes later you're explaining it again because the summary didn't survive.
- **You opened a new chat.** Different window, different conversation, different model — same project. None of yesterday is here. You paste in the file you already discussed, repeat the constraint you already mentioned, ask the question you already answered.
- **You switched IDE.** Claude Code → Cursor. Or Cursor → Claude.ai. Or Claude.ai → the API. Each one starts at zero. The agent that knew your codebase yesterday is back to "what's this repo about."
- **Your team-mate took over.** They opened your project, asked the agent for help, got a different answer because the agent doesn't know the half-conversation you and it had on Tuesday.

Every fix to this you've seen so far is the same trick at a different layer: stuff a longer summary into the system prompt, hope the model doesn't drop it, and pay for the tokens forever. That isn't memory. That's prompt-engineering pretending to be memory.

Mnemo flips it. The substrate is a SQLite file that lives on your disk, holds every word verbatim, indexes them with both keyword and vector search, and exposes a 27-tool MCP surface so any assistant in any window can ask "what did we decide about X?" and get the actual answer in milliseconds. Compaction stops eating your context because the context stops living in the chat window. Session switches stop costing you anything because the session was never where the memory lived. New IDE? Wire the MCP server. Two minutes. Same memory.

- **The agent you talk to tomorrow is the same agent you talked to today.** Not a fresh instance with a vague summary — the same memory, the same values, the same in-flight commitments.
- **Your team's PCs become one nervous system.** Pair every machine with `mnemo-pc`. Now your agent can fix a bug on the home desktop while you're on the laptop. Same persona. Same memory. Different keyboard.
- **It catches itself.** Promises tracked, follow-ups detected, scars recorded automatically when the owner pushes back. The agent gets better not because it's smarter — because it stops repeating the move you already corrected.
- **Multi-tenant out of the gate.** One Mnemo can host every customer's agent in isolated SQLite files. Drop a header, get isolation. SaaS-ready without rewriting a thing.
- **Local-first, MIT-licensed, no third parties.** No Pinecone subscription, no Weaviate cluster, no OpenAI lock-in for embeddings (we ship a local 384-dim model). Your customers' memories live on your hardware. That is increasingly the only viable position.
- **Soon: it answers the phone.** A native iOS + Android app pairs the same way `mnemo-pc` does. Your agent makes calls from your number, reads SMS, navigates apps you have open, asks for confirmation when it matters.

This isn't memory-as-a-feature. It's the substrate that lets a chat assistant become an actual assistant — one that grows with you instead of restarting under you.

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
