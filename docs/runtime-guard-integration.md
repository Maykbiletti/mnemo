# Runtime Guard Integration

Mnemo must sit between an agent and meaningful action. Runtime adapters such as
CodexLink, OpenClaw, Claude sidecars, Telegram bridges, browser workers, and
shell wrappers must not rely on an agent remembering the rules from a prompt.

The adapter owns enforcement. The model owns reasoning.

## Core Rule

Risky actions must not run unless Mnemo grants them.

Risky actions include:

- `write`
- `code_edit`
- `delete`
- `move`
- `exec`
- `deploy`
- `migration`
- `auth`
- `billing`
- `production`
- `external_comm`

If there is no valid Mnemo context, the adapter may allow only safe read-only
inspection or a request for a Work Order.

## Session Start

Every adapter session starts by loading Mnemo context:

```text
mem_session_start({
  agent_name:"alfred",
  project:"mnemo",
  runtime_name:"codexlink",
  channel:"telegram"
})
mem_context_preview({ agent_name:"alfred", project:"mnemo" })
mem_session_brief({ agent_name:"alfred", project:"mnemo" })
```

The runtime should keep the active `agent_name`, `project`, `runtime_name`,
`session_key`, current Work Order id, and current Capability Token id in local
session state.

## Work Order And Token Context

Risky execution needs:

- Work Order id
- Capability Token id
- agent name
- project
- action type
- tool name
- concrete resources

Create or request the Work Order with:

```text
mem_work_order_create({
  project:"account",
  title:"Fix login loop",
  objective:"Repair the account login redirect loop.",
  department_name:"engineering",
  assigned_agent:"alfred",
  owner_agent:"alfred",
  risk_class:"auth-risk",
  action_type:"code_edit",
  files:["/root/account/*"],
  allowed_tools:["apply_patch","npm test"],
  required_evidence:["login smoke","unit tests"],
  ttl_minutes:120
})
```

If the adapter cannot create the Work Order itself, route the intent:

```text
mem_intent_route({
  intent_kind:"work_order_request",
  agent_name:"alfred",
  project:"account",
  summary:"Need scoped permission to repair login redirect loop.",
  write_brief:true
})
```

## Pre-Tool Guard

Before every risky tool call, the adapter classifies the action and asks Mnemo.

Preferred full gate:

```text
mem_agent_preflight({
  agent_name:"alfred",
  project:"account",
  task:"Patch account login redirect loop",
  action_type:"code_edit",
  tool_name:"apply_patch",
  files:["/root/account/routes/auth.js"],
  work_order_id:42,
  token_id:"cap-...",
  approval_ids:["approval-123"]
})
```

The adapter may use the narrower token gate only when it already ran the normal
session/context gates and just needs a fast per-tool decision:

```text
mem_capability_token_check({
  token_id:"cap-...",
  work_order_id:42,
  agent_name:"alfred",
  project:"account",
  action_type:"code_edit",
  tool_name:"apply_patch",
  files:["/root/account/routes/auth.js"]
})
```

The adapter must block execution unless the response grants the action.

Required response fields:

- `granted`
- `reason`
- `matched_scope`
- `missing_approval`
- `required_evidence`
- `expires_at`
- `audit_id`

If `granted:false`, the adapter must not run the tool. It should show the
reason, request access or approval, or create a blocked handoff.

## Tool Receipt

External runtimes should open a receipt before execution:

```text
mem_runtime_tool_receipt_start({
  runtime_name:"openclaw",
  agent_name:"alfred",
  project:"account",
  task:"Patch account login redirect loop",
  action_type:"code_edit",
  tool_name:"apply_patch",
  session_key:"openclaw:telegram:-1001:alfred",
  files:["/root/account/routes/auth.js"],
  work_order_id:42,
  token_id:"cap-..."
})
```

Execute only if the receipt returns `allowed:true`.

After execution, finish the receipt:

```text
mem_runtime_tool_receipt_finish({
  receipt_id:"rt-...",
  status:"done",
  result_summary:"Login redirect loop fixed.",
  evidence:[
    {
      url:"https://account.blun.ai/login",
      test_step:"Login with existing account",
      result:"Redirected to account overview and stayed logged in"
    }
  ]
})
```

Blocked receipts stay in the ledger. They are evidence that the gate worked.

## End Hook

Every meaningful session ends with a handoff. If the Work Order requires
evidence, completion without evidence is incomplete.

```text
mem_session_handoff({
  agent_name:"alfred",
  project:"account",
  status:"done",
  completion_method:"evidence-backed",
  summary:"Login loop fixed.",
  evidence:[
    {
      url:"https://account.blun.ai/login",
      test_step:"Existing account login",
      result:"pass"
    }
  ],
  rollback_plan:"Revert commit abc123 and restart account runtime."
})
```

Then close the Work Order:

```text
mem_work_order_complete({
  work_order_id:42,
  completion_summary:"Login loop fixed.",
  evidence:[
    {
      test_step:"Existing account login",
      result:"pass",
      url:"https://account.blun.ai/login"
    }
  ]
})
```

## Adapter Decision Table

| Situation | Runtime behavior |
| --- | --- |
| Safe read-only, no token | Allow, still audit through normal capture/session logs |
| Risky action, no token | Block and request Work Order or Capability Token |
| Token expired | Block |
| Token belongs to another agent | Block |
| Token has wrong project/scope/resource | Block |
| Token missing required approval | Block and route approval request |
| Token grants action | Execute, write receipt, finish with evidence |
| Tool fails after allowed receipt | Finish receipt with `status:"failed"` and error |
| Session ends without evidence | Mark incomplete/blocked, do not claim done |

## Adapter Pseudocode

```js
async function guardedToolRun(ctx, toolCall) {
  const action = classifyAction(toolCall);

  if (action.risky && (!ctx.workOrderId || !ctx.capabilityTokenId)) {
    return block("Work Order + Capability Token required");
  }

  const receipt = await mnemo.mem_runtime_tool_receipt_start({
    runtime_name: ctx.runtimeName,
    agent_name: ctx.agentName,
    project: ctx.project,
    task: toolCall.task,
    action_type: action.type,
    tool_name: toolCall.name,
    files: toolCall.files,
    routes: toolCall.routes,
    domains: toolCall.domains,
    system_names: toolCall.systems,
    resources: toolCall.resources,
    work_order_id: ctx.workOrderId,
    token_id: ctx.capabilityTokenId,
    approval_ids: ctx.approvalIds
  });

  if (!receipt.allowed) {
    return block(receipt.hint || "Mnemo blocked this toolrun");
  }

  try {
    const result = await runTool(toolCall);
    await mnemo.mem_runtime_tool_receipt_finish({
      receipt_id: receipt.receipt_id,
      status: "done",
      result_summary: summarize(result),
      evidence: collectEvidence(result)
    });
    return result;
  } catch (error) {
    await mnemo.mem_runtime_tool_receipt_finish({
      receipt_id: receipt.receipt_id,
      status: "failed",
      error: String(error && error.message || error)
    });
    throw error;
  }
}
```

## Non-Negotiables

- Mnemo is the source of authority for permission, ownership, approval, and
  evidence state.
- A runtime may cache the active token id, but it must check before each risky
  action.
- A Capability Token is permission only. It is not truth.
- Official truth requires evidence-backed completion, handoff, approval, or
  promotion into the right Mnemo ledger.
- No adapter may silently downgrade a blocked action into a direct tool call.
