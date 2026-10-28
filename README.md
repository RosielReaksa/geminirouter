# geminirouter

> **Your Private, High-Performance, Self-Hosted AI Gateway & Account Balancer**  
> Powered by Google Antigravity account pooling, multi-account quota balancing, and unmetered OpenAI/Anthropic API emulation. Zero Docker required — runs 100% natively on Node.js.

---

## 🌟 What is geminirouter?

**geminirouter** turns multiple personal or workspace Google accounts into your own private **OpenRouter** or **Anthropic Claude** endpoint. Instead of paying hefty third-party fees or getting rate-limited during heavy coding sessions, geminirouter automatically pools multiple accounts, balancing traffic via atomic concurrency leases, automatically rotating accounts on quota depletion, and serving standard `/v1/chat/completions` and `/v1/models` endpoints to any AI coding assistant or tool.

### Key Highlights
- **100% Native & Lightweight**: Zero Docker overhead. Runs directly via standard Node.js (v22/v24), managed with systemd or PM2, consuming less than 150MB of RAM.
- **OpenAI & Anthropic Compatible**: Drop-in base URL replacement for Claude Code, Codex CLI, Cursor, Aider, OpenCode, LibreChat, and standard OpenAI SDKs.
- **Smart Concurrency Balancer**:
  - Atomic in-flight lease tracking (`acquireLease` / `releaseLease`).
  - Model-scoped rate-limit cooldowns (60s–300s TTL).
  - Transparent pre-stream failovers retrying alternative accounts on HTTP 429/403/5xx errors before streaming chunks begin.
- **Claude / OpenRouter-style Web Dashboard**:
  - Warm, minimal UI for viewing active account pools, inspecting live request logs, rotating API keys, and monitoring real-time token traffic.
- **Secure by Default**:
  - Protected API routes (`/v1/*`) via `sk-live-...` Bearer tokens.
  - Protected Dashboard via HTTP Basic Auth through Caddy or Nginx reverse proxies with automated Let's Encrypt SSL.

---

## 🏗️ Architecture Overview

```text
                                     +-------------------------------------------+
                                     |             User & AI Clients             |
                                     |  Claude Code | Codex | Cursor | SDKs      |
                                     +---------------------+---------------------+
                                                           |
                                                HTTPS / WSS Request
                                                           |
                                                           v
                     +-------------------------------------------------------------------+
                     |                     Reverse Proxy (Caddy / Nginx)                 |
                     |  - Automatic Let's Encrypt TLS / HTTPS                            |
                     |  - Basic Auth for Dashboard: / (Port 3000)                        |
                     |  - Bearer Token Passthrough for API: /v1/* (Port 8045)            |
                     +------------------+-----------------------------+------------------+
                                        |                             |
                                        v                             v
           +----------------------------------------+    +-------------------------------+
           |      geminirouter Web Bridge           |    |     geminirouter Core         |
           |      (Port 3000)                       |    |     (Port 8045)               |
           |  - Web UI Dashboard                    |    |  - Fastify Gateway & oRPC     |
           |  - Account OAuth session flow          |    |  - OpenAI & Anthropic routes  |
           |  - Token ledger & usage monitoring     |    |  - Concurrency lease manager  |
           +--------------------+-------------------+    +---------------+---------------+
                                |                                        |
                                +-------------------+--------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |    Antigravity Upstream Pool       |
                                  |  - Account 1 (Gemini 2.5 Pro)      |
                                  |  - Account 2 (Gemini 2.5 Flash)    |
                                  |  - Account N (Auto-rotated / TTL)  |
                                  +------------------------------------+
```

---

## 🚀 Quick Start: VPS Automated Deployment

For Ubuntu 22.04 / 24.04 or Debian 11 / 12 servers, an automated native installer is provided.

### 1. Prerequisites
- A VPS (Ubuntu/Debian) with public IPv4 (1 vCPU, 1GB RAM minimum).
- A domain name with an **A record** pointing to your VPS IP (e.g., `router.yourdomain.com`).
- Port 80 and 443 open on your VPS firewall.

### 2. Run the One-Line Installer
SSH into your VPS as `root`, clone or copy the repository, and run:

```bash
cd /opt
git clone <your-geminirouter-repo-url> geminirouter
cd geminirouter/deploy
chmod +x install-vps.sh
./install-vps.sh
```

The script will interactively:
1. Ask for your domain name (e.g. `router.yourdomain.com`).
2. Ask for a web dashboard username and password.
3. Automatically install Node.js 24 LTS, pnpm, and Caddy.
4. Set up `/opt/geminirouter` with a dedicated system user.
5. Generate a secure Master API Key (`sk-live-...`).
6. Configure and start systemd background services (`geminirouter-core.service` and `geminirouter.service`).
7. Obtain a Let's Encrypt SSL certificate automatically.

Once finished, the script displays your complete connection details and configuration snippets.

---

## 🛠️ Manual Deployment (Without Automated Script)

If you prefer to configure your server manually using Node.js, systemd, or PM2:

