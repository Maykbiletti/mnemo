# Agent Company Organization

Mnemo can operate as an agent company, not only as shared memory. The hard
coordination layer is built around five primitives:

- agent identity and passport
- canonical resources
- resource ACLs
- approval requests
- immutable audit events

## Resources

Everything an agent can affect is modeled as a resource:

- `file:packages/core/mcp.js`
- `route:/checkout`
- `domain:account.example.com`
- `system:stripe`
- `service:mnemo-hub`
- `project:account`

Create or update ownership:

```text
mem_resource_upsert({
  project:"account",
  resource_kind:"file",
  resource_key:"packages/account/auth.js",
  owner_agent:"alfred",
  owning_department:"engineering",
  risk_class:"auth",
  updated_by:"alfred"
})
```

List the company map:

```text
mem_resource_list({project:"account"})
```

## ACLs

The owner grants explicit access. A non-owner cannot grant themselves access to
an owned resource.

```text
mem_resource_acl_grant({
  project:"account",
  resource_kind:"file",
  resource_key:"packages/account/auth.js",
  agent_name:"otto",
  permission:"write",
  granted_by:"alfred",
  reason:"handoff for chat/account login regression",
  expires_at:"2026-05-15T22:00:00.000Z"
})
```

Before edits, `mem_agent_preflight` automatically calls
`mem_resource_access_check`. If a write/deploy action touches a managed
resource without owner/ACL/approval, it blocks.

## Approval Queue

Use approvals when an agent needs a resource outside its assignment.

```text
mem_approval_request({
  project:"account",
  resource_kind:"route",
  resource_key:"/auth/google/callback",
  requester_agent:"otto",
  permission:"write",
  reason:"Chat login redirect depends on account callback behavior"
})
```

Only the resource owner can decide:

```text
mem_approval_decide({
  id:42,
  status:"approved",
  decided_by:"alfred",
  expires_at:"2026-05-15T22:00:00.000Z"
})
```

Approving can automatically create a matching ACL entry.

## Claim Access

An active work claim is treated as a lock. If another agent must touch it, the
claim owner grants access or transfers the claim.

Request:

```text
mem_claim_request_access({
  claim_id:17,
  requester_agent:"alfred",
  permission:"write",
  reason:"Auth crossover repair requires this claimed chat file"
})
```

Grant:

```text
mem_claim_grant_access({
  claim_id:17,
  requester_agent:"alfred",
  granted_by:"otto",
  approval_id:88
})
```

Transfer:

```text
mem_claim_transfer({
  claim_id:17,
  to_agent:"alfred",
  by_agent:"otto",
  reason:"handoff after chat-side analysis"
})
```

## Audit Log

Every resource upsert, ACL grant, approval decision, claim grant, and claim
transfer writes `resource_audit_log`.

```text
mem_resource_audit_list({
  project:"account",
  resource_kind:"file",
  resource_key:"packages/account/auth.js"
})
```

This is the company record: who changed access, why, which resource, which
claim or approval was involved, and when it happened.

## Runtime Enforcement

The preflight stack now checks:

1. project rules
2. canonical facts
3. team ownership
4. write gate
5. duplicate work
6. impact map
7. protected scopes
8. resource ACLs and active claim locks
9. file work claims

Blocked means stop. The correct next action is one of:

- ask the owner for `mem_resource_acl_grant`
- create `mem_approval_request`
- create `mem_claim_request_access`
- ask the claim owner for `mem_claim_grant_access`
- ask the claim owner for `mem_claim_transfer`
- hand off the task

## External Runtimes

OpenClaw-style runtimes should not carry their own truth about who may do what.
They register bindings and capabilities in Mnemo, then open a receipt before
each toolrun.

```text
mem_runtime_binding_upsert({
  runtime_name:"openclaw",
  agent_name:"alfred",
  project:"chat",
  session_key:"openclaw:telegram:-1001:alfred",
  channel:"telegram",
  connector_system:"telegram"
})

mem_runtime_tool_receipt_start({
  runtime_name:"openclaw",
  agent_name:"alfred",
  project:"chat",
  task:"Check settings popup",
  action_type:"code_edit",
  tool_name:"browser.click",
  urls:["https://chat.example"]
})
```

The receipt links the external action to Mnemo preflight, resource gates,
claims, approvals, capability checks, and evidence. If the receipt says
`allowed:false`, the external runtime must not execute the tool.

See [`external-runtime-governance.md`](external-runtime-governance.md).

## Completion Contract

Finished work must include:

- evidence
- completion method
- rollback or repair plan

`mem_session_handoff` rejects evidence-backed completions that omit
`completion_method` or `rollback_plan`, unless legacy compatibility is explicitly
allowed with `meta.allow_legacy_no_evidence=true`.
