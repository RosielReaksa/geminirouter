#!/usr/bin/env bash
# ==============================================================================
# geminirouter - Lightweight Native Node.js & Caddy VPS Installer
# For Ubuntu 22.04 / 24.04 & Debian 11 / 12
# Zero Docker - Native Node.js, systemd services & PM2 support
# ==============================================================================

set -euo pipefail

# Text styling
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "======================================================================"
echo "          geminirouter Native VPS Automated Installer                "
echo "  Self-Hosted Private AI Gateway & Dashboard (Zero-Docker Native)     "
echo "======================================================================"
echo -e "${NC}"

# Ensure root execution
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] Please run this installer as root or with sudo.${NC}"
  exit 1
fi

# Detect system architecture
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ]; then
  echo -e "${RED}[ERROR] Unsupported architecture: ${ARCH}. Only x86_64 and aarch64 (arm64) are supported.${NC}"
  exit 1
fi

# Prompt for Domain Name
read -r -p "Enter your Domain name for geminirouter (e.g. router.yourdomain.com): " USER_DOMAIN
if [ -z "$USER_DOMAIN" ]; then
  echo -e "${RED}[ERROR] Domain name cannot be empty. Please configure DNS A record pointing to this VPS first.${NC}"
  exit 1
fi

# Prompt for Dashboard Admin Credentials
read -r -p "Enter Dashboard Admin username [default: admin]: " USER_ADMIN
USER_ADMIN=${USER_ADMIN:-admin}

read -r -s -p "Enter Dashboard Admin password (leave empty to generate secure random): " USER_PASS
echo ""
if [ -z "$USER_PASS" ]; then
  USER_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
  echo -e "${YELLOW}Generated Dashboard Password: ${BOLD}${USER_PASS}${NC}"
fi

# Generate Master API Key
MASTER_API_KEY="sk-live-$(openssl rand -hex 24)"

echo ""
echo -e "${CYAN}[1/7] Updating system packages and installing base utilities...${NC}"
apt-get update -y
apt-get install -y --no-install-recommends \
  curl \
  wget \
  git \
  build-essential \
  python3 \
  ca-certificates \
  gnupg \
  debian-keyring \
  debian-archive-keyring \
  apt-transport-https \
  openssl \
  procps

echo -e "${CYAN}[2/7] Installing Node.js 24 (LTS) & pnpm...${NC}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 22 ]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi

corepack enable || npm install -g pnpm pm2
echo -e "${GREEN}✓ Node.js $(node -v) and pnpm $(pnpm -v) ready.${NC}"

echo -e "${CYAN}[3/7] Setting up dedicated user and directory structure (/opt/geminirouter)...${NC}"
if ! id -u geminirouter >/dev/null 2>&1; then
  useradd -m -s /bin/bash geminirouter
fi

INSTALL_DIR="/opt/geminirouter"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"
mkdir -p "$INSTALL_DIR/logs"
mkdir -p /home/geminirouter/.config/antigravity-manager

