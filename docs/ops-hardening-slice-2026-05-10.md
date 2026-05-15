# Ops Hardening Slice

This slice hardens Mnemo around identity, evidence, maintenance windows, freezes, overrides, incidents, and search reindexing.

## Included

- Agent identity loaded at `mem_session_start`
- Identity snapshot stored in `mem_session_handoff`
- Evidence required for new handoffs unless `meta.allow_legacy_no_evidence=true`
- Maintenance window registry and checks
- Dependency freeze registry and checks
- Temporary override log
- Secret rotation log
- Durable incident register
- Machine-readable status board
- Learning-loop report from drift/findings/scars
- Search reindex for `mnemo_search_fts`

## New Tables

- `maintenance_window`
- `override_log`
- `secret_rotation_log`
- `dependency_freeze`
- `ops_incident`

## New Tools

- `mem_maintenance_window_upsert`
- `mem_maintenance_window_list`
- `mem_maintenance_window_check`
- `mem_override_log`
- `mem_override_list`
- `mem_override_check`
- `mem_secret_rotation_log`
- `mem_secret_rotation_list`
- `mem_freeze_set`
- `mem_freeze_list`
- `mem_freeze_check`
- `mem_incident_report`
- `mem_incident_list`
- `mem_status_board`
- `mem_learning_loop_report`
- `mem_search_reindex`

## Changed Behavior

- `mem_write_gate_check` now also checks:
  - active dependency freezes
  - active maintenance windows for high-risk work
- `mem_session_start` now returns:
  - `agent_passport`
  - `status_board` for the selected project
- `mem_session_handoff` now:
  - rejects empty evidence by default
  - stores `identity_context` in handoff meta
  - stores structured evidence in handoff meta

## Evidence Shape

Each evidence row should contain:

- one target field such as `url`, `file_path`, `server`, `pm2`, `nginx`, `screenshot_path`, `json_ref`, `curl_ref`, or `browser_ref`
- `test_step`
- `result`
- `timestamp`

## Example Calls

```json
mem_status_board({ "projects": ["Example Main"] })
```

```json
mem_search_reindex({ "scopes": ["transcript", "brief"], "limit": 5000, "reset": true })
```

```json
mem_maintenance_window_upsert({
  "project": "Example Main",
  "title": "Auth rollout window",
  "starts_at": "2026-05-10T20:00:00.000Z",
  "ends_at": "2026-05-10T22:00:00.000Z",
  "risk_class": "live-risk",
  "approved_by": "dieter"
})
```

```json
mem_freeze_set({
  "project": "Example Main",
  "reason": "Shared auth migration in progress",
  "approved_by": "dieter"
})
```

```json
mem_session_handoff({
  "agent_name": "alfred",
  "project": "Example Main",
  "summary": "Verified login shell route",
  "evidence": [
    {
      "url": "https://example.org/login",
      "test_step": "GET /login",
      "result": "200 ok",
      "timestamp": "2026-05-10T20:00:00.000Z"
    }
  ]
})
```

## Local Smoke

- `node --check packages/core/mcp.js`
- `node --check packages/core/daemon.js`
- `mem_status_board({ "projects": ["Example Main"] })` -> ok
- `mem_search_reindex({ "scopes": ["transcript"], "limit": 50, "reset": true })` -> ok
- `mem_session_handoff(...)` without evidence -> `evidence_required`
- `mem_session_handoff(...)` with evidence -> ok

## Not In This Slice

- explicit runtime identity drift blocker outside existing passport/load path
- additional claim types beyond current task/file overlap logic
- remote deployment of this slice to the hub
- broader docs merge into existing MCP docs
