# AGENTS.md - Operating Guide For Mnemo Agents

Read this before using Mnemo in an local runtime.

Mnemo is a persistent memory, identity, and coordination layer. It exists so an
agent does not lose context, identity, preferences, project truth, file
ownership, or open work when a chat session ends.

## Non-Optional Loop

Every non-trivial session follows this loop:

1. Start with `mem_session_start({agent_name, project, task})`.
2. Call `mem_context_preview({agent_name, project, task, token_budget})` and use
   its selected fetch plan before loading broad context.
3. Reload identity with `mem_session_brief({agent_name, project, token_budget: 250})`.
4. Search memory token-efficiently:
   - Use `mem_recall_ids` or compact search first.
   - Use `mem_timeline` or `mem_neighbors` around selected IDs.
   - Use `mem_get` only for the few rows you actually need.
5. Read project rules with `mem_project_rules_get(project)` before touching UI,
   auth, pricing, checkout, VAT, legal, language, navigation, deploy, or design.
6. Claim edited files/modules with `mem_work_claim`, or enable hook auto-claim.
7. Make the smallest coherent change.
8. Verify with tests, browser checks, live checks, or smoke calls.
9. Record findings with `mem_quality_finding_report` and resolve them only after
   verification.
10. For website work, run `mem_site_golden_check_plan` and report the actual
   result with `mem_site_golden_check_report`.
11. Check agent health with `mem_agent_scorecard` when a task had blockers,
   corrections, live-site changes, or review handoff.
12. Handoff with `mem_session_handoff` before stopping, switching, deploying, or
   leaving blockers.

## Operating DNA

Every agent must know where truth lives before it starts work. Chat, terminal
scrollback, local report folders, screenshots on disk, and private notes are
never the canonical source by themselves. They are evidence or raw material;
Mnemo is where the operational fact must be stored.

Before acting, use the right source of truth:

- Identity and permissions: `mem_agent_pass_get`, then `mem_session_brief`.
- Project facts, domains, repos, PM2, nginx, auth, billing, mail, and owners:
  `mem_project_registry_get`, `mem_project_rules_get`, and project truth tools.
- Access routes and "how do I get there" knowledge: `mem_access_guide`,
  `mem_access_list`, `mem_access_upsert`, and `mem_access_event_log`.
- External systems such as OAuth, Stripe, VAT, search, mail, DNS, APIs, and
  provider dashboards: `mem_connector_list` and `mem_connector_upsert`.
- Final design, landing pages, pitch pages, shared chrome, and protected live
  surfaces: `mem_artifact_lock_check` or the hard preflight before editing.
- Open work and duplicate-work risk: `mem_work_active`, `mem_actions_search`,
  `mem_project_timeline_report`, `mem_work_claim`, and active quality findings.
- Finished work: `mem_action_finish`, `mem_site_golden_check_report`,
  `mem_quality_finding_report`/resolve, and `mem_session_handoff`.

Where new facts go:

- Verified access path: `mem_access_upsert`; store only `secret_ref`, vault
  label, env var name, or local path label, never raw secrets.
- New connector/system: `mem_connector_upsert`, with owner, auth type,
  secret reference, lifecycle, rights, health, runbook, and rollback hints.
- Stable project truth: project registry/truth map, not a one-off report.
- Final/protected artifact: artifact lock, with project, route/file/domain,
  reason, owner, and verification evidence.
- Temporary exception: override/exception log with who, why, scope, expiry, and
  approver.
- Decision: decision/rationale entry that explains why the chosen path won.
- Incident or repeated mistake: scar/correction/training rule so the next agent
  sees it before touching the same surface.

Every meaningful code, design, deploy, auth, billing, language, or infra change
must update all affected surfaces in the same work unit: implementation, config,
schema/migration, docs, tests/smokes, project truth, connector/access records,
locks/claims, and handoff. If one of those cannot be updated, mark the task
blocked with evidence instead of reporting done.

## Agent Company Permissions

Agents are company workers with assigned resources, not free-floating editors.
Before touching another lane's surface, the agent must have one of:

- ownership of the resource
- an active `resource_acl` grant
- an approved `approval_request`
- an explicit claim-access grant from the current claim owner
- a transferred claim

Resources are canonical company objects: files, routes, domains, systems,
services, projects, protected scopes, and external connectors. Register them
with `mem_resource_upsert` and keep the owner current.

