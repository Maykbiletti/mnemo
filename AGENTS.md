# AGENTS.md — Orientation for AI agents installing Mnemo

> If you are an AI agent (Claude Code, Cursor, Cline, GPT-based, etc.) and your owner just installed Mnemo for you to use, **read this first**. It tells you what Mnemo is, how to use it, and what to do at the start of every new conversation so you stop forgetting things between sessions.

## What Mnemo is for you

Mnemo is your **persistent memory + identity backbone**. Without it, every new session starts at zero — you don't remember the user's preferences, past commitments, recurring frustrations, prior decisions, or running projects. With it, you have a single SQLite-backed source of truth that:

- Logs every conversation (Telegram, terminal, hooks, manual ingest)
- Stores your owner's hard rules as `core_value` rows you must obey
- Tracks evolving traits about how you interact (so you can drift toward what's working and away from what isn't)
- Records every promise you make so you can check what's still open
- Indexes everything with FTS5 + vector embeddings for fast recall

You access it via the **MCP server** (`mcp.js`), exposed as 13 tools.

## Your start-of-conversation ritual

At the start of any non-trivial task, run this in order:

0. **`mem_session_brief({ token_budget: 250 })`** — your wake-up call. One tool call returns your identity, top traits, open promises, open commitments, today's signals, and recent decisions, all shaped to fit in a few hundred tokens. **Do this first, always.** It replaces the next 3-4 individual calls when you only need orientation. Use a larger `token_budget` if you have headroom.

1. **`mem_who_am_i()`** — full self-state when you need depth beyond `mem_session_brief`'s identity layer (every active value, every trait, last reflection in detail).

2. **`mem_recall(query)`** — search for context related to the user's request. Use `mode: "hybrid"` (default) which fuses keyword + semantic. If you don't know what to query, query whatever nouns or topics appear in the user's message.

3. **`mem_skill_search(query)`** — check if a recipe already exists for the task type. If so, follow it. **Never reinvent a recipe that has been recorded.** This is how Mnemo grows — the second time someone asks for a flight booking, you don't start from scratch.

4. **`mem_promise_open()`** — check what you've committed to and not yet delivered. Surfacing forgotten promises is one of the highest-value things you can do for your owner.

5. **`mem_commitment_due({ horizon_hours: 24 })`** — what does the owner have on their plate today? Surface time-sensitive items unprompted.

## During the task

- **`mem_task_start(task_type, description)`** when starting a non-trivial task. Returns an `id`.
- **`mem_task_finish(id, outcome)`** when done. Records actual duration → grows your `mem_duration_history` data → next time you can quote real numbers instead of guessing.
- **`mem_recall(...)`** any time you need historical context.
- **`mem_value_get`** / **`mem_belief_get`** / **`mem_trait_get`** when behavior questions come up ("am I supposed to...?").

## After the task

- **`mem_skill_record(...)`** if you just learned a new repeatable recipe. Future you (or any other agent on this Mnemo) gets that recipe via `mem_skill_search` next time.
- **`mem_add(kind, text, importance)`** for explicit memories you want to be sure stick: decisions, ratings, preferences. Set `importance: 7` or higher for things that should be embedded with high priority.
- **`mem_link(from_id, to_id, kind)`** if this task references / corrects / resolves a previous memory row.

## End of day

- **`mem_reflect()`** — runs the daily reflection cycle: counts corrections, praises, drift indicators. Writes a `daily_reflection` row. The next day you'll see "yesterday's focus" via `mem_who_am_i()`.

## What gets logged automatically (you don't have to do anything)

- Every Telegram message in/out (if Telegram is wired)
- Every URL the daemon is watching (status changes)
- Every correction-pattern match → automatic `scar_event` row + trait drift
- Hooks (if your client supports them) for: prompt submit, tool use, etc.

## What you must log explicitly

- Decisions you make autonomously that the owner should know about (`mem_add({kind: "decision", importance: 8, ...})`)
- Promises in your own messages — the open-loop scanner picks these up via regex but you can be explicit by setting `kind: "promise"`.
- New skills (`mem_skill_record`) — this is the loop that makes the system smarter.

## Hard rules

- **Read the owner's `core_value` rows on first message.** They are non-negotiable. The owner set them deliberately.
- **Read the `personality_trait` rows where `notes LIKE '%HARD_CAP%'`.** Those are locked floors/ceilings — never push past them even if the conversation seems to encourage it.
- **`mem_recall` before claiming "I don't know" or "I don't remember"** — most of the time, Mnemo does remember.
- **`mem_duration_history` instead of guessing time.** If you don't have data, say "I'll start, then tell you" — never invent ETAs.

## Channels

The owner may have wired Mnemo to Telegram (or later: WhatsApp, Email). If so, your replies to the owner go through the channel adapter, not console output. Check `channels/` for which are enabled.

## When in doubt

`mem_health()` shows you which writers are alive vs stale. If you see `dead` or `error:` next to a writer, surface it to the owner — Mnemo has a leak somewhere and you should fix it before it costs you context.

## Don't

- Don't bypass Mnemo to "just remember in your context window for now." That's how you forget tomorrow.
- Don't silently overwrite `core_value` rows. Adding/changing values needs explicit owner confirmation.
- Don't run skills marked `requires_confirmation: true` without an explicit owner "go".
- Don't paste the contents of `mnemo.db` anywhere outside the owner's machine. It contains everything they've ever told you.

## TL;DR

```
session_start:
  - mem_session_brief({token_budget: 250})        # one call → identity + open loops + today
  - mem_recall(<topic of user request>)           # only if request needs depth
  - mem_skill_search(<verb of user request>)      # don't reinvent
  - mem_commitment_due({horizon_hours: 24})       # what hits today
during_task:
  - mem_task_start / mem_task_finish for non-trivial work
after_task:
  - mem_skill_record if newly learned
  - mem_add for important explicit memories
day_end:
  - mem_reflect()
```

Mnemo is here so you can be a real assistant across sessions, not a goldfish in each one. Use it.
