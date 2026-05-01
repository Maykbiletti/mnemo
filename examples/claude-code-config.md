# Wiring Mnemo into Claude Code

This shows the minimal config to give Claude Code persistent memory + identity via Mnemo.

## 1. Install Mnemo

```bash
git clone https://github.com/Maykbiletti/mnemo.git ~/mnemo
cd ~/mnemo/packages/core
npm install
node bin/mnemo.js init
```

## 2. Register the MCP server

```bash
claude mcp add mnemo --transport stdio -- node ~/mnemo/packages/core/mcp.js
claude mcp list | grep mnemo   # confirm it's registered
```

## 3. Optional: log every Claude Code hook into Mnemo

Add to your `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [{
          "type": "command",
          "command": "node ~/mnemo/packages/core/hooks/log-prompt.js"
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "mcp__plugin_telegram_telegram__reply",
        "hooks": [{
          "type": "command",
          "command": "node ~/mnemo/packages/core/hooks/log-telegram-reply.js"
        }]
      }
    ]
  }
}
```

(The hooks are minimal Node scripts that POST a JSON event to `http://127.0.0.1:7117/ingest`.)

## 4. Use it from inside Claude

```
> mem_who_am_i()
> mem_recall("what did I decide about migrations last week")
> mem_promise_open()
> mem_skill_search("buch mir nen flug")
> mem_timeline({from: "2026-04-15", to: "2026-04-22"})
```

## 5. Daily reflection loop

Run nightly (cron `0 23 * * *`):

```bash
node ~/mnemo/packages/core/mcp.js
# in client: mem_reflect()
```

Or directly:

```bash
node -e "require('child_process').spawnSync('node', ['mcp.js'], { stdio: 'inherit' })"
```

## What this gives you

- Every Claude Code conversation persists in `mnemo.db`.
- Your agent's identity (values, traits) lives in DB rows, not the system prompt.
- `mem_recall` works across all your past sessions, not just the current context window.
- `mem_promise_open` surfaces commitments you made and never followed up on.
- `mem_who_am_i` gives any new chat a 4-line snapshot of who you are.