The runtime preflight checks resource ACLs automatically. For write/deploy-like
work on managed resources, Mnemo blocks when the agent is not the owner and has
no active grant or approval. If another agent holds an active work claim, Mnemo
blocks until that claim owner grants access with `mem_claim_grant_access` or
transfers the claim with `mem_claim_transfer`.

Protected scopes are stricter. Auth/login, billing, production infra, final
artifacts, shared portal design, translations, chat runtime, and Mnemo
coordination have `protected_scope_rule` entries. A non-owner cannot approve an
exception for those scopes. Use `mem_protected_scope_list` to see owners and
`mem_protected_scope_check` before risky work.

Correct conflict flow:

1. Stop editing when preflight blocks.
2. Request access with `mem_approval_request` or `mem_claim_request_access`.
3. Wait for the assigned owner to approve, deny, or transfer.
4. Resume only after the gate returns `ok`.
5. Finish with `mem_session_handoff` including evidence, `completion_method`,
   and `rollback_plan`.

Every grant, denial, transfer, approval, and resource owner change must be in
Mnemo. Use `mem_resource_audit_list` to reconstruct what happened.

External runtimes such as OpenClaw, browser runners, Telegram bridges, or
custom tool gateways are not a second authority. Register their session/channel
mapping with `mem_runtime_binding_upsert`, register tool/channel permissions
with `mem_runtime_capability_upsert`, and open
`mem_runtime_tool_receipt_start` before the runtime executes a tool. If the
receipt returns `allowed:false`, do not execute the tool. Finish the receipt
with `mem_runtime_tool_receipt_finish` and evidence, then write the normal
handoff for the completed work.

## Memory Consolidation And REM

Mnemo has three reviewable memory layers in addition to raw capture and semantic
recall:

- Company Ledger: official truth such as decisions, claims, approvals, evidence,
  incidents, handoffs, owner instructions, project rules, and resource owners.
- Department Journal: daily department progress, blockers, risks, open
  questions, dependencies, and foreign-scope requests.
- Agent Sleep Notes: personal agent REM notes about lessons, uncertainty,
  repeated errors, needed context, and improvement ideas.

Department journals and sleep notes are not official truth. They are raw
material for REM. Use `mem_memory_rem_plan` to see due phases and
`mem_memory_rem_run` to produce draft consolidation runs. If a REM finding
should become durable truth, create a review item with
`mem_memory_promotion_propose`; a coordinator or owner must explicitly call
`mem_memory_promotion_decide` before it is approved or promoted.

Use `mem_company_rem_brief` for the morning management view. It aggregates
department journals, sleep notes, pending promotion proposals, active claims,
pending approvals, and REM status. This brief guides decisions; it does not
change truth by itself.

## Work Orders And Capability Tokens

Risky work is not governed by memory or prompt wording. It is governed by a
Work Order plus a Capability Token.

Risky work includes write, edit, delete, move, deploy, migration, billing, auth,
production, or external-send actions. For those actions, the agent or wrapper
must have:

- a structured `work_order`
- a valid `capability_token`
- a passing `mem_capability_token_check`

The token check returns `granted`, `reason`, `matched_scope`,
`missing_approval`, `required_evidence`, `expires_at`, and `audit_id`. If it
does not grant the action, the action does not run. Without a valid Mnemo token,
an agent may do safe read-only work or create/request a Work Order.

Tokens are not truth. They are temporary permission only. Completion still needs
evidence and handoff through `mem_work_order_complete` and
`mem_session_handoff`. Durable facts, rules, and decisions still go through the
proper Mnemo promotion, decision, project-rule, access, or connector tools.

`mem_work_order_complete` with `status:"done"` requires concrete evidence:
command/test/check/file/url plus result/status/exit_code. `handoff_id` alone is
not done. For `done`, evidence must pass: command `exit_code` is `0` and
result/status does not say fail/error/blocked/incomplete. Use `needs_review` or
`blocked` when verification is missing or failing.

Department charters define standing responsibilities and boundaries with
`mem_department_charter_set`, but they do not bypass risky-action tokens.
Use `mem_intent_route` when an agent needs access, decision, review, handoff, or
incident routing.

## Autonomous Backlog Routing

Agents do not wait for the owner to notice open work. When an inbox is empty,
the loop must run the autonomy backlog scout (`mem_autonomy_sweep`) on a
rate-limited schedule. The sweep converts project readiness gaps, live-gate
failures, missing rules, and open quality findings into department-owned
`autonomy_task` rows.

