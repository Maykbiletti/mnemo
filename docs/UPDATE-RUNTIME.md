# Updating A Local Mnemo Install

Use this when a local agent machine already has a git clone of Mnemo and needs
to pull the latest public core.

## Steps

```bash
cd /path/to/mnemo
git fetch origin
git checkout main
git pull --ff-only origin main

cd packages/core
npm install
node --check mcp.js
node --check daemon.js
node --check hooks/firm-runtime-hook.js
```

If you run a local daemon:

```bash
npm run daemon
```

or restart your process manager.

## Private Files

The public repo does not ship private facts or project rules. Keep these local
and ignored:

- `packages/core/.env.local`
- `.mnemo-hook.env`
- `.mnemo-project-aliases.json`
- `packages/core/facts/<scope>.json`
- `packages/core/facts/<scope>-project-rules.json`
- `mnemo.db`, `mnemo.db-shm`, `mnemo.db-wal`
- `daemon.log.*`

If this is a fresh install, run:

```bash
npm run bootstrap
```

## Hook Activation

Do not enable blocking hooks immediately after a pull. First run a smoke test:

```bash
MNEMO_HOOK_BLOCK=0 \
MNEMO_REQUIRE_PROJECT_RULES=1 \
MNEMO_BLOCK_HIGH_FINDINGS=0 \
MNEMO_AUTO_CLAIM=0 \
MNEMO_REQUIRE_AUTO_CLAIM=0 \
node packages/core/hooks/firm-runtime-hook.js pre-tool <<'JSON'
{"tool_name":"Read","tool_input":{"file_path":"AGENTS.md"},"task":"hook smoke"}
JSON
```

Expected:

- `project_info.name` is the canonical project you intended
- identity check can read `mem_session_brief`
- token-efficiency policy is present
- missing project rules are fixed before `MNEMO_HOOK_BLOCK=1`

Use `.mnemo-project-aliases.json` or `MNEMO_PROJECT_ALIASES` for local aliases.
Do not hard-code private project names in public hook code.

## When A Smoke Test Fails

- Syntax failure: resolve the pull/merge conflict first.
- Unknown tool: daemon or MCP server is still old; restart it.
- Missing facts: run bootstrap or create `<scope>.json` from
  `packages/core/facts/example.json`.
- Missing project rules: create `<scope>-project-rules.json` from the example
  template or call `mem_project_rules_set`.
- Wrong project alias: update ignored local alias config before enabling block
  mode.
