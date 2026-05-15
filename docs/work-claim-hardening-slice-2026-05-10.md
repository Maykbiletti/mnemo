## Work Claim Hardening Slice

Commit target: claim TTL, heartbeat, stale recovery, and non-file scope claims.

### Added

- `mem_work_heartbeat`
- non-file claim kinds via `mem_work_claim`
- stale claim recovery with `allow_takeover=true`
- broader duplicate-work checks via explicit claim targets

### Claim Model

`work_claim` now supports:

- `claim_kind`
- `scope_value`
- `scope_key`
- `heartbeat_at`
- `stale_after_sec`
- `released_at`
- `takeover_count`
- `meta_json`

Old file-path claims remain valid. Existing rows are backfilled to:

- `claim_kind=file`
- `scope_value=file_path`
- `scope_key=file:<normalized path>`

### Supported Claim Kinds

- `file`
- `route`
- `domain`
- `server`
- `task`
- `service`
- generic custom scope kinds

### Behavior

- active claims expire at `expires_at`
- active claims become `stale` if heartbeat age exceeds `stale_after_sec`
- another agent can recover a stale claim with `allow_takeover=true`
- same-agent reclaims refresh TTL and heartbeat

### Example Calls

```json
mem_work_claim({
  "project": "Example Account",
  "file_path": "src/routes/auth.js",
  "agent_name": "otto",
  "summary": "auth refactor",
  "ttl_minutes": 120
})
```

```json
mem_work_claim({
  "project": "Example Account",
  "claim_kind": "route",
  "scope_value": "/account/login",
  "agent_name": "alfred",
  "summary": "login flow repair",
  "stale_after_sec": 900
})
```

```json
mem_work_heartbeat({
  "project": "Example Account",
  "claim_kind": "route",
  "scope_value": "/account/login",
  "agent_name": "alfred",
  "ttl_minutes": 120
})
```

```json
mem_work_claim({
  "project": "Example Account",
  "claim_kind": "route",
  "scope_value": "/account/login",
  "agent_name": "otto",
  "allow_takeover": true
})
```

```json
mem_duplicate_work_check({
  "agent_name": "otto",
  "project": "Example Account",
  "task": "repair login flow",
  "files": ["src/routes/auth.js"],
  "claims": [{ "claim_kind": "route", "scope_value": "/account/login" }]
})
```

### Local Smoke

- file claim blocks another agent
- route claim heartbeat refreshes
- stale route claim can be taken over
