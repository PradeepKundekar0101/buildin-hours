# Deploying MolBhav to panchayatai.com

This covers a production split of the two apps in this monorepo.
`apps/web` (Next.js) goes to Vercel.
`apps/orchestrator` (Node/Express + a raw WebSocket upgrade handler) goes to an AWS EC2 box behind nginx, with TLS from Certbot.

## Domain plan

| Host | Points to | Serves |
|---|---|---|
| `panchayatai.com` (+ `www`) | Vercel | `apps/web` |
| `api.panchayatai.com` | EC2 Elastic IP | `apps/orchestrator` |

The orchestrator needs its own subdomain because it is not a static site: it terminates Twilio's media-stream WebSocket at `wss://api.panchayatai.com/media/:callId`, and that upgrade has to reach the same Node process that Express is running in.
Keeping it off Vercel (which does not run long-lived WebSocket servers) is the reason for the two-provider split you already chose.

Config templates referenced below live in [deploy/](deploy).

---

## Part A - Frontend on Vercel

1. Push this repo to GitHub/GitLab if it is not already there - Vercel deploys from a git remote, not a local upload.
2. In the Vercel dashboard: **Add New Project** and import the repo.
3. Because this is a pnpm workspace, set the project's **Root Directory** to `apps/web` in the project's Settings -> General.
4. Vercel auto-detects Next.js once the root directory is set.
   Leave the build command as `next build` (or `pnpm build`) and the install command as `pnpm install` - Vercel's pnpm support handles the workspace `pnpm-lock.yaml` at the repo root automatically once it sees `packageManager` in the root `package.json`.
5. Add one environment variable, for Production (and Preview if you want previews to hit the real API): `NEXT_PUBLIC_API_BASE=https://api.panchayatai.com`.
   This matters because [next.config.mjs](apps/web/next.config.mjs) only auto-loads the workspace-root `.env` for local dev - that file is gitignored and will not exist on Vercel's build machine, so without this step the deployed site silently falls back to `http://localhost:8080`.