If the task belongs to the agent's department, the agent claims it with
`mem_autonomy_next`, reloads project context, fixes or verifies it, and moves it
to review. If it belongs to another department, the agent must not silently take
over the lane. It preserves the finding/task and drops a brief to the assigned
agent or reviewer with the project, evidence, expected result, and verification
needed.

Delegation has a hard timeout. If a department task is still open after 20
minutes without owner progress, an idle capable agent may claim it with
`mem_autonomy_next({allow_takeover:true, stale_takeover_minutes:20})`, finish it
directly, and leave a handoff/brief for the previous owner. The default is
execution, not waiting for permission, when the work is safe, reversible, and
verifiable.

No loop may treat "no pending brief" as "nothing to do" until it has checked the
readiness board, open findings, autonomy tasks, and project timeline report.

## Identity Must Persist

An agent must not drift into a new personality or forget who it is working for.
At session start and before meaningful work, reload:

- owner identity and owner-set `core_value` rows
- the agent's own name, role, scope, and current task
- locked preferences, no-gos, corrections, and taste memories
- open promises and commitments
- current project rules, live gates, and open findings
- recent handoffs from other agents

Do not overwrite owner identity, core values, or agent roles from short-term chat
context. Change identity only through explicit owner action, a private pack, or a
deliberate memory/tool update.

Agent IDs used in tools are stable lowercase identifiers. Display names may use
capital letters, but queues, heartbeats, claims, and actions must use the
lowercase `agent_name` so `agentone` and `AgentOne` cannot split into separate inboxes.

## Self-Improvement Memory

Corrections are operating-system updates, not chat comments. When the owner or a
reviewer points out a mistake, the agent must call `mem_correction_capture` with
the agent, project, severity, and exact correction. Mnemo writes a scar event and
an active training rule so future sessions reload it.

Before taking more live work after a correction, run `mem_agent_scorecard` for
the agent. A blocking score means the agent clears the finding, backlog, or guard
failure first, or briefs the reviewer with the blocker. Review leads use
`mem_agent_scoreboard` to see who needs training, who is blocked, and which
agent should not receive the next risky task.

Use `mem_agent_training_rule_upsert` for team-wide no-gos, owner taste rules,
project-specific habits, and repeated defects. Rules should be short, specific,
and enforceable: "Preserve locale-specific legal links" is useful; "be careful"
is not.

## Token Efficiency

Tokens are shared team capacity. Agents must not waste them.

- Search small first. Prefer IDs, snippets, counts, and timelines before full
  memory rows.
- For non-trivial work, call `mem_context_preview` first and follow its
  token-budgeted fetch plan. Do not load every possible memory just because it
  exists.
- Batch exact IDs when fetching full records, and keep batches small.
- Do not paste raw database dumps, whole logs, or long transcripts into chat.
- Summarize discoveries into durable decisions, findings, or handoffs.
- Keep `mem_session_brief` token budgets tight unless the task genuinely needs
  more context.
- Use `mem_lens_view(project)` for a structured project bundle instead of many
  unrelated calls.
- For code files, call `mem_code_outline(file_path)` before reading the whole
  file. The outline gives imports, headings, symbols, line ranges, and an
  estimated full-file token cost.
- Use `mem_code_unfold(file_path, symbol)` or a bounded
  `mem_code_unfold(file_path, start_line, end_line)` to inspect only the code
  needed for the task.
- Full-file reads are allowed only for small files or when the outline proves
  global context is required. If a full read is necessary, say why in the
  pre-work or completion guard.

## Runtime Hook

Use `packages/core/hooks/firm-runtime-hook.js` for lifecycle enforcement:

- `session-start` records session start and injects the canonical Mnemo startup
  context.
- `user-prompt` captures every user prompt, syncs the runtime transcript tail,
  searches prior conversations/solutions, and injects the results before the
  agent answers.
- `pre-compact` syncs the transcript before runtime context compaction so compacting
  cannot erase the only copy of recent work.
- `pre-tool` runs file echo, project preflight, identity check, owner preference
  check, token-efficiency guard, clean-work guard, and optional auto-claim.
- `post-tool` records file ownership, action logs, tool observations, and
  recent transcript turns.
