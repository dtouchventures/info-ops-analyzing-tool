# AIVS transcription service

This is a private speech-to-text service for AIVS. It runs **faster-whisper**, a dedicated speech recognition engine, on the CPU of an Ubuntu server on your network. Ollama is not used for speech.

- Only the AIVS server sends it recordings, and it needs a shared token for every call.
- It keeps each recording only while transcribing it.
- It uses no outside service; after installation it runs offline.

## Where things run

| Part | Where | Notes |
|---|---|---|
| AIVS (Node server, database, uploads) | JK's Windows PC, `C:\Users\pc\Documents\aivs`, started with `start-windows.bat` (port 8080) | Holds `TRANSCRIBE_URL` and `TRANSCRIBE_TOKEN` in `.env`. Only this server talks to the service; browsers never do. |
| Transcription service | Ubuntu server lab1, `10.104.4.151`, port 9000 | systemd service `aivs-transcribe`, user `aivs-transcribe`, program in `/opt/aivs-transcribe`, settings and token in `/etc/aivs-transcribe.env` (root and the service only). |

The server sees the AIVS PC as **172.16.39.29**, its OpenVPN (TAP-Windows) address; the PC reaches lab1 through the VPN, and its Wi-Fi address is different (10.100.100.72 on 26 October). The firewall rule uses the VPN address.

## Setup, step by step

Every command is marked with where to run it.
- **Windows PowerShell** commands run on the AIVS PC. Open PowerShell, then `cd $HOME\Documents\aivs`.
- **Ubuntu** commands run on the server, after you log in with SSH. The prompt shows `ubuntu@lab1`.

Paste one line at a time (right-click pastes in PowerShell).

### 1. Copy the latest service files to the server (Windows PowerShell)

```
scp -i $HOME\Downloads\Lab1.pem -r $HOME\Documents\aivs\transcriber ubuntu@10.104.4.151:~/
ssh -i $HOME\Downloads\Lab1.pem ubuntu@10.104.4.151
```

### 2. See what is already installed (Ubuntu)

```
cd ~/transcriber && sudo bash status.sh
```

This changes nothing and does not show the token. It reports:
- whether the service is installed, running and enabled at boot;
- the model and settings;
- the firewall rules for port 9000;
- the health answer.

### 3. Install or repair (Ubuntu)

```
sudo AIVS_ALLOW_FROM=172.16.39.29 bash install.sh
```

The installer starts by checking what is already there:
- **Already running and healthy:** it leaves the program and model alone and only applies the firewall rule and the token copy. To force a reinstall, add `--reinstall`.
- **Installed but broken:** it repairs it.
- **Not installed:** it installs it. This takes 10 to 20 minutes, most of it the model download.

It keeps an existing token and settings, and never prints the token. Its other steps:
- **Model:** chosen from CPU and RAM. lab1 (12 cores, 39 GB RAM) gets `medium` in int8: more accurate, especially for Kiswahili, but slower than `small`. To choose yourself, add `WHISPER_MODEL=small` before `bash`.
- **Start at boot:** `systemctl enable`.
- **Firewall:** only `AIVS_ALLOW_FROM` may reach port 9000; older wider rules for port 9000 are removed; everyone else is blocked. To allow the whole trusted network instead, use `AIVS_ALLOW_FROM=172.16.39.0/24`. Without `AIVS_ALLOW_FROM`, the networks already allowed to reach Ollama are used.
- **Token copy:** it leaves `~/aivs-transcribe-token.txt`, readable only by `ubuntu`, so the PC can fetch the token without anyone pasting it.

### 4. Real-model self-test on the server (Ubuntu)

```
sudo -u aivs-transcribe /opt/aivs-transcribe/venv/bin/python /opt/aivs-transcribe/selftest.py
```

It checks:
- English and Kiswahili, detected automatically and with Kiswahili chosen manually;
- the soundtrack of a video;
- silence, which must give no text;
- a fake MP3 and a video without sound, which must both be refused.

For each one it prints word accuracy and speed. The voices are synthetic (espeak-ng) and robotic, so real recordings score differently.

Then type `exit` to return to Windows.

### 5. Connect AIVS (Windows PowerShell)

```
.\set-transcribe.bat
```

It reads the token over SSH and writes `TRANSCRIBE_URL=http://10.104.4.151:9000` and `TRANSCRIBE_TOKEN` into `.env`. All other settings are kept, and a copy of the old file is kept as `.env.before-transcribe`. Nothing is shown on screen.

### 6. Restart AIVS only (Windows)

Close the AIVS window (the one started by `start-windows.bat`), then double-click `start-windows.bat`. The transcription service and Ollama are not touched.

The start window prints `Speech-to-text: available (…)` when AIVS's authenticated check works. The result is also written to `data\transcribe-health.txt`, without the token.

### 7. Test uploads through AIVS with the real model (Windows PowerShell)

```
.\check-transcribe.bat
```

