#!/usr/bin/env bash
#
# Update the external AntigravityManager core bundle safely.
#
# The core is NOT part of this repository. Use this when Antigravity rotates
# its public OAuth client credentials or when you want a newer core build.
#
#   ./update-core.sh --bundle /tmp/main.cjs       # install an already-built bundle
#   ./update-core.sh --source /opt/core-src       # build from a patched source tree
#   ./update-core.sh --rollback                   # restore the latest backup
#
# Env overrides:
#   CORE_HOME      default /opt/geminirouter/core
#   CORE_PROFILE   default /home/geminirouter/.antigravity-agent
#   CORE_SERVICE   default geminirouter-core
#   CORE_PIPE      default $CORE_PROFILE/runtime/core-v1.sock
#   BACKUP_ROOT    default /opt/geminirouter/backups
#
set -euo pipefail

CORE_HOME="${CORE_HOME:-/opt/geminirouter/core}"
CORE_PROFILE="${CORE_PROFILE:-/home/geminirouter/.antigravity-agent}"
CORE_SERVICE="${CORE_SERVICE:-geminirouter-core}"
CORE_PIPE="${CORE_PIPE:-$CORE_PROFILE/runtime/core-v1.sock}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/geminirouter/backups}"
CORE_BUNDLE="$CORE_HOME/dist/core/main.cjs"

MODE=""
ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) MODE="bundle"; ARG="${2:-}"; shift 2 ;;
    --source) MODE="source"; ARG="${2:-}"; shift 2 ;;
    --rollback) MODE="rollback"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

latest_backup() {
  ls -1d "$BACKUP_ROOT"/core-* 2>/dev/null | sort | tail -1
}

health_check() {
  local attempts=30
  while [ "$attempts" -gt 0 ]; do
    if curl -fsS --max-time 3 --unix-socket "$CORE_PIPE" http://localhost/v1/status >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    attempts=$((attempts - 1))
  done
  return 1
}

do_rollback() {
  local backup="$1"
  if [ -z "$backup" ] || [ ! -d "$backup/dist" ]; then
    echo "No backup to roll back to." >&2
    exit 1
  fi
  echo "Rolling back core bundle from $backup"
  rm -rf "$CORE_HOME/dist"
  cp -a "$backup/dist" "$CORE_HOME/dist"
  chown -R geminirouter:geminirouter "$CORE_HOME/dist"
  systemctl restart "$CORE_SERVICE"
  if health_check; then
    echo "Rollback complete; core is healthy."
  else
    echo "Rollback applied but core is still unhealthy." >&2
    exit 1
  fi
}

if [ "$MODE" = "rollback" ]; then
  do_rollback "$(latest_backup)"
  exit 0
fi

if [ -z "$MODE" ]; then
  echo "Specify --bundle PATH, --source DIR, or --rollback" >&2
  exit 2
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/core-$STAMP"
mkdir -p "$BACKUP"

echo "Backing up current core + account database..."
if [ -d "$CORE_HOME/dist" ]; then
  cp -a "$CORE_HOME/dist" "$BACKUP/dist"
fi
if [ -f "$CORE_PROFILE/cloud_accounts.db" ]; then
  cp -a "$CORE_PROFILE/cloud_accounts.db" "$BACKUP/cloud_accounts.db"
  echo "  accounts db: $BACKUP/cloud_accounts.db"
fi
echo "  backup dir: $BACKUP"

if [ "$MODE" = "source" ]; then
  if [ ! -d "$ARG" ]; then
    echo "Source directory not found: $ARG" >&2
    exit 1
  fi
  echo "Building core from $ARG ..."
  ( cd "$ARG" && pnpm install --frozen-lockfile && pnpm run build:core )
  BUILT="$ARG/dist/core/main.cjs"
  if [ ! -f "$BUILT" ]; then
    echo "Build did not produce $BUILT" >&2
    exit 1
  fi
  NEW_BUNDLE="$BUILT"
else
  NEW_BUNDLE="$ARG"
fi

if [ ! -f "$NEW_BUNDLE" ]; then
  echo "Bundle not found: $NEW_BUNDLE" >&2
  exit 1
fi

echo "Installing $NEW_BUNDLE ..."
mkdir -p "$(dirname "$CORE_BUNDLE")"
cp "$NEW_BUNDLE" "$CORE_BUNDLE.new"
chown geminirouter:geminirouter "$CORE_BUNDLE.new"
mv -f "$CORE_BUNDLE.new" "$CORE_BUNDLE"

echo "Restarting $CORE_SERVICE ..."
systemctl restart "$CORE_SERVICE"

if health_check; then
  echo "Core updated and healthy (backup: $BACKUP)."
  exit 0
fi

echo "Core failed its health check; rolling back automatically." >&2
do_rollback "$BACKUP"
exit 1
