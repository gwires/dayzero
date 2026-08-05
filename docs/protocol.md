# sync protocol

The server is a dumb, durable relay: it stores opaque per-entry yjs update
blobs in an append-only log, plus content-addressed attachment blobs. It
never parses or merges CRDT data — all merging happens on clients via
`Y.applyUpdate`, which is commutative and idempotent, so message ordering
and duplicate delivery are both safe. See PLAN.md "sync" and "entries as
CRDTs" for the design rationale; this doc is the wire-level contract kept in
lockstep with both the zig server (`server/src/api.zig`) and the client sync
engine (`app/src/lib/sync/`).

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

## `PUT /api/blobs/<sha256>`

Uploads a content-addressed attachment blob (a photo, from the client's
`attachments` table). `<sha256>` is the lowercase hex sha256 of the raw
request body; the server recomputes it and rejects the upload if it
doesn't match — this is what "content-addressed" buys: the id *is* the
integrity check, and there's nothing to authenticate beyond the bearer
token. Re-uploading a blob that's already stored is a harmless no-op (the
bytes for a given hash are immutable by definition).

The raw bytes go directly in the request body, not JSON-wrapped.

Response: `200 {"status": "ok"}`.

Errors: `400 {"error": "invalid_id"}` (path segment isn't 64 hex chars),
`400 {"error": "hash_mismatch"}` (body doesn't hash to the given id).

## `GET /api/blobs/<sha256>`

Response: the raw bytes with `Content-Type: application/octet-stream`, or
`404 {"error": "not_found"}` if no blob with that id has been uploaded.

## client sync loop

`syncOnce()` in `app/src/lib/sync/engine.ts`, wired up by `initSyncEngine()`
on app startup, on the browser's `online` event, and debounced after local
writes (`sync/notify.ts`):

1. **pull** — loop on `cursor` (persisted in `sync_state`) until a page
   comes back with fewer than the page size: apply each update via
   `applyRemoteUpdate` (`entries/store.ts`; `Y.applyUpdate` +
   re-materialize, *without* re-queuing it to the outbox — it just came
   from the log), then fetch any attachment hashes the newly-applied docs'
   `photos` maps reference that aren't already in the local `attachments`
   table (`sync/blobs.ts`'s `fetchMissingBlobs`).
2. **push** — send whatever's in the local `outbox` table (`sync/outbox.ts`),
   deleting exactly the rows that were just sent (by `rowid`, so a write
   that lands mid-push isn't dropped without being sent), then upload any
   attachment blobs not yet marked `pushed` (`sync/blobs.ts`'s
   `pushPendingBlobs`).

No-ops quietly (not an error) if no server url/token is configured yet
(`/settings`).
