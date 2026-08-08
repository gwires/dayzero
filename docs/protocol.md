# sync protocol

The server is a dumb, durable relay: it stores opaque per-entry yjs update
blobs in an append-only log, plus content-addressed attachment blobs. It
never parses or merges CRDT data — all merging happens on clients via
`Y.applyUpdate`, which is commutative and idempotent, so message ordering
and duplicate delivery are both safe. See PLAN.md "sync" and "entries as
CRDTs" for the design rationale; this doc is the wire-level contract kept in
lockstep with both the zig server (`server/src/api.zig`) and the client sync
engine (`app/src/lib/sync/`).

Clients reserve the `entry_id` `_diaries` for the diary-registry Y.Doc (see
PLAN.md "multiple diaries") and `_e2ee_meta` for the E2EE bootstrap doc (see
PLAN.md "encryption"). The server needs no knowledge of either — any opaque
id is already accepted, and both travel through push/pull exactly like an
entry's updates.

Once a client has set up encryption (PLAN.md "encryption"), the `update`
bytes for every `entry_id` except `_e2ee_meta` are a client-side AES-GCM
envelope, not a raw yjs update — the server doesn't need to know or care;
it's still just relaying opaque bytes either way. The same applies to blob
bodies (see `PUT /api/blobs/<id>` below).

Cross-origin: the PWA and the server are separate origins in general (a
self-hosted service, not served from the app's own origin), so the server
sends CORS headers (`Access-Control-Allow-Origin: *`) and answers the
browser's `OPTIONS` preflight on every endpoint — see `middleware.Cors` in
`server/src/main.zig`. `*` is fine here since requests never use
credentialed mode (cookies); the bearer token travels as a plain header,
which CORS doesn't restrict the same way.

## auth

Every endpoint except `GET /api/health` requires:

```
Authorization: Bearer <token>
```

`<token>` is the single long random string configured via `DAYZERO_AUTH_TOKEN`
on the server. There is one token for the whole server (v1 is single-user);
a missing or incorrect token gets `401 {"error": "unauthorized"}`. TLS is
expected to be handled by a reverse proxy in front of the server, not by the
server itself.

## `GET /api/health`

No auth required. Used for liveness checks.

```json
200 {"status": "ok"}
```

## `POST /api/changes`

Pushes one or more yjs updates. Each is appended to the server's log and
assigned a monotonically increasing `seq` (clients don't need to know their
own pushed seqs — they'll see them again on the next pull, and reapplying
an update a client already has is a no-op).

Request:

```json
{
	"changes": [{ "entry_id": "<uuid>", "update": "<base64>" }]
}
```

`update` is the base64 encoding of a yjs update (`Y.encodeStateAsUpdate` /
an update produced by a `Y.Doc` "update" event) — JSON has no binary type,
so raw bytes never appear directly in the request.

Response:

```json
200 { "status": "ok", "count": 1 }
```

Errors: `400 {"error": "invalid_json"}` (unparseable body), `400
{"error": "missing_body"}` (empty body), `400 {"error":
"invalid_update_encoding"}` (an `update` field isn't valid base64).

## `GET /api/changes?since=<seq>&limit=<n>`

Pulls all updates with `seq > since`, oldest first. `since=0` (or omitted)
pulls from the beginning of the log. `limit` defaults to 500 and is capped
at 2000 server-side, so a client that's very far behind can't force one
huge response — a client should keep pulling (using the returned `cursor`
as the next `since`) until a response comes back with fewer changes than it
asked for.

Response:

```json
200 {
	"changes": [{ "seq": 1, "entry_id": "<uuid>", "update": "<base64>" }],
	"cursor": 1
}
```

`cursor` is the highest `seq` in this response (or `since` unchanged if
`changes` is empty) — save it and pass it as the next `since`.

## `PUT /api/blobs/<id>`

Uploads an attachment blob (a photo, from the client's `attachments`
table). `<id>` must be a 64-character lowercase hex string, but the server
does **not** verify it against the body's content hash — it's a
client-chosen opaque identifier, same as `entry_id`. (Earlier versions of
this protocol verified `id == sha256(body)`; that was dropped once clients
started encrypting blob bodies, since an encrypted body's hash can never
match a plaintext content-address, and AES-GCM's own auth tag already gives
the same integrity guarantee on decrypt. Unencrypted clients still populate
`id` with the plaintext content hash by convention, for local dedup, but
the server no longer cares either way.) Re-uploading a blob already stored
under a given id is a harmless no-op.

The raw bytes go directly in the request body, not JSON-wrapped.

Response: `200 {"status": "ok"}`.

Errors: `400 {"error": "invalid_id"}` (path segment isn't 64 hex chars).

## `GET /api/blobs/<id>`

Response: the raw bytes with `Content-Type: application/octet-stream`, or
`404 {"error": "not_found"}` if no blob with that id has been uploaded.

## client sync loop

`syncOnce()` in `app/src/lib/sync/engine.ts`, wired up by `initSyncEngine()`
on app startup, on the browser's `online` event, and debounced after local
writes (`sync/notify.ts`):

1. **pull** — loop on `cursor` (persisted in `sync_state`) until a page
   comes back with fewer than the page size: the `_e2ee_meta` change (if
   any) is applied directly, always plaintext, *regardless of whether this
   device has a key yet* — that's how a fresh device learns the salt in the
   first place. Every other change requires a verified passphrase to go
   any further: with one, it's decrypted (`e2ee/crypto.ts`'s
   `decryptBytes`) before being applied via `applyRemoteUpdate`
   (`entries/store.ts`; `Y.applyUpdate` + re-materialize, *without*
   re-queuing it to the outbox — it just came from the log), then any
   attachment hashes the newly-applied docs' `photos` maps reference that
   aren't already in the local `attachments` table are fetched and
   decrypted (`sync/blobs.ts`'s `fetchMissingBlobs`). Without a key, pulling
   stops at the first such change — the cursor is saved at the last one
   actually applied, so the next pull resumes exactly there once unlocked —
   and the pass is reported as `locked`, not an error.
2. **push** — without a verified passphrase, nothing in the local `outbox`
   table is sent at all (reported `locked` if anything's actually queued).
   With one: every update except `_e2ee_meta`'s own is encrypted before
   sending, outbox rows that were just sent are deleted (by `rowid`, so a
   write that lands mid-push isn't dropped without being sent), then any
   attachment blobs not yet marked `pushed` are uploaded, encrypted
   (`sync/blobs.ts`'s `pushPendingBlobs`).

No-ops quietly (not an error) if no server url/token is configured yet.
Once one is, a passphrase is not optional: nothing but the `_e2ee_meta`
bootstrap doc is ever sent or applied without a verified key — there is no
plaintext fallback. `/settings` surfaces the `locked` state to the user as
"enter your passphrase below to enable encrypted sync."
