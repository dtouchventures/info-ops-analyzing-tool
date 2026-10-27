#!/usr/bin/env bash
# Install the AIVS transcription service on Ubuntu (22.04 or later). Run from this folder:
#   sudo AIVS_ALLOW_FROM=172.16.39.29 bash install.sh      only the AIVS computer may connect (recommended)
#   sudo bash install.sh                                   the networks already allowed to reach Ollama may connect
#   sudo bash install.sh --reinstall                       reinstall even if the service is already running
# It checks what is already installed first, keeps an existing token and settings, and never prints the token.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo bash install.sh"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"; APP=/opt/aivs-transcribe; DATA=/var/lib/aivs-transcribe; ENVF=/etc/aivs-transcribe.env; PORT=9000
REINSTALL=0; [ "${1:-}" = "--reinstall" ] && REINSTALL=1
echo "== Checking what is already installed"
SKIP=0
if systemctl is-active --quiet aivs-transcribe 2>/dev/null && curl -sf -m 120 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
  echo "The aivs-transcribe service is already installed, running and healthy."
  if [ "$REINSTALL" = 1 ]; then echo "--reinstall given: reinstalling (the token and settings in $ENVF are kept)."; else SKIP=1; echo "Leaving the program and model unchanged (use --reinstall to update them). Checking the firewall and the token copy only."; fi
elif systemctl list-unit-files aivs-transcribe.service >/dev/null 2>&1 && [ -f /etc/systemd/system/aivs-transcribe.service ]; then
  echo "The service is installed but not healthy; repairing it (the token and settings in $ENVF are kept)."
else echo "Not installed yet."; fi
CORES=$(nproc); RAM=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo); DISK=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "Server: $CORES CPU cores, ${RAM} GB RAM, ${DISK} GB free disk"
# a model the CPU can run: small is the default (good balance); medium is more accurate, especially for Kiswahili, but 2-3 times slower
if [ "$RAM" -lt 3 ]; then MODEL=base; elif [ "$RAM" -ge 12 ] && [ "$CORES" -ge 12 ]; then MODEL=medium; else MODEL=small; fi
MODEL=${WHISPER_MODEL:-$MODEL}; echo "Model: $MODEL (int8 on the CPU). To change later, edit WHISPER_MODEL in $ENVF."
if [ "$SKIP" = 0 ]; then
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
apt-get update -qq && apt-get install -y -qq python3-venv espeak-ng ffmpeg >/dev/null
id aivs-transcribe >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin aivs-transcribe
mkdir -p "$APP/tests" "$DATA/models" "$DATA/work"
install -m 0644 "$HERE/aivs_transcribe.py" "$HERE/selftest.py" "$HERE/requirements.txt" "$APP/"; install -m 0644 "$HERE/tests/make_speech.py" "$APP/tests/"
[ -x "$APP/venv/bin/python" ] || python3 -m venv "$APP/venv"
echo "Installing faster-whisper and its libraries (a few minutes, no output)..."
"$APP/venv/bin/pip" install -q --upgrade pip && "$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"
if [ ! -f "$ENVF" ]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 40)
  printf 'TRANSCRIBE_TOKEN=%s\nWHISPER_MODEL=%s\nWHISPER_COMPUTE_TYPE=int8\nWHISPER_THREADS=%s\nWHISPER_MODEL_DIR=%s/models\nTRANSCRIBE_WORK_DIR=%s/work\nTRANSCRIBE_MAX_MB=500\nTRANSCRIBE_MAX_MINUTES=120\n' "$TOKEN" "$MODEL" "$((CORES > 1 ? CORES - 1 : 1))" "$DATA" "$DATA" > "$ENVF"
