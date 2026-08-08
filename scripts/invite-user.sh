#!/usr/bin/env bash
# Computes a per-user bearer token for the dayzero sync server's
# multi-tenant auth scheme (see docs/protocol.md "auth" and
# server/src/api.zig's deriveUserToken): user_token =
# hex(HMAC-SHA256(key = DAYZERO_AUTH_TOKEN, message = username)). Stateless
# — this script and the server independently compute the same value from
# the same server secret; nothing is written anywhere, and there's no way
# to revoke a single user short of rotating DAYZERO_AUTH_TOKEN (which
# invalidates and requires redistributing everyone's tokens).
#
# Usage: DAYZERO_AUTH_TOKEN=... scripts/invite-user.sh <username>
#
# Run from the nix devshell (needs openssl):
#   nix develop -c scripts/invite-user.sh alice
set -euo pipefail

username="${1:-}"
if [ -z "$username" ]; then
	echo "usage: DAYZERO_AUTH_TOKEN=... $0 <username>" >&2
	exit 1
fi

if [ -z "${DAYZERO_AUTH_TOKEN:-}" ]; then
	echo "error: DAYZERO_AUTH_TOKEN must be set (the server's own secret)" >&2
	exit 1
fi

# same charset/length rules as tenants.zig's validateUsername — checked
# here too so a typo produces a clear error instead of a token the server
# will just reject.
if ! [[ "$username" =~ ^[a-z0-9_-]{1,32}$ ]]; then
	echo "error: username must be 1-32 chars of [a-z0-9_-] (lowercase only)" >&2
	exit 1
fi
if [ "$username" = "health" ]; then
	echo "error: 'health' is a reserved username" >&2
	exit 1
fi

# printf '%s' (never echo -n, not portable): the HMAC message must be
# exactly the raw username bytes, no trailing newline, matching what the
# server reads from the URL path segment. `awk '{print $NF}'` (last
# whitespace-separated field) rather than assuming a specific `openssl
# dgst` output format, since that varies across OpenSSL/LibreSSL versions
# — the hex digest is always the last token regardless of the prefix.
token=$(printf '%s' "$username" | openssl dgst -sha256 -hmac "$DAYZERO_AUTH_TOKEN" | awk '{print $NF}')

echo "username: $username"
echo "token:    $token"
echo
echo "give the user both values — they go into the app's Settings > sync"
echo "username / sync token fields (or DAYZERO_E2E_USERNAME/DAYZERO_E2E_TOKEN"
echo "for the test harnesses)."
