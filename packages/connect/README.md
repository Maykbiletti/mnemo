# Mnemo Connect

The coordination layer for distributed AI workforces.

A typical setup: one **hub** (a server running the Mnemo daemon) and many
**connect-clients** running on user PCs. Each connect-client registers the
local agents — Codex CLIs, Claude Code instances, headless bots — with the
hub and watches for briefs addressed to them.

The hub is the single source of truth: agent registry, channels,
subscriptions, briefs, memory. Clients are stateless.

## Topology

```
                       ┌─────────────────────┐
                       │  Mnemo Hub  (HTTP)  │
                       │  agent_registry      │
                       │  agent_brief         │
                       │  channel             │
                       └──────────┬──────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  PC #1 (Mayk)             PC #2 (Mayk)              PC #14 (Felix)
  ┌──────────────┐         ┌──────────────┐          ┌──────────────┐
  │ connect-cli  │         │ connect-cli  │          │ connect-cli  │
  │  · Otto      │         │  · Frida     │          │  · Felix-bot │
  │  · Angel     │         │  · Marketing │          │  · Tax-bot   │
  └──────────────┘         └──────────────┘          └──────────────┘
```

Owner posts a brief to channel `#listings` → hub fans out to every agent
subscribed to `#listings` regardless of which PC they live on. Each
connect-client pulls its agents' briefs and delivers them locally
(stdin pipe, terminal paste, or HTTP webhook).

## MCP tools (hub-side)

- `mem_connect_register({ agent_name, display_name, host, pid, skills, meta })`
  — register an agent on startup
- `mem_connect_heartbeat({ agent_name, status })` — every 30–60 s
- `mem_connect_list({ only_online })` — see who is up
- `mem_connect_channel_upsert({ name, description })` — create channels
- `mem_connect_channel_subscribe({ channel, agent_name })` — agent joins a channel
- `mem_connect_channel_post({ channel, content, source_agent, require_skill })`
  — fan a brief out to all subscribers (optionally filtered by skill)
- `mem_connect_channel_list()` — list channels with subscriber counts
- `mem_brief_pull({ agent_name })` — agent (or its dispatcher) pulls work

## Run

### Hub

```sh
MNEMO_HTTP_PORT=7117 node packages/core/daemon.js
```

### Connect-client (Node, stdin-pipe)

```sh
MNEMO_URL=http://hub.example.com:7117 \
  node packages/connect/client.js \
    --agent otto-pc3 \
    --display "Otto (Backend on PC #3)" \
    --skills scraper,postal,deploy \
    --channels listings,deploy \
    --pipe /tmp/otto.in
```

### Connect-client (Windows terminal-paste)

```powershell
$env:MNEMO_URL = "http://hub.example.com:7117"
powershell -ExecutionPolicy Bypass -File .\packages\connect\client.ps1 `
  -Agents otto,frida `
  -Channels listings,deploy
```

Set the Windows Terminal tab title to `Otto` / `Frida` so the dispatcher can
paste into the right terminal.

## Skills + routing

Each agent advertises an array of skills. When a brief is posted with a
`require_skill` filter, only subscribers whose skills include that string get
a copy. This is how the same channel can serve multiple agent classes (e.g.
`#deploy` channel routes a `require_skill: postgres` brief only to the agents
that can do Postgres).

## Auth (Phase 1)

Phase 0 (this doc) trusts the network — fine for Tailscale-only or local.
Phase 1 will add per-agent token + signed brief envelopes; the schema already
reserves a `meta_json` column for it.
