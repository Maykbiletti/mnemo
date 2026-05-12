#!/bin/bash
STATE=/root/mnemo/.brief_poll_state
LOG=/root/mnemo/poll_briefs.log
LAST=$(cat $STATE 2>/dev/null || echo 0)
RES=$(curl -s -X POST http://127.0.0.1:7117/tool/mem_brief_pull -H 'Content-Type: application/json' -d '{"agent_name":"dieter","limit":20}')
NEW=$(echo "$RES" | python3 -c 'import sys,json;d=json.load(sys.stdin);b=[x for x in d["result"]["briefs"] if x["id"]>'$LAST'];print(len(b));[print(x["id"],"|",x.get("source_agent","?"),"|",x["content"][:120].replace(chr(10)," ")) for x in b]' 2>/dev/null)
COUNT=$(echo "$NEW" | head -1)
if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  MAX=$(echo "$NEW" | tail -n+2 | awk '{print $1}' | sort -n | tail -1)
  echo $MAX > $STATE
  echo "[$(date -Iseconds)] +$COUNT new briefs (last id $MAX)" >> $LOG
  echo "$NEW" | tail -n+2 >> $LOG
  # Telegram notify
  TXT="$COUNT neue Briefs gepullt ($(echo "$NEW" | tail -n+2 | head -3))"
  curl -s -X POST 'https://api.telegram.org/bot8038117420:AAGZX9P0eMVi5WfaIqu5dRUm2NfX3-htEK4/sendMessage'     --data-urlencode chat_id=1605241602     --data-urlencode text="$TXT" >/dev/null
fi
