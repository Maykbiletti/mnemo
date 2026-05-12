# Contributing to Mnemo

Mnemo is in active early development. Contributions welcome — but please read this first.

## What we're looking for

- **Channel adapters** for new platforms (Slack, Discord, Matrix, Signal). The `BaseChannel` interface is small and well-defined; new adapters are great first contributions.
- **Embedding model adapters** beyond Xenova/MiniLM — OpenAI, Cohere, Mistral, local Ollama.
- **Skills**: SKILL.md + run.js pairs that solve common agent tasks (booking, payment, scraping, summarization).
- **Personality packs** (`@mnemo/pack-*`) that demonstrate different agent styles.
- **Storage backend swaps**: keep the SQLite default, but explore a Postgres backend behind the same query layer.
- **Documentation**: real-world setup stories, integration with other MCP clients (Cursor, Cline, etc.).

## What we're NOT looking for (yet)

- Major schema changes — Phase 2/3 has its own roadmap.
- Replacing SQLite with anything else as the default. The single-file-DB property is load-bearing.
- Adding heavy runtime dependencies. We prefer ~5 npm packages total.

## How to submit

1. Open an issue first describing what you want to add. We'll discuss scope before code.
2. Fork → branch → PR.
3. Keep PRs small. If you have a 1000-line PR, that's actually 5 PRs.
4. Run `npm test` (when we have tests — currently smoke-tests only).
5. Update `ROADMAP.md` if your change shifts the plan.

## Code style

- Plain JavaScript, Node 20+. No TypeScript-required-for-build for the core.
- `"use strict"` everywhere.
- No frameworks. No router. The whole HTTP server is one `http.createServer` call — keep it that way.
- Comments only when the *why* is non-obvious.

## License

By contributing, you agree your contribution is MIT-licensed (same as the project).

## Code of conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Short version: be helpful, be honest, don't be a jerk.
