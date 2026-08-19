#!/usr/bin/env bash
# Builds everything dayzero ships — the web app, the Android APK, the sync
# server, and the desktop shell — from a fresh checkout. Works on macOS and
# Linux; everything it needs comes from flake.nix's devshell.
#
#   nix develop -c scripts/build-all.sh
#
# The web app is built once (scripts/build-apk.sh and build-desktop.sh are
# invoked with DAYZERO_SKIP_WEB_BUILD=1 so they don't rebuild it).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/app"

fail() {
  echo "error: $*" >&2
  exit 1
}

# All tooling comes from the nix devshell; fail fast with a clear message
# instead of dying deep inside a sub-build.
for tool in node npm npx zig java; do
  command -v "$tool" >/dev/null 2>&1 ||
    fail "'$tool' not found — run this from the nix devshell (nix develop)"
done
[ -n "${ANDROID_HOME:-}" ] ||
  fail "ANDROID_HOME is not set — run this from the nix devshell (nix develop)"

echo "==> [1/5] installing web dependencies"
(cd "$app_dir" && npm ci)

echo "==> [2/5] building web app"
(cd "$app_dir" && npm run build)

echo "==> [3/5] building sync server"
(cd "$repo_root/server" && zig build)

echo "==> [4/5] building Android APK"
DAYZERO_SKIP_WEB_BUILD=1 "$repo_root/scripts/build-apk.sh"

echo "==> [5/5] building desktop app"
DAYZERO_SKIP_WEB_BUILD=1 "$repo_root/scripts/build-desktop.sh"

apk="$app_dir/android/app/build/outputs/apk/debug/app-debug.apk"
server_bin="$repo_root/server/zig-out/bin/dayzero-server"
desktop_bin="$repo_root/desktop/zig-out/bin/dayzero-desktop"

echo
echo "==> all builds succeeded:"
echo "    web app: $app_dir/build/"
echo "    apk:     $apk ($(du -h "$apk" | cut -f1))"
echo "    server:  $server_bin ($(du -h "$server_bin" | cut -f1))"
echo "    desktop: $desktop_bin ($(du -h "$desktop_bin" | cut -f1))"
