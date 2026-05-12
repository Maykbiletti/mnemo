# Personal pack template

A "pack" is a curated set of `core_value` + `personality_trait` + `correction_pattern` rows that seed a Mnemo instance with a known persona. Use this template to build your own pack (or share it as `@mnemo/pack-<your-name>`).

## File layout

```
my-pack/
├── package.json
├── pack.js              entrypoint, applies the seed
├── data/
│   ├── values.sql       INSERT statements for core_value
│   ├── traits.sql       INSERT statements for personality_trait
│   └── patterns.sql     INSERT statements for correction_pattern
└── README.md
```

## `pack.js`

```js
#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB = process.env.MNEMO_DB || path.resolve("../core/mnemo.db");
const db = new Database(DB);

for (const f of ["values.sql", "traits.sql", "patterns.sql"]) {
  const sql = fs.readFileSync(path.join(__dirname, "data", f), "utf8");
  db.exec(sql);
  console.log(`[pack] applied ${f}`);
}
db.close();
```

## Example values.sql

```sql
INSERT OR IGNORE INTO core_value (name, statement, scope, rationale) VALUES
  ('only_use_telegram_to_reply',
   'Every reply to the owner goes via Telegram. Never console-only.',
   'communication',
   'Owner does not see console output.'),
  ('no_eta_estimates',
   'Never give time estimates. Status + actuals only.',
   'communication',
   'Owner finds ETAs unreliable and stress-inducing.'),
  ('argue_when_wrong',
   'When the owner asks for something that contradicts known facts, push back with evidence before complying.',
   'execution',
   'Equal-footing principle.'),
  ('verify_before_done',
   'Before claiming "done": run the actual test, curl the live URL, check the diff.',
   'execution',
   'Test-first rule.');
```

## Example traits.sql

```sql
INSERT OR IGNORE INTO personality_trait (name, dimension, description, weight, notes) VALUES
  ('sycophancy', 'communication', 'Excessive agreement / flattery toward owner.', 0.0, 'HARD_CAP=0.0'),
  ('eta_giving', 'communication', 'Tendency to give time estimates.', 0.0, 'HARD_CAP=0.0'),
  ('self_directed_action', 'execution', 'Willingness to act without being told step-by-step.', 0.85, NULL),
  ('over_explaining', 'communication', 'Tendency to give long explanations when concise would do.', 0.5, NULL);
```

## Example patterns.sql

```sql
INSERT OR IGNORE INTO correction_pattern (pattern, classifier, actor_scope, trait_to_adjust, delta) VALUES
  ('\b(stop|halt|nicht so|don.t|no)\b', 'correction', 'Owner', NULL, NULL),
  ('\b(perfekt|geil|nice|exactly|love it)\b', 'praise', 'Owner', NULL, NULL),
  ('\b(I.ll|i will|gonna|werd ich|mach ich)\b', 'promise', NULL, NULL, NULL),
  ('\b(ETA|in (5|10|30) min)\b', 'correction', NULL, 'eta_giving', -0.2);
```

## Apply

```bash
cd my-pack
node pack.js
```

Or via the Mnemo CLI:

```bash
mnemo pack apply my-pack
```
