# Security policy

## Supported versions

Mnemo is in early development. Only the `main` branch is supported. No backports to release tags yet.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private "Report a vulnerability" feature on the repo, or email the maintainer directly (contact in [README.md](./README.md)).

We aim to:

- Acknowledge within 72 hours
- Confirm and triage within 7 days
- Ship a fix or mitigation within 30 days for critical issues

## Threat model

Mnemo is designed to run **on a trusted machine you control**. The default HTTP server binds to `127.0.0.1` and is not exposed to the internet. The MCP server runs over stdio.

If you put Mnemo behind a reverse proxy or expose its HTTP endpoint:

- Always require authentication at the proxy layer (Basic-Auth, OAuth, mTLS).
- Treat `mnemo.db` as containing all your private memory — protect it like an SSH key.
- Encrypt at rest if possible (LUKS, BitLocker, FileVault).
- Backups should also be encrypted.

## Sensitive data in memory

By design, Mnemo stores everything you tell it. **Don't paste secrets, passwords, or PII into your agent's chat unless your DB is encrypted.** Future versions will have a redaction layer for known sensitive patterns; for now treat the DB as plaintext-equivalent.

## Skill execution

Skills with `sandbox: docker` will run in isolated containers (Phase 3). Until that ships, all skills run in-process — review skill code before applying it.

## Dependencies

We aim to minimize the dependency tree. Current production deps:

- `better-sqlite3` (database)
- `sqlite-vec` (vector index)
- `@xenova/transformers` (embeddings)

Run `npm audit` and review changes before upgrading any of them.
