# test data generation — findings

Implementation report for `TESTGEN-PLAN.md`. All eight steps were built and
verified end-to-end against a real `dayzero-server` and the real app; see
`tools/README.md` for the operator-facing quickstart.

## what was built

- `tools/lib/` — `rng.ts` (mulberry32 + `int`/`pick`/`weighted`/`chance`/`bytes`/`shuffle`),
  `ids.ts` (seeded uuidv7, `uuidFromHash`, `clientIdFrom`), `yjs-entry.ts`
  (`buildEntryUpdate`/`buildDiaryUpdate`, unit-tested), `materialize.ts` +
  `streak.ts` (ports of the app's originals), `frontmatter.ts`, plus
  generator-internal `vocab.ts` / `text-gen.ts` / `image-gen.ts` (not in the
  plan's four-program list, added for readability — pure data/logic, no
  server or on-disk-format knowledge, so they don't break the layering).
- `tools/dayzero-cli.ts` — single-item `health` / `diary create` /
  `blob push` / `entry create` commands.
- `tools/generate-test-data.ts` — writes the markdown tree + `manifest.json`.
- `tools/import-test-data.ts` — walks the tree, drives the cli as a
  subprocess per item.
- `tools/verify-import.ts` — pulls the change log, re-materializes, diffs
  against the manifest.
- `tools/run-test-server.sh`, `tools/deno.json` (with matching `fmt` config:
  tabs + single quotes, matching `app/prettier.config.js`), `tools/README.md`.

## end-to-end run (default params: 4000 entries / 2500-day streak / 3000 images)

**Generate** — `deno task generate`, seed 42: 138 MB on disk (114.5 MB
apparent content, the rest is filesystem block overhead from ~7,170 small
files), 3,907 `.md` files, 3,264 JPEGs averaging ~33 KB (target was 30–60
KB). Self-checks passed: 4,125 total entries (target 4,000, within ±10%),
3,264 photos (target 3,000, within ±10%), streak computed as exactly 2,500.
Determinism confirmed: two runs with the same seed produced byte-identical
trees (`diff -r` on a smaller 40-entry/10-day-streak run — same entry/photo
counts, same bytes). Wipe-safety guardrail confirmed both ways: refuses to
touch a non-empty directory with no `manifest.json` (exit 1, directory
untouched), wipes and regenerates one that has one.

**Import** — `deno task import` against a fresh server: 4,125 entries created,
218 of them photo-only, 3,264 blobs pushed, 6 diaries created, in 443s
(~7.4 minutes — comfortably inside the plan's 10–25 minute estimate).
Re-running the same import was confirmed idempotent (second pass produced
identical `distinct docs: 29` for a 20-day-folder slice, no duplicated text
in the materialized entries).

**Verify** — `deno task verify`: **ALL PASS** on every field — 6/6 diaries
(id + name), totalEntries, photoOnlyEntries, totalPhotos, distinctLocations,
streak, per-diary entry counts (all 6 created diaries + `default`), all 40
tags' counts, blob distinct-hash count, and a 25-blob spot-check (all 200s,
non-empty bodies).

**App check** — browser-driven (headless Chromium + playwright-core) against
the real SvelteKit app, synced against the imported data:

| check | result |
|---|---|
| streak | shows "2500 days" |
| calendar | current month's days-so-far (Aug 1–7) all marked, future days correctly blank |
| list view | markdown previews + month/day grouping render correctly |
| map | Amsterdam cluster + dots across all 12 trip cities (Reykjavik, Bergen, Berlin/Prague/Vienna/Ljubljana cluster, Lisbon, Barcelona, Marrakech, Rome, New York, Kyoto) |
| tags page | exactly 40 tags, counts matching `verify-import.ts` exactly |
| "on this day" | 8 hits across 6 distinct years (2020–2025) |
| photo-only entries | render correctly via the photo lightbox; `/photos` grid shows exactly 3,264 items |

One methodological note: early browser-automation attempts produced false
negatives (0 tags found, pages stuck on "loading…") that looked like app
bugs but weren't — they were caused by the test script's own full-page
`goto()` reloads racing the sqlite-wasm/OPFS worker's async teardown
(`NoModificationAllowedError: ... Access Handles cannot be created if there
is another open Access Handle`), and by clicking through pages faster than
the client-side router could settle. Switching to in-app nav-link clicks
(client-side routing) plus polling for the "loading…" text to clear (rather
than fixed sleeps) resolved all of it — a single clean `page.goto('/tags')`
right after sync settled loaded in 10s and found all 40 tags. Worth knowing
if this app is browser-tested again with a dataset this size: give it real
completion signals, not fixed timeouts, and avoid rapid full-page reloads
right after a large sync.

## bugs found and fixed (in `tools/`, not `app/` or `server/`)

1. **Negative-longitude arg parsing (real bug, would have silently corrupted
   data).** `dayzero-cli.ts` used `@std/cli`'s `parseArgs` (minimist-style),
   which misreads `--lng -9.1393` as the short-flag combo `-9` with value
   `.1393` — `--lng`'s actual value is dropped entirely, silently. This
   would have broken the location for every entry in Lisbon, New York,
   Reykjavik, or Marrakech (all negative-longitude trip cities) — caught
   while smoke-testing the CLI directly in step 3, before any data was
   generated. Fixed by rewriting `--flag -N` to `--flag=-N` before handing
   argv to `parseArgs` (`normalizeNegativeNumberArgs` in `dayzero-cli.ts`).

2. **Word-bank grammar bug in the text generator.** Some `{weather}` bank
   entries carried their own article (`'a warm breeze'`, `'the first
   snow'`), but every template using `{weather}` also prepends its own
   article (`"The {weather} made everything feel..."`), producing "The a
   warm breeze made everything feel...". Same issue for `{daypart}`, which
   mixed bare nouns (`'morning'`) with prepositional phrases (`'before
   work'`), breaking `"the {daypart}"` templates ("the before work"). Fixed
   by making both banks pure bare-noun phrases with no embedded articles.

3. **`tools/deno.json`'s `import` task was missing `--allow-write`** (the
   plan's own spec for it) — `import-test-data.ts` needs it for
   `Deno.makeTempDir`/writing scratch text files. Added.

4. **A real `deno check` type error**, unrelated to the above: `Uint8Array`
   from `Deno.readFile()` is typed `Uint8Array<ArrayBufferLike>`, which a
   newer TypeScript lib no longer accepts where `crypto.subtle.digest`
   wants `BufferSource` (excludes `SharedArrayBuffer`-backed views). Never
   a runtime problem (Deno's `Uint8Array` is never actually
   `SharedArrayBuffer`-backed here), but `deno check` failed. Fixed by
   copying into a fresh `Uint8Array` before hashing in `dayzero-cli.ts`'s
   `sha256Hex`.

5. **A stray inline `jsr:` import** in `lib/yjs-entry.test.ts` tripped
   `deno lint`'s `no-import-prefix` rule. Moved `@std/assert` into
   `deno.json`'s import map.

All of `deno fmt --check`, `deno lint`, `deno check *.ts lib/*.ts`, and
`deno test` are clean as of this writing.

## caveats for next time

- The pre-streak era is a fixed 1,500 days regardless of `--streak`, so
  even a tiny `--entries`/`--streak`/`--images` smoke-test run still walks
  1,500+ days and generates a proportional number of images — there's no
  fast/small mode for iterating on the generator itself. A 40-entry,
  10-day-streak run still took long enough that quick iteration means
  watching for the self-check FAILs (expected at that scale) rather than
  actually hitting the targets.
- Image generation is the dominant cost (~70-100ms/image on this machine),
  so a full `deno task generate` run is a genuine 5-8 minute wait, and a
  full `deno task import` is ~7-8 minutes here (plan estimated up to 25).
- The dataset currently sitting in `test-data/` and the running test
  server's db (`test-data-server.sqlite`, gitignored) reflect this run's
  seed-42 output as of 2026-08-07. Per the plan's own caveat, the app's
  streak will only read as 2500 on the day the data was generated —
  regenerate + reimport to a fresh db before demoing on a later date.
