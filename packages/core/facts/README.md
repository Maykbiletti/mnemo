# Facts Directory

This directory is for local, tenant-specific facts.

Do not commit real company, customer, server, pricing, legal, team, or project
data here. Install those through a private pack, a local ignored file, or a
deployment-specific `MNEMO_FACTS_DIR`.

Committed files in this directory must be examples only.

Runtime configuration:

- `MNEMO_DEFAULT_SCOPE`: default facts scope for tools that accept `scope`
- `MNEMO_FACTS_DIR`: directory containing `<scope>.json` and
  `<scope>-project-rules.json`

Examples:

- `example.json`
- `example-project-rules.json`
