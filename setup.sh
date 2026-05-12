#!/usr/bin/env bash
# setup.sh - one-shot bootstrap for Mnemo on a fresh host.
#
# 1) installs deps,
# 2) runs interactive bootstrap.js (owner identity, autonomy mode, channels),
# 3) starts the PM2 ecosystem (daemon, gateway, inspector, remote-mcp, skill-watcher),
# 4) prints next steps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "[setup] node not found - install Node 20+ first." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[setup] node $NODE_MAJOR detected - Mnemo requires Node 20+." >&2
  exit 1
fi

echo "[setup] installing dependencies..."
if [ -f package.json ] && [ ! -d node_modules ]; then
  npm install --omit=dev
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[setup] installing pm2 globally..."
  npm install -g pm2
fi

echo
echo "[setup] running interactive bootstrap (owner + autonomy + channels)..."
node packages/core/bootstrap.js

echo
echo "[setup] starting PM2 processes..."
pm2 start ecosystem.config.js
pm2 save

cat <<EOF

======================================================================
  Mnemo is up.

  Daemon:        http://127.0.0.1:7117/health
  Multi-gateway: http://127.0.0.1:7118/healthz
  Inspector UI:  http://127.0.0.1:7119
  Remote MCP:    http://127.0.0.1:7120/mcp/list_tools

  Useful skills:
    node packages/core/skills/agent_skills_loader.js <dir>
    node packages/core/skills/nl_cron.js "daily 8am: ..."
    node packages/core/skills/subagent_pool.js spawn --task "..."
    node packages/core/skills/llm_router.js --providers
    node packages/core/skills/owner_map.js add --owner you --platform telegram --id 123
    node packages/core/skills/soul_loader.js path/to/SOUL.md --tenant you
    node packages/core/skills/approval_queue.js list
    node packages/core/skills/context_files.js ./your-project --tenant you
    node packages/core/skills/dialectic_modeler.js --tenant you --actor you

  PM2:           pm2 status        pm2 logs <name>     pm2 restart <name>
  llms.txt:      cat llms.txt

======================================================================
EOF