- `stop` checks active claims, open findings, readiness board, and writes a
  handoff plus a durable session summary.
- `session-end` writes the final transcript sync, session summary, and hook
  status snapshot.

If the hub is temporarily unavailable, hook writes are queued under
`MNEMO_HOOK_QUEUE_DIR` or `$HOME/.mnemo/hook_queue` and replayed on the next hook
event. Run `mnemo-hook-doctor` or `mnemo-hook-doctor --flush` after wiring a new
agent, after compaction failures, or after a hub restart.

Memory-private text must be wrapped before it enters Mnemo. Supported tags:
`<private>...</private>`, `<no-memory>...</no-memory>`,
`<mnemo-private>...</mnemo-private>`, `[private]...[/private]`, and
`<!-- mnemo:private -->...<!-- /mnemo:private -->`. These blocks are redacted
before capture, transcript promotion, memory promotion, and hook payload logging.

Recommended hard-enforcement environment:

```bash
MNEMO_HOOK_BLOCK=1
MNEMO_AUTO_CLAIM=1
MNEMO_REQUIRE_AUTO_CLAIM=1
MNEMO_REQUIRE_PROJECT=1
MNEMO_REQUIRE_TASK=1
MNEMO_REQUIRE_FILES_FOR_EDIT=1
MNEMO_REQUIRE_PROJECT_RULES=1
MNEMO_BLOCK_HIGH_FINDINGS=1
MNEMO_ENFORCE_CLEAN_WORK=1
MNEMO_BLOCK_DIRTY_DEPLOY=1
MNEMO_REQUIRE_IDENTITY_CHECK=1
MNEMO_REQUIRE_OWNER_TASTE_CHECK=1
MNEMO_BLOCK_WITHOUT_OWNER_TASTE=1
MNEMO_REQUIRE_TOKEN_EFFICIENT_MEMORY=1
MNEMO_MAX_MEMORY_FETCH_IDS=8
MNEMO_REQUIRE_SMART_CODE_READ=1
MNEMO_CAPTURE_TOOL_OBSERVATION=1
MNEMO_CAPTURE_SESSION_SUMMARY=1
MNEMO_HOOK_QUEUE_ON_FAILURE=1
MNEMO_HOOK_FLUSH_ON_EVENT=1
MNEMO_SMART_CODE_READ_MIN_BYTES=20000
MNEMO_REQUIRE_CHAT_CAPTURE=1
MNEMO_REQUIRE_PROMPT_RECALL=1
MNEMO_TRANSCRIPT_SYNC_LINES=180
MNEMO_PROMPT_RECALL_LIMIT=8
MNEMO_ALLOW_AUTONOMOUS_LOW_RISK_IDEAS=1
MNEMO_REQUIRE_PRE_WORK_GUARD=1
PREWORK_MAX_TURNS=20
MNEMO_REQUIRE_REGRESSION_GUARD=1
MNEMO_REQUIRE_COMPLETION_GUARD=1
MNEMO_REQUIRE_SITE_CONTRACT_GUARD=1
MNEMO_REQUIRE_REMAINING_CHECK=1
MNEMO_BLOCK_STOP_WITHOUT_REMAINING=1
MNEMO_REQUIRE_STOP_SUMMARY=1
MNEMO_REQUIRE_STOP_NEXT_ACTIONS=1
MNEMO_DIRTY_INCLUDE_UNTRACKED=0
MNEMO_ALLOW_DESTRUCTIVE=0
```

Keep `MNEMO_HOOK_BLOCK=0` during first install until the smoke tests pass.

Project aliases are local configuration. Put them in ignored
`.mnemo-project-aliases.json` or `MNEMO_PROJECT_ALIASES`, not in the public repo.

## Clean Work Rules

The hook blocks or warns on:

- missing explicit project or task for tracked work
- edits without concrete file paths
- code edits without claims when claim enforcement is enabled
- deploy/live/restart actions from a dirty tracked git tree
- destructive shortcuts such as `git reset --hard`, `git checkout --`, forced
  recursive deletes, or `git clean -fd`
- missing project rules on surfaces that affect users
- failed identity, preference, or token-efficiency preflight
- stop/handoff without next actions when work remains

If a hook returns `decision: "block"`, stop and resolve the blocker. Do not work
around it.

## Pre-Work Guard

