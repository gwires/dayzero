#!/usr/bin/env bash
# End-to-end sync convergence test: builds and starts a real dayzero-server,
# then runs the vitest sync harness (app/src/lib/sync/e2e.test.ts) against
# it, simulating two devices that edit the same entry concurrently while
# offline and asserting they converge once both have pushed and pulled.
# Complements server/test-integration.sh (protocol-shape checks) and
# sync/api.test.ts (mocked-fetch unit tests) — this is the only one that
# exercises the real server binary and the real wire encoding together.
# See PLAN.md "verification" and docs/protocol.md.
#
# Run from the nix devshell:
#   nix develop -c server/test-e2e-sync.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dir="$repo_root/server"
app_dir="$repo_root/app"
work="$(mktemp -d)"
port=18100
server_token="e2e-token-$$"
username="e2euser"
user_token=$(printf '%s' "$username" | openssl dgst -sha256 -hmac "$server_token" | awk '{print $NF}')

cleanup() {
	if [ -n "${server_pid:-}" ] && kill -0 "$server_pid" 2>/dev/null; then
		kill "$server_pid" 2>/dev/null
		wait "$server_pid" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

echo "==> building server"
(cd "$server_dir" && zig build)

echo "==> starting server on 127.0.0.1:$port"
DAYZERO_AUTH_TOKEN="$server_token" DAYZERO_PORT="$port" DAYZERO_ADDRESS=127.0.0.1 \
	DAYZERO_DB_PATH="$work/tenant-dbs" \
	"$server_dir/zig-out/bin/dayzero-server" >"$work/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 50); do
	if curl -s -o /dev/null "http://127.0.0.1:$port/api/health"; then break; fi
	sleep 0.1
done

echo "==> running vitest sync harness against it"
(
	cd "$app_dir"
	DAYZERO_E2E_SERVER_URL="http://127.0.0.1:$port" \
		DAYZERO_E2E_USERNAME="$username" \
		DAYZERO_E2E_TOKEN="$user_token" \
		npx vitest run src/lib/sync/e2e.test.ts
)
