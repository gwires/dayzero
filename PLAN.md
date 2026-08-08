we are going to build `dayzero`, a diary application inspired by dayone.

## architecture

- there is a sync server (`server/`), written in zig, using sqlite for storage. single static binary, self-hostable.
- there is a local-first front end (`app/`), a PWA written in typescript using svelte. it works fully offline; the server is only needed for sync between devices.
- entries are CRDTs (yjs docs), so concurrent edits on desktop and phone merge cleanly — no lost edits, ever. the server never interprets CRDT data; it only stores opaque update blobs, so no CRDT implementation is needed in zig.
- dev environment is managed with nix (flake + direnv devshell providing zig, zls, node, sqlite).

note: `nix-command`/`flakes` are not enabled on this machine yet. either add
`nix.settings.experimental-features = [ "nix-command" "flakes" ];` to the nix-darwin
config, or rely on nix-direnv / `--extra-experimental-features "nix-command flakes"`.

## features

- markdown entries (write raw markdown, rendered preview; sanitized with DOMPurify)
- a few photos per entry (client-side resized/re-encoded, stored as blobs)
- tags (freeform, autocomplete from existing tags, filter timeline by tag)
- location per entry (geolocation api for coords + free-text place name; no online reverse geocoding in v1 so it stays offline-friendly)
- offline map: a locator map on entries with a captured location (lat/lng text stays too), using a small bundled vector basemap (country borders + top 50k cities) by default, with an optional custom tile url (self-hosted or OSM) for more detail when online
- "on this day": entries from the same month/day in earlier years, shown on the home screen
- calendar view: a month grid showing which days have entries; clicking a day shows that day's entries
- current streak: consecutive days with at least one entry, shown on the home screen
- multi-device sync via the zig server; export/import of the whole journal

## client (`app/`)

- sveltekit (svelte 5, typescript) + `adapter-static` → pure static app, no server rendering
- `vite-plugin-pwa` (workbox) for the service worker: precache the app shell, installable, offline-first
- storage: official `@sqlite.org/sqlite-wasm` running in a dedicated web worker, persisted in OPFS via the `opfs-sahpool` VFS (works in chrome, firefox and safari, no COOP/COEP headers required). the UI talks to the worker through a small typed RPC layer
- schema migrations: numbered sql migrations applied by the worker on startup (`user_version` pragma)
- photos: file input / drag-drop → resize to max ~2048px, re-encode to webp via canvas → stored content-addressed (sha-256) in an `attachments` table
- markdown rendering: `marked` + DOMPurify; editor is a plain textarea with preview toggle in v1 (codemirror 6 later — it has a first-class yjs binding (`y-codemirror.next`) which would give live collaborative cursors for free)
- map: `maplibre-gl` rendering a bundled offline vector basemap (`pmtiles`) by default, or a custom online tile url from settings — see "map" below

### routes

- `/` timeline, newest first, grouped by day, with an "on this day" strip and the current streak at the top
- `/new` new entry
- `/entry/[id]` view/edit entry
- `/tags` and `/?tag=...` tag filtering
- `/calendar` and `/?date=...` month grid of which days have entries; clicking a day filters the timeline to it
- `/map` overview map — every entry with a captured location plotted as a marker, tapping one opens that entry
- `/settings` sync server url + token, map tile url, export/import, storage usage, diary management

the nav also has a diary switcher (scope the whole app to one diary, or "all diaries") — see "multiple diaries" below

## entries as CRDTs

each entry is one **yjs `Y.Doc`**, identified by a uuidv7. inside the doc:

- `text: Y.Text` — the markdown body (character-level merge of concurrent edits)
- `meta: Y.Map` — `entry_date`, `diary_id`, `location_lat/lng/name`, `deleted` (tombstone). Y.Map is last-write-wins **per key**, which is exactly right for scalars
- `tags: Y.Map` — tag name → `true`; removing a tag deletes the key (add/remove of *different* tags on two devices both survive)
- `photos: Y.Map` — sha-256 → `{mime, width, height}`; the actual bytes are immutable, content-addressed blobs synced separately (blobs can never conflict)

concurrent creation is a non-issue: two devices creating "today's entry" produce two
docs with different uuids, and a diary may simply have multiple entries per day
(the timeline groups by day anyway).

