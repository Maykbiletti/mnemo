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
| `TELEGRAM_BOT_TOKEN` | _(none)_ | enables Telegram poller + send |

## Wiring into Claude Code

```bash
claude mcp add mnemo --transport stdio -- node /path/to/mnemo/packages/core/mcp.js
```

Then verify:

```bash
claude mcp list | grep mnemo
```

## Wiring into Cursor or any MCP client

The MCP server speaks JSON-RPC 2.0 over stdio (protocol version `2024-11-05`). Any client that supports MCP should pick it up — point it at `node packages/core/mcp.js`.

## Reverse proxy (optional)

If you want `/ingest` reachable from other machines, put a reverse proxy in front:

```nginx
location /mnemo/ {
  proxy_pass http://127.0.0.1:7117/;
  proxy_set_header Host $host;
}
```

Add Basic-Auth or an API-key check at the proxy layer. Don't expose Mnemo's HTTP server directly to the internet without auth.
