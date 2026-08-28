#!/bin/bash
# The ambience, made impervious. Nothing here touches the game server.
#  - plays through the mac's DEFAULT output (so the laptop's volume keys / menu bar control it; pick the
#    speaker in the sound menu or with: SwitchAudioSource -t output -s "Bence Charge 5")
#  - restarts the player within 3 s if it ever exits
#  - restarts it whenever the default output device changes or a bluetooth speaker reconnects (stale streams)
#  - installed as a launchd agent it survives terminal closes, logouts and reboots (see --install)
cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/ambience.log
PY=audio/venv/bin/python
ARGS=(audio/ambience.py --rain 0.8)          # no --device: default output

if [ "$1" = "--install" ]; then
  P=~/Library/LaunchAgents/com.clocktower.ambience.plist
  cat > "$P" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.clocktower.ambience</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(pwd)/audio/ambience-forever.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ambience.launchd.log</string><key>StandardErrorPath</key><string>/tmp/ambience.launchd.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/com.clocktower.ambience" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$P" && echo "installed + started: com.clocktower.ambience (launchctl bootout gui/$(id -u)/com.clocktower.ambience to stop)"
  exit
fi
if [ "$1" = "--uninstall" ]; then launchctl bootout "gui/$(id -u)/com.clocktower.ambience"; pkill -f "audio/ambience.py"; echo stopped; exit; fi

out_sig() { /opt/homebrew/bin/SwitchAudioSource -c -t output 2>/dev/null; }
last_out="$(out_sig)"
# watchdog: default-output change → restart the player onto the new device
( while true; do sleep 4; cur="$(out_sig)"; if [ "$cur" != "$last_out" ]; then echo "$(date +%H:%M:%S) output → $cur, restarting player" >> "$LOG"; last_out="$cur"; pkill -f "audio/ambience.py"; fi; done ) &
WD=$!
trap 'kill $WD 2>/dev/null; pkill -f "audio/ambience.py"; exit' INT TERM
while true; do
  echo "$(date +%H:%M:%S) player start on: $(out_sig)" >> "$LOG"
  "$PY" -u "${ARGS[@]}" >> "$LOG" 2>&1
  echo "$(date +%H:%M:%S) player exited, retry in 3 s" >> "$LOG"; sleep 3
done
