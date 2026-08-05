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
- offline map: a locator map on entries with a captured location (lat/lng text stays too), using a small bundled vector basemap (country borders + top 10k cities) by default, with an optional custom tile url (self-hosted or OSM) for more detail when online
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
- `/settings` sync server url + token, map tile url, export/import, storage usage

## entries as CRDTs

each entry is one **yjs `Y.Doc`**, identified by a uuidv7. inside the doc:

- `text: Y.Text` — the markdown body (character-level merge of concurrent edits)
- `meta: Y.Map` — `entry_date`, `location_lat/lng/name`, `deleted` (tombstone). Y.Map is last-write-wins **per key**, which is exactly right for scalars
- `tags: Y.Map` — tag name → `true`; removing a tag deletes the key (add/remove of *different* tags on two devices both survive)
- `photos: Y.Map` — sha-256 → `{mime, width, height}`; the actual bytes are immutable, content-addressed blobs synced separately (blobs can never conflict)

concurrent creation is a non-issue: two devices creating "today's entry" produce two
docs with different uuids, and a diary may simply have multiple entries per day
(the timeline groups by day anyway).

## client data model (sqlite, in OPFS)

sqlite is the query layer; the yjs docs are the source of truth for content.
after every local or remote change, the entry's current state is **materialized**
into plain columns so timeline / tag filter / "on this day" stay ordinary SQL
(and full-text search is easy later).