echo -e "${CYAN}[4/7] Copying application and building production assets...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# If installer is run directly inside repository
if [ -f "$PARENT_DIR/package.json" ]; then
  cp -r "$PARENT_DIR"/* "$INSTALL_DIR/" || true
  cp "$PARENT_DIR/.nvmrc" "$INSTALL_DIR/" 2>/dev/null || true
fi

cd "$INSTALL_DIR"

if [ -f "server/package.json" ]; then
  echo "Installing bridge dependencies..."
  pnpm --dir server install --frozen-lockfile || pnpm --dir server install
  echo "Building bridge..."
  pnpm --dir server build || true
fi

if [ -f "frontend/package.json" ]; then
  echo "Installing frontend dependencies..."
  pnpm --dir frontend install --frozen-lockfile || pnpm --dir frontend install
  echo "Building frontend..."
  pnpm --dir frontend build || true
fi

# The AntigravityManager core is an external dependency and is not part of this repository.
CORE_MAIN_PATH="${CORE_MAIN_PATH:-$INSTALL_DIR/core/dist/core/main.cjs}"
if [ -f "$CORE_MAIN_PATH" ]; then
  echo -e "${GREEN}✓ Core bundle found at $CORE_MAIN_PATH${NC}"
else
  echo -e "${YELLOW}! Core bundle not found at $CORE_MAIN_PATH${NC}"
  echo -e "${YELLOW}  Install the AntigravityManager core separately, or set CORE_MAIN_PATH${NC}"
  echo -e "${YELLOW}  in $INSTALL_DIR/.env before starting geminirouter-core.service.${NC}"
fi

# Ensure ecosystem.config.js is copied to INSTALL_DIR
if [ -f "$SCRIPT_DIR/ecosystem.config.js" ]; then
  cp "$SCRIPT_DIR/ecosystem.config.js" "$INSTALL_DIR/ecosystem.config.js"
fi

# Generate password hash for Caddy
echo -e "${CYAN}[5/7] Installing Caddy Web Server with automatic Let's Encrypt SSL...${NC}"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

CADDY_HASH=$(caddy hash-password --plaintext "$USER_PASS")

# Create .env file
cat <<EOF > "$INSTALL_DIR/.env"
NODE_ENV=production
CORE_PORT=8045
WEB_PORT=3000
PORT=8045
DOMAIN=${USER_DOMAIN}
GEMINIROUTER_API_KEY=${MASTER_API_KEY}
DASHBOARD_USER=${USER_ADMIN}
DASHBOARD_PASSWORD=${USER_PASS}
DASHBOARD_PASSWORD_HASH=${CADDY_HASH}
DATA_DIR=${INSTALL_DIR}/data
LOG_DIR=${INSTALL_DIR}/logs
EOF

# Render Caddyfile
cat <<EOF > /etc/caddy/Caddyfile
# geminirouter Production Caddy Configuration
${USER_DOMAIN} {
    log {
        output file /var/log/caddy/geminirouter.log {
            roll_size 10mb
            roll_keep 10
        }
    }

    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    # API endpoints (OpenAI / Anthropic compatible)
    @api {
        path /v1/* /v1beta/*
    }

    handle @api {
        reverse_proxy 127.0.0.1:8045 {
            header_up Host {upstream_hostport}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}

            transport http {
                response_header_timeout 600s
                read_timeout 600s
            }
        }
    }

    # Dashboard & Web Management (Protected by HTTP Basic Auth)
    @dashboard {
        not path /v1/* /v1beta/*
    }

    handle @dashboard {
        basic_auth {
            ${USER_ADMIN} ${CADDY_HASH}
        }

        reverse_proxy 127.0.0.1:3000 {
            header_up Host {upstream_hostport}
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up Upgrade {>Upgrade}
            header_up Connection {>Connection}
        }
    }
}
EOF

# Fix permissions
chown -R geminirouter:geminirouter "$INSTALL_DIR"
chown -R geminirouter:geminirouter /home/geminirouter/.config
chmod 600 "$INSTALL_DIR/.env"

echo -e "${CYAN}[6/7] Configuring systemd services...${NC}"
cp "$SCRIPT_DIR/geminirouter-core.service" /etc/systemd/system/geminirouter-core.service
cp "$SCRIPT_DIR/geminirouter.service" /etc/systemd/system/geminirouter.service
cp "$SCRIPT_DIR/geminirouter-core-creds.service" /etc/systemd/system/geminirouter-core-creds.service
cp "$SCRIPT_DIR/geminirouter-core-creds.timer" /etc/systemd/system/geminirouter-core-creds.timer

systemctl daemon-reload
systemctl enable geminirouter-core.service
systemctl enable geminirouter.service
systemctl enable --now geminirouter-core-creds.timer
systemctl restart geminirouter-core.service || true
systemctl restart geminirouter.service || true
systemctl restart caddy

echo -e "${CYAN}[7/7] Verifying services status...${NC}"
sleep 3
systemctl is-active --quiet caddy && echo -e "${GREEN}✓ Caddy service is active.${NC}" || echo -e "${YELLOW}! Caddy status warning (check systemctl status caddy)${NC}"

echo ""
echo -e "${GREEN}${BOLD}======================================================================${NC}"
echo -e "${GREEN}${BOLD}     🎉 geminirouter Successfully Deployed on Your VPS!             ${NC}"
echo -e "${GREEN}${BOLD}======================================================================${NC}"
echo ""
echo -e "${BOLD}1. Web Management Dashboard:${NC}"
echo -e "   URL:      ${CYAN}https://${USER_DOMAIN}${NC}"
echo -e "   Username: ${BOLD}${USER_ADMIN}${NC}"
echo -e "   Password: ${BOLD}${USER_PASS}${NC}"
echo ""
echo -e "${BOLD}2. OpenAI-Compatible API Endpoint:${NC}"
echo -e "   Base URL: ${CYAN}https://${USER_DOMAIN}/v1${NC}"
echo -e "   API Key:  ${BOLD}${MASTER_API_KEY}${NC}"
echo ""
echo -e "${BOLD}3. Quick Tool Configurations:${NC}"
echo ""
echo -e "   ${YELLOW}• Claude Code (~/.claude/settings.json or CLI):${NC}"
echo -e "     export ANTHROPIC_BASE_URL=\"https://${USER_DOMAIN}/v1\""
echo -e "     export ANTHROPIC_API_KEY=\"${MASTER_API_KEY}\""
echo ""
echo -e "   ${YELLOW}• Codex (~/.codex/config.toml):${NC}"
echo -e "     model_provider = \"geminirouter\""
echo -e "     [model_providers.geminirouter]"
echo -e "     base_url = \"https://${USER_DOMAIN}/v1\""
echo -e "     api_key = \"${MASTER_API_KEY}\""
echo ""
echo -e "   ${YELLOW}• Cursor IDE (Settings -> Models -> OpenAI API Key):${NC}"
echo -e "     Base URL: https://${USER_DOMAIN}/v1"
echo -e "     API Key:  ${MASTER_API_KEY}"
echo ""
echo -e "   ${YELLOW}• Python (openai SDK):${NC}"
echo -e "     client = OpenAI(base_url=\"https://${USER_DOMAIN}/v1\", api_key=\"${MASTER_API_KEY}\")"
echo ""
echo -e "${BOLD}4. Management Commands:${NC}"
echo -e "   Check Core Status:      ${CYAN}systemctl status geminirouter-core${NC}"
echo -e "   Check Web Status:       ${CYAN}systemctl status geminirouter${NC}"
echo -e "   View Live Logs:         ${CYAN}journalctl -u geminirouter-core -u geminirouter -f${NC}"
echo -e "   Restart Services:       ${CYAN}systemctl restart geminirouter-core geminirouter${NC}"
echo -e "   (Optional PM2 control): ${CYAN}cd /opt/geminirouter && pm2 start ecosystem.config.js${NC}"
echo ""
echo -e "${GREEN}Configuration saved to: /opt/geminirouter/.env${NC}"
echo -e "${GREEN}Enjoy your fast, private, unmetered AI Gateway!${NC}"
echo "======================================================================"
