"use strict";

// PM2 ecosystem for Mnemo - start everything in one command:
//   pm2 start ecosystem.config.js
//
// Override ports/paths via env, e.g.
//   MNEMO_INSPECTOR_PORT=7129 pm2 reload mnemo-inspector

const path = require("path");
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: "mnemo-daemon",
      script: path.join(ROOT, "packages/core/daemon.js"),
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
      autorestart: true,
    },
    {
      name: "mnemo-multi-gateway",
      script: path.join(ROOT, "packages/core/channels/multi_gateway.js"),
      env: { MNEMO_GATEWAY_PORT: process.env.MNEMO_GATEWAY_PORT || "7118" },
      autorestart: true,
    },
    {
      name: "mnemo-inspector",
      script: path.join(ROOT, "packages/core/inspector_ui.js"),
      env: { MNEMO_INSPECTOR_PORT: process.env.MNEMO_INSPECTOR_PORT || "7119" },
      autorestart: true,
    },
    {
      name: "mnemo-remote-mcp",
      script: path.join(ROOT, "packages/core/mnemo_remote_mcp.js"),
      env: { MNEMO_REMOTE_MCP_PORT: process.env.MNEMO_REMOTE_MCP_PORT || "7120" },
      autorestart: true,
    },
    {
      name: "mnemo-skills-watcher",
      script: path.join(ROOT, "packages/core/skills/skills_watcher.js"),
      args: [path.join(ROOT, "packages/core/skills"), "--tenant", "shared"],
      autorestart: true,
    },
    {
      name: "mnemo-email-gateway",
      script: path.join(ROOT, "packages/core/channels/email_gateway.js"),
      env: { MNEMO_EMAIL_PORT: process.env.MNEMO_EMAIL_PORT || "7121" },
      autorestart: true,
    },
  ],
};
