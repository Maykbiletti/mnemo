# Hub Operations

This guide documents the shared hub surface that agents should use before they
start work, when they need a compact memory frontdoor, and when they need to
debug blocked or stale coordination state.

Keep this document generic. Real domains, server IPs, tokens, chat IDs, and
customer facts belong in local config, private packs, access records, or a
vault reference, not in the public repo.

## Reverse Proxy Shape

Run the core daemon on a private interface and expose only the routed hub
frontdoors through your proxy:

```nginx
location ^~ /mnemo/tool/ {
  proxy_pass http://127.0.0.1:7117/tool/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 60s;
}

location = /mnemo/memory-tool {
  proxy_pass http://127.0.0.1:7117/memory-tool;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 60s;
}

location = /mnemo/health {
  proxy_pass http://127.0.0.1:7117/health;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 60s;
}

location /mnemo/ {
  proxy_pass http://127.0.0.1:7119/;
  proxy_set_header Host $host;
}
```

Add authentication at the proxy layer before exposing a hub to the internet.
The core HTTP daemon is not a public anonymous API.

## Memory Frontdoor

`POST /mnemo/memory-tool` exposes a file-like view over selected Mnemo context.
It is designed for agents that need a predictable first read without loading a
large markdown export or guessing tool names.

Example:

```bash
curl -s https://your-mnemo.example/mnemo/memory-tool \
  -H 'content-type: application/json' \
  -d '{"command":"view","path":"/memories/top.md","agent":"agent-a","project":"example-project"}'
```

Recommended first reads:

- `/memories/top.md` - weighted current context and hot work.
- `/memories/today.md` - recent activity.
- `/memories/inbox.md` - pending briefs and visible assignments.
- `/memories/projects/<project>/registry.md` - canonical project registry view.
- `/memories/projects/<project>/live-check.md` - current live verification notes.
- `/memories/projects/<project>/rules.md` - project rules and constraints.
- `/memories/projects/<project>/findings.md` - open quality findings.

## Tool Frontdoor

`POST /mnemo/tool/<tool_name>` calls structured tools over HTTP. Use it for
automation, diagnostics, and bridges that cannot use stdio MCP directly.

`GET /mnemo/health` should route to the core daemon's `/health` endpoint so
`mnemo hook-doctor` can distinguish a real hub problem from a proxy gap.

Examples:

```bash
curl -s https://your-mnemo.example/mnemo/tool/mem_recall \
  -H 'content-type: application/json' \
  -d '{"query":"blocked VAT task","limit":5}'

curl -s https://your-mnemo.example/mnemo/tool/mem_project_registry_list \
  -H 'content-type: application/json' \
  -d '{"limit":10}'
```

## Ops Hardening Rules

Blocked work must explain why it is blocked. Autonomy review briefs include the
blocker reason and batch position so the receiver can see "why" and "how many"
without rediscovering the same context.

Autonomy task updates may receive a linked brief ID. When possible, Mnemo
resolves that brief ID to the real autonomy task ID and reports the resolved
ID. Setting a task to `blocked` without a blocker reason is rejected.

Recall first uses the configured search mode. If exact matching returns no
usable result, Mnemo falls back to a bounded fuzzy/LIKE search so typo-heavy
queries still surface likely rows.

Hook output should stay compact. Large hook payloads are written to a rotating,
ASCII-safe JSONL queue and the injected context stays focused on critical
items, brief previews, and the selected memory frontdoor paths.

## Smoke Checks

After a hub deploy or proxy change, run:

```bash
curl -s https://your-mnemo.example/mnemo/memory-tool \
  -H 'content-type: application/json' \
  -d '{"command":"view","path":"/memories/top.md","agent":"agent-a","project":"example-project"}'

curl -s https://your-mnemo.example/mnemo/tool/mem_recall \
  -H 'content-type: application/json' \
  -d '{"query":"known test phrase","limit":3}'

curl -s https://your-mnemo.example/mnemo/tool/mem_project_registry_list \
  -H 'content-type: application/json' \
  -d '{"limit":5}'

curl -s https://your-mnemo.example/mnemo/health
```

A good result is not only HTTP 200. Confirm that the response contains current
hub data, not an empty placeholder or stale local install.
