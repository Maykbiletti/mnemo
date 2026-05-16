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

1. Create a Work Order with `mem_work_order_create`.
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
5. Completion uses `mem_work_order_complete` and must attach evidence or a
   handoff id when evidence is required.
6. Trust/autonomy is updated from facts with `mem_autonomy_score_report`.

## Token Is Not Truth

A Capability Token is only permission. It never makes an implementation, fact,
decision, project rule, or access route true.

Truth is written only through evidence-backed completion, handoff, approval, or
promotion into the correct Mnemo ledger/tool.

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
{"tool":"mem_work_order_complete","args":{"work_order_id":42,"completion_summary":"Login loop fixed.","evidence":[{"test_step":"login smoke","result":"pass","url":"https://account.blun.ai/login"}]}}
```

```json
{"tool":"mem_intent_route","args":{"intent_kind":"access_request","agent_name":"alfred","project":"chat","resource_kind":"file","resource_key":"/root/blun-chat/public/index.html","summary":"Need temporary access for auth popup repair","write_brief":true}}
```
