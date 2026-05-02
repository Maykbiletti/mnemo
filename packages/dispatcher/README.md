# Mnemo Brief Dispatcher

Pulls pending briefs from Mnemo's `agent_brief` table for one or more named
agents and delivers them. Two transports are supported:

- **stdin pipe** (any OS): the dispatcher writes the brief to a named pipe /
  FIFO that the agent's process reads from. Cleanest for headless agents.
- **terminal paste** (Windows + Windows Terminal): the dispatcher finds the
  Codex / Claude Code window by tab-title, focuses it, sets the clipboard,
  and presses Ctrl+V + Enter. Fragile but lets you keep an interactive REPL.

The dispatcher is a thin client. The source-of-truth is Mnemo:
- Orchestrator drops a brief via `mem_brief_drop({ agent_name, content })`.
- Dispatcher pulls via `mem_brief_pull({ agent_name })` (marks dispatched).
- Agent reports via `mem_brief_done({ id, status: "done", outcome })`.

## Run (Windows terminal-paste mode)

```powershell
$env:MNEMO_URL = "http://127.0.0.1:7117"
powershell -ExecutionPolicy Bypass -File .\dispatcher.ps1 -Agents otto,frida
```

Set the Windows Terminal tab title for each agent so the dispatcher can find
the window: right-click tab -> Rename Tab -> "Otto" / "Frida".

## Run (Node, stdin-pipe mode)

```sh
MNEMO_URL=http://127.0.0.1:7117 node dispatcher.js --agent otto --pipe /tmp/otto.in
```

Then start the agent with `cat /tmp/otto.in | <agent-cmd>` or have the agent
read from the FIFO.
