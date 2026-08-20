#!/usr/bin/env bash
# Builds the dayzero desktop binary: production web build -> Zig shell with
# the build embedded (github.com/webview/webview window around a localhost
# http server). See docs/DESKTOP-PLAN.md for the architecture and platform
# status (notably: WebKitGTK has no OPFS, so the Linux build is currently a
# shell looking for an engine — macOS/Windows are the supported targets).
# Run from the nix devshell (needs node, zig, pkg-config, gtk3,
# webkitgtk_4_1 — all provided by flake.nix).
#
# Set DAYZERO_SKIP_WEB_BUILD=1 to skip the web build when app/build/ is
# already up to date (scripts/build-all.sh does this to avoid building the
# web app twice).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/app"
bin="$repo_root/desktop/zig-out/bin/dayzero-desktop"

if [ "${DAYZERO_SKIP_WEB_BUILD:-}" != 1 ]; then
  echo "==> building web assets"
  (cd "$app_dir" && npm run build)
fi

echo "==> building the desktop shell (embeds app/build)"
# On nix-darwin the devshell injects NIX_CFLAGS_COMPILE, CC, CXX, etc.
# pointing at nix-store toolchain paths. zig picks these up and links
# against nix's libc++/compiler-rt instead of the macOS SDK's, which
# breaks ObjC runtime resolution (_objc_msgSend undefined). Clear them
# so zig uses only the system SDK via its native detection.
env -u NIX_CFLAGS_COMPILE \
    -u NIX_LDFLAGS \
    -u CC -u CXX -u CFLAGS -u CXXFLAGS -u LDFLAGS \
    -u SDKROOT -u DEVELOPER_DIR \
  bash -c 'cd "$0" && exec zig build -Doptimize=ReleaseSafe' \
  "$repo_root/desktop"

echo "==> done: $bin ($(du -h "$bin" | cut -f1))"
