## What

<!-- One-paragraph summary. What does this PR change in user-visible terms? -->

## Why

<!-- Motivation: bug, feature, scar-fix, owner directive, or linked memory. -->

## Touched layers

- [ ] MCP tools (`packages/core/mcp.js`)
- [ ] Hub daemon (`packages/core/daemon.js`)
- [ ] Schema / migrations (`schema.sql`, `identity_schema.sql`)
- [ ] Facts templates / private-facts loading (`packages/core/facts/*`)
- [ ] Channel adapters (`packages/core/channels/*`)
- [ ] Hooks (`packages/core/hooks/*`)
- [ ] Docs (`AGENTS.md`, README, examples)
- [ ] CI / repo policy

## Verification

<!-- Say exactly what ran: node --check, smoke-test, manual tool call, screenshot, or CI. -->

## Schema impact

- [ ] No schema change
- [ ] Additive only (CREATE TABLE IF NOT EXISTS, new column with default)
- [ ] Breaking - backfill / migration plan below

<!-- If breaking, describe how existing rows survive. -->

## Agent / runtime impact

<!-- Does this affect what agents can do, see, or enforce? -->
- [ ] Pure internal change, no agent surface
- [ ] New tool exposed via MCP and/or Hub (list names)
- [ ] Changed behavior of an existing tool (note the diff)
- [ ] Changed runtime hook behavior (list blocking rules)

## Public-release hygiene

- [ ] No private facts, customer names, server paths, credentials, or local DB/log files committed
- [ ] Examples use placeholders or `example-*` files only
- [ ] Install flow still works for a new owner with a fresh scope

## Owner sign-off

<!-- Per CODEOWNERS, core, hooks, facts templates, and repo policy need maintainer review. -->
