# Mnemo Connect

The coordination layer for distributed AI workforces.

A typical setup has one **hub** (a server running the Mnemo daemon) and many
**connect-clients** running on user PCs. Each connect-client registers local
agents - coding CLIs, interactive sessions, or headless bots - with the hub and
watches for briefs addressed to them.

The hub is the single source of truth for agent registry, channels,
subscriptions, briefs, and memory. Clients are stateless.

## Topology

```text
                    Mnemo Hub (HTTP)
                 agent_registry + briefs
                            |
         -----------------------------------------
         |                   |                   |
  Workstation A       Workstation B       Workstation C
  - agent-a           - agent-b           - ops-bot
  - frontend          - researcher        - tax-bot
```

An owner or orchestrator posts a brief to channel `#deploy`; the hub fans it
out to every subscribed agent. Each connect-client pulls its agents' briefs and
delivers them locally by stdin pipe, terminal paste, or HTTP webhook.

## MCP tools (hub-side)

- `mem_connect_register({ agent_name, display_name, host, pid, skills, meta })`
- `mem_connect_heartbeat({ agent_name, status })`
- `mem_connect_list({ only_online })`
- `mem_connect_channel_upsert({ name, description })`
- `mem_connect_channel_subscribe({ channel, agent_name })`
- `mem_connect_channel_post({ channel, content, source_agent, require_skill })`
- `mem_connect_channel_list()`
- `mem_brief_pull({ agent_name })`

## Run

### Hub

```sh
MNEMO_HTTP_PORT=7117 node packages/core/daemon.js
```

### Connect-client (Node, stdin-pipe)

```sh
MNEMO_URL=http://hub.example.com:7117 \
  node packages/connect/client.js \
    --agent agent-a \
    --display "Agent A" \
    --skills scraper,deploy \
    --channels listings,deploy \
    --pipe /tmp/agent-a.in
```

### Connect-client (Windows terminal-paste)

```powershell
$env:MNEMO_URL = "http://hub.example.com:7117"
powershell -ExecutionPolicy Bypass -File .\packages\connect\client.ps1 `
  -Agents agent-a,agent-b `
  -Channels listings,deploy
```

Set each Windows Terminal tab title to the matching agent id so the dispatcher
can paste into the right terminal.

## Skills + routing

Each agent advertises an array of skills. When a brief is posted with a
`require_skill` filter, only subscribers whose skills include that string get a
copy. This lets one channel route specialized work without manual coordination.

## Auth

The first public skeleton trusts the network, which is acceptable only for
local or private-network setups. Production installs should add per-agent
tokens and signed brief envelopes.