Agents must think first, then work. The autonomous loop creates and validates a
pre-work plan before every brief, autonomy task, or initiative cycle. By
default this plan is deterministic inside the worker, not a second full model
run, so the loop cannot stall or spend tokens before starting real work. Set
`LOOP_PRE_WORK_MODE=llm` only when an agent-run planning phase is intentional.
If the phase does not produce a valid plan, execution never starts.

The pre-work phase is read-only. Agents may load compact Mnemo context, project
rules, owner preferences, open claims, recent actions, relevant files, and
quality findings. They must not edit files, write final outcomes to memory,
deploy, restart services, install packages, commit, push, or mark anything
complete.

Before execution, the plan must name:

- real acceptance criteria
- context and dependencies to inspect
- files/modules that need claims
- blast radius and crossover surfaces
- site-contract surfaces when website work is involved
- concrete checks the agent will run itself
- stop conditions that force a blocker instead of a shortcut

For website work, the plan must include canonical header/menu/footer, links,
forbidden domain leaks, languages/locales, light/dark logos, mobile, desktop,
and relevant crossover surfaces. "HTTP 200" is never enough.

Required marker:

```text
MNEMO_PRE_WORK_GUARD: {"status":"pass|blocked|not_applicable","task_summary":"","acceptance_criteria":[],"context_to_load":[],"dependencies_to_inspect":[],"files_or_modules_to_claim":[],"blast_radius":[],"site_contract_surfaces":[],"risk_level":"low|medium|high","planned_checks":[],"stop_conditions":[],"blocked_reason":[]}
```

Use `blocked`, not `pass`, when the agent cannot name enough context,
dependencies, checks, or stop conditions. Do not finish with "the owner should
check"; the agent must run the checks or record exactly why it is blocked.

## Complementary Agent Roles

Mnemo teams are complementary, not competitive. Each agent keeps its own
identity, but the team must route work to the strongest lane instead of
pretending every agent is best at every task.

- Deep code bug diagnosis, large-codebase root-cause work, API/backend/database
  issues, auth, billing, checkout, deployment risk, and crossover regressions
  belong to the deep diagnosis lane. A deep diagnosis pass should map the
  dependency path, inspect callers and shared modules, name the regression
  perimeter, then propose or ship the smallest verified fix.
- Coordination, visual QA, browser verification, owner communication, product
  taste capture, and cross-lane routing belong to coordination/visual lanes.
  Those agents must not replace root-cause diagnosis with a superficial page
  check or a quick CSS edit.
- If a coordination/visual agent discovers a code bug or high-risk regression,
  it records the evidence, creates or updates the finding/task, briefs the
  diagnosis lane or reviewer with exact URLs/files/symptoms, and continues with
  safe work in its own lane.
- If a diagnosis agent discovers visual, language, legal, brand, or owner-taste
  risk outside its lane, it records the evidence and briefs the responsible
  lane instead of guessing.
- A task is not done just because one lane says "looks okay". Done means the
  owning lane verified its part and the affected crossover lanes either passed
  or received a concrete handoff.

## Agent Loop Self-Start

Agents are allowed to start or repair their own Mnemo loop when the owner
asks for loop mode, when their PM2 process is missing, or when the process was
started without agent/workspace arguments. This is normal runtime maintenance,
not a deploy.

Use the helper instead of hand-assembling PM2 commands:

```bash
cd packages/core
npm run agent-loop:start -- <agent_name> <workspace_path> --engine agent
```

The helper requires `pm2` (`npm install -g pm2` if missing), deletes the stale
`agent-loop-<agent>` process if present, starts
`agent_loop_worker.js <agent_name> <workspace_path>`, saves PM2 state, and
defaults the hard guards on:

- `AGENT_ENGINE=agent` unless another supported engine is passed deliberately
- `MNEMO_REQUIRE_PRE_WORK_GUARD=1`
- `LOOP_PRE_WORK_MODE=deterministic`
- `PREWORK_MAX_TURNS=20`
- `MNEMO_REQUIRE_COMPLETION_GUARD=1`
- `MNEMO_REQUIRE_REGRESSION_GUARD=1`
- `MNEMO_REQUIRE_SITE_CONTRACT_GUARD=1`
- `MNEMO_REQUIRE_TOKEN_EFFICIENT_MEMORY=1`
- `MNEMO_REQUIRE_SMART_CODE_READ=1`
- `ENGINE_AUTH_COOLDOWN_MIN=15`

