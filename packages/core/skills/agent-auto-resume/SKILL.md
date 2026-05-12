---
name: agent-auto-resume
description: Poll local runtime tmux panes and auto-confirm only whitelisted low-risk prompts.
trigger_phrases:
  - "agent auto resume"
  - "approval prompt stuck"
  - "tmux agent continue"
sandbox: shell
requires_confirmation: false
sensitive_data:
  - "tmux pane contents"
  - "approval prompts"
status: learned
---

## Purpose

Keep local runtime agent loops moving when they stop on routine approval/resume prompts, while escalating destructive or secret-exposing commands.

## Poll Loop

1. Enumerate configured local runtime tmux sessions.
2. Every 10 seconds run `tmux capture-pane -t <session> -p`.
3. Match prompt text case-insensitively: `approve?`, `resume?`, `continue?`, `(y/n)?`, `proceed?`.
4. Read the nearby command/context line before deciding.

## Auto-Confirm Whitelist

Auto-confirm only when the captured context is limited to:

- file-edit
- ssh
- scp
- npm-build
- git-status
- mem_*
- sql-select-ro

## Escalation Blocklist

Never auto-confirm; brief the owner/team instead:

- pm2-delete
- pm2-kill
- rm-rf
- drop-database
- secret-print
- env-cat

## Receipt Rules

Log every decision through Mnemo:

- auto-confirm: `mem_event_log` with `source=process:agent-auto-resume`, `event_kind=auto_confirm`
- escalation: `mem_event_log` with `event_kind=auto_resume_escalation`
- process stdout/stderr: use the Universal Capture process pipe wrapper and `source=process:<name>`
