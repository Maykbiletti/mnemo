# Skills registry (mnemohub.ai concept)

The `skills/` folder in `@mnemo/core` ships with two example stubs (`book_flight`, `pay_invoice`) and the `mem_skill_search` / `mem_skill_record` tools that let an agent discover + write recipes. That covers the local case: you and your agent grow your own library over time.

The next layer up is **shared skills**. The thing the LangChain ecosystem famously got wrong was bundling thousands of plugins into the core monorepo, where:
- security review can't keep up,
- the dependency tree explodes,
- one buggy plugin breaks the rest,
- there's no clear ownership.

We don't want that. The plan is to ship a thin core + a separate skill-registry surface. Working name: **mnemohub.ai**.

## What the registry does

- Hosts skill packages with semantic versioning, stable IDs, and signed manifests.
- Each skill declares its `sandbox` requirement (`browser_only` | `shell` | `docker` | `none`), `requires_confirmation` flag, and `sensitive_data` categories.
- Lookup: an agent that doesn't find a recipe locally via `mem_skill_search` can optionally search the registry (`mem_skill_search_registry`) and pull a candidate down for review.
- Pull is always opt-in — no auto-installation. A skill is a piece of code that will run on your machine; explicit "yes, install" is required.

## What the registry does NOT do

- It does not replace `@mnemo/core`. Core stays small, registry lives separately.
- It does not auto-update installed skills.
- It does not serve as a dependency manager — skills declare their own runtime needs and get sandboxed accordingly.

## Structure of a registry skill

Same as a local skill folder:

```
mnemohub:slack-summarize@1.2.0/
├── SKILL.md            (frontmatter: name, description, triggers, sandbox, sensitive_data, signature)
├── run.js              (executable steps)
├── README.md
└── tests/              (recommended; the registry CI runs these on publish)
```

Plus on the registry side:

- `manifest.json` — package metadata, signature, declared permissions
- `signature.sig` — author signature over manifest + content
- `provenance.json` — build log, source-repo hash, reviewer notes (if reviewed)

## Status

Concept locked, no infra yet. The current `skills/` folder layout is forward-compatible — when the registry exists, locally-recorded skills can be promoted to it without restructuring.

## Why this isn't urgent

Mnemo solves the cold-start problem for an *individual* agent by recording every skill it learns in `skills/`. The registry only matters once cross-agent skill-sharing becomes a frequent need. Until then, every Mnemo install grows its own library through use, and that's enough.
