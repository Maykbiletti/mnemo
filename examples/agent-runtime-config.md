# Wiring Mnemo Into An Agent Runtime

This is the neutral setup for persistent memory, identity, project rules, and
runtime hooks. Replace every example value with your own local scope, owner, and
agent names.

## 1. Install

```bash
git clone https://github.com/Maykbiletti/mnemo.git
cd mnemo/packages/core
npm install
npm run bootstrap
```

The bootstrap asks for:

- owner name
- private scope name
- primary agent name
- optional additional agents
- mission
- first project/workspace

It creates local ignored files:

- `packages/core/.env.local`
- `.mnemo-hook.env`
- `packages/core/facts/<scope>.json`
- `packages/core/facts/<scope>-project-rules.json`

## 2. Start Daemon

```bash
npm run daemon
```

Remote agents should use your own hub URL:

```bash
export MNEMO_HUB_URL=https://your-domain.example/mnemo
```

Leave `MNEMO_HUB_URL` empty for purely local use.

## 3. Register MCP

Register `packages/core/mcp.js` as a stdio MCP server in your agent client:

```bash
node /absolute/path/to/mnemo/packages/core/mcp.js
```

## 4. Runtime Hook

Use the same hook script for each lifecycle event:

```bash
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js session-start
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js user-prompt
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js pre-compact
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js pre-tool
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js post-tool
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js stop
node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js session-end
```

For runtimes with named lifecycle hooks, wire each event to the matching command:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js session-start" }] }],
    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js user-prompt" }] }],
    "PreCompact": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js pre-compact" }] }],
    "PreToolUse": [{ "matcher": "Read|Edit|Write|MultiEdit|Bash|Grep|Glob", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js pre-tool" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js post-tool" }] }],
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js stop" }] }],
    "SessionEnd": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/mnemo/packages/core/hooks/firm-runtime-hook.js session-end" }] }]
  }
}
```

`UserPromptSubmit` is the hard memory gate: every user prompt is captured through
`mem_capture_ingest`, the current runtime transcript tail is synced, relevant
prior conversations are recalled, and the resulting Mnemo context is injected
back into the runtime. `PreCompact` syncs the transcript before compaction so
context compression cannot become a memory-loss event. `PostToolUse` captures a compact
tool observation for all tools, not only edits. `Stop` and `SessionEnd` write a
summary memory plus final hook status for Mission Control. If the hub is down,
hook writes are queued locally and flushed on the next hook event.

Recommended environment:

```bash
export MNEMO_AGENT=agent
export MNEMO_OWNER_NAME=owner
export MNEMO_SCOPE=personal
export MNEMO_DEFAULT_SCOPE=personal
export MNEMO_FACTS_DIR=/absolute/path/to/mnemo/packages/core/facts
export MNEMO_PROJECT="Example Project"
export MNEMO_HOOK_BLOCK=0
export MNEMO_AUTO_CLAIM=1
export MNEMO_REQUIRE_AUTO_CLAIM=1
export MNEMO_REQUIRE_PROJECT=1
export MNEMO_REQUIRE_TASK=1
export MNEMO_REQUIRE_FILES_FOR_EDIT=1
export MNEMO_REQUIRE_PROJECT_RULES=1
export MNEMO_BLOCK_HIGH_FINDINGS=1
export MNEMO_ENFORCE_CLEAN_WORK=1
export MNEMO_BLOCK_DIRTY_DEPLOY=1
export MNEMO_REQUIRE_IDENTITY_CHECK=1
export MNEMO_REQUIRE_OWNER_TASTE_CHECK=1
export MNEMO_BLOCK_WITHOUT_OWNER_TASTE=1
export MNEMO_REQUIRE_TOKEN_EFFICIENT_MEMORY=1
export MNEMO_MAX_MEMORY_FETCH_IDS=8
export MNEMO_REQUIRE_SMART_CODE_READ=1
export MNEMO_SMART_CODE_READ_MIN_BYTES=20000
export MNEMO_REQUIRE_CHAT_CAPTURE=1
export MNEMO_REQUIRE_PROMPT_RECALL=1
export MNEMO_CAPTURE_TOOL_OBSERVATION=1
export MNEMO_CAPTURE_SESSION_SUMMARY=1
export MNEMO_HOOK_QUEUE_ON_FAILURE=1
export MNEMO_HOOK_FLUSH_ON_EVENT=1
export MNEMO_HOOK_QUEUE_DIR="$HOME/.mnemo/hook_queue"
export MNEMO_TRANSCRIPT_SYNC_LINES=180
export MNEMO_PROMPT_RECALL_LIMIT=8
export MNEMO_ALLOW_AUTONOMOUS_LOW_RISK_IDEAS=1
export MNEMO_REQUIRE_REMAINING_CHECK=1
export MNEMO_BLOCK_STOP_WITHOUT_REMAINING=1
export MNEMO_REQUIRE_STOP_SUMMARY=1
export MNEMO_REQUIRE_STOP_NEXT_ACTIONS=1
export MNEMO_DIRTY_INCLUDE_UNTRACKED=0
export MNEMO_ALLOW_DESTRUCTIVE=0
```

Flip `MNEMO_HOOK_BLOCK=1` only after smoke tests pass.

Run the doctor after wiring hooks or after any hub restart:

```bash
mnemo-hook-doctor
mnemo-hook-doctor --flush
```

## 5. Alias Smoke

Project aliases are local and ignored. Example:

```json
{
  "mnemo": "Example Project",
  "example-project": "Example Project"
}
```

Save as `.mnemo-project-aliases.json`, then run:

```bash
unset MNEMO_PROJECT
printf '{"tool_name":"Read","tool_input":{"file_path":"AGENTS.md"},"task":"alias smoke"}' \
  | MNEMO_AGENT=agent MNEMO_SCOPE=personal MNEMO_REQUIRE_PROJECT_RULES=1 MNEMO_BLOCK_HIGH_FINDINGS=0 MNEMO_AUTO_CLAIM=0 MNEMO_REQUIRE_AUTO_CLAIM=0 node packages/core/hooks/firm-runtime-hook.js pre-tool
```

Expected:

- `project_info.name` is your canonical project name
- `preflight.status` is not blocked by a missing alias
- no private company data appears in the public repo

## 6. Seed Rules

Use the private project-rule seed created by bootstrap:

```bash
curl -sS -X POST "$MNEMO_HUB_URL/tool/mem_project_rules_seed_defaults" \
  -H 'content-type: application/json' \
  -d '{"scope":"personal","updated_by":"agent"}'
```

Or call `mem_project_rules_set` manually for each project.

## 7. Token-Efficient Memory Pattern

Agents should follow:

1. `mem_session_brief({token_budget: 250})`
2. `mem_recall_ids(query, limit: 10)`
3. `mem_timeline(...)` or `mem_neighbors(id)`
4. `mem_get(ids)` only for selected IDs
5. `mem_session_handoff(...)` with the distilled outcome

Do not fetch full memory rows just to skim them.
