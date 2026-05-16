# Memory Consolidation And REM

Mnemo treats memory as company infrastructure, not as loose chat history. External
runtimes such as OpenClaw can observe, execute, capture screenshots, and return
tool receipts, but they do not own durable truth. Mnemo remains the authority for
identity, claims, approvals, evidence, project rules, decisions, and promotion.

## Canonical Layers

- **Company Ledger**: official truth. Decisions, claims, approvals, evidence,
  incidents, handoffs, owner instructions, project rules, and resource ownership.
- **Department Journal**: department diary. Progress, blockers, risks, open
  questions, dependencies, and foreign-scope requests. This explains work but is
  not official truth until reviewed.
- **Agent Sleep Notes**: personal REM notes per agent. What the agent learned,
  where it was uncertain, repeated mistakes, needed context, and improvement
  ideas. These notes never set policy by themselves.
- **Session Layer**: raw conversation, capture receipts, transcripts, actions,
  and episodic memory.
- **Daily Layer**: daily reflection and day-level consolidation.
- **Long-Term Layer**: semantic memories, decisions, scars, rules, and stable
  project facts.
- **Recall Layer**: search surfaces such as `mem_recall`, `mem_recall_layered`,
  `memory_fts`, and `mnemo_search_fts`.
- **REM Layer**: `cycle_event` plus `memory_consolidation_run` records that
  extract patterns without deleting or overwriting old facts.

## REM Process

1. **Agent REM**: the agent writes `mem_agent_sleep_note_add` for personal
   lessons, uncertainty, repeated errors, and context needed tomorrow.
2. **Department REM**: a department writes `mem_department_journal_add` with
   progress, blockers, risks, dependencies, and foreign-scope requests.
3. **Company REM**: Mnemo runs `mem_memory_rem_run` in `light`, `daily`, `deep`,
   or `rem` phase. The run is a draft consolidation and produces selected source
   refs for review.
4. **Coordinator Review**: `mem_company_rem_brief` aggregates journals, sleep
   notes, promotion proposals, open claims, pending approvals, and REM status.
5. **Promotion**: agents propose durable facts with
   `mem_memory_promotion_propose`. Only `mem_memory_promotion_decide` with an
   explicit reviewer can approve, reject, or promote the proposal.

## Promotion Rules

REM is allowed to propose:

- `decision`
- `rule`
- `project_memory`
- `risk`
- `owner_question`
- `scar`
- `runbook`

REM is not allowed to silently rewrite official truth. Promotion requires a
reviewer, attribution, and an audit trail. Concrete project rules, protected
scope rules, access routes, and connector facts should still be written through
their dedicated Mnemo APIs after approval.

## OpenClaw Boundary

OpenClaw-style systems should use Mnemo like this:

1. Register runtime/channel state with `mem_runtime_binding_upsert`.
2. Register allowed tool/channel capabilities with
   `mem_runtime_capability_upsert`.
3. Open a tool receipt with `mem_runtime_tool_receipt_start`.
4. Execute only if the receipt is allowed.
5. Finish with `mem_runtime_tool_receipt_finish` and evidence.
6. Feed observations into Mnemo capture/journal APIs.
7. Let Mnemo handle consolidation, promotion, claims, approvals, and truth.

The rule is simple: OpenClaw is hands and eyes. Mnemo is memory, law, and audit.

## Example Calls

```json
{"tool":"mem_memory_layer_status","args":{"project":"account","days":7}}
```

```json
{"tool":"mem_agent_sleep_note_add","args":{"agent_name":"alfred","project":"account","learned":"Account settings own language and theme.","recurring_errors":"Portal-local popups get duplicated."}}
```

```json
{"tool":"mem_department_journal_add","args":{"department_name":"frontend","agent_name":"angel","project":"listing","progress":"Dashboard chrome aligned to shared shell.","blockers":"Needs shared settings popup import.","dependencies":["account settings popup"]}}
```

```json
{"tool":"mem_memory_rem_run","args":{"phase":"rem","project":"account","days":7,"agent_name":"alfred"}}
```

```json
{"tool":"mem_company_rem_brief","args":{"project":"account","write_brief":true,"coordinator_agent":"dieter"}}
```
