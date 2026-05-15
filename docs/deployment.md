# Deployment

Mnemo is designed to run on a small VPS or a home server. SQLite + Node.js, no external dependencies beyond what npm provides.

## Recommended layout

- 1 vCPU, 1 GB RAM is plenty for a personal Mnemo with thousands of memories.
- 2 vCPU, 2 GB RAM if you're embedding aggressively (back-fills are CPU-bound).
- Disk: budget ~1 MB per 1000 memory rows + ~10x for embeddings.

## Production setup with PM2

```bash
git clone https://github.com/Maykbiletti/mnemo.git
cd mnemo/packages/core
npm install
node bin/mnemo.js init       # answers your name, channels, timezone
npm install -g pm2
pm2 start daemon.js --name mnemo-daemon
pm2 startup && pm2 save
```

## Agent loop self-start

After PM2 is installed, an agent can start or repair its own worker loop:

```bash
cd /path/to/mnemo/packages/core
MNEMO_URL=http://127.0.0.1:7117 npm run agent-loop:start -- agent-a /path/to/workspace --engine agent
```

On Windows PowerShell:

```powershell
cd C:\path\to\mnemo\packages\core
$env:MNEMO_URL="https://your-mnemo.example/mnemo"
npm run agent-loop:start -- agent-a C:\path\to\workspace --engine agent
```

The helper starts `agent-loop-<agent>` with PM2, passes the agent name and
workspace as script args, saves PM2 state, and enables the pre-work,
completion, regression, and site-contract guards by default.
The helper defaults to the local runtime engine and ignores accidental generic
`AGENT_ENGINE` shell state; set a different supported engine only when that is
deliberate for the runtime you are using.
Pre-work defaults to deterministic mode so the loop cannot burn a full model run
or hang before it starts real work. Set `LOOP_PRE_WORK_MODE=llm` only if you
explicitly want an agent-run planning phase.
If the configured engine returns an auth failure such as `403 Forbidden`, the
worker records `auth_failed`, sends a blocked heartbeat, and pauses new work for
`ENGINE_AUTH_COOLDOWN_MIN` minutes (default 15) instead of retrying the same
brief repeatedly.
Briefs that start with `[STATUS]`, `[INFO]`, `[FYI]`, or `[UPDATE]` and contain
no explicit action request are acknowledged without model execution.

## Cron for embeddings + open-loop sweep + nightly export

```cron
*/10 * * * * cd /path/to/mnemo/packages/core && /usr/bin/node embedding_writer.js >> /var/log/mnemo-embed.log 2>&1
*/15 * * * * cd /path/to/mnemo/packages/core && /usr/bin/node loop_scanner_v2.js >> /var/log/mnemo-loops.log 2>&1
15 6 * * *   cd /path/to/mnemo/packages/core && /usr/bin/node export_declarative.js >> /var/log/mnemo-export.log 2>&1
```

## Nightly DB backup (suggested)

```cron
15 4 * * * sqlite3 /path/to/mnemo.db ".backup /backup/mnemo-$(date +\%Y\%m\%d).db" && find /backup -name 'mnemo-*.db' -mtime +30 -delete
```

For off-machine backups: pipe through SSH to a remote storage box.

## Environment variables

| var | default | meaning |
|---|---|---|
| `MNEMO_DB` | `./mnemo.db` | path to SQLite file |
| `MNEMO_HTTP_PORT` | `7117` | HTTP server port |
| `MNEMO_HTTP_HOST` | `127.0.0.1` | bind host |
| `MNEMO_OWNER_NAME` | `owner` | the agent's owner identity |
| `MNEMO_OWNER_CHAT_ID` | _(none)_ | Telegram chat-id (if Telegram enabled) |
| `MNEMO_ESCALATION_CHAT_ID` | `MNEMO_OWNER_CHAT_ID` | Telegram chat-id for high-urgency escalation delivery |
| `MNEMO_OWNER_USER_ID` | _(none)_ | Telegram user-id for backfill scripts |
| `MNEMO_TZ_OFFSET_HOURS` | `0` | timezone offset for quiet-hours calc |
| `MNEMO_QUIET_START` | `23` | hour quiet hours begin |
| `MNEMO_QUIET_END` | `7` | hour quiet hours end |
| `MNEMO_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | embedding model id |
| `MNEMO_EMBED_BATCH` | `500` | rows per embedding batch |
| `MNEMO_EMBED_MAX` | `10000` | max embeddings per `embedding_writer` run |
| `MNEMO_EMBED_MIN_IMPORTANCE` | `5` | min importance for embedding |
| `MNEMO_MODEL_CACHE` | `./.models` | where to cache ONNX model weights |
| `MNEMO_SKILLS` | `./skills` | path to skills folder |
| `MNEMO_EXPORTS_DIR` | `./exports` | where SOUL/AGENTS/TOOLS markdown lands |
| `MNEMO_CODE_ROOTS` | workspace, repo, home | extra path roots allowed for `mem_code_outline` / `mem_code_unfold` |
| `MNEMO_CODE_MAX_FILE_BYTES` | `2097152` | max file size for smart code reads |
| `MNEMO_CODE_MAX_SYMBOLS` | `500` | max symbols returned by code outline |
| `MNEMO_CODE_MAX_UNFOLD_LINES` | `500` | max lines returned by code unfold |
| `MNEMO_REQUIRE_SMART_CODE_READ` | `1` | block direct full reads of large source files in the runtime hook |
| `MNEMO_SMART_CODE_READ_MIN_BYTES` | `20000` | source-file size where direct full reads must switch to outline/unfold |
| `EXTERNAL_AGENT_BIN` | `assistant` | binary used by `AGENT_ENGINE=print-cli` |
| `EXTERNAL_AGENT_MAX_TURNS` | `40` | max turns passed to a print-mode external CLI |
| `TELEGRAM_BOT_TOKEN` | _(none)_ | enables Telegram poller + send |

## Wiring into an MCP Client

```bash
node /path/to/mnemo/packages/core/mcp.js
```

Then verify:

```bash
<your-agent-client> mcp list | grep mnemo
```

## Wiring into Cursor or any MCP client

The MCP server speaks JSON-RPC 2.0 over stdio (protocol version `2024-11-05`). Any client that supports MCP should pick it up — point it at `node packages/core/mcp.js`.

## Reverse proxy (optional)

If you want the HTTP tool API reachable from other machines, put a reverse
proxy in front and keep the daemon bound to `127.0.0.1`:

```nginx
location ^~ /mnemo/tool/ {
  proxy_pass http://127.0.0.1:7117/tool/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location = /mnemo/memory-tool {
  proxy_pass http://127.0.0.1:7117/memory-tool;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /mnemo/ {
  proxy_pass http://127.0.0.1:7119/;
  proxy_set_header Host $host;
}
```

Use the `7119` route only if you run the optional inspector UI. Add Basic-Auth,
OAuth, mTLS, or an API-key check at the proxy layer. Do not expose Mnemo's HTTP
server directly to the internet without auth.
