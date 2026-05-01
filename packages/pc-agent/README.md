# mnemo-pc

Single-file PC agent. Runs on Windows, macOS, Linux. Connects out (WSS) to a Mnemo dispatcher and accepts RPC calls — screenshot, file read/write, shell exec, tap, type, app launch.

The agent is owned by you. The dispatcher only ever speaks to it via your pairing code, and destructive operations require explicit confirmation.

## Status

Skeleton. The wire protocol + connection lifecycle + handful of tools (file_read, file_write, shell_exec, device_info) are real. The platform-specific tools (screenshot, tap_at, key_press, app_open) are stubs awaiting per-OS implementations.

## Build

```bash
cd packages/pc-agent
go mod tidy
make                 # build for current platform
make all             # cross-build for win, mac (arm64+amd64), linux
```

Output goes to `dist/`.

## Usage

```bash
# 1. Pair with the dispatcher (one-time)
./mnemo-pc pair --dispatcher https://mnemo.your-domain --code 123456

# 2. Run (uses ~/.mnemo-pc.json from previous pair)
./mnemo-pc run
```

The dispatcher displays the 6-digit code in your Mnemo dashboard or via the `mem_pc_pair_start()` MCP tool.

## Configuration

After pairing, settings live in `~/.mnemo-pc.json`:

```json
{
  "device_id": "...",
  "jwt": "...",
  "ws_url": "wss://mnemo.your-domain/pc/ws",
  "dispatcher": "https://mnemo.your-domain",
  "device_name": "Mayk-MBP",
  "os": "darwin",
  "paired_at": "2026-05-01T22:00:00Z"
}
```

The JWT is a session token. Re-pair to rotate it.

## Tools

| tool | status | notes |
|---|---|---|
| `device_info` | works | round-trip smoke test, no args |
| `file_read` | works | `{path, encoding?}` |
| `file_write` | works | `{path, content, encoding?, confirm: true}` |
| `shell_exec` | works | `{cmd, cwd?, timeout_sec?, confirm: true}` |
| `screenshot` | stub | platform binding pending |
| `tap_at` | stub | platform binding pending |
| `type_text` | stub | platform binding pending |
| `key_press` | stub | platform binding pending |
| `app_open` | stub | platform binding pending |
| `call_phone` | stub | mobile only (Mnemo Remote app) |

## Confirm-layer

For `file_write` and `shell_exec`, the agent returns `{status: "needs_confirmation", ...}` unless `confirm: true` is in the args. The dispatcher should display the pending action to the device owner (Telegram push, web UI) and re-issue with confirm=true after explicit approval.

This is the safety floor — the OS-level perms apply on top.

## Auto-update

Not yet. The Phase-2 plan: lightweight updater that polls the dispatcher's `/pc/version` for newer signed builds and self-replaces.

## Distribution

GitHub Releases will host signed builds:

- Windows: signed with Mayks Sectigo cert
- macOS: notarized via Apple Developer Account
- Linux: GPG-signed tarball

Until then, `make all` produces unsigned builds you can run yourself.
