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

Currently implemented (milestones 1–2 of the plan):

- Installable, offline-first PWA shell (`vite-plugin-pwa`, precached app
  shell, works with no network at all)
- Local storage: SQLite running in a web worker, persisted via the
  `opfs-sahpool` VFS (no special HTTP headers required), with numbered SQL
  migrations
- Entries as Yjs `Y.Doc`s (markdown text + metadata + tags), materialized
  into plain SQL rows after every change so the timeline and tag filters are
  ordinary queries
- Timeline (`/`, grouped by day), entry editor (`/new`, `/entry/[id]`) with
  a markdown/preview toggle (sanitized with DOMPurify) and a freeform tag
  editor, and a tags overview (`/tags`) that filters the timeline
- A minimal Zig server with `GET /api/health` and the `updates`/`blobs`
  tables it will use for sync, but no sync protocol wired up yet

Not yet implemented: photos, location, "on this day", the sync protocol
between client and server, and export/import. See the milestones in
[`PLAN.md`](./PLAN.md) for what's next.

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
| `DAYZERO_AUTH_TOKEN`   | *(none)*            | bearer token (not enforced yet)   |

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
  app/
    src/lib/db/       # sqlite-wasm worker, migrations, typed rpc
    src/lib/entries/  # Y.Doc wrapper, materializer, entry store
    src/lib/ui/        # shared UI components (EntryEditor, ...)
    src/routes/        # timeline, new/edit entry, tags, settings
  server/
    src/main.zig  src/config.zig  src/db.zig  src/api.zig
```
