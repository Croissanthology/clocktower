#!/bin/bash
# clocktower tripwire: one stdout line = one alert; each distinct problem at most once per 10 min
declare -A last
while true; do
  s=$(curl -s -m 5 localhost:4141/api/state)
  if [ -z "$s" ]; then issues="SERVER-DOWN /api/state not answering"; else
  issues=$(python3 - <<'PY' <<<"$s"
import sys, json, time
s = json.load(sys.stdin)
now = time.time()*1000
for p in s['players']:
    if p.get('parseError'): print(f"PLAYER-ERROR-{p['name']} {p['name']}: {p['parseError'][:110]}")
    if p['status']=='thinking' and now-(p.get('thinkingSince') or now) > 150000: print(f"STUCK-{p['name']} {p['name']} thinking {int((now-p['thinkingSince'])/1000)}s")
m=s['mics']
if not m['running']: print("MICS-DOWN transcriber not running")
elif now-m['ts']>20000: print(f"MICS-STALE no mic levels for {int((now-m['ts'])/1000)}s")
ws=s['whispers']
for w in ws:
    if w['from']=='human' and 150000<now-w['ts']<900000:
        if not any(x['from']=='ai' and x['human']==w['human'] and x['ai']==w['ai'] and x['ts']>w['ts'] for x in ws):
            print(f"WHISPER-{w['human']}-{w['ai']} whisper from {w['human']} to {w['ai']} unanswered {int((now-w['ts'])/1000)}s")
if len(s['queue'])>10: print(f"QUEUE-PILEUP {len(s['queue'])} unspoken lines in the queue")
PY
  ); fi
  now=$(date +%s)
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key=${line%% *}
    if [ $(( now - ${last[$key]:-0} )) -ge 600 ]; then last[$key]=$now; echo "$(date +%H:%M:%S) ${line#* }"; fi
  done <<< "$issues"
  sleep 30
done
