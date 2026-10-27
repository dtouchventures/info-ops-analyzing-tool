#!/usr/bin/env bash
# Read-only status of the AIVS transcription service. Changes nothing and never prints the token.
#   sudo bash status.sh
PORT=9000; ENVF=/etc/aivs-transcribe.env
echo "== Server: $(nproc) CPU cores, $(awk '/MemTotal/ {printf "%.0f", $2/1048576}' /proc/meminfo) GB RAM, $(df -BG --output=avail / | tail -1 | tr -dc 0-9) GB free disk"
if [ -f /etc/systemd/system/aivs-transcribe.service ]; then
  echo "== Service: installed; $(systemctl is-active aivs-transcribe); starts at boot: $(systemctl is-enabled aivs-transcribe 2>/dev/null)"
else echo "== Service: NOT installed (run: sudo AIVS_ALLOW_FROM=<AIVS computer address> bash install.sh)"; fi
if [ -f "$ENVF" ]; then
  echo "== Settings ($ENVF, $(stat -c '%a %U:%G' "$ENVF")):"
  grep -v '^TRANSCRIBE_TOKEN=' "$ENVF" | sed 's/^/   /'
  grep -q '^TRANSCRIBE_TOKEN=.\{20,\}' "$ENVF" && echo "   TRANSCRIBE_TOKEN=(set, not shown)" || echo "   TRANSCRIBE_TOKEN is MISSING"
fi
for u in /home/*; do [ -f "$u/aivs-transcribe-token.txt" ] && echo "== Token copy for set-transcribe.bat: $u/aivs-transcribe-token.txt ($(stat -c '%a %U' "$u/aivs-transcribe-token.txt"))"; done
echo "== Listening: $(ss -ltn "sport = :$PORT" | tail -n +2 | awk '{print $4}' | tr '\n' ' ')"
echo "== Firewall rules for port $PORT:"; ufw status 2>/dev/null | grep -E "^Status|^$PORT" | sed 's/^/   /'
echo "== Health (no token needed):"; curl -s -m 120 "http://127.0.0.1:$PORT/health" || echo "   no answer on port $PORT"; echo
