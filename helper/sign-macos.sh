#!/usr/bin/env bash
#
# Signs and notarizes the macOS helper builds. Must run on macOS with Xcode
# command line tools installed (`xcode-select --install`).
#
# Required:
#   MACOS_SIGN_IDENTITY    e.g. "Developer ID Application: Framecall (TEAMID)"
#   APPLE_ID               Apple account email
#   APPLE_TEAM_ID          10-character team id
#   APPLE_APP_PASSWORD     app-specific password (appleid.apple.com)
#
# Usage:
#   ./sign-macos.sh                      # signs + notarizes dist/framecall-helper-macos-*
#   ./sign-macos.sh path/to/binary ...
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dist="$here/dist"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "sign-macos.sh must run on macOS." >&2
  exit 1
fi

for name in MACOS_SIGN_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_APP_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env var: $name" >&2
    exit 1
  fi
done

if [[ $# -gt 0 ]]; then
  binaries=("$@")
else
  binaries=("$dist"/framecall-helper-macos-*)
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for bin in "${binaries[@]}"; do
  if [[ ! -f "$bin" ]]; then
    echo "not found: $bin" >&2
    exit 1
  fi

  echo "==> signing $bin"
  codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$bin"
  codesign --verify --strict --verbose=2 "$bin"

  zip="$work/$(basename "$bin").zip"
  echo "==> notarizing $bin"
  /usr/bin/ditto -c -k --keepParent "$bin" "$zip"
  xcrun notarytool submit "$zip" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait

  echo "==> stapling $bin"
  xcrun stapler staple "$bin"
  xcrun stapler validate "$bin"
  spctl --assess --type execute --verbose=2 "$bin" || true
done

echo "macOS signing and notarization complete."