## multiple diaries

entries can be grouped into named diaries (like Day One's journals). An
entry's diary is just another key in its `meta` map (`diary_id`) — a `meta`
with no `diary_id` means the always-existing **virtual default diary**
(`id: 'default'`, display name "journal"), so every pre-existing entry lands
there with no data rewrite.

the diary registry itself is one more well-known `Y.Doc`, reserved id
`_diaries`, synced through the same append-only log as entries (the server
treats `entry_id` as an opaque string, so this needs no server changes). It
holds a single `diaries: Y.Map` from diary id → `{ name, deleted? }`.
Creating a diary sets a new uuidv7 key; renaming re-sets it with a new name;
deleting re-sets it with `deleted: true` (a tombstone, mirroring entry
deletion — entries are never bulk-moved or cascade-deleted, so deleting a
diary requires it to be empty first). A map entry under the key `'default'`
overrides the virtual default diary's display name.

which diary is currently selected in the UI is device-local state (stored in
`sync_state`, not synced) — every device can look at a different diary (or
"all diaries") independently of what diaries exist.

## client data model (sqlite, in OPFS)

sqlite is the query layer; the yjs docs are the source of truth for content.
after every local or remote change, the entry's current state is **materialized**
into plain columns so timeline / tag filter / "on this day" stay ordinary SQL
(and full-text search is easy later).

```sql
entries(          -- materialized view of each Y.Doc, rebuilt on change
  id TEXT PRIMARY KEY, diary_id TEXT, entry_date TEXT, markdown TEXT,
  location_lat REAL, location_lng REAL, location_name TEXT,
  deleted INTEGER, updated_at TEXT
)
entry_tags(entry_id TEXT, tag TEXT, PRIMARY KEY(entry_id, tag))  -- materialized
ydocs(entry_id TEXT PRIMARY KEY, snapshot BLOB)   -- merged yjs state (Y.encodeStateAsUpdate)
meta_ydocs(doc_id TEXT PRIMARY KEY, snapshot BLOB) -- non-entry well-known docs, e.g. `_diaries`
outbox(entry_id TEXT, update BLOB, created_at TEXT) -- local updates not yet pushed
attachments(id TEXT PRIMARY KEY, mime TEXT, width INTEGER, height INTEGER,
            bytes BLOB, pushed INTEGER)             -- id = sha-256 of bytes
sync_state(key TEXT PRIMARY KEY, value TEXT)        -- device id, server cursor, current diary scope
```

"on this day" is just: `WHERE deleted=0 AND strftime('%m-%d', entry_date) = strftime('%m-%d', 'now') AND entry_date < date('now')`.

the calendar view is `SELECT DISTINCT entry_date FROM entries WHERE deleted=0 AND strftime('%Y-%m', entry_date) = ?` for the visible month, rendered as a grid with entry-having days marked; clicking a day is just `/?date=<entry_date>` (same pattern as `?tag=...`). the current streak is computed client-side from the distinct, sorted `entry_date` values already in `entries`: walk backwards day-by-day from today (or yesterday, if nothing is logged yet today) while a matching `entry_date` exists, counting as you go — pure function, no new sql needed.

## map

entries with a captured location (`location_lat`/`location_lng`) get a small
locator map in the entry view, in addition to the existing lat/lng text
(which stays — the map is additive, not a replacement). `/map` shows every
located entry at once, as markers on the same offline basemap; tapping a
marker opens that entry.

- rendering: `maplibre-gl` (open-source WebGL vector tile renderer, no api key)
- offline by default: a single bundled `app/static/basemap.pmtiles` file —
  country borders (Natural Earth 1:110m admin-0, public domain) plus the top
  50,000 cities by population (GeoNames `cities5000`, CC BY 4.0 — credited
  in `/settings`). read via the `pmtiles` library's HTTP range-request
  reader: no backend, no COOP/COEP, just another static file the service
  worker precaches alongside everything else
- online alternative: `/settings` has a "map tile url" field (stored in the
  existing `sync_state` table, no schema change) for an OSM-compatible
  raster/vector tile url template — a self-hosted tileserver, a commercial
  provider, or osm.org directly if the user has read and accepts its usage
  policy. dayzero never ships a default that hits osm.org, since their
  tile usage policy disallows unauthorized embedded use at any real scale
- rebuilding the basemap: `scripts/build-basemap.sh` (documented in
  `scripts/README.md`) downloads Natural Earth + GeoNames, filters/sorts to
  the top 50k cities by population, and runs `tippecanoe` to produce
  `basemap.pmtiles`. not run automatically as part of the build — the
  output is small and stable enough to just commit, like the vendored
  sqlite amalgamation in `server/lib/`; re-run only when refreshing the
  source data. `tippecanoe` is added to the nix devshell for this
- city names are labeled on the map (a `cities-label` symbol layer), using
  GeoNames' `asciiname` field so the label text is always plain ASCII. this
  keeps the offline glyph requirement to a single bundled range:
  `app/static/glyphs/dejavu-sans/0-255.pbf`, generated from the `dejavu_fonts`
  nix package via `scripts/build-glyphs.sh` (uses `fontnik`, installed
  ad-hoc and pruned by the script — not an app dependency). MapLibre requires
  pre-rendered SDF glyph `.pbf` files for any `symbol` layer `text-field`;
  there's no client-side text rasterization fallback for latin text
- estimated added weight: ~220kb (maplibre-gl) + ~15kb (pmtiles reader) +
  ~1-3mb (`basemap.pmtiles`, borders + city points only, no imagery) +
  ~80kb (`glyphs/dejavu-sans/0-255.pbf`) — keep an eye on the workbox
  `maximumFileSizeToCacheInBytes` ceiling (currently 5mb, set for the
  sqlite-wasm file) if the basemap grows close to it

## sync

per-entry **append-only log of yjs updates**; merge happens on the clients
(commutative + idempotent, so ordering and duplicates don't matter). the server is
a dumb, durable relay.

- on every local edit, yjs emits a compact binary update → append to `outbox`
- push: `POST /api/changes` with `[{entry_id, update}]`; server appends each to its log and assigns a global monotonic `seq`
- pull: `GET /api/changes?since=<cursor>` → all update blobs with `seq > cursor` (+ new cursor); client does `Y.applyUpdate` per entry, re-materializes, saves new snapshot
- blobs: `PUT /api/blobs/<sha256>` / `GET /api/blobs/<sha256>`; pull learns needed hashes from the docs' `photos` maps and fetches any it doesn't have locally
- sync engine runs pull-then-push on app start, on the `online` event, and debounced after local writes
- deletion = `meta.deleted = true` tombstone inside the doc, so it propagates like any edit
- compaction (later, optional): a client may post a merged snapshot update and the server can drop that entry's older updates once all known devices' cursors have passed them. not needed for v1 — diary entries are small and the log is cheap
- auth: multi-tenant, stateless per-user tokens derived from one server secret (`DAYZERO_AUTH_TOKEN`) — see "multi-tenant server" below and `docs/protocol.md` "auth" for the full formula. TLS is left to a reverse proxy (caddy/nginx). end-to-end encryption of everything that crosses this boundary is implemented — see "encryption" below
- client implementation (`app/src/lib/sync/`): `api.ts` (fetch wrapper matching `docs/protocol.md`, base64 (de)coding), `outbox.ts` (read/delete queued updates by rowid), `blobs.ts` (push un-pushed attachments, fetch attachments newly referenced by pulled docs), `engine.ts` (`syncOnce()` = pull-then-push; `initSyncEngine()` wires start/`online`/debounced-after-write). `entries/store.ts` gained `applyRemoteUpdate` (applies a pulled update and re-materializes *without* re-queuing it to the outbox) and a `sync/notify.ts` pub/sub so a local write can trigger a debounced sync without `entries/store.ts` importing the sync engine (avoiding a circular import)
- the sync server needs CORS (`Access-Control-Allow-Origin`, handling the browser's `OPTIONS` preflight) since it's a separate origin from the PWA — httpz ships a `middleware.Cors` for exactly this, registered once as a server-wide middleware in `main.zig`

## encryption

Passphrase-based end-to-end encryption of everything that crosses the sync
boundary — CRDT updates (entries + `_diaries`) and photo blobs. **Scope is
deliberately limited to the wire/server side**: local sqlite/OPFS storage on
each device is completely unaffected, exactly as before this feature — no
in-memory materialized index, no changes to search/calendar/tags/streak/map,
no passphrase required for local-only usage. A broader "no plaintext stored
anywhere, including locally" version of this was designed and rejected in
favor of this smaller one — see `SECURE-STORE-INVESTIGATION.md` for the full
comparison (that doc also covers, and rejects, whole-database-at-rest
encryption via SQLite3 Multiple Ciphers/OPFS: immature WASM support, no
official docs, real toolchain risk on top of the APK build's existing
quirks).

- **key derivation**: PBKDF2-HMAC-SHA256 via native `crypto.subtle`, 600,000
  iterations (OWASP's current recommendation), deriving an AES-256-GCM key.
  No new dependency — `crypto.subtle` is already used elsewhere (photo
  content hashing) and is available in every runtime this app ships to.
- **cipher**: AES-256-GCM, random 96-bit IV per encryption call, prepended
  to the ciphertext+tag. No format marker is needed: once a passphrase is
  set, every push is unconditionally encrypted (this assumes a fresh
  database — no mixed plaintext/ciphertext history to reconcile).
- **cross-device bootstrap**: a new well-known, always-plaintext Y.Doc,
  reserved id `_e2ee_meta`, holding one atomic `{salt, iterations, verifier}`
  value (a `Y.Map` with a single key, so a Y.Map merge between two devices
  that raced to set up encryption concurrently with different passphrases
  can never mix one device's salt with another's verifier — one whole
  config wins). Travels through the exact same outbox/`/api/changes` log as
  `_diaries` — the server already treats `entry_id` as opaque, so this
  needed no server change. The verifier is an AES-GCM encryption of a fixed
  known string under the candidate key; a wrong passphrase simply fails
  AES-GCM's auth tag on decrypt, which *is* the "wrong passphrase" signal
  (`e2ee/crypto.ts`'s `computeVerifier`/`checkVerifier`).
- **mandatory, no plaintext escape hatch**: a passphrase isn't optional once
  sync is configured — `sync/engine.ts`'s `pull()`/`push()` never send or
  apply an entry/`_diaries` update or a photo blob without a verified key,
  full stop. The one exception is `_e2ee_meta` itself, which is always
  applied regardless of key state — it has to be, so a fresh device can
  learn the salt before it can derive anything (`getConfig()` only requires
  a server url + token, precisely so this bootstrap pull can still happen;
  the *key* requirement is enforced per-change inside `pull()`/`push()`, not
  by refusing to sync at all). Until a passphrase is verified, a configured
  sync target simply transmits and receives nothing but that one bootstrap
  doc — surfaced to the user as a `locked` `SyncResult`, not a silent
  plaintext fallback.
- **key persistence**: the derived key (never the passphrase) is persisted
  locally as a plaintext `sync_state` row (`settings/store.ts`'s
  `getE2eeKeyMaterial`/`setE2eeKeyMaterial`) — same trust model already used
  for the plaintext-stored bearer token, so the passphrase is entered once
  per device, not every session. Platform-native hardening (Android
  Keystore, etc.) was investigated and explicitly deferred — see
  `SECURE-STORE-INVESTIGATION.md`.
- **photo blobs**: encrypted the same way (`sync/blobs.ts`), still addressed
  by the existing local plaintext-content hash (`attachments.id` —
  unchanged). This meant relaxing the server's blob upload verification
  (`sha256(body) == id`, `server/src/api.zig`'s `putBlob`): it can never
  hold once the body is ciphertext, and AES-GCM's own auth tag already gives
  the same integrity guarantee on decrypt. The alternative (address blobs by
  `sha256(ciphertext)` instead) was rejected — a receiving device can't
  derive that id without already having the ciphertext it's trying to
  fetch, which would require syncing a new per-photo id field and writing
  it back into the entry's Y.Doc after every push.
- known limitations: no passphrase rotation/history re-encryption in v1; the
  rare case of two never-yet-synced devices concurrently setting *different*
  passphrases resolves deterministically once they sync (Y.Map LWW), but the
  losing device's already-cached key then fails and surfaces as a normal
  sync error until the user re-enters the winning passphrase.

## multi-tenant server

Each user is identified by a username and gets their own sqlite database
file — a small group of people can share one self-hosted server without
seeing each other's data, and without the server maintaining any accounts
table at all.

- **routing**: every endpoint except `GET /api/health` is scoped under a
  `<username>` path segment (`/api/<username>/changes`,
  `/api/<username>/blobs/<id>`). httpz's router natively supports two path
  params in one route pattern.
- **auth**: `user_token = hex(HMAC-SHA256(key = DAYZERO_AUTH_TOKEN, message
  = username))` — fully stateless, no per-user secret stored server-side
  (`server/src/api.zig`'s `deriveUserToken`). The raw `DAYZERO_AUTH_TOKEN`
  is never itself accepted as a bearer token post-change, even by the
  admin's own device — see `docs/protocol.md` "auth" for the exact formula
  and a known-answer test vector. No revocation mechanism for a single user
  short of rotating `DAYZERO_AUTH_TOKEN` for everyone.
- **storage**: `DAYZERO_DB_PATH` is a directory, not a file —
  `<dir>/<username>.sqlite`, opened lazily on first request for that
  username and cached for the process's lifetime
  (`server/src/tenants.zig`'s `TenantStore`). The directory is created
  fail-fast at startup if it doesn't exist. Per-tenant isolation is
  structural (separate files), so `_diaries`/`_e2ee_meta`/entry/blob id
  collisions between different users are impossible by construction.
- **username validation**: `[a-z0-9_-]{1,32}`, checked identically
  server-side and by `scripts/invite-user.sh` (no silent normalization —
  the HMAC message must be one unambiguous canonical byte string on both
  sides). `health` is reserved: httpz's router matches a literal child
  (`/api/health`) before trying the `:username` param sibling, with no
  backtracking, so a real user named "health" would 404 on every route of
  their own.
- **inviting a user**: `DAYZERO_AUTH_TOKEN=... scripts/invite-user.sh
  <username>` computes and prints that user's token for the admin to hand
  out — nothing is written anywhere.

## server (`server/`)

- zig (version pinned by the nix flake, e.g. 0.14.x), dependencies via `build.zig.zon`:
  - `http.zig` (karlseguin) for the http server — much nicer than raw `std.http`
  - `zqlite` for sqlite
- one sqlite database file per username, in a directory from config; WAL mode; opened lazily (see "multi-tenant server")

```sql
updates(seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, update BLOB, received_at TEXT)
blobs(id TEXT PRIMARY KEY, bytes BLOB)   -- id is client-chosen and opaque, not server-verified (see "encryption")
```

- endpoints: the sync api above + `GET /api/health` — see `docs/protocol.md` for the full wire contract
- config: env vars (port, address, db path, auth token). `DAYZERO_AUTH_TOKEN` is required — the server refuses to start without one, since there's no safe "open" default for a sync endpoint
- also serves the built PWA as static files (optional but convenient: one binary = whole app)
- `zig build test` for unit tests (handlers are tested directly via `httpz.testing`, no real socket); `server/test-integration.sh` starts a real instance and exercises the protocol over HTTP with curl (push, pull, blob round-trip, auth rejection, cross-tenant isolation). `server/test-e2e-sync.sh` builds on that: starts a real instance and runs the client's vitest sync harness against it, simulating two devices (as plain `Y.Doc`s, not full client sqlite databases — that needs a browser) to assert convergence after concurrent edits
- needs CORS (see "sync") since the PWA calls it cross-origin — httpz's `middleware.Cors`, registered server-wide in `main.zig`'s `server.router(...)` call
- gotcha: `zig build test`'s root module (`main.zig`) only discovers `test` blocks in files it actually analyzes — merely `@import`ing and calling into `config.zig`/`db.zig`/`api.zig`/`tenants.zig` from `main()` isn't enough, since `main()` itself never runs during a test build. `main.zig` has a `test { std.testing.refAllDecls(@This()); }` block to force those files (and their tests) to be analyzed; without it `zig build test` silently reports success having run zero tests

## repo layout

```
dayzero/
  flake.nix  flake.lock  .envrc
  PLAN.md
  app/            # sveltekit pwa
    src/lib/db/       # worker, schema, migrations, typed rpc
    src/lib/entries/  # Y.Doc wrapper, materializer
    src/lib/sync/     # api client, outbox, blob fetcher, sync engine, local-write notify
    src/lib/ui/       # components: EntryCard, MarkdownView, PhotoStrip, TagPicker, MapView, ...
    src/routes/
    static/basemap.pmtiles  # bundled offline vector basemap, see "map" above
  server/
    build.zig  build.zig.zon
    src/main.zig  src/config.zig  src/db.zig  src/api.zig  src/tenants.zig
    test-integration.sh   # curl-based protocol test against a real running instance
    test-e2e-sync.sh      # real server + client vitest sync harness, two simulated devices
  scripts/
    build-basemap.sh  invite-user.sh  README.md   # rebuilds app/static/basemap.pmtiles; computes a user's sync token
  docs/protocol.md   # the sync protocol, kept in lockstep with both implementations
```

## milestones

1. **scaffold**: nix flake + devshell (zig, zls, nodejs, sqlite), sveltekit app skeleton, zig server skeleton with `/api/health`; installable PWA whose shell loads offline
2. **local storage**: sqlite-wasm worker + migrations; Y.Doc-per-entry with snapshot persistence and materialization; timeline and entry editor working fully offline (markdown + tags)
3. **photos & location**: attachment pipeline (resize → webp → blob), photo strip in entries; location capture
4. **on this day**: query + home screen strip
5. **calendar & streaks**: `/calendar` month grid keyed off `entry_date`, `/?date=...` day filtering, current-streak counter on the home screen
6. **map**: `scripts/build-basemap.sh` + committed `basemap.pmtiles`, `maplibre-gl` locator map on entries with a location, `/map` overview of all located entries, custom map tile url setting, labeled city names via `scripts/build-glyphs.sh` + committed `glyphs/dejavu-sans/0-255.pbf`
7. **server**: `updates`/`blobs` schema, required bearer-token auth, `/api/changes` push/pull (base64-wrapped updates, cursor pagination), `/api/blobs/<sha256>` put/get (content-addressed, hash-verified), `docs/protocol.md`, `zig build test` unit tests + `server/test-integration.sh` curl-based protocol test
8. **sync engine**: `app/src/lib/sync/` (api, outbox, blobs, engine, notify), `applyRemoteUpdate` in `entries/store.ts`, `/settings` sync server url + token + manual "sync now", CORS on the server, `sync/api.test.ts` (mocked-fetch unit tests), `server/test-e2e-sync.sh` (real server + vitest sync harness, two simulated devices converging after concurrent offline edits)
9. **polish**: export/import — done as a single sqlite file (`app/src/lib/settings/backup.ts`), per "defaults chosen" below, not the zip-of-markdown+photos alternative; pwa icons/manifest — done (milestone 1); empty states — done (timeline, `/map`); lighthouse pass — remaining
10. **android apk**: wraps the static build in Capacitor (`app/capacitor.config.ts`, `app/android/`, see `APK-PLAN.md`) so it installs and runs from a bundled `https://localhost` WebView origin — a secure context, which OPFS (the sqlite storage layer) requires — rather than a hosted/TWA origin; Android SDK + JDK 21 added to the nix devshell (`flake.nix`); native geolocation via `@capacitor/geolocation` (the plain web API gets no permission prompt inside a plain WebView); native backup export via `@capacitor/filesystem` (a Blob + `<a download>` silently no-ops in a WebView); debug APK builds successfully (`./gradlew assembleDebug`) — on-device confirmation of the full app (OPFS-backed pages, native location, native backup export) is the remaining step, see `BUGS.md`
11. **multiple diaries**: entries can belong to a named diary (`meta.diary_id`, absent = virtual default "journal"); the diary registry is a well-known `_diaries` Y.Doc synced through the existing log (no server changes); a nav diary switcher scopes timeline/on-this-day/streak/calendar/tags/map (device-local selection, not synced); the entry editor's diary select doubles as "move entry"; `/settings` gets a diaries section to create/rename/delete (delete requires the diary to be empty first)
12. **end-to-end encryption**: `app/src/lib/e2ee/` (ids, ydoc, crypto, store, session) — PBKDF2/AES-256-GCM via native `crypto.subtle`, a well-known `_e2ee_meta` bootstrap doc for cross-device salt/verifier distribution; `sync/engine.ts` requires a verified passphrase alongside the server url/token, encrypting every entry/`_diaries` update and photo blob once configured; `/settings` gets a passphrase field; `server/src/api.zig`'s blob upload hash verification was removed (see "encryption"); scope is deliberately sync-only — local storage is unaffected, see `SECURE-STORE-INVESTIGATION.md`
13. **multi-tenant server**: `server/src/tenants.zig` (`TenantStore`, username validation) — one `DAYZERO_AUTH_TOKEN` server secret now mints per-user tokens via `hex(HMAC-SHA256(key=secret, message=username))` instead of being usable directly as a bearer token; `DAYZERO_DB_PATH` is now a directory holding one sqlite file per username, opened lazily; routes become `/api/<username>/changes` and `/api/<username>/blobs/<id>` (`/api/health` unchanged); `scripts/invite-user.sh` computes a new user's token for an admin to hand out; no revocation short of rotating the server secret; no data migration — existing single-tenant `dayzero.sqlite` deployments start fresh under the new default directory (`dayzero-data`)

## verification

- `app`: vitest for the materializer — two Y.Docs diverge offline, exchange updates in both orders, assert identical text/tags/meta and identical materialized rows (`entries/materialize.test.ts`)
- `app`: vitest for the sync engine's wire layer — base64 round-tripping, request shapes, pagination, error handling, all against a mocked `fetch` (`sync/api.test.ts`); `entries/store.ts`'s db-backed pieces (`applyRemoteUpdate`, outbox, blobs) aren't unit tested the same way since they need a real sqlite-wasm/OPFS worker (a browser), not just node — covered by the browser smoke test below instead
- `app`: vitest for the streak calculation — given a set of entry dates, assert the correct current-streak count, including gaps, an unbroken streak, and today vs. yesterday as the streak's anchor
- `server`: `zig build test` (including `tenants.zig`'s username-validation/isolation tests and a known-answer HMAC vector); curl-based integration script (push updates, pull from zero cursor, blob round-trip, auth rejection, cross-tenant isolation, reserved/invalid-username rejection)
- end-to-end: `server/test-e2e-sync.sh` starts a real server and runs the vitest sync harness (`sync/e2e.test.ts`, skipped unless `DAYZERO_E2E_SERVER_URL`/`DAYZERO_E2E_TOKEN` are set) against it — two `Y.Doc`s standing in for two devices push/pull through the real HTTP protocol and are asserted to converge after concurrent edits
- manual: two isolated browser profiles (separate OPFS storage, same real server) exercising the actual UI end to end — create an entry on device A, sync, pull it up on device B, edit concurrently on both (text on A, a tag on B) without syncing, then sync in order and confirm both devices converge to the same markdown + tags
- `app`: vitest for the E2EE primitives — KDF determinism, encrypt/decrypt round-tripping, verifier accept/reject, key-material export/import (`e2ee/crypto.test.ts`); the bootstrap doc's atomic-config convergence under a concurrent-setup race (`e2ee/ydoc.test.ts`); `sync/e2e.test.ts` extended with two simulated devices converging over ciphertext plus a wrong-passphrase negative case

## defaults chosen (flag if you disagree)

- yjs for the CRDT (mature, tiny (~tens of KB), battle-tested, good codemirror binding for later) rather than automerge (heavier wasm) or loro (younger). server stays CRDT-agnostic either way
- multi-tenant server, stateless per-user tokens (HMAC-derived from one server secret, no accounts table, no revocation short of rotating the secret) — still self-hosted, but for a small group rather than strictly one person
- photos live inside sqlite as blobs (content-addressed) rather than as loose files — one-file backup, simpler sync
- end-to-end encryption is scoped to the sync wire only (entries/`_diaries` updates + photo blobs) — local sqlite/OPFS storage is unaffected by design; see "encryption" and `SECURE-STORE-INVESTIGATION.md`
- sveltekit static rather than bare vite+svelte — free routing and structure, still a pure static PWA
