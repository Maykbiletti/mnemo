# @mnemo/client

Minimal Node 18+ client for Mnemo. Native `fetch`, zero dependencies, tenant-aware.

## Install

```bash
npm install @mnemo/client
```

## Use

```js
const { MnemoClient } = require("@mnemo/client");

const mnemo = new MnemoClient({
  url: process.env.MNEMO_URL,        // default http://127.0.0.1:7117
  tenant: "tenant-42",                // sent as X-Tenant-Id header
  token: process.env.MNEMO_TOKEN,     // sent as Authorization: Bearer
});

// 1. Log every user message
await mnemo.ingest({
  kind: "message",
  source: "blun-chat",
  actor: "user-123",
  text: messageBody,
  importance: 5,
  meta: { conversation_id: convId, session_id: sid },
});

// 2. Recall context before calling the LLM
const ctx = await mnemo.recall({ query: messageBody, limit: 5 });
const systemContext = ctx.map(r => `- (${r.actor}, ${r.occurred_at}): ${r.preview}`).join("\n");

// 3. Hand the LLM a system prompt that includes recalled context
const systemPrompt = `You are this user's agent. Recent context:\n${systemContext}`;
const llmReply = await callLLM({ system: systemPrompt, user: messageBody });

// 4. Log the LLM reply too
await mnemo.ingest({
  kind: "message",
  source: "blun-chat",
  actor: "agent",
  text: llmReply,
  importance: 5,
  meta: { conversation_id: convId, session_id: sid, replied_to: messageId },
});
```

## Why use it

Most chat services have an in-memory conversation buffer that resets between sessions. The user re-explains their context every time. With `@mnemo/client` injected at pre/post flight, every conversation contributes to a long-term memory the next conversation can search.

For SaaS, pass a different `tenant` per customer and Mnemo isolates their memories. One Mnemo instance, N tenants.

## Pattern: BLUN-style integration

In a chat route handler:

```js
router.post("/send", async (req, res) => {
  const { tenant_id, user_id, body } = req.body;
  const mnemo = new MnemoClient({ tenant: tenant_id });

  // Log incoming
  await mnemo.ingest({ kind: "message", source: "chat", actor: user_id, text: body, importance: 5 });

  // Recall relevant memory
  const recalled = await mnemo.recall({ query: body, limit: 5 });

  // Hand to your agent worker with recalled context attached
  agentWorker.send({ user_id, body, recalled });

  res.json({ ok: true });
});
```

After your agent worker emits a reply, ingest that too with `actor: "agent"`. The next message recalls both sides.

## API

- `new MnemoClient({ url, tenant, token, timeoutMs })`
- `client.ingest(event)` — POST /ingest
- `client.recall({ query, limit })` — GET /recall
- `client.health()` — GET /health
- `client.raw({ method, path, body })` — escape hatch for any future endpoint

## License

MIT.