```sql
entries(          -- materialized view of each Y.Doc, rebuilt on change
  id TEXT PRIMARY KEY, entry_date TEXT, markdown TEXT,
  location_lat REAL, location_lng REAL, location_name TEXT,
  deleted INTEGER, updated_at TEXT
)
entry_tags(entry_id TEXT, tag TEXT, PRIMARY KEY(entry_id, tag))  -- materialized
ydocs(entry_id TEXT PRIMARY KEY, snapshot BLOB)   -- merged yjs state (Y.encodeStateAsUpdate)
outbox(entry_id TEXT, update BLOB, created_at TEXT) -- local updates not yet pushed
attachments(id TEXT PRIMARY KEY, mime TEXT, width INTEGER, height INTEGER,
            bytes BLOB, pushed INTEGER)             -- id = sha-256 of bytes
sync_state(key TEXT PRIMARY KEY, value TEXT)        -- device id, server cursor
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
  10,000 cities by population (GeoNames `cities15000`, CC BY 4.0 — credited
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
  the top 10k cities by population, and runs `tippecanoe` to produce
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
- v1 auth: single user, one long random bearer token in the server config. TLS is left to a reverse proxy (caddy/nginx). end-to-end encryption is a natural v2 here (the server already treats updates as opaque bytes — encrypting them client-side wouldn't change the protocol at all), but out of scope for now
- client implementation (`app/src/lib/sync/`): `api.ts` (fetch wrapper matching `docs/protocol.md`, base64 (de)coding), `outbox.ts` (read/delete queued updates by rowid), `blobs.ts` (push un-pushed attachments, fetch attachments newly referenced by pulled docs), `engine.ts` (`syncOnce()` = pull-then-push; `initSyncEngine()` wires start/`online`/debounced-after-write). `entries/store.ts` gained `applyRemoteUpdate` (applies a pulled update and re-materializes *without* re-queuing it to the outbox) and a `sync/notify.ts` pub/sub so a local write can trigger a debounced sync without `entries/store.ts` importing the sync engine (avoiding a circular import)
- the sync server needs CORS (`Access-Control-Allow-Origin`, handling the browser's `OPTIONS` preflight) since it's a separate origin from the PWA — httpz ships a `middleware.Cors` for exactly this, registered once as a server-wide middleware in `main.zig`

## server (`server/`)

- zig (version pinned by the nix flake, e.g. 0.14.x), dependencies via `build.zig.zon`:
  - `http.zig` (karlseguin) for the http server — much nicer than raw `std.http`
  - `zqlite` for sqlite
- single sqlite database file, path from config; WAL mode

```sql
updates(seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, update BLOB, received_at TEXT)
blobs(id TEXT PRIMARY KEY, bytes BLOB)   -- id = sha-256, verified on upload
```

- endpoints: the sync api above + `GET /api/health` — see `docs/protocol.md` for the full wire contract
- config: env vars (port, address, db path, auth token). `DAYZERO_AUTH_TOKEN` is required — the server refuses to start without one, since there's no safe "open" default for a sync endpoint
- also serves the built PWA as static files (optional but convenient: one binary = whole app)
- `zig build test` for unit tests (handlers are tested directly via `httpz.testing`, no real socket); `server/test-integration.sh` starts a real instance and exercises the protocol over HTTP with curl (push, pull, blob round-trip, auth rejection). `server/test-e2e-sync.sh` builds on that: starts a real instance and runs the client's vitest sync harness against it, simulating two devices (as plain `Y.Doc`s, not full client sqlite databases — that needs a browser) to assert convergence after concurrent edits
- needs CORS (see "sync") since the PWA calls it cross-origin — httpz's `middleware.Cors`, registered server-wide in `main.zig`'s `server.router(...)` call
- gotcha: `zig build test`'s root module (`main.zig`) only discovers `test` blocks in files it actually analyzes — merely `@import`ing and calling into `config.zig`/`db.zig`/`api.zig` from `main()` isn't enough, since `main()` itself never runs during a test build. `main.zig` has a `test { std.testing.refAllDecls(@This()); }` block to force those files (and their tests) to be analyzed; without it `zig build test` silently reports success having run zero tests

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
    src/main.zig  src/config.zig  src/db.zig  src/api.zig
    test-integration.sh   # curl-based protocol test against a real running instance
    test-e2e-sync.sh      # real server + client vitest sync harness, two simulated devices
  scripts/
    build-basemap.sh  README.md   # rebuilds app/static/basemap.pmtiles
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
9. **polish**: export/import (single sqlite file or zip of markdown+photos), pwa icons/manifest, empty states, lighthouse pass

## verification

- `app`: vitest for the materializer — two Y.Docs diverge offline, exchange updates in both orders, assert identical text/tags/meta and identical materialized rows (`entries/materialize.test.ts`)
- `app`: vitest for the sync engine's wire layer — base64 round-tripping, request shapes, pagination, error handling, all against a mocked `fetch` (`sync/api.test.ts`); `entries/store.ts`'s db-backed pieces (`applyRemoteUpdate`, outbox, blobs) aren't unit tested the same way since they need a real sqlite-wasm/OPFS worker (a browser), not just node — covered by the browser smoke test below instead
- `app`: vitest for the streak calculation — given a set of entry dates, assert the correct current-streak count, including gaps, an unbroken streak, and today vs. yesterday as the streak's anchor
- `server`: `zig build test`; curl-based integration script (push updates, pull from zero cursor, blob round-trip, auth rejection)
- end-to-end: `server/test-e2e-sync.sh` starts a real server and runs the vitest sync harness (`sync/e2e.test.ts`, skipped unless `DAYZERO_E2E_SERVER_URL`/`DAYZERO_E2E_TOKEN` are set) against it — two `Y.Doc`s standing in for two devices push/pull through the real HTTP protocol and are asserted to converge after concurrent edits
- manual: two isolated browser profiles (separate OPFS storage, same real server) exercising the actual UI end to end — create an entry on device A, sync, pull it up on device B, edit concurrently on both (text on A, a tag on B) without syncing, then sync in order and confirm both devices converge to the same markdown + tags

## defaults chosen (flag if you disagree)

- yjs for the CRDT (mature, tiny (~tens of KB), battle-tested, good codemirror binding for later) rather than automerge (heavier wasm) or loro (younger). server stays CRDT-agnostic either way
- single-user server with one bearer token (no accounts) — it's self-hosted and personal
- photos live inside sqlite as blobs (content-addressed) rather than as loose files — one-file backup, simpler sync
- no end-to-end encryption in v1 (but the opaque-blob protocol makes it easy to add)
- sveltekit static rather than bare vite+svelte — free routing and structure, still a pure static PWA
