# Protected Scope Gates

Protected scope gates turn team organization into enforceable Mnemo data. They
exist for shared or risky surfaces where "I will quickly fix it" is not an
acceptable coordination model.

## Model

Each protected scope has:

- `rule_key`
- `label`
- `owner_agent`
- optional `required_approval_by`
- `risk_class`
- match patterns for tasks, files, routes, domains, systems, and topics
- required work-claim scopes
- required completion evidence hints

Default rules cover account/auth/login, global account settings popup, billing,
production infra, locked final artifacts, portal design system, chat runtime,
translations, and coordination rules. The defaults are seeded idempotently on
startup and can be replaced or extended in the database.

## Hard Behavior

`mem_agent_preflight` calls `mem_protected_scope_check` automatically.

For write/deploy-like work on a matched protected scope:

- non-owners are blocked unless a current owner-approved override exists
- owners are also blocked until they hold an active work claim
- stale or expired claims do not pass
- overrides for protected scopes must use `gate_kind=protected_scope:<rule_key>`
- only the assigned owner can approve that override through `approved_by`

Read-only discovery receives a warning instead of a blocker, so agents can
inspect context before they claim or hand off the work.

## Required Flow

1. Check the scope:

```text
mem_protected_scope_check({
  agent_name:"alfred",
  project:"account",
  task:"fix login redirect on account.blun.ai",
  action_type:"code_edit"
})
```

2. Claim the exact protected scope:

```text
mem_work_claim({
  project:"account",
  agent_name:"alfred",
  claim_kind:"protected_scope",
  scope_value:"auth login",
  summary:"Fix account login redirect",
  ttl_minutes:240
})
```

3. Work normally. The runtime hook will run `mem_agent_preflight` before edits
   and block if the claim, owner, or override is missing.

4. Complete with evidence, how it was fixed, and a rollback/repair path:

```text
mem_session_handoff({
  agent_name:"alfred",
  project:"account",
  summary:"Fixed account login redirect/session persistence",
  changed_files:["packages/account/auth.js"],
  completion_method:"Adjusted callback redirect validation and verified whoami session persistence.",
  rollback_plan:"Revert packages/account/auth.js to the previous commit and restart account runtime.",
  evidence:[{
    url:"https://account.example.test/login",
    test_step:"Login with existing account, follow redirect, call /whoami",
    result:"Login succeeds, redirect stays on account portal, whoami returns authenticated user"
  }]
})
```

## Owner Override

If another agent must touch a protected scope, the owner records a temporary
exception:

```text
mem_override_log({
  scope:"default",
  project:"account",
  agent_name:"otto",
  gate_kind:"protected_scope:auth_login",
  reason:"Otto owns the current chat-login regression and needs one auth touch.",
  approved_by:"alfred",
  expires_at:"2026-05-15T22:00:00.000Z",
  meta:{rule_key:"auth_login"}
})
```

If `approved_by` is not the assigned owner, Mnemo rejects the override.

## Default Owners

Defaults can be overridden with environment variables before startup:

```bash
MNEMO_SCOPE_OWNER_AUTH=alfred
MNEMO_SCOPE_OWNER_ACCOUNT_UI=alfred
MNEMO_SCOPE_OWNER_BILLING=alfred
MNEMO_SCOPE_OWNER_INFRA=dieter
MNEMO_SCOPE_OWNER_DESIGN_LOCKS=angel
MNEMO_SCOPE_OWNER_DESIGN=angel
MNEMO_SCOPE_OWNER_CHAT=otto
MNEMO_SCOPE_OWNER_TRANSLATIONS=frida
MNEMO_SCOPE_OWNER_COORDINATION=dieter
```

## Tools

- `mem_protected_scope_seed`
- `mem_protected_scope_list`
- `mem_protected_scope_check`
- `mem_work_claim`
- `mem_override_log`
- `mem_agent_preflight`
- `mem_session_handoff`

The protected-scope tools are machine-readable and suitable for Mission Control
views: list rules, show owners, show matched gates, show missing claims, and
show active overrides.
