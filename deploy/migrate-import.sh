#!/usr/bin/env bash
#
# geminirouter - lift-and-shift import.
#
# Run this ON THE NEW VPS, as root, once the bundle from migrate-export.sh has
# been copied next to this script. It restores the identical layout, reinstalls
# the systemd units and starts the services. Nothing about the configuration is
# rewritten: the env files, the domain and the API keys all move unchanged.
#
# The only thing you must do outside this script is point the domain's A record
# at the new server, because Caddy issues its certificate over HTTP-01.
#
# Usage:
#   sudo bash migrate-import.sh geminirouter-YYYYmmdd-HHMMSS.tar.gz

set -euo pipefail

BUNDLE="${1:-}"
if [[ -z "${BUNDLE}" || ! -f "${BUNDLE}" ]]; then
  echo "Usage: sudo bash migrate-import.sh <bundle.tar.gz>" >&2
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run this as root (sudo)." >&2
  exit 1
fi

WORK="$(cd "$(dirname "${BUNDLE}")" && pwd)"
BUNDLE_NAME="$(basename "${BUNDLE}")"
STAMP="${BUNDLE_NAME#geminirouter-}"
STAMP="${STAMP%.tar.gz}"
MANIFEST="${WORK}/MANIFEST-${STAMP}.txt"

echo "==> [1/8] Checking the destination"
if [[ -d /opt/geminirouter/server/dist ]] && systemctl is-active --quiet geminirouter-bridge 2>/dev/null; then
  echo "ERROR: this host already runs geminirouter. Refusing to overwrite a live" >&2
  echo "       deployment. Stop the services first if this is intentional." >&2
  exit 1
fi
echo "    arch: $(uname -m)   os: $(. /etc/os-release && echo "${PRETTY_NAME}")"

echo "==> [2/8] Installing runtime dependencies"
# Same versions as the source: Node 24, Caddy from its own repo, ffmpeg for the
# media routes. Skip this step if the image already provides them.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 24 ]]; then
  echo "    installing Node.js 24"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
else
  echo "    node already present: $(node -v)"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "    installing ffmpeg"
  apt-get update -y && apt-get install -y --no-install-recommends ffmpeg
else
  echo "    ffmpeg already present"
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "    installing caddy"
  apt-get install -y --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  echo "    caddy already present"
fi

echo "==> [3/8] Creating the service account"
# The uid matters: the files in the bundle are owned by 999, and matching the
# number keeps the ownership intact without a recursive chown.
if ! id geminirouter >/dev/null 2>&1; then
  if id -u 999 >/dev/null 2>&1; then
    echo "    uid 999 is taken by $(id -un 999); creating geminirouter with the next free uid"
    useradd --system --create-home --shell /usr/sbin/nologin geminirouter
  else
    groupadd --system --gid 988 geminirouter 2>/dev/null || true
    useradd --system --uid 999 --gid 988 --create-home --shell /usr/sbin/nologin geminirouter
  fi
else
  echo "    geminirouter already exists: uid=$(id -u geminirouter)"
fi

echo "==> [4/8] Restoring files"
tar -xzf "${BUNDLE}" -C /
# The units were staged under their export path; install them where systemd
# reads them.
if [[ -d "/var/tmp/geminirouter-migration/units-${STAMP}" ]]; then
  cp -a "/var/tmp/geminirouter-migration/units-${STAMP}"/geminirouter-*.service /etc/systemd/system/ 2>/dev/null || true
  cp -a "/var/tmp/geminirouter-migration/units-${STAMP}"/geminirouter-*.timer /etc/systemd/system/ 2>/dev/null || true
fi

echo "==> [5/8] Fixing ownership and permissions"
chown -R geminirouter:geminirouter /opt/geminirouter
chown -R geminirouter:geminirouter /home/geminirouter
# These two must stay root-only; they hold the admin password and the OAuth
# client secrets.
chown root:geminirouter /etc/geminirouter /etc/geminirouter/*.env
chmod 750 /etc/geminirouter
chmod 640 /etc/geminirouter/*.env
# The bridge writes its state next to the build.
mkdir -p /opt/geminirouter/server/.data
chown geminirouter:geminirouter /opt/geminirouter/server/.data

echo "==> [6/8] Reloading systemd"
systemctl daemon-reload
systemctl enable geminirouter-core geminirouter-bridge geminirouter-core-creds.timer 2>/dev/null || true
systemctl start geminirouter-core
# The bridge depends on the core's port being up.
for _ in $(seq 1 30); do
  if ss -ltn 2>/dev/null | grep -q ':8046'; then break; fi
  sleep 1
done
systemctl start geminirouter-bridge

# The restored Caddyfile must reach the running process. The apt install in
# step [2/8] auto-starts Caddy with the package's default localhost config and
# the tarball overwrites the file afterwards, so without this restart Caddy
# keeps serving the default on :80 only and never attempts HTTPS.
if command -v caddy >/dev/null 2>&1; then
  systemctl restart caddy
  echo "    caddy restarted on the restored Caddyfile"
fi

# Some cloud images (Vultr's Ubuntu 24.04) ship ufw ACTIVE with only 22 open,
# which makes the ACME HTTP/TLS-ALPN challenges time out and the certificate
# never issues. The source box had ufw inactive, so these two rules reproduce
# its effective policy while keeping everything else closed.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "    ufw active: opened 80/tcp and 443/tcp for Caddy + ACME"
fi

echo "==> [7/8] Waiting for the bridge to answer"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" -eq 1 ]]; then
  echo "    local health: $(curl -fsS -m 3 http://127.0.0.1:3000/api/health)"
else
  echo "ERROR: the bridge did not answer on 127.0.0.1:3000." >&2
  echo "       Check: journalctl -u geminirouter-bridge -n 50" >&2
  exit 1
fi

echo "==> [8/8] Verifying the build matches the source"
if [[ -f "${MANIFEST}" ]]; then
  echo "    comparing deployed checksums against the source manifest:"
  failed=0
  while read -r sum path; do
    [[ -z "${sum}" || "${sum}" == ---* ]] && continue
    if [[ -f "/opt/geminirouter/${path}" ]]; then
      actual="$(md5sum "/opt/geminirouter/${path}" | cut -d' ' -f1)"
      if [[ "${actual}" != "${sum}" ]]; then
        echo "    MISMATCH ${path}" >&2
        failed=1
      fi
    fi
  done < <(grep -E '^[0-9a-f]{32}  ' "${MANIFEST}" || true)
  if [[ "${failed}" -eq 0 ]]; then
    echo "    all compared files are identical"
  fi
else
  echo "    manifest not found next to the bundle; skipped the comparison"
fi

echo
echo "Import complete."
echo
echo "Remaining step: point the domain's A record at this server, then Caddy"
echo "issues its certificate automatically. Verify with:"
echo "  curl -s https://<your-domain>/api/health"
echo "  systemctl status geminirouter-core geminirouter-bridge caddy"