If the configured engine returns an auth failure, the loop must not hammer the
same brief/task. It records `auth_failed`, sends a blocked heartbeat, and waits
for the cooldown before trying again.

Pure `[STATUS]`, `[INFO]`, `[FYI]`, and `[UPDATE]` briefs with no explicit action
request are acknowledged without model execution. Use that format for
coordination updates that should not create work.

Before declaring loop mode ready, verify:

- PM2 shows exactly one `agent-loop-<agent>` process online
- `pm2 describe agent-loop-<agent>` shows script args:
  `<agent_name> <workspace_path>`
- `pm2 env agent-loop-<agent>` contains the intended `MNEMO_URL`,
  `AGENT_ENGINE`, `AGENT_WORKSPACE`, and guard env values
- logs show `[agent_name] loop start`, not `[agent] loop start`

## Completion Guard

Coding work is complete only when the whole coherent task is complete. Agents
must not quick-fix one line, skip the surrounding dependencies, and report done.

Before coding, identify:

- the real acceptance criteria
- dependent callers, routes, schemas, config, tests, styles, translations,
  assets, deploy/runtime wiring, and shared components
- files/modules that need claims
- checks that can prove the work

After coding, self-review the diff and run the strongest practical verification:
tests, lint, build, typecheck, smoke calls, browser checks, or explicit
file/content verification. A pass requires no unrelated changes, no TODO
placeholders, no half-wired flows, no missing language copies, no missing routes,
and no remaining work.

The autonomous agent loop enforces this marker for coding/programming work:

```text
MNEMO_COMPLETION_GUARD: {"status":"pass|blocked|not_applicable","task_understood":true,"dependencies_checked":[],"changed_files":[],"acceptance_checks":[],"tests_run":[],"self_review":[],"unrelated_changes":[],"remaining_work":[],"blockers":[]}
```

Use `blocked`, not `pass`, when any dependency, check, or acceptance criterion is
unfinished. Use `not_applicable` only for read-only/status work with no code,
content, config, deploy, or live-site change.

## Site Contract Guard

Website checks must verify the product contract, not only HTTP status. A page
returning `200` can still be broken if the header style is partial, the menu
flow points to the wrong domain, legal links lose the locale, a dark logo is
missing, or mobile differs from desktop.

Use this guard for any task involving websites, pages, all-page audits, header,
menu, nav, footer, legal links, logos, language routes, style parity, mobile, or
crossover links.

Before editing or approving, identify:

- canonical source for the surface
- target domains/pages that must match it
- expected menu labels/order and href targets
- allowed external hosts and forbidden domain leaks
- required language/locale paths
- light/dark logo assets
- mobile and desktop viewports

Preferred helper:

```bash
node packages/core/bin/site-contract-audit.js --canonical https://example.com --targets https://target.example.com --paths /,/de,/en --forbidden-host example.com
node packages/core/bin/site-contract-audit.js --project my-project --report
```

The helper checks header/nav/footer links, same-label menu href targets,
canonical-domain leaks, rough header style-token overlap, forbidden host leaks,
locale-prefix loss, localized legal links, logo/dark-logo assets, and viewport
meta. It does not replace screenshot or browser checks for UI/style/header/mobile
work.

Store reusable expectations with `mem_site_contract_set`, then use
`mem_site_golden_check_plan(project)` before edits and
`mem_site_golden_check_report(project, status, evidence, findings)` after the
checks. A site contract is the durable source for canonical URL, target domains,
locale paths, forbidden hosts, header/menu/footer/logo rules, mobile/desktop
viewports, and required evidence.

Required marker:

```text
MNEMO_SITE_CONTRACT_GUARD: {"status":"pass|blocked|not_applicable","canonical_source":"","target_urls":[],"pages_checked":[],"header_style_checked":false,"menu_structure_checked":false,"footer_checked":false,"links_checked":[],"forbidden_domain_leaks":[],"locale_routes_checked":[],"logos_checked":[],"mobile_checked":false,"desktop_checked":false,"visual_quality_checked":false,"layout_overflow_checked":false,"audit_commands":[],"screenshots":[],"remaining_risks":[],"blockers":[]}
```

For strict site work, a pass requires no forbidden domain leaks, no remaining
risks, mobile and desktop evidence, checked links, and checked contract surfaces.
For UI/page/header/mobile/style work, screenshot or browser evidence is
mandatory. The agent must explicitly check clipped text, overflow, broken
buttons/inputs, missing logos/icons, wrong theme assets, inconsistent
header/menu/footer styling, and any content that looks unfinished.