It starts a temporary, separate copy of AIVS with an empty database (your cases are not touched) and uploads synthetic recordings through the normal AIVS upload: English WAV, Kiswahili MP3 (detected and chosen), a video with sound, silence, a video without sound and a fake MP3. It checks:
- language and word accuracy (at least 60%);
- ordered timestamps;
- no text from silence;
- clear refusals for the invalid files;
- a correction with its history, search, and TXT/SRT/VTT/JSON downloads;
- adding segments as evidence, which then open at their time in the recording.

The results are shown on screen and saved in `data\transcribe-check.txt`. The token is never shown.

### 8. Check the Start page

**Upload files** shows **Available** only after the running AIVS has reached the service and the service has accepted AIVS's token. Otherwise the card says what is wrong.

### If something fails

| Symptom | Where | Check |
|---|---|---|
| `check-transcribe` says the connection timed out or was refused | Ubuntu | `sudo bash status.sh`. Is the service active? Does the firewall list 172.16.39.29 for port 9000? If the PC's address changed, rerun step 3 with the new address (on the server, `echo $SSH_CLIENT` shows the address of the connected PC). |
| "rejected AIVS's token" | Windows | Rerun `.\set-transcribe.bat`, then restart AIVS. |
| `set-transcribe.bat` cannot read the token | Ubuntu | `ls -l ~/aivs-transcribe-token.txt`. If it is missing, rerun step 3. |
| A recording fails with "out of memory" or is very slow | Ubuntu | Set `WHISPER_MODEL=small` in `/etc/aivs-transcribe.env`, then run `sudo bash install.sh --reinstall`. |
| Logs | Ubuntu | `sudo journalctl -u aivs-transcribe -n 50`. Uvicorn access logs are off, so request headers (and the token) are not logged. |

## Checks and maintenance (on the server)

| What | Command |
|---|---|
| Status | `sudo systemctl status aivs-transcribe` |
| Logs | `sudo journalctl -u aivs-transcribe -n 50` |
| Health | `curl -s http://127.0.0.1:9000/health` |
| Everything at once (read-only) | `sudo bash ~/transcriber/status.sh` |
| Change the model | edit `WHISPER_MODEL` in `/etc/aivs-transcribe.env`, then rerun `sudo bash install.sh` (this downloads the new model) |
| Change limits | `TRANSCRIBE_MAX_MB` and `TRANSCRIBE_MAX_MINUTES` in `/etc/aivs-transcribe.env`, then `sudo systemctl restart aivs-transcribe` |
| Allow another host or network | `sudo AIVS_ALLOW_FROM="172.16.39.29 10.x.x.0/24" bash ~/transcriber/install.sh` (it keeps exactly these) |
| Remove | `sudo systemctl disable --now aivs-transcribe`, then `sudo rm -r /opt/aivs-transcribe /var/lib/aivs-transcribe /etc/aivs-transcribe.env /etc/systemd/system/aivs-transcribe.service` |

## How it avoids inventing speech

- **Voice activity detection** (Silero VAD) skips silence and noise, so a silent recording gives no text.
- A segment that Whisper itself judges probably not speech is dropped. This means a no-speech probability above 0.6 together with low confidence.
- A segment is kept but marked **unclear** when it has:
  - low confidence;
  - a possible non-speech signal;
  - repetitive text;
  - typical text produced from noise, such as "thank you for watching".
- Each segment is decoded separately, without the previous text as a prompt, so one mistake does not spread into the next.
- AIVS labels every transcript and export *machine-generated*. Evidence made from a transcript says whether it contains unchecked machine text.

## Speed on a CPU

With `small` in int8 on a modern 8-core server, expect about 1 to 3 times faster than real time. `medium` is more accurate, especially for Kiswahili, but 2 to 3 times slower. The service handles one recording at a time and queues the rest. The `/health` endpoint reports the measured speed after the first job.

## Developer tests (no model needed)

```
pip install -r requirements.txt espeakng-loader httpx
python tests/test_service.py
```

These tests run real decoding and real voice activity detection, with scripted text in place of Whisper.

## Status and limitations

- **Setup on lab1 not yet verified:** as of 26 October 2026, the installation on lab1 had been started but its result was not reported, and the self-test (step 4) and the AIVS check (step 7) had not yet been run. Until they pass, real-model accuracy and speed are unknown.
- **Languages:** only English and Kiswahili. Recordings in other languages are transcribed as whichever of the two is more likely, with a note saying so.
- **Test voices:** they are synthetic. Real voice notes with noise, accents or code-switching (Sheng, English mixed with Kiswahili) will score lower. Always check passages against the recording.
- **CPU speed:** with `medium` on a CPU, a recording can take about as long as it plays, or longer. Jobs run one at a time.
- **Restarts:** a job running when the service restarts is lost and must be started again (AIVS reports this).
- **Firewall address:** it is tied to the AIVS PC's address as the server sees it (172.16.39.29). If that changes, rerun step 3.
- **Limits:** 500 MB and 120 minutes per recording.
