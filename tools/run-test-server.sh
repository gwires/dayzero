#!/usr/bin/env bash
# Starts a real dayzero-server for use with the tools/ test-data generator,
# importer, and verifier (see TESTGEN-PLAN.md). Builds the server, then
# execs it in the foreground so `kill`/Ctrl-C stops it cleanly. Mirrors the
# server half of server/test-e2e-sync.sh.
#
# Usage: tools/run-test-server.sh [db-path]
#   db-path defaults to <repo-root>/test-data-server.sqlite. Pass a fresh
#   path whenever re-importing regenerated data (see TESTGEN-PLAN.md
#   "changed data must go to a fresh server db").
#
# Run from the nix devshell:
#   nix develop -c tools/run-test-server.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dir="$repo_root/server"
port=18200
token="testgen-token"
db_path="${1:-$repo_root/test-data-server.sqlite}"

echo "==> building server"
(cd "$server_dir" && zig build)

echo "==> server url:   http://127.0.0.1:$port"
echo "==> auth token:   $token"
echo "==> db path:      $db_path"

export DAYZERO_AUTH_TOKEN="$token"
export DAYZERO_PORT="$port"
export DAYZERO_ADDRESS=127.0.0.1
export DAYZERO_DB_PATH="$db_path"
exec "$server_dir/zig-out/bin/dayzero-server"
