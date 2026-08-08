#!/usr/bin/env bash
# Starts a real dayzero-server for use with the tools/ test-data generator,
# importer, and verifier (see TESTGEN-PLAN.md). Builds the server, then
# execs it in the foreground so `kill`/Ctrl-C stops it cleanly. Mirrors the
# server half of server/test-e2e-sync.sh.
#
# Usage: tools/run-test-server.sh [db-dir]
#   db-dir defaults to <repo-root>/test-data-server-db — a *directory*
#   (post multi-tenant server, DAYZERO_DB_PATH holds one <username>.sqlite
#   per tenant, see docs/PLAN.md "multi-tenant server"). Pass a fresh path
#   whenever re-importing regenerated data (see TESTGEN-PLAN.md "changed
#   data must go to a fresh server db").
#
# Run from the nix devshell:
#   nix develop -c tools/run-test-server.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dir="$repo_root/server"
port=18200
server_token="testgen-token"
username="testgen"
db_path="${1:-$repo_root/test-data-server-db}"

echo "==> building server"
(cd "$server_dir" && zig build)

# same derivation as scripts/invite-user.sh / server/src/api.zig's
# deriveUserToken — the fixed "testgen" user's bearer token, computed from
# this script's own DAYZERO_AUTH_TOKEN.
user_token=$(printf '%s' "$username" | openssl dgst -sha256 -hmac "$server_token" | awk '{print $NF}')

echo "==> server url:   http://127.0.0.1:$port"
echo "==> username:     $username"
echo "==> user token:   $user_token"
echo "==> db path:      $db_path"
echo
echo "==> pass to import/verify: --username $username --token $user_token"

export DAYZERO_AUTH_TOKEN="$server_token"
export DAYZERO_PORT="$port"
export DAYZERO_ADDRESS=127.0.0.1
export DAYZERO_DB_PATH="$db_path"
exec "$server_dir/zig-out/bin/dayzero-server"
