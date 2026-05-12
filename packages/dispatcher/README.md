# Mnemo Brief Dispatcher

Pulls pending briefs from Mnemo's `agent_brief` table for one or more named
agents and delivers them to local agent windows.

Two transports are planned:

- **stdin pipe**: a dispatcher writes the brief to a named pipe or FIFO that
  the agent process reads from.
- **terminal paste**: the PowerShell dispatcher finds the target terminal tab by
  title, focuses it, sets the clipboard, and presses Ctrl+V + Enter.

The dispatcher is a thin client. Mnemo remains the source of truth:

- Orchestrator drops a brief via `mem_brief_drop({ agent_name, content })`.
- Dispatcher pulls via `mem_brief_pull({ agent_name })`.
- Agent reports via `mem_brief_done({ id, status: "done", outcome })`.

## Run (Windows terminal-paste mode)

```powershell
$env:MNEMO_URL = "http://127.0.0.1:7117"
powershell -ExecutionPolicy Bypass -File .\dispatcher.ps1 -Agents agent-a,agent-b
```

Set each Windows Terminal tab title to the agent id, for example `agent-a` and
`agent-b`.