## Regression Guard

Agents must protect the product around the requested fix. A task is not done
when the direct bug is fixed but another language, route, theme, or shared
component regresses.

Before editing, write the blast radius:

- direct target
- shared header, menu, footer, legal links, and app shell
- sibling pages/components that reuse the changed code
- every declared language/locale route for touched public pages
- light and dark theme assets, especially logos and header marks
- mobile-first layout plus desktop layout
- crossover surfaces: auth, pricing, checkout, billing, VAT/OSS, legal,
  monitoring, deploy, and related domains when relevant

After editing, verify the target and the blast radius. For website/UI work this
means mobile and desktop. For language or legal-link work this means every
locale route stays in that locale. For header/footer/menu work this means the
canonical nav and footer links are still correct. For theme work this means
light and dark assets both render.

For strict website work, a pass requires evidence in all relevant buckets:
baseline before edit, post-change target check, dependency/crossover checks,
mobile check, desktop check, language checks, link checks, and theme/logo checks.
Half checks are blockers, not success.

The autonomous agent loop enforces a machine-readable completion marker for
strict work. Without a passing `MNEMO_REGRESSION_GUARD` line, the worker must
not mark the brief done or move an autonomy task to review.

Required final marker:

```text
MNEMO_REGRESSION_GUARD: {"status":"pass|blocked|not_applicable","changed_files":[],"changed_surfaces":[],"baseline_checks":[],"post_change_checks":[],"cross_checks":[],"languages_checked":[],"themes_checked":[],"mobile_checked":false,"desktop_checked":false,"links_checked":[],"commands":[],"remaining_risks":[],"blockers":[]}
```

Use `not_applicable` only for read-only/status work. If any required surface
cannot be checked, use `blocked`, record the missing checks, and brief the
reviewer.

## Autonomous Ideas

Agents act on good low-risk ideas instead of waiting for permission. Initiative
is part of the operating system, not a loose brainstorm.

The owner default is approval for useful, reversible, low-risk improvements
inside the agent's lane. Do not ask "should I do this?" and then stop. If the
idea is safe, do it. If it is not the agent's lane, create or preserve the
finding/task and brief the responsible agent/reviewer. If it is high-risk, leave
the proposal queued with a concrete recommendation and continue other work.

When an agent has no direct brief or assigned autonomy task, the agent loop may
run a rate-limited initiative cycle. In that cycle the agent must:

- reload identity, owner taste, no-gos, project rules, readiness board, open
  findings, recent actions, and pending proposals
- generate concrete project-specific ideas with `mem_propose`
- avoid duplicates across proposals, findings, autonomy tasks, and recent work
- ship at least one safe low-risk improvement when one exists and can be
  verified in the current workspace
- leave larger or risky ideas queued for review
- record the outcome, verification, and handoff in Mnemo

Allowed without owner approval when project rules pass:

- small bug fixes
- consistency cleanup
- broken link fixes
- mobile polish
- docs/tests for existing behavior
- agent coordination and memory hygiene

Ask, escalate, or brief first only for:

- destructive actions
- live flips or deploys
- auth, billing, checkout, VAT, legal, customer data, or pricing changes
- large visual identity changes
- public claims or anything with meaningful cost

After shipping an autonomous idea, log the decision/finding, update proposal
status when applicable, and brief the configured reviewer/team with
verification. If the idea should wait, leave it queued, brief the reviewer with
the reason and recommended next action, then continue to the next safe item.

## Departments

Mnemo work is routed through departments so agents keep clear ownership.

- `strategy-review` owns final review, readiness sign-off, task routing, and
  duplicate-work prevention.
- `frontend` owns landing pages, menus, header/footer, links, mobile, i18n, and
  visual consistency.
- `backend` owns APIs, auth crossover, sessions, account state, and security.
- `billing` owns pricing source of truth, checkout, subscriptions, refunds,
  VAT/OSS, and payment webhooks.
- `qa` owns browser/mobile regression checks and durable findings.
- `deploy-ops` owns server state, deploy gates, monitoring, CORS, env, and
  rollback readiness.
- `content-legal` owns legal pages, public claims, policy pages, and copy.

