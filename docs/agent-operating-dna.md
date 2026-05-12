# Agent Operating DNA

This is the fixed map every Mnemo agent must follow.

## Canonical Sources

Agents must load the canonical source before acting:

- Agent identity and rights: `mem_agent_pass_get`, `mem_session_brief`.
- Project truth: project registry, project rules, project truth map.
- Access routes: `mem_access_guide`, `mem_access_list`.
- Connectors and external systems: `mem_connector_list`.
- Open work: `mem_work_active`, `mem_actions_search`, timeline reports.
- Protected final artifacts: artifact-lock checks and hard preflight.
- Recent evidence: action logs, site check reports, findings, handoffs.

Chat, terminal scrollback, screenshots, and local reports are evidence, not
truth. If a fact matters later, write it into Mnemo.

## Where Things Go

- Verified server/repo/admin/API/database access route:
  `mem_access_upsert` plus `mem_access_event_log`.
- Secret material:
  never raw in Mnemo or the repo; store only `secret_ref`, env var name, vault
  label, or local path label.
- New system/provider:
  `mem_connector_upsert` with owner, auth type, secret reference, lifecycle,
  rights, health, runbook, dependencies, and rollback hints.
- Final design/page/shared chrome:
  artifact lock with project, domain/route/file, reason, owner, and evidence.
- Active edit/deploy scope:
  `mem_work_claim` with TTL and heartbeat.
- Bug/regression:
  `mem_quality_finding_report`, then resolve only after verification.
- Decision:
  decision/rationale entry explaining why this route was chosen.
- Repeated mistake:
  correction/scar/training rule.
- Completion:
  `mem_action_finish`, evidence-backed site/check report, and
  `mem_session_handoff`.

## Update Rule

Every meaningful code, design, auth, billing, language, deploy, or infra change
must update all affected surfaces in one coherent work unit:

- implementation
- config/env references
- schema or migrations
- docs/runbook
- tests or smoke checks
- project truth
- connector/access records
- claims and artifact locks
- evidence and handoff

If the agent cannot update or verify an affected surface, it must mark the work
blocked with evidence. It must not report done.

## Public Repo Hygiene

The public repo must stay vendor-neutral and free of private facts:

- no provider names in docs, filenames, comments, examples, or commit messages
  unless the user explicitly approves a public provider integration
- no raw tokens, passwords, SSH keys, chat IDs, server secrets, customer facts,
  or private business details
- no local report dumps or old backup files inside the public tree
- no copied provenance or tool-signature text

Runtime-specific names belong in ignored local config, not in committed public
files.
