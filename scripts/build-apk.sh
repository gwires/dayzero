#!/usr/bin/env bash
# Builds a debug Android APK: production web build -> Capacitor sync -> Gradle
# assembleDebug. See APK-PLAN.md for how the Android project (app/android/)
# was set up. Run from the nix devshell (needs node, the Android SDK, and
# JDK 21 — all provided by flake.nix).
#
# Set DAYZERO_SKIP_WEB_BUILD=1 to skip the web build when app/build/ is
# already up to date (scripts/build-all.sh does this to avoid building the
# web app twice).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir="$repo_root/app"
apk="$app_dir/android/app/build/outputs/apk/debug/app-debug.apk"

if [ "${DAYZERO_SKIP_WEB_BUILD:-}" != 1 ]; then
  echo "==> building web assets"
  (cd "$app_dir" && npm run build)
fi

echo "==> syncing web assets into the Android project"
(cd "$app_dir" && npx cap sync android)

echo "==> assembling debug APK"
(cd "$app_dir/android" && ./gradlew assembleDebug)

echo "==> done: $apk ($(du -h "$apk" | cut -f1))"