Run `mem_department_seed_defaults` once per install, then adjust members with
`mem_department_member_set`. Every autonomous task must have a department, an
assignee, and a reviewer. The review department can block live launch until all
gates and findings are resolved.

## Live Crossover Checks

Before a project is called live, run `mem_project_crossover_check(project)`.
It checks the site/app as one connected product, including:

- landing-page menu and app menu match the canonical nav
- header/footer and links are consistent across pages and languages
- one login/account model is documented across related sites
- pricing pages and admin price changes use the same source of truth
- checkout, billing portal, refunds, webhooks, VAT/OSS, legal pages, mobile,
  deploy, and monitoring gates are documented and passed

Findings from this check are durable. They become department-owned autonomy
tasks through `mem_autonomy_sweep`, then the assigned agent can claim the next
task with `mem_autonomy_next({agent_name, claim:true})`.

## Public Repo Hygiene

The public repository must stay reusable by other teams.

- Do not commit real company facts, customer names, server paths, credentials,
  pricing, legal data, or private agent rosters.
- Store real facts in local ignored `<scope>.json` files, private packs, or a
  deployment-specific `MNEMO_FACTS_DIR`.
- Use `packages/core/facts/example.json` and
  `packages/core/facts/example-project-rules.json` as templates only.
- Use `packs/example-pack` as the template for private personas.

## Useful Tools

| Tool | Use |
| --- | --- |
| `mem_session_start` / `mem_session_brief` / `mem_session_handoff` | lifecycle and identity continuity |
| `mem_context_preview` | token-budgeted context plan before loading broad memory |
| `mem_recall_ids` / `mem_timeline` / `mem_get` | token-efficient memory retrieval |
| `mem_project_rules_set/get/list` | canonical per-project rules |
| `mem_project_registry_upsert/get/list` | domains, repos, servers, deploy state, live gates |
| `mem_quality_finding_report/list/resolve` | durable defect register |
| `mem_work_claim` / `mem_work_active` | file/module ownership |
| `mem_resource_upsert/list` | canonical company resources and owners |
| `mem_resource_acl_grant/list` | explicit resource permissions |
| `mem_approval_request/decide/list` | owner-routed approval queue |
| `mem_claim_request_access/grant_access/deny_access/transfer` | active-claim access and handoff |
| `mem_protected_scope_list/check` | high-risk shared-surface gates |
| `mem_resource_audit_list` | durable permission and claim-access audit trail |
| `mem_file_echo` / `mem_file_owner_set/get` | pre-read context and edit history |
| `mem_company_fact_get/set` / `mem_pre_action_check` | private canonical facts |
| `mem_firm_readiness_board` | readiness overview across projects |
| `mem_project_timeline_report` | one-project dossier: recent work, live blockers, open tasks, next actions |
| `mem_department_seed_defaults/list/member_set` | departments, owners, reviewers |
| `mem_loop_doctor` | autonomous-loop health, stuck briefs, stale actions, auth cooldowns |
| `mem_agent_name_migrate` | dry-run/apply consolidation of split agent-name queues |
| `mem_brief_requeue_stale` | dry-run/apply recovery for stale dispatched briefs |
| `mem_project_crossover_check` | landing/app/menu/auth/pricing/live gate audit |
| `mem_autonomy_sweep` / `mem_autonomy_next` / `mem_autonomy_task_update` | automatic task creation and assignment |
| `mem_propose` / `mem_proposals_pending` / `mem_proposal_update` | autonomous idea capture, review, and shipped-status tracking |
| `mem_agent_scorecard` / `mem_agent_scoreboard` | agent health, guard misses, backlog, findings, and training needs |
| `mem_correction_capture` / `mem_agent_training_rules` | convert corrections into durable rules |
| `mem_site_contract_set/get` / `mem_site_golden_check_plan/report/history` | website contract, golden-check plan, and durable QA evidence |

## First Install Checklist

1. Run `npm run bootstrap` in `packages/core`.
2. Answer owner, scope, primary agent, optional other agents, mission, and first
   project.
3. Edit generated private facts/rules under `packages/core/facts/<scope>*.json`.
4. Apply a private pack if you have one, or use `packs/example-pack` as a
   template.
5. Start the daemon and wire the MCP server.
6. Run hook smoke tests with blocking disabled.
7. Enable blocking hooks only after identity, scope, aliases, and project rules
   resolve correctly.
