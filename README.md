# dayzero

A local-first diary app, inspired by Day One. Entries live on your device first
and sync between devices later — the app works fully offline.

- **`app/`** — a SvelteKit PWA (Svelte 5 + TypeScript). Entries are stored
  locally in SQLite (via `sqlite-wasm`, persisted in OPFS) and modeled as
  [Yjs](https://yjs.dev) CRDTs, so edits made on two devices while offline
  merge cleanly with no lost data.
- **`server/`** — a Zig sync server (single static binary, SQLite storage).
  It only ever stores opaque CRDT update blobs; it never needs to understand
  the entry format.

See [`PLAN.md`](./PLAN.md) for the full architecture and roadmap.

## Status

Milestones 1–9 are done: offline-first PWA shell, local SQLite/Yjs storage,
photos, location, "on this day", calendar/streaks, an offline vector map,
a working sync protocol (client + Zig server, bearer-token auth required),
and export/import. Only a Lighthouse pass remains from milestone 9.

Milestone 10 (packaging as an Android APK via Capacitor) is also done —
native geolocation and native backup export are confirmed working
on-device; the offline map's Capacitor range-request workaround has passed
build/lint/test but not yet been confirmed rendering correctly on a real
device (see `BUGS.md` bug 3).

Milestone 11 (multiple diaries) is done — entries can be grouped into named,
syncing diaries, scoped from a nav switcher, with a settings section to
manage them. See [`PLAN.md`](./PLAN.md) for the full milestone list and
architecture.

## Prerequisites

- [Nix](https://nixos.org/download) with flakes enabled (either
  system-wide, or run commands with
  `--extra-experimental-features "nix-command flakes"`)
- Optionally [direnv](https://direnv.net/) — this repo has an `.envrc`, so
  `direnv allow` will drop you into the dev shell automatically whenever
  you `cd` into the project

The flake's dev shell provides pinned versions of everything you need: Zig
0.14, `zls`, Node 22, and `sqlite`. You don't need any of these installed
globally.

## Getting started

```sh
git clone <this repo>
cd dayzero
nix develop        # or: direnv allow
```

Everything below assumes you're inside the dev shell (either via `nix
develop` or direnv). If you'd rather not enter a shell, prefix any command
with `nix develop -c <command>`.

## App (`app/`)

```sh
cd app
npm install          # first time only
npm run dev           # start the dev server (http://localhost:5173)
npm run dev -- --open # ...and open it in a browser
```

Other useful commands, all run from `app/`:

| command             | what it does                                      |
| ------------------- | -------------------------------------------------- |
| `npm run build`     | production build (static files in `app/build/`)    |
| `npm run preview`   | serve the production build locally                 |
| `npm run check`     | svelte-check (types + Svelte diagnostics)           |
| `npm run lint`      | prettier --check + eslint                           |
| `npm run format`    | prettier --write                                    |
| `npm run test`      | vitest, single run                                  |
| `npm run test:unit` | vitest in watch mode                                |

The app is a pure static SPA (`adapter-static` with a `200.html` fallback,
`ssr = false`) — there's no server-side rendering, so `npm run build` just
needs to be hosted as static files (or served by the Zig server later on).

## Server (`server/`)

```sh
cd server
zig build run    # starts on http://127.0.0.1:8080 by default
zig build test   # unit tests
```

Configuration is via environment variables:

| variable              | default            | meaning                          |
| ---------------------- | ------------------ | --------------------------------- |
| `DAYZERO_PORT`         | `8080`              | port to listen on                 |
| `DAYZERO_ADDRESS`      | `127.0.0.1`         | address to bind                   |
| `DAYZERO_DB_PATH`      | `dayzero.sqlite`    | path to the SQLite database file |
| `DAYZERO_AUTH_TOKEN`   | *(required)*        | bearer token; server refuses to start without one |

The server compiles to a single, dependency-free static binary — SQLite is
vendored and compiled in rather than linked against the system library.

```sh
zig build          # build zig-out/bin/dayzero-server without running it
```

## Repo layout

```
dayzero/
  flake.nix  flake.lock  .envrc   # nix devshell
  PLAN.md                          # architecture + full milestone roadmap
  BUGS.md                          # known mobile/APK bugs and their status
  APK-PLAN.md                      # Capacitor packaging plan (milestone 10)
  docs/protocol.md                 # sync wire protocol, kept in lockstep with client + server
  scripts/                         # build-basemap.sh, build-glyphs.sh (offline map assets)
  app/
    src/lib/db/       # sqlite-wasm worker, migrations, typed rpc
    src/lib/entries/  # Y.Doc wrapper, materializer, entry store
    src/lib/sync/     # api client, outbox, blob fetcher, sync engine
    src/lib/settings/ # backup export/import
    src/lib/ui/        # shared UI components (EntryEditor, MapView, ...)
    src/routes/        # timeline, new/edit entry, tags, calendar, map, settings
    android/           # Capacitor Android project (milestone 10)
  server/
    src/main.zig  src/config.zig  src/db.zig  src/api.zig
```
