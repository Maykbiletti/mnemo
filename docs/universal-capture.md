# Universal Capture

Mnemo stores two layers for work memory:

- `mnemo_event_journal`: raw receipts for every channel, command, tool call, result, bridge message, status change, and small text fragment.
- `memory`, `transcript`, `agent_action`, `agent_brief`: searchable working layers for facts, conversations, actions, and assignments.

The rule is simple: if an agent saw it, said it, did it, changed it, verified it, used access for it, or got blocked by it, Mnemo needs a receipt.

## Required Write Paths

- New channel/session importers should use `mem_capture_ingest` as their front door. It writes an idempotent `capture_receipt`, a raw journal receipt, and optional transcript/memory rows.
- Human or agent chat text: `mem_transcript_log`
- Raw bridge/tool/CLI receipt: `mem_event_log`
- Work started or finished: `mem_action_log` and `mem_action_finish`
- Agent assignment: `mem_brief_drop`, `mem_brief_pull`, `mem_brief_done`
- Access route discovered or verified: `mem_access_guide`, `mem_access_upsert`, and `mem_access_event_log`
- Durable fact, decision, preference, correction: `mem_add`, `mem_decision_log`, or `mem_correction_capture`

## Access Inventory

Store how to reach a system, not the secret itself.

There should be one fixed place to look first: `mem_access_guide`. Humans and
agents should read that before asking where a server, repo, admin, dashboard,
API, database, or provider lives. If the route already exists there, reuse it.
If it does not exist, add it with `mem_access_upsert` and immediately log the
verification with `mem_access_event_log`.

This is mandatory for operational agents. Access knowledge belongs in Mnemo,
not only in chat history.

Use `secret_ref` for labels such as an env var name, key-file name, password-manager item, vault path, or server note. Do not store raw tokens, passwords, private keys, customer data, or billing secrets in Mnemo.

Example:

```json
{
  "system_name": "example-production",
  "access_kind": "ssh",
  "entrypoint": "root@example.org",
  "account_hint": "root",
  "secret_ref": "SSH key label or env var name",
  "project": "Example",
  "updated_by": "agent-name"
}
```

## Health Check

Use `mem_source_coverage` to see which sources wrote events recently. If a channel has no recent journal rows, treat that as a broken bridge until proven otherwise.

Use `mem_event_recent` before asking the owner what happened yesterday. Use `mem_actions_search` before repeating work.

## Capture-By-Default Rule

Every new bridge, bot, console lane, CLI loop, webhook, queue, or chat channel must be connected to universal capture when it is created. Capture is opt-out only through explicit local policy. A bot/listener without capture is not production-ready.

Do not silently drop burst messages, duplicate-looking messages, or throttled messages. If a message is not promoted to transcript or semantic memory, write an audit receipt with the reason. `mem_capture_ingest` handles this by updating `capture_receipt.seen_count` and writing a `capture_duplicate` event for duplicate skips.

Keep public repos neutral: put private chat IDs, names, customer details, and project-specific channels in local runtime configuration or personal packs, not in committed source.

## Claude Code Memory Hooks

Claude Code runtimes must treat context compaction as a capture event, not as a
memory boundary. Wire the firm runtime hook to:

- `SessionStart`: load the canonical session bundle and inject it as context.
- `UserPromptSubmit`: capture the exact user prompt, sync the transcript tail,
  recall prior conversations/solutions, and inject the hits before the answer.
- `PreCompact`: sync the transcript tail and write a compaction snapshot before
  Claude compresses context.
- `PostToolUse`, `Stop`, and `SessionEnd`: keep recent transcript turns,
  handoffs, and final hook status fresh.

When `MNEMO_REQUIRE_CHAT_CAPTURE=1` and `MNEMO_REQUIRE_PROMPT_RECALL=1`, failed
prompt capture or failed prior-context recall is a blocker if the runtime has
`MNEMO_HOOK_BLOCK=1`. This is deliberate: an agent should not continue blind
after losing access to the shared memory layer.

Use `mem_agent_memory_health` in Mission Control to see whether each agent's
hooks are alive, when it last captured a prompt, whether transcript sync passed,
and whether prior recall ran before answering.

## Memory-Private Tags

Anything inside memory-private tags is redacted before persistence:

- `<private>...</private>`
- `<no-memory>...</no-memory>`
- `<mnemo-private>...</mnemo-private>`
- `[private]...[/private]`
- `<!-- mnemo:private -->...<!-- /mnemo:private -->`

Use these for sensitive local-only text. Do not put raw secrets, passwords,
private keys, tokens, customer data, or billing secrets in Mnemo even inside a
private tag; store a `secret_ref` instead.

## Dedup And Burst Safety

Dedup should use a stable `source_ref` when the upstream source provides one
such as message ID, event ID, file path plus line offset, or session item ID.
When no stable upstream ID exists, build the fallback hash from:

- source name
- conversation ID
- speaker or actor
- content hash
- `occurred_at` with millisecond precision when available
- media path or attachment ID when text is empty

Do not round timestamps to whole seconds for rapid-fire chat sources. Five
messages sent inside one second must still produce five receipts unless the
upstream source explicitly marks them as the same message.

Recommended smoke test for a live bridge:

1. Send five test messages in less than one second.
2. Query `mem_capture_recent` and `mem_event_recent`.
3. Confirm `seen=5`, `captured+duplicate=5`, and `drop=0`.
4. Record the result with `mem_source_coverage`.

## Attachments And Media

Text-free messages are still messages. Importers should create a receipt when a
message contains an image, file, voice note, sticker, or other attachment even
if the text body is empty.

Store local file references under metadata, for example:

```json
{
  "media_path": "./photos/photo_42.jpg",
  "media_type": "image/jpeg",
  "attachment_id": "42"
}
```

Do not embed binary file contents in `mnemo_event_journal` or `memory`. Store a
path or vault reference and let downstream tooling decide how to inspect the
asset.

## Reminders And Future Commitments

Future-dated owner requests are not normal chat. When an owner says things like
"remind me next week", "I have a meeting on Monday", or "ask me tomorrow",
capture a `reminder` row.

Use:

- `mem_reminder_capture` for natural chat text. It parses common German/English
  relative dates and stores `status=needs_due_at` if the date is ambiguous.
- `mem_reminder_add` when the exact `due_at` is already known.
- `mem_reminder_due` during loop heartbeat/startup.
- `mem_reminder_done` after the owner was reminded or the reminder is no longer
  needed.

The daemon dispatches due open reminders into `agent_brief` once, so a sleeping
agent gets a normal brief when it wakes. Never drop an ambiguous reminder. Store
it as `needs_due_at` and ask one short clarification when needed.

## Backfill

Historical exports should be replayed through `mnemo-backfill-universal`:

```bash
mnemo-backfill-universal --source auto --dry-run
mnemo-backfill-universal --source telegram --path "./ChatExport/result.json" --commit --batch-size 100
mnemo-backfill-universal --source agent --path "$HOME/.agent-sessions" --commit
mnemo-backfill-universal --source local-agent --agent-root "/path/to/agent-client-root" --commit
```

Default mode is dry-run. Use `--commit` to write to the daemon or hub. Commit mode uses `mem_capture_ingest_batch` by default so large exports do not waste one HTTP request per line. Use `--promote-memory none|owner|all` to control semantic memory volume; transcript and raw receipt capture remain separate so token-heavy history can stay searchable without flooding every recall.
