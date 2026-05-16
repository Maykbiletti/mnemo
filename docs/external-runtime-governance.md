# External Runtime Governance

OpenClaw-like runtimes are useful as channels, tools, browser control, session
management, and execution surfaces. They must not become a second source of
truth for identity, memory, permissions, or completion state.

Mnemo stays the authority:

- agent identity and passport
- project truth and connector registry
- resource ownership and ACLs
- active claims and approvals
- protected scopes
- evidence-backed completion

External runtimes act as transport and execution layers. Every meaningful
runtime toolrun should create a Mnemo receipt before execution and finish that
same receipt with evidence or an error.

For the adapter-side enforcement contract, see
[`runtime-guard-integration.md`](runtime-guard-integration.md). Runtime
adapters must block risky tool calls unless Mnemo grants the Work Order /
Capability Token gate.

## Runtime Bindings

A binding maps one external runtime/session/channel to the Mnemo company model.

```text
mem_runtime_binding_upsert({
  runtime_name:"openclaw",
  agent_name:"alfred",
  project:"mnemo",
  session_key:"openclaw:telegram:-1001:alfred",
  channel:"telegram",
  peer_kind:"group",
  peer_id:"-1001",
  connector_system:"telegram",
  capabilities:["browser","toolrun","telegram"],
  updated_by:"alfred"
})
```

Use bindings so routers and Mission Control can answer:

- which external session belongs to which agent
- which channel delivered the task
- which project and connector are involved
- which workspace/session is currently active

## Runtime Capabilities

Capabilities declare what a runtime or tool is allowed to expose.

```text
mem_runtime_capability_upsert({
  runtime_name:"openclaw",
  capability_kind:"tool",
  capability_key:"browser.click",
  allowed_agents:["alfred","angel"],
  risk_class:"ui_check",
  requires_preflight:true,
  requires_receipt:true,
  updated_by:"alfred"
})
```

To block a dangerous tool:

```text
mem_runtime_capability_upsert({
  runtime_name:"openclaw",
  capability_kind:"tool",
  capability_key:"shell.rm",
  permission:"deny",
  risk_class:"destructive",
  updated_by:"alfred"
})
```

## Tool Receipts

Before an external runtime executes a tool, open a receipt:

```text
mem_runtime_tool_receipt_start({
  runtime_name:"openclaw",
  agent_name:"alfred",
  project:"chat",
  task:"Check chat settings popup regression",
  action_type:"code_edit",
  tool_name:"browser.click",
  session_key:"openclaw:chat:5870",
  channel:"telegram",
  files:["public/index.html"],
  urls:["https://chat.blun.ai"]
})
```

`mem_runtime_tool_receipt_start` calls `mem_agent_preflight` by default and
stores:

- receipt id
- runtime/session/channel
- agent and project
- tool name and tool kind
- resources/files/routes/domains/systems
- capability gate result
- preflight status and preflight action id
- claim and approval references
- evidence requirement

If the preflight, protected scope, active claim, resource ACL, or runtime
capability blocks, the receipt is still written with `allowed:false`, but the
runtime must not execute the tool.

After execution:

```text
mem_runtime_tool_receipt_finish({
  receipt_id:"rt-...",
  status:"done",
  result_summary:"Popup regression checked and fixed",
  evidence:[
    {
      url:"https://chat.blun.ai",
      test_step:"Open sidebar settings and switch theme",
      result:"Popup opens above header and persists selected theme"
    }
  ]
})
```

For write/deploy/external-communication toolruns, `done` requires evidence or a
linked evidence-backed handoff.

## Integration Rule

External runtimes should follow this loop:

1. Resolve binding with `mem_runtime_binding_list`.
2. Check or register capability with `mem_runtime_capability_check`.
3. Open receipt with `mem_runtime_tool_receipt_start`.
4. Execute only if `allowed:true`.
5. Finish the receipt with result and evidence.
6. Finish the session with `mem_session_handoff` for work-level completion.

This gives the coordinator a reconstructable chain:

`runtime message -> Mnemo preflight -> claim/approval -> tool receipt -> evidence -> handoff`

That is the clean boundary: OpenClaw can be hands, eyes, and channels. Mnemo is
the company brain and audit authority.
