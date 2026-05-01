# Skills

A skill is a self-contained recipe for an agent action. Each skill lives in its own folder with at minimum a `SKILL.md` file (declarative frontmatter) and optionally a `run.js` (executable steps).

## Layout

```
skills/
├── README.md              this file
├── book_flight/
│   ├── SKILL.md           required: name, description, triggers, sandbox, sensitive_data
│   └── run.js             optional: deterministic execution
├── pay_invoice/
│   ├── SKILL.md
│   └── run.js
└── <your_skill>/
    └── ...
```

## SKILL.md frontmatter

```yaml
---
name: book_flight
description: Book a flight via Skyscanner. Compare top 3, await confirmation, complete with stored card.
trigger_phrases:
  - 'book (me )?(a )?flight'
  - 'fly to'
  - 'flight to'
sandbox: browser_only        # browser_only | shell | docker | none
requires_confirmation: true
sensitive_data: ['credit_card', 'passport']
status: stub                 # stub | learned | trusted
first_recorded_at: 2026-05-01T22:36:00Z
---

## Recipe steps

1. Open https://www.skyscanner.com
2. Fill departure + destination + date
3. Sort by price + duration
4. Present top 3 to user
5. Await user confirmation
6. Proceed to checkout, fill stored payment details
7. Confirm booking
8. Email confirmation to owner
```

## Discovery

Skills are auto-indexed by `mem_skill_search(query)` — the MCP tool extracts `trigger_phrases` from each `SKILL.md` and matches against the query. Mnemo will surface matching skills before attempting a new task, so it doesn't reinvent recipes.

## Recording new skills

After a successful previously-unknown task, the agent can call `mem_skill_record({ name, description, trigger_phrases, sandbox, recipe_steps, ... })` to persist the recipe. The folder is auto-created and `SKILL.md` written.

## Sandboxing

Skills with `sandbox: docker` will be executed inside a fresh container (network policy + read-only mount) by the upcoming sandbox runner. Until that ships, they fall back to in-process execution; treat the field as a forward-compatibility hint.
