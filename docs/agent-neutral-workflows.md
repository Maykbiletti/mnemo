# Agent-Neutral Workflows

Mnemo workflow governance must work the same way for Claude, GPT/Codex,
OpenClaw, CodexLink, and any future runtime. Models differ in prompts, tool
names, context windows, and behavior. Mnemo must therefore expose contracts as
tools and data, not as model-specific instructions.

## Rule

The runtime adapter translates local behavior into Mnemo. Mnemo decides:

- which Work Order applies
- which resources are allowed
- whether a capability token grants the action
- which quality gate is required
- whether the work can be marked `done`

The model may explain, plan, or execute. It is not the source of truth.

## Standard Flow

1. Start or resume context with normal session/context tools.
2. Create work through `mem_work_order_create_from_template`.
3. For risky actions, use `mem_runtime_tool_receipt_start` or
   `mem_capability_token_check` before execution.
4. Finish tool receipts with evidence.
5. Save handoff context with `mem_context_snapshot_create`.
6. Run `mem_quality_gate_run`.
7. Mark the Work Order done only with `mem_work_order_complete` and passing
   evidence.

## Built-In Work Order Templates

Use `mem_work_order_template_list` to inspect the active templates.

Important built-ins:

- `general_task`
- `debug_investigation`
- `browser_qa`
- `ship_release`
- `design_review`
- `i18n_qa`
- `wizard_surface_work`
- `context_checkpoint`

Templates contain default department, risk, action type, done criteria,
required evidence, quality gates, and an agent-neutral runtime contract.

Use `mem_work_order_template_upsert` for custom company templates.

## Quality Gates

Use `mem_quality_gate_template_list` to inspect quality gates and
`mem_quality_gate_run` before claiming done.

Built-in gates:

- `code_change_gate`
- `debug_gate`
- `browser_qa_gate`
- `release_gate`
- `design_review_gate`
- `i18n_gate`
- `wizard_gate`
- `context_handoff_gate`

If a gate returns `status:"block"`, the agent must not mark the Work Order
done. It should use `needs_review` or `blocked` and attach the failing evidence.

## Context Snapshots

Use `mem_context_snapshot_create` before compaction, session handoff, long
pauses, or cross-agent takeover. It captures:

- project
- agent/runtime
- Work Order id
- summary
- decisions
- remaining work
- files/routes/URLs
- branch/commit/dirty state

Use `mem_context_restore_brief` to resume. Restore briefs are context, not
company truth. The next agent must still check current repo state and Mnemo
gates before editing.

## Project Operating Board

Use the project board tools when several agents, portals, or product surfaces
are active at the same time. Their job is to keep project clarity durable
instead of relying on Telegram memory or a single agent session.

- `mem_project_focus_set` pins the active target, surface, owner, must-do list,
  and explicit out-of-scope items.
- `mem_user_intent_capture` stores the user's exact words and business intent.
  It can optionally create a task and update project focus.
- `mem_project_task_create` and `mem_project_task_update` maintain a durable
  board of findings, user requests, and agent-proposed improvements.
- `mem_project_channel_policy_set` defines what belongs in Telegram, Mnemo
  briefs, and Work Orders for the project.
- `mem_project_board` returns focus, policy, tasks, active Work Orders, pending
  briefs, user intents, and suggested next actions in one call.

Channel split:

- Telegram is for short coordination, visible team updates, and explicit
  questions.
- Mnemo briefs are for durable findings, assignments, acceptance criteria, and
  cross-agent handoffs.
- Project tasks are the backlog and operating board.
- Work Orders are execution contracts. They authorize risky work only when
  paired with capability tokens and evidence gates.
- Company Ledger remains the official truth for durable decisions and rules.

Agents should create useful project tasks when they see a real risk, missing
acceptance criterion, or project gap. They should not wait for the human to
phrase every task. Risky execution still requires a Work Order and token.

Example project focus:

```json
{
  "tool": "mem_project_focus_set",
  "args": {
    "project": "apps.blun.ai",
    "surface": "wizard2",
    "active_target": "Wizard2 output only",
    "must_do": ["Fix verified Wizard2 findings"],
    "must_not_do": ["Do not mix Wizard1", "Do not change chat/mobile scope"],
    "updated_by": "alfred"
  }
}
```

Example user intent capture:

```json
{
  "tool": "mem_user_intent_capture",
  "args": {
    "project": "apps.blun.ai",
    "source_channel": "telegram",
    "exact_words": "Wizard2 nichts anderes.",
    "summary": "Keep current execution on Wizard2 only.",
    "create_task": true,
    "set_focus": true,
    "assigned_agent": "alfred"
  }
}
```

## Adapter Contract

Every runtime adapter should map its local names into Mnemo fields:

| Runtime concept | Mnemo field |
| --- | --- |
| model/session name | `runtime_name` |
| agent identity | `agent_name` |
| user task | `task` or `objective` |
| local tool name | `tool_name` |
| file/route/domain/system target | `files`, `routes`, `domains`, `system_names`, `resources` |
| approval/claim refs | `approval_ids`, `claim_ids` |
| verification output | `evidence` |

No adapter should invent a second truth store for company state. Local notes are
allowed, but durable truth must be promoted through Mnemo.

## Example

```json
{
  "tool": "mem_work_order_create_from_template",
  "args": {
    "template_id": "wizard_surface_work",
    "project": "apps.blun.ai",
    "objective": "Merge the Wizard2 final builder without touching Wizard1.",
    "assigned_agent": "angel",
    "owner_agent": "alfred",
    "routes": ["/de/dashboard/wizard2"],
    "files": ["admin/app/dashboard/wizard2/*"],
    "created_by": "alfred"
  }
}
```

```json
{
  "tool": "mem_quality_gate_run",
  "args": {
    "gate_id": "wizard_gate",
    "work_order_id": 123,
    "agent_name": "angel",
    "evidence": [
      {"check":"explicit wizard target","result":"pass","file_path":"admin/app/dashboard/wizard2/page.tsx"},
      {"check":"builder route check","result":"pass","url":"https://apps.blun.ai/de/dashboard/wizard2"}
    ]
  }
}
```
