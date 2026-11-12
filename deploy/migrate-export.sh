#!/usr/bin/env bash
#
# geminirouter - lift-and-shift export.
#
# Run this ON THE SOURCE VPS. It stops nothing and changes nothing: it only
# reads the deployment and writes one tarball plus a manifest of checksums.
# The companion script deploy/migrate-import.sh restores the identical layout
# on a fresh Ubuntu VPS.
#
# What is included (everything needed to run identically):
#   /opt/geminirouter                 code, core bundle, built dist
#   /home/geminirouter/.antigravity-agent
#                                     OAuth token db, device fingerprint,
#                                     proxy state
#   /etc/geminirouter                 env files (root-only secrets)
#   systemd units, Caddyfile, crontabs
#
# What is deliberately excluded, and why:
#   core-*.log                       1.2 GB of rotated daily logs; no state
#   .deploy-backups, backups         247 MB of superseded deploy tarballs
#   proxy-state/request-audit.db     1.2 GB SQLite of request history that only
#                                    feeds the Usage page. Pass --with-audit-log
#                                    to carry it via a consistent SQLite snapshot.
#
# Usage:
#   sudo bash deploy/migrate-export.sh [--with-audit-log] [output-dir]
#
# Output defaults to /var/tmp/geminirouter-migration.

set -euo pipefail

WITH_AUDIT=0
ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --with-audit-log) WITH_AUDIT=1 ;;
    *) ARGS+=("${arg}") ;;
  esac
done

OUT_DIR="${ARGS[0]:-/var/tmp/geminirouter-migration}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BUNDLE="${OUT_DIR}/geminirouter-${STAMP}.tar.gz"
MANIFEST="${OUT_DIR}/MANIFEST-${STAMP}.txt"
AUDIT_SRC="/home/geminirouter/.antigravity-agent/proxy-state/request-audit.db"
AUDIT_STAGE="${OUT_DIR}/audit-${STAMP}/request-audit.db"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run this as root (sudo) so the root-only env files can be read." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "==> [1/6] Verifying the deployment before capturing it"
for unit in geminirouter-core geminirouter-bridge; do
  state="$(systemctl is-active "${unit}" 2>/dev/null || true)"
  echo "    ${unit}: ${state}"
  if [[ "${state}" != "active" ]]; then
    echo "WARNING: ${unit} is not active; the bundle still captures the files on disk." >&2
  fi
done
# A warning here is not fatal, but a half-written state file would be, so the
# check only reports.
echo "    caddy: $(systemctl is-active caddy 2>/dev/null || echo unknown)"

echo "==> [2/6] Collecting systemd units"
UNIT_STAGE="${OUT_DIR}/units-${STAMP}"
mkdir -p "${UNIT_STAGE}"
for unit in \
  /etc/systemd/system/geminirouter-bridge.service \
  /etc/systemd/system/geminirouter-core.service \
  /etc/systemd/system/geminirouter-core-creds.service \
  /etc/systemd/system/geminirouter-core-creds.timer
do
  [[ -f "${unit}" ]] && cp -a "${unit}" "${UNIT_STAGE}/"
done
systemctl list-timers --all --no-pager 2>/dev/null \
  | grep -i geminirouter > "${UNIT_STAGE}/timers.txt" || true

echo "==> [3/6] Writing the manifest"
{
  echo "geminirouter migration manifest"
  echo "created_utc: ${STAMP}"
  echo "hostname: $(hostname)"
  echo "os: $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
  echo "arch: $(uname -m)"
  echo "node: $(node -v 2>/dev/null || echo missing)"
  echo "pnpm: $(pnpm -v 2>/dev/null || echo missing)"
  echo "caddy: $(caddy version 2>/dev/null | head -1 || echo missing)"
  echo "ffmpeg: $(ffmpeg -version 2>/dev/null | head -1 || echo missing)"
  echo "geminirouter_uid: $(id -u geminirouter 2>/dev/null || echo missing)"
  echo "geminirouter_gid: $(id -g geminirouter 2>/dev/null || echo missing)"
  echo
  echo "--- listening ports ---"
  ss -ltn 2>/dev/null | grep -E ':3000|:8045|:8046|:80 |:443 ' || true
  echo
  echo "--- source checksums (compare these after import) ---"
  find /opt/geminirouter/server/dist -name '*.js' -print0 2>/dev/null \
    | sort -z | xargs -0 md5sum 2>/dev/null | sed 's|/opt/geminirouter/||'
  echo
  echo "--- critical state files ---"
  md5sum /home/geminirouter/.antigravity-agent/cloud_accounts.db \
         /home/geminirouter/.antigravity-agent/device_original.json \
         /opt/geminirouter/server/.data/server-state.json 2>/dev/null || true
} > "${MANIFEST}"
echo "    manifest: ${MANIFEST}"

