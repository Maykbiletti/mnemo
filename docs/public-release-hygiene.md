# Public Release Hygiene

Mnemo is a public core. It must stay installable by anyone without inheriting a
specific company, owner, server, agent crew, customer, channel, or private
workflow.

## What Belongs In Git

- generic source code
- neutral examples
- setup instructions
- schema migrations
- public templates
- tests and smoke scripts
- docs that explain concepts without private data

## What Must Stay Local Or Private

- real company facts
- customer names, portals, billing data, VAT details, prices, or legal copy
- private personas, owner preferences, family data, and internal agent crews
- Telegram chat IDs, phone numbers, emails, bot tokens, webhook secrets
- server IPs, SSH commands, PM2 process names for a real deployment
- `.env`, `.env.local`, `.mnemo-hook.env`
- `mnemo.db`, WAL/SHM files, logs, exports, local screenshots
- private packs under `packs/*-personal-pack/`

## Expected Local Paths

Use ignored local files or private packs:

```text
.env.local
.mnemo-hook.env
.mnemo-project-aliases.json
packages/core/facts/<scope>.json
packages/core/facts/<scope>-project-rules.json
packs/<name>-personal-pack/
```

## Pre-Commit Scan

Run this before publishing:

```bash
git status --short
git grep -n -i -e "private" -e "customer-name" -e "server-ip" -e "chat_id" -- .
git grep -n -E "[0-9]{8,}|-[0-9]{10,}|BEGIN (OPENSSH|RSA|EC) PRIVATE KEY" -- .
```

Replace the example search terms with names, domains, IDs, and phrases from your
own private environment.

## Neutral Examples

Use neutral placeholders:

- `owner`
- `agent-a`
- `agent-b`
- `example-project`
- `example-production`
- `https://your-mnemo.example/mnemo`
- `secret_ref`

Do not use a real organization as the default example in public docs.

## Access Records

Mnemo can store how to reach a system, but never the secret itself. Store:

- `system_name`
- `access_kind`
- `entrypoint`
- `account_hint`
- `secret_ref`
- `verified_at`

Do not store raw passwords, private keys, recovery codes, API tokens, or billing
secrets.
