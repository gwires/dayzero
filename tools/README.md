# tools/

Deno-based test-data generation and import for dayzero. See
`../TESTGEN-PLAN.md` for the full design; this is the short operator's
version. Everything here runs through the nix devshell:
`nix develop -c <command>`, or `cd tools && deno task <name>` from inside
the devshell.

## the four programs

**`generate-test-data.ts`** writes a realistic markdown-on-disk test
dataset — by default ~4000 entries, a 2500-day streak, 7 diaries, ~40 tags,
~100 locations, and ~3000 procedurally generated JPEGs — to `test-data/` at
the repo root, plus a `manifest.json` describing what was written. It knows
nothing about the server; it only ever reads/writes local files.

**`dayzero-cli.ts`** performs single-item operations against a running
dayzero-server: `health`, `diary create`, `blob push <file>`, and
`entry create`. It knows nothing about the on-disk test-data format — it
just builds one real yjs update per call (via `npm:yjs`, mirroring the
app's `createEntry`/`applyEdits`) and POSTs/PUTs it.

**`import-test-data.ts`** walks the tree `generate-test-data.ts` produced
and drives `dayzero-cli.ts` once per item (diary, blob, or entry) as a
subprocess — it never constructs a yjs doc itself.

**`verify-import.ts`** pulls the entire change log back from the server,
re-materializes every entry with yjs, and compares the result against
`manifest.json`'s `expected` block, printing a PASS/FAIL table.

## quickstart

```sh
nix develop -c tools/run-test-server.sh          # starts a server on :18200, prints the token
cd tools
deno task generate                                # writes ../test-data/ (~5-8 minutes, mostly JPEG encoding)
deno task import  -- --server http://127.0.0.1:18200 --token testgen-token
deno task verify   -- --server http://127.0.0.1:18200 --token testgen-token
```

Use `deno task import -- --limit 20 ...` while iterating — a full import is
~7000 `dayzero-cli` subprocess spawns (one per diary/blob/entry) and takes
roughly 7-25 minutes depending on the machine. `--limit` imports only the
first N day-folders (ascending by date).

## seed / determinism

Everything is driven by one seeded PRNG (mulberry32, `--seed`, default
`42`). The same seed always produces a byte-identical on-disk tree —
`generate-test-data.ts` mints every id (entries, the six diaries) from the
seeded stream, and every generated image gets independent per-pixel noise
from that same stream, so no two blobs collide on sha256 even though the
gradient/shape content repeats across images.

Every yjs doc is also built with a *deterministic clientID* derived from
its entry id (`lib/ids.ts`'s `clientIdFrom`), so re-running the importer
against the same server reproduces byte-identical updates — reapplying an
already-seen yjs update is a no-op, so `import-test-data.ts` is safe to
re-run.

## fresh db after regenerating

That idempotency has a sharp edge: if you regenerate the tree with the
*same* seed but change the generator (different text, different photo
counts, etc.), the entries keep the same ids and clientIDs but now carry
different content. Re-importing them into a server that already has the
old versions does **not** update anything — same clientID + clock range
with different content is exactly what yjs treats as "already seen" and
skips. Always start the server against a fresh `DAYZERO_DB_PATH` after
regenerating:

```sh
nix develop -c tools/run-test-server.sh /path/to/a-new-db.sqlite
```

## other flags

- `generate-test-data.ts --out <dir> --seed <n> --entries <n> --streak <n> --images <n>`
  — targets, not exact counts; the generator self-checks that actual totals
  land within ±10% and that the computed streak matches exactly, and
  aborts loudly otherwise. Refuses to overwrite a non-empty `--out` unless
  it contains a `manifest.json` from a prior run (then wipes and
  regenerates).
- `import-test-data.ts` / `verify-import.ts --data <dir> --server <url> --token <t>`
  — `--server`/`--token` fall back to `DAYZERO_SERVER_URL`/`DAYZERO_AUTH_TOKEN`.
