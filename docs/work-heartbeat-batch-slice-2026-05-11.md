# Work Heartbeat Batch Slice — 2026-05-11

This slice cleans up the work-claim tool surface and adds a batch heartbeat path.

## What changed

- Added `mem_work_heartbeat_batch`
- Added `handleWorkHeartbeatBatch(...)` in:
  - `packages/core/mcp.js`
  - `packages/core/daemon.js`
- Removed the obsolete duplicate legacy work-claim tool block from `mcp.js`
- Matched the daemon `stripPrivate(...)` fast-path to the MCP implementation

## Why

Two problems existed:

1. Agents had to refresh claim heartbeats one-by-one
2. `mcp.js` still exposed an older duplicate work-claim tool block alongside the newer TTL/scope-aware claim system

That left the surface noisier than necessary and made the server worktree drift.

## New tool

```json
mem_work_heartbeat_batch({
  "agent_name": "dieter",
  "project": "Mnemo Firm-OS",
  "ttl_minutes": 180
})
```

Returns:

- `refreshed`
- `heartbeat_at`
- list of refreshed claim ids/scope values

## Files

- `packages/core/mcp.js`
- `packages/core/daemon.js`
