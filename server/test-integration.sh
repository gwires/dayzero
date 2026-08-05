#!/usr/bin/env bash
# Curl-based integration test for the sync server: builds it, starts a real
# instance against a throwaway sqlite db, and exercises the full protocol
# over HTTP (push, pull, blob round-trip, auth rejection). Complements
# `zig build test`'s unit tests, which call handlers directly and never
# touch the network or a real subprocess. See docs/protocol.md and
# PLAN.md "server".
#
# Run from the nix devshell:
#   nix develop -c server/test-integration.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dir="$repo_root/server"
work="$(mktemp -d)"
port=18099
base="http://127.0.0.1:$port"
token="test-token-$$"
pass=0
fail=0

cleanup() {
	if [ -n "${server_pid:-}" ] && kill -0 "$server_pid" 2>/dev/null; then
		kill "$server_pid" 2>/dev/null
		wait "$server_pid" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

ok() {
	pass=$((pass + 1))
	echo "  ok: $1"
}

bad() {
	fail=$((fail + 1))
	echo "  FAIL: $1"
}

expect_status() {
	local desc="$1" expected="$2" actual="$3"
	if [ "$actual" = "$expected" ]; then
		ok "$desc (status $actual)"
	else
		bad "$desc (expected status $expected, got $actual)"
	fi
}

expect_eq() {
	local desc="$1" expected="$2" actual="$3"
	if [ "$actual" = "$expected" ]; then
		ok "$desc"
	else
		bad "$desc (expected [$expected], got [$actual])"
	fi
}

echo "==> building server"
(cd "$server_dir" && zig build)

echo "==> starting server on $base"
DAYZERO_AUTH_TOKEN="$token" DAYZERO_PORT="$port" DAYZERO_ADDRESS=127.0.0.1 \
	DAYZERO_DB_PATH="$work/test.sqlite" \
	"$server_dir/zig-out/bin/dayzero-server" >"$work/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 50); do
	if curl -s -o /dev/null "$base/api/health"; then break; fi
	sleep 0.1
done

echo "==> health"
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/health")
expect_status "GET /api/health" 200 "$status"

echo "==> auth rejection"
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/changes?since=0")
expect_status "GET /api/changes with no Authorization header" 401 "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "$base/api/changes?since=0")
expect_status "GET /api/changes with the wrong token" 401 "$status"

echo "==> push"
update_b64=$(printf 'hello-yjs-update' | base64 | tr -d '\n')
push_body="{\"changes\":[{\"entry_id\":\"entry-1\",\"update\":\"$update_b64\"}]}"
resp=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $token" \
	-H "Content-Type: application/json" -d "$push_body" "$base/api/changes")
status=$(echo "$resp" | tail -1)
expect_status "POST /api/changes" 200 "$status"

echo "==> pull from zero cursor"
resp=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $token" "$base/api/changes?since=0")
status=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -n -1)
expect_status "GET /api/changes?since=0" 200 "$status"
case "$body" in
*'"entry_id":"entry-1"'*'"update":"'"$update_b64"'"'*) ok "pulled change matches what was pushed" ;;
*) bad "pulled change matches what was pushed (got: $body)" ;;
esac

echo "==> blob round-trip"
printf 'hello blob content' >"$work/blob.bin"
hash=$(sha256sum "$work/blob.bin" | cut -d' ' -f1)

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $token" \
	--data-binary @"$work/blob.bin" "$base/api/blobs/$hash")
expect_status "PUT /api/blobs/<sha256> with the correct hash" 200 "$status"

resp=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $token" "$base/api/blobs/$hash")
status=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -n -1)
expect_status "GET /api/blobs/<sha256>" 200 "$status"
expect_eq "fetched blob matches uploaded bytes" "hello blob content" "$body"

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $token" \
	--data-binary @"$work/blob.bin" "$base/api/blobs/$(printf '0%.0s' {1..64})")
expect_status "PUT /api/blobs/<sha256> with a mismatched hash" 400 "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
	"$base/api/blobs/$(printf '1%.0s' {1..64})")
expect_status "GET /api/blobs/<sha256> for an unknown blob" 404 "$status"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