### Step 1: Install Node.js 24 and pnpm
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
corepack enable
```

### Step 2: Prepare Application Directory
```bash
useradd -m -s /bin/bash geminirouter
mkdir -p /opt/geminirouter
cp -r . /opt/geminirouter/
cd /opt/geminirouter
pnpm install --frozen-lockfile
pnpm run build:core
pnpm run build
```

### Step 3: Configure Environment Variables
Copy the template and adjust your settings:
```bash
cp deploy/.env.example /opt/geminirouter/.env
nano /opt/geminirouter/.env
```

### Step 4: Run via systemd Services
Install the provided systemd service units:
```bash
cp deploy/geminirouter-core.service /etc/systemd/system/
cp deploy/geminirouter.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now geminirouter-core.service
systemctl enable --now geminirouter.service
```

Check status:
```bash
systemctl status geminirouter-core
systemctl status geminirouter
```

### Alternative: Run via PM2
If you prefer PM2 over systemd:
```bash
npm install -g pm2
cd /opt/geminirouter
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup
```

### Step 5: Configure Reverse Proxy (Caddy or Nginx)

#### Option A: Caddy (Recommended - Auto SSL)
Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, fill in your domain name and dashboard password hash, then reload:
```bash
# Generate Caddy password hash:
caddy hash-password --plaintext "YourSecretPassword"

systemctl restart caddy
```

#### Option B: Nginx
If using Nginx, create an htpasswd file for basic auth:
```bash
apt-get install -y apache2-utils certbot python3-certbot-nginx
htpasswd -c /etc/nginx/.geminirouter_htpasswd admin

# Obtain cert:
certbot certonly --standalone -d router.yourdomain.com

# Copy config:
cp deploy/nginx.conf /etc/nginx/sites-available/geminirouter.conf
ln -s /etc/nginx/sites-available/geminirouter.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

## 🔑 Authorizing Google Accounts via Web Dashboard

1. Navigate to `https://router.yourdomain.com` in your browser.
2. Enter the Dashboard credentials configured during setup.
3. In the **Accounts / Antigravity Pool** tab:
   - Click **Add Account** / **Connect Google Account**.
   - Follow the OAuth authentication flow.
   - You can connect multiple Google accounts. Each account adds independent quota capacity to your cluster.
4. The system will continuously monitor quotas and automatically route incoming prompts across active accounts with minimal concurrency and zero rate-limit collisions.

---

## 💻 Client Configuration Guide

Use your domain and Master API key (`sk-live-...`) with any AI tool:

### 1. Claude Code
Configure Claude Code to route requests through your private geminirouter:
```bash
export ANTHROPIC_BASE_URL="https://router.yourdomain.com/v1"
export ANTHROPIC_API_KEY="sk-live-your_api_key_here"
claude
```
Or set in `~/.claude/settings.json`:
```json
{
  "apiBase": "https://router.yourdomain.com/v1",
  "apiKey": "sk-live-your_api_key_here"
}
```

### 2. Codex CLI
In `~/.codex/config.toml`:
```toml
model_provider = "geminirouter"

[model_providers.geminirouter]
base_url = "https://router.yourdomain.com/v1"
api_key = "sk-live-your_api_key_here"
```

### 3. Cursor IDE
1. Open **Cursor Settings** -> **Models**.
2. Under **OpenAI API Key**, enter your Master API key: `sk-live-your_api_key_here`.
3. Check **Override OpenAI Base URL** and enter:
   ```text
   https://router.yourdomain.com/v1
   ```
4. Add model aliases like `gemini-2.5-pro` or `gemini-2.5-flash`.

### 4. Aider
```bash
export OPENAI_API_BASE="https://router.yourdomain.com/v1"
export OPENAI_API_KEY="sk-live-your_api_key_here"
aider --model openai/gemini-2.5-pro
```

### 5. OpenCode
In `~/.config/opencode/config.json`:
```json
{
  "provider": "openai-compatible",
  "baseURL": "https://router.yourdomain.com/v1",
  "apiKey": "sk-live-your_api_key_here"
}
```

### 6. OpenAI Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://router.yourdomain.com/v1",
    api_key="sk-live-your_api_key_here"
)

response = client.chat.completions.create(
    model="gemini-2.5-pro",
    messages=[
        {"role": "user", "content": "Explain quantum computing in one sentence."}
    ]
)
print(response.choices[0].message.content)
```

### 7. cURL Test
```bash
curl -X POST https://router.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-live-your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

---

## 🔒 Security Best Practices

To ensure your private router remains exclusively yours:

1. **Firewall (UFW)**:
   Only keep ports 22, 80, and 443 open to the public. Internal ports (8045 and 3000) should only listen on `127.0.0.1`.
   ```bash
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow 22/tcp
   ufw allow 80/tcp
   ufw allow 443/tcp
   ufw enable
   ```
2. **Dashboard Isolation**:
   The web dashboard has full access to add and manage Google accounts. Never expose it without the HTTP Basic Auth layer provided in `Caddyfile` or `nginx.conf`.
3. **API Key Hygiene**:
   Generate distinct keys for different machines or team members if needed. Rotate the master API key immediately if it is ever exposed in logs or shared code.
4. **Log Rotation**:
   The provided Caddyfile and systemd configurations include automated log rotation to keep VPS disk usage predictable.

---

## 📜 Service Management Reference

| Task | Command |
|---|---|
| View Core Logs | `journalctl -u geminirouter-core -f` |
| View Web Dashboard Logs | `journalctl -u geminirouter -f` |
| Restart All Services | `systemctl restart geminirouter-core geminirouter caddy` |
| Stop All Services | `systemctl stop geminirouter-core geminirouter` |
| Check Memory & PID | `systemctl status geminirouter-core geminirouter` |
| (Optional) PM2 Status | `pm2 status` |

---

## 📄 License & Attribution
The geminirouter dashboard and bridge server (this repository) are MIT licensed,
created for private, personal, and self-hosted developer use.

This project is a companion UI for the [AntigravityManager](https://github.com/Draculabo/AntigravityManager)
core (not included in this repository), which is licensed **CC BY-NC-SA 4.0** — non-commercial
use, with attribution. Respect that license when using or modifying the core.