fi
chown root:aivs-transcribe "$ENVF"; chmod 0640 "$ENVF"; chown -R aivs-transcribe:aivs-transcribe "$DATA"
set -a; . "$ENVF"; set +a
echo "Downloading the $WHISPER_MODEL model once (it then works offline)..."
sudo -u aivs-transcribe env HOME="$DATA" HF_HOME="$DATA/hf" "$APP/venv/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('$WHISPER_MODEL', device='cpu', compute_type='int8', download_root='$DATA/models')"
cat > /etc/systemd/system/aivs-transcribe.service <<UNIT
[Unit]
Description=AIVS transcription service (faster-whisper)
After=network-online.target
[Service]
User=aivs-transcribe
Group=aivs-transcribe
EnvironmentFile=$ENVF
Environment=HF_HUB_OFFLINE=1
Environment=HF_HOME=$DATA/hf
Environment=HOME=$DATA
WorkingDirectory=$APP
ExecStart=$APP/venv/bin/uvicorn aivs_transcribe:app --host 0.0.0.0 --port $PORT --workers 1 --log-level warning
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now aivs-transcribe >/dev/null && systemctl restart aivs-transcribe
fi   # SKIP
# firewall: only the AIVS computer (AIVS_ALLOW_FROM) or, if not given, the networks already allowed to reach Ollama; everyone else blocked
echo "== Firewall"
if ufw status | grep -q "Status: active"; then
  if [ -n "${AIVS_ALLOW_FROM:-}" ]; then SRCS="$AIVS_ALLOW_FROM"; else SRCS=$(ufw status | awk '$1 ~ /^11434(\/tcp)?$/ && $2 == "ALLOW" {print $NF}' | sort -u); fi
  if [ -z "$SRCS" ]; then echo "WARNING: nothing to allow. Run again with AIVS_ALLOW_FROM=<address of the AIVS computer as this server sees it>."; fi
  # remove allow rules for this port that are no longer wanted (for example from an earlier, wider setup)
  for old in $(ufw status | awk -v p="$PORT" '($1 == p || $1 == p"/tcp") && $2 == "ALLOW" {print $NF}' | sort -u); do
    case " $SRCS " in *" $old "*) ;; *) ufw delete allow from "$old" to any port $PORT proto tcp >/dev/null 2>&1 || true; echo "Firewall: removed old rule for $old";; esac; done
  for src in $SRCS; do ufw status | awk -v p="$PORT" -v s="$src" '($1 == p || $1 == p"/tcp") && $2 == "ALLOW" && $NF == s {f=1} END {exit !f}' || ufw insert 1 allow from "$src" to any port $PORT proto tcp >/dev/null; echo "Firewall: $src may reach port $PORT"; done
  ufw status | grep -qE "^$PORT/tcp +DENY" || ufw deny $PORT/tcp >/dev/null; echo "Firewall: everyone else is blocked from port $PORT"
else echo "WARNING: the firewall (ufw) is off, so any computer on the network can reach port $PORT (it still needs the token). Turn it on with: sudo ufw allow OpenSSH && sudo ufw enable"; fi
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 2; done
echo "== Health"; curl -s "http://127.0.0.1:$PORT/health"; echo
echo
echo "Done. Service address for AIVS: TRANSCRIBE_URL=http://$(hostname -I | awk '{print $1}'):$PORT"
echo "The token is NOT shown. It is in $ENVF (root only); set-transcribe.bat on the AIVS computer copies it into AIVS's .env."
# a copy of the token for the admin account that ran the installer, so set-transcribe.bat on the AIVS computer can read it over SSH
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then H=$(getent passwd "$SUDO_USER" | cut -d: -f6); install -m 0600 -o "$SUDO_USER" /dev/null "$H/aivs-transcribe-token.txt"; grep ^TRANSCRIBE_TOKEN= $ENVF | cut -d= -f2 > "$H/aivs-transcribe-token.txt"; echo "(A copy of the token is in $H/aivs-transcribe-token.txt, readable only by $SUDO_USER; set-transcribe.bat reads it.)"; fi
echo "Then run the self-test:  sudo -u aivs-transcribe $APP/venv/bin/python $APP/selftest.py"
