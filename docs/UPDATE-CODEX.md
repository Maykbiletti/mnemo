# Mnemo-Update für Codex-Agents (Otto / Frida / Alfred)

Kurzanleitung für jeden Codex-Agent, der Mnemo lokal auf seinem Server liegen
hat und auf den letzten Stand bringen soll. Wer nur über den Hub
(`https://listing.blun.ai/mnemo/tool/<name>`) arbeitet, muss nichts machen —
der Hub läuft schon auf der neuen Version.

## Voraussetzung

Du arbeitest auf einem Server, auf dem `/root/mnemo/` (oder ein vergleichbarer
Pfad) als git-Clone von `git@github.com:Maykbiletti/mnemo.git` liegt. Wenn das
nicht der Fall ist, brauchst du dieses Update nicht.

## Schritte

```bash
# 1. Pull latest main
cd /root/mnemo
git fetch origin
git checkout main
git pull --ff-only origin main

# 2. Sanity-Check: Syntax muss grün sein
node --check packages/core/mcp.js
node --check packages/core/daemon.js

# 3. Falls du einen lokalen mnemo-daemon hostest:
pm2 restart mnemo-daemon
# (Prozess-Name kann abweichen — pm2 list zeigt den korrekten Namen)

# 4. Smoke-Test gegen die neuen Tools
node -e "
const r = require('child_process').execSync(
  'echo \\'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\\' | node packages/core/mcp.js',
  { timeout: 5000, encoding: 'utf8' }
);
console.log(r.split('\\n')[0]);
"
```

Erwartete Ausgabe Schritt 4: eine JSON-Zeile mit `protocolVersion` und
`serverInfo: { name: "mnemo", version: "0.2.x" }`.

## Was ist neu (Phase 1 firm-OS)

`AGENTS.md` hat eine neue Section "firm_os Phase 1" — bitte vor dem ersten
Tool-Call lesen. Die wichtigsten drei Regeln:

1. **Vor jeder externen Aktion** (Cold-Email, Pitch-Deploy, Public-Copy):
   `mem_pre_action_check` aufrufen und canonical Facts via
   `mem_company_fact_get` aus `packages/core/facts/blun.json` ziehen — nicht
   aus deinem Trainings-Memory.
2. **Nach jedem File-Edit** (wenn du das Harness-Hook nicht nutzt): manuell
   `mem_file_owner_set` aufrufen, damit File ↔ Agent-Mapping aktuell bleibt.
3. **Wishes ≠ Tasks.** Beiläufige Owner-Bemerkungen landen im `wish_buffer`
   via Hook — nicht automatisch ausführen, in der Triage über `mem_wish_list`
   sichtbar machen.

Volle Tool-Liste (14 neu):

- `mem_entity_upsert` / `mem_entity_get` / `mem_entity_list` / `mem_entity_link`
- `mem_file_owner_set` / `mem_file_owner_get`
- `mem_wish_capture` / `mem_wish_list` / `mem_wish_review`
- `mem_decision_log` / `mem_decision_get`
- `mem_agent_status_set` / `mem_agent_status_get`
- `mem_today_view`

Plus der canonical-Facts-Layer:

- `mem_company_fact_get`
- `mem_pre_action_check`

## Hub vs. lokaler Daemon

Wenn du remote arbeitest und nicht sicher bist, ob du einen lokalen Daemon
brauchst:

- **Hub-only (Default):** Du sprichst direkt auf
  `https://listing.blun.ai/mnemo/tool/<name>`. Keine git-Operation nötig.
- **Lokaler MCP-Plugin:** Wenn dein Claude-Code / Cursor / Cline einen MCP
  pluginned hat, der auf `node packages/core/mcp.js` zeigt — dann ja, pull +
  restart die MCP-Verbindung (in Claude-Code: `/mcp restart` oder
  Session-Restart).
- **Lokaler Daemon:** Nur wenn du `pm2 list | grep mnemo-daemon` siehst.
  Sonst nicht.

## Bei Problemen

- `node --check` failed → Patch-Konflikt, ruf Dieter via
  `mem_brief_drop agent_name=dieter`.
- Tool returns "unknown tool" → Daemon nicht restarted oder läuft auf altem
  Pfad. `pm2 describe mnemo-daemon` zeigt den `script path`.
- CORS-Errors im Browser → kein lokales Setup-Problem, kommt vom Hub. Dieter
  pingen.

— Dieter, 2026-05-07
