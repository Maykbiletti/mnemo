# Work Orders And Capability Tokens

Mnemo should sit between an agent and meaningful action. A prompt can remind an
agent to be careful, but a gate can block unsafe work deterministically.

## Rule

Risky action requires a valid Work Order and Capability Token.

Risky means write, edit, delete, move, deploy, migration, billing, auth,
production, or external-send style work. Low-risk read-only work may proceed
without a token, but it still stays observable through normal session and
capture hooks.

## Flow

1. Create a Work Order with `mem_work_order_create_from_template` or
   `mem_work_order_create`.
   It contains objective, owner, department, assigned agent, scope, done
   criteria, risk, allowed tools/resources, required evidence, and deadline.
2. Mnemo issues a Capability Token for that Work Order.
   The token is time-limited and bound to one agent, scope, action type, tools,
   resources, and evidence requirements.
3. Before action, the wrapper or agent calls `mem_capability_token_check`.
   The result is deterministic:
   - `granted`
   - `reason`
   - `matched_scope`
   - `missing_approval`
   - `required_evidence`
   - `expires_at`
   - `audit_id`
4. Tool wrappers such as CodexLink, OpenClaw, or Claude sidecars must execute
   risky tool calls only when the token check grants the action.
5. Completion uses `mem_work_order_complete` and must attach concrete evidence.
   A handoff id alone is not enough for `done`.
6. Trust/autonomy is updated from facts with `mem_autonomy_score_report`.

## Templates, Quality Gates, Context

Use templates when the work is a repeated company process. Templates are
agent-neutral: Claude, GPT/Codex, OpenClaw, CodexLink, and other runtimes all
call the same Mnemo tools through their adapter.

- `mem_work_order_template_list` lists built-ins such as `debug_investigation`,
  `browser_qa`, `ship_release`, `design_review`, `i18n_qa`,
  `wizard_surface_work`, and `context_checkpoint`.
- `mem_work_order_create_from_template` creates the scoped Work Order and
  carries the template's quality gates and runtime contract into `meta`.
- `mem_quality_gate_run` checks concrete evidence before done.
- `mem_context_snapshot_create` saves a compaction/handoff-safe state.
- `mem_context_restore_brief` lets any agent resume from that snapshot without
  pretending the snapshot is company truth.

This is deliberately not Claude-specific. A runtime adapter may have different
tool names, but it must map them into Mnemo fields such as `runtime_name`,
`agent_name`, `tool_name`, `files`, `routes`, `resources`, and `evidence`.

## Token Is Not Truth

A Capability Token is only permission. It never makes an implementation, fact,
decision, project rule, or access route true.

Truth is written only through evidence-backed completion, handoff, approval, or
promotion into the correct Mnemo ledger/tool.

## Definition Of Done

`done` is a Mnemo state, not an agent opinion.

`mem_work_order_complete({status:"done"})` requires evidence even when the Work
Order did not list `required_evidence`. If an agent cannot verify the result, it
must use `status:"needs_review"` or `status:"blocked"` instead of `done`.

Evidence objects must be concrete. They need an outcome field such as `result`,
`status`, or `exit_code`, plus a real check or target such as `command`,
`test_step`, `check`, `file_path`, `url`, `files`, `urls`, `output_ref`, or
`receipt_id`. Command evidence must include `exit_code`.

For `done`, evidence must be passing. `exit_code` must be `0`, and `result` or
`status` must not say fail, error, blocked, incomplete, skipped, missing,
timeout, cancelled, or needs review. Failed checks are useful evidence, but they
belong to `needs_review` or `blocked`, not `done`.

When `required_evidence` is set, each required item must be explicitly covered
by at least one evidence object. Use `check`, `name`, or `label` to make the
match deterministic.

Valid evidence examples:

```json
{"check":"unit tests","command":"npm test","exit_code":0,"result":"pass","files":["packages/core/agent_governance.js"]}
```

```json
{"check":"login smoke","test_step":"Login with existing account","url":"https://account.blun.ai/login","result":"pass"}
```

Not done:

```json
{"status":"needs_review","completion_summary":"Patch applied; browser smoke still missing."}
```

```json
{"status":"blocked","completion_summary":"VAT key missing; cannot verify billing checkout."}
```

```json
{"status":"needs_review","completion_summary":"Tests still fail.","evidence":[{"check":"unit tests","command":"npm test","exit_code":1,"result":"failed"}]}
```

## Department Charters

Use `mem_department_charter_set` to define department responsibilities,
boundaries, standing permissions, escalation rules, default risk class, and
autonomy bounds. The charter tells Mnemo what an agent may normally do inside
its department, but risky work still needs a Work Order + Capability Token.

## Intent Router

Use `mem_intent_route` when an agent needs access, a decision, review, handoff,
or incident routing. Mnemo routes by resource owner, department charter, or the
default coordinator, and can optionally create a brief.

## Example Calls

```json
{"tool":"mem_work_order_create","args":{"project":"account","title":"Fix login loop","objective":"Repair account login redirect loop without touching admin auth.","department_name":"backend","assigned_agent":"alfred","owner_agent":"alfred","risk_class":"auth-risk","action_type":"code_edit","files":["/root/account/*"],"allowed_tools":["apply_patch","npm test"],"required_evidence":["login smoke","unit tests"],"ttl_minutes":120}}
```

```json
{"tool":"mem_capability_token_check","args":{"token_id":"cap-...","work_order_id":42,"agent_name":"alfred","project":"account","action_type":"code_edit","tool_name":"apply_patch","files":["/root/account/routes/auth.js"]}}
```

```json
{"tool":"mem_work_order_complete","args":{"work_order_id":42,"completion_summary":"Login loop fixed.","evidence":[{"check":"login smoke","test_step":"Login with existing account","result":"pass","url":"https://account.blun.ai/login"},{"check":"unit tests","command":"npm test","exit_code":0,"result":"pass","files":["packages/core/auth.js"]}]}}
```

```json
{"tool":"mem_intent_route","args":{"intent_kind":"access_request","agent_name":"alfred","project":"chat","resource_kind":"file","resource_key":"/root/blun-chat/public/index.html","summary":"Need temporary access for auth popup repair","write_brief":true}}
```
