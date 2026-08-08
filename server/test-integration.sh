#!/usr/bin/env bash
# Curl-based integration test for the sync server: builds it, starts a real
# instance against a throwaway per-tenant db directory, and exercises the
# full multi-tenant protocol over HTTP (push, pull, blob round-trip, auth
# rejection, per-username isolation). Complements `zig build test`'s unit
# tests, which call handlers directly and never touch the network or a real
# subprocess. See docs/protocol.md and PLAN.md "server"/"encryption".
#
# Run from the nix devshell (needs openssl, for deriving per-user tokens the
# same way scripts/invite-user.sh does):
#   nix develop -c server/test-integration.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_dir="$repo_root/server"
work="$(mktemp -d)"
port=18099
base="http://127.0.0.1:$port"
server_token="test-token-$$"
username="testuser"
other_username="otheruser"
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

user_token() {
	printf '%s' "$1" | openssl dgst -sha256 -hmac "$server_token" | awk '{print $NF}'
}

token=$(user_token "$username")
other_token=$(user_token "$other_username")

echo "==> building server"
(cd "$server_dir" && zig build)

echo "==> starting server on $base"
DAYZERO_AUTH_TOKEN="$server_token" DAYZERO_PORT="$port" DAYZERO_ADDRESS=127.0.0.1 \
	DAYZERO_DB_PATH="$work/tenant-dbs" \
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
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/$username/changes?since=0")
expect_status "GET /api/<username>/changes with no Authorization header" 401 "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "$base/api/$username/changes?since=0")
expect_status "GET /api/<username>/changes with the wrong token" 401 "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $server_token" "$base/api/$username/changes?since=0")
expect_status "GET /api/<username>/changes with the raw server token (never a valid bearer token)" 401 "$status"

echo "==> username validation"
status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$base/api/Not-Valid!/changes?since=0")
expect_status "GET /api/<invalid-charset-username>/changes" 400 "$status"

status=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/health/changes?since=0")
expect_status "GET /api/health/changes (username shaped like the reserved literal route)" 404 "$status"

echo "==> push"
update_b64=$(printf 'hello-yjs-update' | base64 | tr -d '\n')
push_body="{\"changes\":[{\"entry_id\":\"entry-1\",\"update\":\"$update_b64\"}]}"
resp=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $token" \
	-H "Content-Type: application/json" -d "$push_body" "$base/api/$username/changes")
status=$(echo "$resp" | tail -1)
expect_status "POST /api/<username>/changes" 200 "$status"

echo "==> pull from zero cursor"
resp=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $token" "$base/api/$username/changes?since=0")
status=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -n -1)
expect_status "GET /api/<username>/changes?since=0" 200 "$status"
case "$body" in
*'"entry_id":"entry-1"'*'"update":"'"$update_b64"'"'*) ok "pulled change matches what was pushed" ;;
*) bad "pulled change matches what was pushed (got: $body)" ;;
esac

echo "==> cross-tenant isolation"
resp=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $other_token" "$base/api/$other_username/changes?since=0")
status=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -n -1)
expect_status "GET /api/<other_username>/changes?since=0" 200 "$status"
case "$body" in
*'"changes":[]'*) ok "a different username's fresh db sees none of testuser's data" ;;
*) bad "a different username's fresh db sees none of testuser's data (got: $body)" ;;
esac

echo "==> blob round-trip"
printf 'hello blob content' >"$work/blob.bin"
hash=$(sha256sum "$work/blob.bin" | cut -d' ' -f1)

status=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $token" \
	--data-binary @"$work/blob.bin" "$base/api/$username/blobs/$hash")
expect_status "PUT /api/<username>/blobs/<id>" 200 "$status"

resp=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $token" "$base/api/$username/blobs/$hash")
status=$(echo "$resp" | tail -1)
body=$(echo "$resp" | head -n -1)
expect_status "GET /api/<username>/blobs/<id>" 200 "$status"
expect_eq "fetched blob matches uploaded bytes" "hello blob content" "$body"

status=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
	"$base/api/$username/blobs/$(printf '1%.0s' {1..64})")
expect_status "GET /api/<username>/blobs/<id> for an unknown blob" 404 "$status"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
