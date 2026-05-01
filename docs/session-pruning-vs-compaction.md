# Session pruning vs context compaction

These two mechanisms get conflated; they are not the same and the difference matters for cost + correctness.

## Pruning (in-memory, ephemeral)

**What it is:** trimming old tool-results out of the live conversation context **without** touching the durable transcript on disk. The agent keeps recent tool-output in its working window; older tool-output is dropped from the window but still recoverable from the JSONL session file or from Mnemo.

**When to do it:** when the conversation window is approaching the model's context limit but you don't want to invalidate the prompt cache. Pruning the *tail* of tool-results (oldest first) keeps the *prefix* identical, which is what the cache hashes.

**Cache implication:** If you preserve the system-prompt + first N rounds verbatim and only drop tool-results from the middle/older sections in a non-prefix-stable way, you **lose the cache hit** on the next message. Pruning that respects prefix-stability is the only kind that's economical.

**Anthropic prompt-cache TTL:** 5 minutes default (longer with extended-cache). Plan pruning passes around that TTL — don't prune mid-window if you're going to need the same context within the cache window.

**Implementation:** done by your client (Claude Code, Cursor, your own loop) — Mnemo doesn't manage your live context. Mnemo gives you `mem_recall` to fetch back what was pruned.

## Compaction (durable, transcript-mutating)

**What it is:** rewriting the durable transcript so a long conversation gets summarized into a shorter form. Loses fidelity. Permanent.

**When to do it:** rarely. Only when a session is "complete" and you want a low-fidelity record. Or when storage is a concern and you've extracted everything important via Mnemo first.

**Atomicity rule:** every `tool_call` must stay paired with its matching `tool_result`. Compacting one without the other corrupts the conversation — many models will refuse to continue or produce nonsense. Always compact in pairs.

**Cache implication:** compaction invalidates everything downstream of the rewrite point. Don't compact mid-active-session unless you accept the cache-flush.

**Implementation:** rare in Mnemo's workflow. Mnemo prefers to *index* rather than *compact* — your full transcript is in `memory.text` and FTS5/vec_memory finds what matters without you needing to summarize destructively.

## Practical guidance

- **Default:** don't compact. Prune at the tail with prefix-stability. Use Mnemo for recall.
- **If you must compact:** keep tool_call/tool_result pairs atomic. Mark the compaction point with a `memory.kind = 'compaction_marker'` row so you can find it later.
- **If you must prune mid-session:** time it for between cache windows (>5 min idle), not within an active back-and-forth.
- **Quote actual durations from `mem_duration_history`** instead of guessing how long compaction will take — measurements beat estimates.

## Why this matters for Mnemo specifically

Mnemo's promise is "you never lose context." That promise relies on the agent treating Mnemo as the canonical store and treating the live conversation window as a *cache* of recently-relevant rows. Pruning is fine because Mnemo holds the truth. Compaction is dangerous because it loses fidelity that Mnemo can't reconstruct after the fact.

If you find yourself compacting often, you're probably under-using `mem_recall` — surface a row and link to it instead of summarizing the whole exchange inline.
