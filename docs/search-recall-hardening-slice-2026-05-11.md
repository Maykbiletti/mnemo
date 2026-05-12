# Search / Recall Hardening Slice — 2026-05-11

This slice closes the gap where Telegram/group/brief/transcript backfill was present in Mnemo but not reliably reachable through `mem_recall`.

## What changed

- `mem_recall` now searches two surfaces:
  - `memory_fts` for canonical memory rows
  - `mnemo_search_fts` for indexed `transcript`, `brief`, and `event` rows
- `mem_recall_ids` now returns:
  - `surface`
  - `ref_id`
  - `id` only for real `memory` rows
- `mem_search_reindex` now reports per-scope status:
  - `available`
  - `indexed_before`
  - `indexed_after`
  - `inserted`
  - `has_more`
  - `remaining_estimate`

## Why

The previous recall path only searched `memory_fts`. That meant:

- transcript backfill could exist
- brief/event history could exist
- the universal capture could be working
- but `mem_recall` still missed it

This slice makes recall follow the same searchable journal surface already used elsewhere in Mnemo.

## New recall behavior

`mem_recall` accepts two optional fields:

- `include_journal` (default: `true`)
- `journal_scopes` (default: `["transcript","brief","event"]`)

`mode="semantic"` remains memory-oriented. Journal hits are FTS-backed.

## Example calls

```json
mem_recall({
  "query": "Ping-Dieter",
  "limit": 12
})
```

```json
mem_recall({
  "query": "redirect_uri_mismatch",
  "include_journal": true,
  "journal_scopes": ["brief", "event"],
  "limit": 20
})
```

```json
mem_recall_ids({
  "query": "mission control",
  "limit": 25
})
```

```json
mem_search_reindex({
  "scopes": ["transcript", "brief", "event"],
  "limit": 50000,
  "reset": true
})
```

## Operational note

For large historical imports, `mem_search_reindex` may need to run with a high limit or in repeated passes until `remaining_estimate` reaches `0`.

## Files

- `packages/core/mcp.js`
- `packages/core/daemon.js`
