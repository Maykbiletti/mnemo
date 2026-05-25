# gstack-Style Multiportal Governance

Mnemo adopts the useful gstack ideas as native governance primitives:

- specialist roles
- `think -> plan -> build -> review -> test -> ship -> reflect -> memorize`
- Agent OS boot kernel and command map
- portal context before work
- global, portal, and customer/partner rule layers
- claims, receipts, evidence, handoffs, and company boards

gstack is workflow structure. Mnemo remains the source of truth for memory,
rules, timestamps, claims, audit, receipts, and team knowledge.

## Tools

- `mem_gstack_catalog`
- `mem_agent_os_boot`
- `mem_agent_role_select`
- `mem_agent_role_get`
- `mem_agent_role_list`
- `mem_portal_context_set`
- `mem_portal_context_get`
- `mem_portal_context_list`
- `mem_agent_company_preflight`
- `mem_workflow_receipt_create`
- `mem_agent_company_board`

## Roles

- Product Planner
- System Architect
- Backend Engineer
- Frontend Engineer
- Security Reviewer
- QA Tester
- Release Manager
- Memory/Audit Officer
- Customer/Support Officer
- Portal Owner

## Agent OS Kernel

Every session starts with `mem_agent_os_boot`. The boot result includes the
kernel contract, current role assignment, portal context gate, active claims,
recent workflow receipts, and mission-control state.

Kernel law:

- owner rules override everything
- forbidden actions block execution
- protected scopes need claim and evidence
- done is invalid without evidence
- stop is invalid without handoff
- repeated failure creates a scar

Command concepts exposed by `mem_gstack_catalog` include `mnemo boot`,
`mnemo claim`, `mnemo receipt`, `mnemo handoff`, `mnemo scar`, `mnemo mission`,
and the gstack-style `/mnemo-*` review, QA, ship, retro, and security commands.

## Portal Context

Before code, text, pricing, design, billing, auth, legal, deployment, or logic
changes, the agent must load the affected portal context.

Required fields include:

- portal id and name
- brand/company
- domain and environment
- market/country
- default and supported languages
- user role
- design source
- credit system and pricing source
- rights/permissions
- billing, auth, deployment, and legal owner
- forbidden cross-portal leaks
- shared modules
- protected surfaces
- global rules
- portal rules
- customer/partner rules

## Company Preflight

`mem_agent_company_preflight` blocks work until the agent has:

- selected a role
- loaded portal context
- loaded all rule layers
- held active work claims for changed files
- saved a plan
- no conflicting active claim from another agent on the same scope

For low-risk read-only checks, callers may set `require_work_claim:false`.

## Scaling to 100 Agents

Shard work by portal, role, project, and risk class. Do not coordinate by chat
thread alone.

Use:

- `mem_agent_company_board` for role coverage, active claims, portal contexts,
  and open work orders
- one Memory/Audit Officer per busy portal
- capability tokens for risky work
- evidence gates before completion
- mandatory handoffs before stopping
