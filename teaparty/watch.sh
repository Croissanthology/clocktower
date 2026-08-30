#!/bin/bash
# tea room tripwire: stage changes, stuck creatures, base model down, door attempts, ladder events — one line each
last_stage=""; last_ctx=0; declare -A seen
while true; do
  s=$(curl -s -m 5 localhost:4242/api/state); if [ -z "$s" ]; then now=$(date +%s); if [ $(( now - ${seen[down]:-0} )) -ge 300 ]; then seen[down]=$now; echo "$(date +%H:%M:%S) TEA SERVER DOWN"; fi; sleep 20; continue; fi
  out=$(python3 - "$last_stage" "$last_ctx" <<'PY' <<<"$s"
import sys,json,time; s=json.load(sys.stdin); last_stage=sys.argv[1]; last_ctx=int(sys.argv[2]); now=time.time()*1000
st=s.get('stage'); 
if st!=last_stage: print(f"STAGE {st} (active: {s.get('active')})")
for c in s['chars']:
    if c['status']=='thinking' and now-(c.get('thinkingSince') or now)>90000: print(f"STUCK {c['name']} thinking {int((now-c['thinkingSince'])/1000)}s")
    if '(bad JSON' in (c.get('lastStatus') or ''): print(f"BADJSON {c['name']}")
if not s['base']['alive'] and st=='scroll': print("BASE MODEL OFFLINE during scroll stage")
if now-s.get('micTs',0)>20000: print("MICS STALE")
for e in s['ctx'][last_ctx:]:
    if e['kind']=='phase' and not e['text'].startswith('—'): print("EVENT "+e['text'][:100])
print(f"__CTX {len(s['ctx'])} __STAGE {st}")
PY
)
  while IFS= read -r line; do case "$line" in "__CTX "*) set -- $line; last_ctx=$2; last_stage=$4;; "") ;; *) echo "$(date +%H:%M:%S) $line";; esac; done <<< "$out"
  sleep 10
done
