# Mnemo Packs

Packs are optional, local bootstrap bundles for identity, preferences, facts, or
project rules.

The public repository only includes `example-pack`. Real owner personas,
company facts, project rules, customer data, servers, prices, and agent rosters
belong in private packs or local ignored files.

Apply a pack from the repo root:

```bash
cd mnemo
node packages/core/bin/mnemo.js pack apply example-pack
```

Pack contract:

- `pack.js` is executable with Node.
- It reads `MNEMO_DB` or defaults to `packages/core/mnemo.db`.
- It may write `core_value`, `personality_trait`, `memory`, facts files, and
  project-rule seeds.
- It must not assume a specific owner, company, agent name, or server unless it
  is a private pack.
