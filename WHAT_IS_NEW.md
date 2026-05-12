# What's new in Mnemo (May 2026)

This batch adds supporting modules that make Mnemo usable as a self-hostable agent runtime.
The files live under `packages/core/skills/`, `packages/core/channels/`, or `packages/core/`
and cooperate with the existing daemon and MCP surface.

| # | Module | Purpose | Long-running? |
|---|--------|---------|---------------|
| 1 | `skills/agent_skills_loader.js` | Ingest `SKILL.md` folders into Mnemo as `kind=skill` | no |
| 2 | `skills/skills_watcher.js` | Watch skill dirs and re-ingest on change | yes |
| 3 | `skills/skill_runner.js` | Execute a skill with sandbox enforcement | no |
| 4 | `skills/approval_queue.js` | Queue actions that require confirmation | no |
| 5 | `skills/owner_map.js` | Cross-platform identity mapping | no |
| 6 | `skills/soul_loader.js` | Seed a `SOUL.md` into the identity layer | no |
| 7 | `skills/context_files.js` | Auto-ingest project context files | no |
| 8 | `skills/nl_cron.js` | Natural-language scheduling to managed cron entries | no |
| 9 | `skills/subagent_pool.js` | Spawn isolated subprocesses for parallel work | no |
|10 | `skills/llm_router.js` | Choose provider/model by task class and target | no |
|11 | `skills/dialectic_modeler.js` | Periodic user-model refinement | no |
|12 | `channels/multi_gateway.js` | Slack, Discord, WhatsApp, and generic webhook ingest | yes |
|13 | `channels/email_gateway.js` | IMAP/SMTP bridge for inbound/outbound email | yes |
|14 | `inspector_ui.js` | Live debug dashboard on port 7119 | yes |
|15 | `mnemo_remote_mcp.js` | Expose Mnemo tools over HTTP/SSE | yes |
|16 | `llms.txt` | Machine-readable interface description | n/a |
|17 | `ecosystem.config.js` + `setup.sh` | One-command PM2 bootstrap | n/a |

## Quick start

```bash
git clone <repo> mnemo
cd mnemo
./setup.sh
```

## Reload after edits

```bash
pm2 reload ecosystem.config.js
pm2 status
```

## Identity/autonomy defaults

The extended bootstrap flow can seed core values such as:

- `autonomy_mode`
- `daily_ship_quota`
- `when_unsure`
- `default_channels`

That gives agents a stable baseline for self-initiated work, escalation behavior, and channel subscriptions.