echo "==> [4/7] Snapshotting the request audit log"
# The audit DB is a 1.2 GB SQLite file that the core keeps open for writes. It
# is copied with VACUUM INTO, which produces a consistent single-file snapshot
# without locking the live process. It is only carried when asked for, because
# it duplicates data the Usage page can rebuild from new traffic.
if [[ "${WITH_AUDIT}" -eq 1 ]]; then
  if [[ -f "${AUDIT_SRC}" ]]; then
    mkdir -p "$(dirname "${AUDIT_STAGE}")"
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "${AUDIT_SRC}" "VACUUM INTO '${AUDIT_STAGE}'"
    else
      echo "    sqlite3 not installed; shipping the raw file plus WAL"
      cp -a "${AUDIT_SRC}" "${AUDIT_STAGE}"
      [[ -f "${AUDIT_SRC}-wal" ]] && cp -a "${AUDIT_SRC}-wal" "${AUDIT_STAGE}-wal"
    fi
    echo "    audit snapshot: $(du -h "${AUDIT_STAGE}" | cut -f1)"
  else
    echo "    no audit DB at ${AUDIT_SRC}; nothing to carry"
  fi
else
  echo "    skipped (pass --with-audit-log to include it)"
fi

echo "==> [5/7] Building the tarball"
# Rotated daily logs are 1.2 GB of the agent directory and carry no state, so
# they are excluded; the databases and JSON state are captured with everything
# else. The two historical backup trees are also excluded: .deploy-backups and
# backups are 247 MB of superseded tarballs from older deploys, and carrying
# them across would double the transfer for no recovery value on the new host.
EXTRA_PATHS=()
if [[ "${WITH_AUDIT}" -eq 1 && -f "${AUDIT_STAGE}" ]]; then
  EXTRA_PATHS+=("var/tmp/geminirouter-migration/audit-${STAMP}")
fi

tar -czf "${BUNDLE}" \
  --warning=no-file-changed \
  --exclude='.antigravity-agent/core-*.log' \
  --exclude='.antigravity-agent/*.log' \
  --exclude='.antigravity-agent/proxy-state/request-audit.db*' \
  --exclude='node_modules/.cache' \
  --exclude='opt/geminirouter/.deploy-backups' \
  --exclude='opt/geminirouter/backups' \
  -C / \
  opt/geminirouter \
  home/geminirouter/.antigravity-agent \
  etc/geminirouter \
  etc/caddy/Caddyfile \
  "var/tmp/geminirouter-migration/units-${STAMP}" \
  "${EXTRA_PATHS[@]}" \
  2>/dev/null || {
    status=$?
    # tar exits 1 when a file changed while being read. The deployment is live,
    # so treat 1 as success and anything else as fatal.
    if [[ ${status} -ne 1 ]]; then
      echo "ERROR: tar failed with status ${status}" >&2
      exit ${status}
    fi
  }

echo "==> [6/7] Appending crontabs"
{
  echo
  echo "--- crontab root ---"
  crontab -l 2>/dev/null || echo "(none)"
  echo "--- crontab geminirouter ---"
  crontab -l -u geminirouter 2>/dev/null || echo "(none)"
} >> "${MANIFEST}"

echo "==> [7/7] Done"
SIZE="$(du -h "${BUNDLE}" | cut -f1)"
echo
echo "Bundle:   ${BUNDLE}  (${SIZE})"
echo "Manifest: ${MANIFEST}"
echo
echo "Next: copy both files to the new VPS, then run as root:"
echo "  sudo bash migrate-import.sh ${BUNDLE##*/}"
