#!/usr/bin/env bash
# Builds the dayzero desktop binary: production web build -> Zig shell with
# the build embedded (github.com/webview/webview window around a localhost
# http server). See docs/DESKTOP-PLAN.md for the architecture and platform
# status (notably: WebKitGTK has no OPFS, so the Linux build is currently a
# shell looking for an engine — macOS/Windows are the supported targets).
# Run from the nix devshell (needs node, zig, pkg-config, gtk3,
# webkitgtk_4_1 — all provided by flake.nix).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/app"
bin="$repo_root/desktop/zig-out/bin/dayzero-desktop"

echo "==> building web assets"
(cd "$app_dir" && npm run build)

echo "==> building the desktop shell (embeds app/build)"
(cd "$repo_root/desktop" && zig build -Doptimize=ReleaseSafe)

echo "==> done: $bin ($(du -h "$bin" | cut -f1))"
