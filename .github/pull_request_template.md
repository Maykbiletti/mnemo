## What

<!-- One-paragraph summary. What does this PR change in user-visible terms? -->

## Why

<!-- The motivation. Bug? Feature? Scar-fix? Mayk-Direktive? Link the conversation
or memory file if it exists. -->

## Touched layers

- [ ] MCP tools (`packages/core/mcp.js`)
- [ ] Hub daemon (`packages/core/daemon.js`)
- [ ] Schema / migrations (`schema.sql`, `identity_schema.sql`)
- [ ] Canonical facts (`packages/core/facts/*.json`)
- [ ] Channel adapters (`packages/core/channels/*`)
- [ ] Hooks (`.claude/hooks/*`)
- [ ] Docs (`AGENTS.md`, `MEMORY.md`, README)
- [ ] CI / repo policy

## Verification

<!-- How did you confirm this works? `node --check`, smoke-test, manual tool call,
screenshot, or "CI is enough". Don't say "looks fine" — say what you actually ran. -->

## Schema impact

<!-- If you added/changed a table or column: -->
- [ ] No schema change
- [ ] Additive only (CREATE TABLE IF NOT EXISTS, new column with default)
- [ ] Breaking — backfill / migration plan below

<!-- If breaking, describe how existing rows survive. -->

## Agent / firm-OS impact

<!-- Does this affect what other agents can do or see? -->
- [ ] Pure internal change, no agent surface
- [ ] New tool exposed via MCP and/or Hub (list names)
- [ ] Changed behavior of an existing tool — note the diff

## Owner sign-off

<!-- Per CODEOWNERS, paths under packages/core/, .github/, .claude/, and facts/
need Dieter (Mayk) review. Paths owned by Angel/Otto/Frida/Alfred should ping
the corresponding operator. -->