6. Deploy.
7. Go to Settings -> Domains and add `panchayatai.com` and `www.panchayatai.com`.
   Vercel will show the exact DNS records to create (typically an `A` record to `76.76.21.21` for the apex and a `CNAME` for `www` to `cname.vercel-dns.com` - use whatever Vercel's UI shows you at the time, it does change).
8. Create those records at your domain registrar / DNS provider.
   Propagation is usually minutes, occasionally longer.

---

## Part B - Provision the EC2 instance

1. Launch an instance: Ubuntu 22.04 or 24.04 LTS, `t3.small` is a reasonable starting size for a single-process Node API plus nginx.
2. Security group: allow inbound `22` (SSH, ideally locked to your IP), `80` (HTTP, needed for the Certbot challenge and to redirect to HTTPS), and `443` (HTTPS).
   You do **not** need to open `8080` publicly - nginx will proxy to it over `localhost`.
3. Allocate and associate an **Elastic IP** so the address survives a reboot/stop-start.
4. Point DNS: create an `A` record for `api.panchayatai.com` -> that Elastic IP, at your registrar.

---

## Part C - Server setup

SSH in, then:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx

# Node 20 (matches the "engines" constraint in package.json)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm (via corepack, so it matches the pinned packageManager version)
sudo corepack enable
sudo corepack prepare pnpm@10.31.0 --activate

# a dedicated non-root user to run the app
sudo adduser --disabled-password --gecos "" deploy
sudo su - deploy
```

As the `deploy` user:

```bash
git clone <your-repo-url> ~/molbhav
cd ~/molbhav
pnpm install --frozen-lockfile
cp .env.example .env
```

## Part D - Fill in the production `.env`

Edit `~/molbhav/.env` (workspace root - both apps read it from there, see [README.md](README.md)) with real values.
The ones that change for production versus local dev:

```bash
PUBLIC_BASE_URL=https://api.panchayatai.com   # was your ngrok URL locally
PORT=8080
IGNORE_CALL_WINDOW=0                          # keep the 09:00-20:30 IST guard on in production
TEST_MODE=0                                   # unless you specifically want every mission redirected
NEXT_PUBLIC_API_BASE=https://api.panchayatai.com
```

Fill in `SARVAM_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` with the real production credentials.
Do not commit this file - it already matches `.gitignore`.

Build the orchestrator:

```bash
cd ~/molbhav
pnpm --filter orchestrator build
```

This produces `apps/orchestrator/dist/`, which is what the systemd unit below runs.

---

## Part E - Run the orchestrator as a systemd service

Log back in as a sudo-capable user (not `deploy`) and install the unit from this repo:

```bash
sudo cp ~deploy/molbhav/deploy/orchestrator.service /etc/systemd/system/orchestrator.service
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator
sudo systemctl status orchestrator
```

Check logs with:

```bash
journalctl -u orchestrator -f
```

You should see the boot report the orchestrator prints (which integrations are live) - if a key is wrong or missing it says so here, not silently.

A crash or an instance reboot restarts it automatically (`Restart=on-failure` plus `enable` wires it into boot).

---

## Part F - nginx reverse proxy

Copy the two config files from this repo:

```bash
sudo cp ~deploy/molbhav/deploy/nginx/api.panchayatai.com.conf /etc/nginx/sites-available/api.panchayatai.com.conf
sudo ln -s /etc/nginx/sites-available/api.panchayatai.com.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

The websocket upgrade map has to live in the `http {}` block of `/etc/nginx/nginx.conf`, not inside a `server {}` block - either paste the contents of [deploy/nginx/websocket-upgrade-map.conf](deploy/nginx/websocket-upgrade-map.conf) into `nginx.conf`'s `http` block directly, or add an `include` line for it there:

```nginx
http {
    include /etc/nginx/conf.d/*.conf;   # if not already present
    ...
}
```

```bash
sudo cp ~deploy/molbhav/deploy/nginx/websocket-upgrade-map.conf /etc/nginx/conf.d/websocket-upgrade-map.conf
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` should print `syntax is ok` / `test is successful` before you reload - if it does not, fix that before moving on rather than forcing a reload.

---

## Part G - TLS with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.panchayatai.com
```

Certbot edits `api.panchayatai.com.conf` in place to add the `listen 443 ssl` block and the certificate paths, and offers to add the HTTP -> HTTPS redirect - accept that.
This is also why [deploy/nginx/api.panchayatai.com.conf](deploy/nginx/api.panchayatai.com.conf) in the repo intentionally only has the port-80 block: Certbot is expected to be the one writing the TLS half, not a hand-authored copy that could drift from what's actually on the box.

Renewal is automatic - Certbot installs a systemd timer (`systemctl list-timers | grep certbot`) that renews before the 90-day expiry.
Confirm the timer exists; nothing further to do unless it's missing.

---

## Part H - Verify

From your laptop, not the server, so you're testing the same path the outside world uses:

```bash
curl https://api.panchayatai.com/health
```

Load `https://panchayatai.com` and confirm it's making requests to `https://api.panchayatai.com`, not `localhost:8080` - check the Network tab in devtools if unsure.

Run the existing telephony preflight check against the production URL to confirm the WebSocket upgrade actually reaches the orchestrator through nginx, not just plain HTTP:

```bash
# on the EC2 box, as the deploy user, with PUBLIC_BASE_URL already set to
# https://api.panchayatai.com in .env
pnpm twilio:check
```

If that passes, place one real call in test mode (`TEST_CALL_REDIRECT` in `.env`) before trusting the setup with a live shop call.

---

## Redeploying after changes

Frontend: push to the branch Vercel is tracking, it rebuilds and deploys automatically.

Backend:

```bash
ssh deploy@api.panchayatai.com
cd ~/molbhav
git pull
pnpm install --frozen-lockfile
pnpm --filter orchestrator build
sudo systemctl restart orchestrator
```
