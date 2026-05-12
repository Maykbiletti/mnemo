#!/bin/bash
# Check daemon.js handleTool cases vs mcp.js tool keys to detect drift
DAEMON=/root/mnemo/packages/core/daemon.js
MCP=/root/mnemo/packages/core/mcp.js
DAEMON_TOOLS=$(grep -oE "case \"mem_[a-z_]+\"" $DAEMON | sort -u | sed "s/case \"//; s/\"//")
MCP_TOOLS=$(grep -oE "^  mem_[a-z_]+:" $MCP | sort -u | sed "s/  //; s/://")
echo "=== in daemon, NOT in mcp ==="
comm -23 <(echo "$DAEMON_TOOLS") <(echo "$MCP_TOOLS")
echo "=== in mcp, NOT in daemon ==="
comm -13 <(echo "$DAEMON_TOOLS") <(echo "$MCP_TOOLS")
