# Deploying AIVS on a virtual server (VPS)

This guide puts AIVS on a rented Linux server so reviewers can reach it from anywhere over HTTPS.
**Choosing a provider and paying for the server is your decision.** Nothing in this kit creates or pays for infrastructure.

What was tested before release (v1.9.0):

- a clean production install (`npm ci --omit=dev`);
- secure mode: `/healthz` answers, the session cookie is `Secure; HttpOnly; SameSite=Strict`, and HSTS is sent;
- backups and restore into a fresh database.

**Not yet tested on a real server:** building the Docker image and Caddy obtaining a certificate. The build environment could not reach Docker Hub. Check both on your server, using steps 4 and 5 below.

## 1. What you need

| Item | Notes |
|---|---|
| A VPS | Ubuntu 24.04 or Debian 12. **2 vCPU, 4 GB RAM, 40 GB disk** is enough for a pilot team; more disk if you upload much video. |
| A domain name | For example `aivs.example.org`. HTTPS needs a name; a bare IP address is not enough. |
| SSH access | The provider gives you an IP address and a root or sudo login. |

Data protection: case material may be sensitive. Choose a provider and region your organisation allows (Kenya's Data Protection Act 2019 and your own policies). Keep the server for AIVS only.

## 2. Point the domain at the server

At your domain registrar, add an **A record**: `aivs` → the server's IPv4 address. Wait until `ping aivs.example.org` shows that address (minutes to a few hours).

## 3. Prepare the server

```bash
ssh root@SERVER_IP
apt update && apt -y upgrade
adduser --disabled-password --gecos "" aivs          # an account that runs AIVS (not root)
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable   # nothing else is reachable
```

Copy the AIVS folder to the server (from your PC, in PowerShell). Leave out `node_modules`, `data` and `.env`:

```powershell
scp -r C:\Users\pc\Documents\aivs\server C:\Users\pc\Documents\aivs\public C:\Users\pc\Documents\aivs\shared C:\Users\pc\Documents\aivs\scripts C:\Users\pc\Documents\aivs\training C:\Users\pc\Documents\aivs\deploy C:\Users\pc\Documents\aivs\package.json C:\Users\pc\Documents\aivs\package-lock.json C:\Users\pc\Documents\aivs\Dockerfile C:\Users\pc\Documents\aivs\.dockerignore C:\Users\pc\Documents\aivs\.env.example root@SERVER_IP:/opt/aivs/
```

To move your existing cases as well, stop AIVS on the PC and copy the `data` folder too. Then, on the server, run `chown -R aivs:aivs /opt/aivs/data` (option B) or copy it into the volume (option A).

Choose **one** of the two options below.

## 4. Option A: Docker (recommended)

```bash
curl -fsSL https://get.docker.com | sh
cd /opt/aivs/deploy
cp ../.env.example .env
nano .env        # set AIVS_DOMAIN=aivs.example.org and any keys (FACTCHECK_API_KEY, ...)
docker compose up -d --build
docker compose logs aivs | grep -A3 "FIRST RUN"      # one-time admin password (first start only)
```

- Caddy obtains and renews the HTTPS certificate automatically.
- AIVS itself is reachable only through Caddy.
- Data and backups live in the Docker volumes `aivs-data` and `aivs-backups`.
- Update after copying new files: `docker compose up -d --build`.

## 5. Option B: without Docker (Node + Caddy)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs caddy
cd /opt/aivs && cp .env.example .env && nano .env      # keys only; network settings come from the service file
npm ci --omit=dev && chown -R aivs:aivs /opt/aivs
cp deploy/aivs.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now aivs
journalctl -u aivs | grep -A3 "FIRST RUN"              # one-time admin password
```

Then replace `/etc/caddy/Caddyfile` with:

```
aivs.example.org {
  encode gzip
  request_body { max_size 600MB }
  reverse_proxy 127.0.0.1:8080
}
```

Finally run `systemctl reload caddy`.

## 6. Check it

- `curl https://aivs.example.org/healthz` should return `{"ok":true,"version":"1.9.0"}`.
- Open the address and sign in as `admin` with the one-time password. You will choose a new one.
- Delete the `FIRST-LOGIN.txt` file in the data folder after the first sign-in.
- Create accounts for reviewers in **Administration → Users**. They sign in from any browser; no installation is needed.

## 7. Backups (do not skip)

- AIVS makes a backup **every day** automatically. It keeps the newest 7; change this in **Administration → Backups & retention**.
- Backups stay **on the same server**. If the server is lost, they are lost too, so copy them off the server regularly. For example, from your PC:

  ```powershell
  scp -r root@SERVER_IP:/opt/aivs/backups C:\Users\pc\Documents\aivs-backups
  ```

  With Docker, find the folder first with `docker volume inspect deploy_aivs-backups`.
- Many providers also sell server snapshots. That is a paid option and your choice.
- Restoring is described in the README, in the **Backups** section.

## 8. Keep it safe

- Keep `ALLOW_SELF_APPROVAL=false`.
- Use strong passwords, and remove the accounts of people who leave.
- Apply updates monthly with `apt update && apt -y upgrade`. Update AIVS by copying new files and restarting.
- Never put API keys in the front end or in chat. They belong only in `.env` on the server.
- Check **Administration → Usage & storage** for failed services and disk use.

## 9. Live Facebook Monitoring (1.26): keep the server running

Live monitoring runs inside the AIVS server. It collects, analyses and alerts on its own, and nobody needs to keep a browser open. The server must keep running, though.

1. **Set up the token.** Put the new Page access token in `.env` as `META_PAGE_ACCESS_TOKEN`, and the Page IDs as `META_PAGE_IDS` (for example `1229829760216382`).
   - Never commit `.env`. It is in `.gitignore`.
   - Revoke any token that was ever shown in a screenshot, then generate a fresh one.
   - If you can, set `META_APP_ID` and `META_APP_SECRET`. AIVS then reads the token's expiry date and warns 7 days before it expires.
2. **Check the real connection.** Run `npm run check:facebook`. It tests the ten points against the real Graph API on a temporary database and writes `data/facebook-check.txt`.
3. **Start AIVS so it keeps running:**
   - **On a VPS:** use the systemd service above (`systemctl enable --now aivs`). It restarts after failures and reboots.
   - **On a Windows PC:** open Task Scheduler and create a task that runs `start-windows.bat` "At startup" (or "At log on"), with "Run whether user is logged on or not" selected. Under Settings, tick "If the task fails, restart every 1 minute". Also stop the PC from sleeping (Settings → System → Power).
4. **Confirm it is running.** Open **Live Monitoring → Sources and history**. Each run is listed with posts read, new and already stored. The Dashboard shows the last successful synchronisation.

When Meta refuses the token, collection stops and a high-priority alert appears. Replace the token in `.env`, restart AIVS, then press **Check the Meta connection**.
