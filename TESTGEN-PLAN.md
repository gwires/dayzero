# test data generation — implementation plan

Build a realistic, deterministic test dataset for dayzero (~4000 entries, a
2500-day streak, 7 diaries, ~40 tags, ~100 locations, ~3000 photos) plus the
tooling to import it into a running dayzero-server: a generator that writes a
markdown-on-disk tree, a `dayzero-cli` that pushes single items to the server,
an import driver that walks the tree and drives the cli, and a verifier that
pulls everything back and checks it.

This plan is decision-complete: follow it step by step, in order, without
re-deciding the design. Read `docs/protocol.md` fully and skim PLAN.md
("entries as CRDTs", "sync", "multiple diaries") first for background.

## design (already decided — do not revisit)

- **Everything is deno**, in a new top-level `tools/` directory. No zig, no
  python, no additions to `app/package.json`. Deno is added to the flake dev
  shell. Dependencies come in via `npm:`/`jsr:` specifiers in
  `tools/deno.json`.
- **The server stores opaque yjs updates** (`docs/protocol.md`), so "import"
  means: construct each entry as a real Y.Doc with the real `npm:yjs` package
  (same major as the app's, `^13.6`), encode it with
  `Y.encodeStateAsUpdate`, base64 it, and `POST /api/changes`. Photos are raw
  bytes to `PUT /api/blobs/<sha256>`. **No server changes, no app changes.**
- **Four programs, strict layering**:
  - `tools/generate-test-data.ts` — writes the on-disk tree + `manifest.json`.
    Knows nothing about the server.
  - `tools/dayzero-cli.ts` — single-item operations against the server
    (health / diary create / blob push / entry create). Knows nothing about
    the on-disk format or the markdown frontmatter.
  - `tools/import-test-data.ts` — parses the tree and shells out to
    `dayzero-cli` once per item.
  - `tools/verify-import.ts` — pulls the whole change log back with yjs,
    re-materializes, and compares against `manifest.json`.
- **Determinism everywhere**: one integer seed drives a local PRNG
  (mulberry32); the same seed must produce a bit-identical tree. Entry ids
  are uuidv7s minted by the generator (from the seeded PRNG, backdated to the
  entry's timestamp) and stored in frontmatter — the importer never invents
  ids for `.md` entries.
- **Idempotent import**: every Y.Doc is built with a *deterministic
  clientID* derived from its entry id, so re-running the importer produces
  byte-identical updates, and re-applying an identical yjs update is a no-op.
  (Without this, each re-run would mint a fresh random clientID and a second
  import would *duplicate all text* on merge.)
- **Days with an image but no `.md` entry become photo-only entries**: the
  importer creates an entry with empty text and the photo attached — a real
  app state, and the day still counts toward the streak.
- **Markdown image links are stripped on import.** On disk,
  `![](imageN.jpg)` lines associate images with an entry; the app stores
  photos in the doc's `photos` map and cannot resolve relative links, so the
  importer removes those lines from the text and turns them into
  attachments.

## guardrails

- **Do not touch `app/` or `server/`** (except reading them), and do not
  change `docs/protocol.md`'s wire format. The only edits outside `tools/`
  are: `flake.nix` (add deno), the repo `.gitignore`, and this plan's
  checkboxes if you keep notes.
- **Never commit `test-data/`** — add `/test-data/` and `tools/node_modules/`
  to the repo `.gitignore` (create the file if it doesn't exist) in step 1,
  before generating anything. Commit `tools/deno.lock` when it appears.
- Disk fills up fast in this environment: keep generated JPEGs small
  (target 30–60 KB each, ~120 MB total). Never generate into `/tmp`.
- The generator must **refuse to overwrite an existing output directory
  unless** it is empty or contains a `manifest.json` (i.e. it was produced by
  a previous run) — then it wipes and regenerates.
- **Changed data must go to a fresh server db.** Re-importing *edited*
  entries under the same ids will be silently ignored (same clientID + clock
  with different content — yjs skips already-seen ranges). To re-import after
  regenerating, start the server with a new `DAYZERO_DB_PATH`.
- Run every shell command through the dev shell: `nix develop -c <command>`.
- All dates/times are UTC. `entry_date` is always `YYYY-MM-DD`; the app has
  no time-of-day concept (frontmatter `time` only feeds realism + uuidv7).
- Fail fast: any non-200 response or parse error aborts the run with a
  nonzero exit and a message naming the item that failed.

## background — what an entry is on the wire

An entry is a Y.Doc, doc id = entry id (a uuidv7 string). Its shape (see
`app/src/lib/entries/ydoc.ts`, and `createEntry`/`applyEdits` in
`app/src/lib/entries/store.ts`, which the cli must mirror exactly):

- `doc.getText('text')` — the markdown body.
- `doc.getMap('meta')` — keys: `deleted` (boolean, always set, `false` on
  create), `entry_date` (`'YYYY-MM-DD'`, always set), `diary_id` (always
  set; `'default'` for the default diary), `location_lat` (number),
  `location_lng` (number), `location_name` (string) — the three location
  keys are set **only when a location exists** (never set to null).
- `doc.getMap('tags')` — each tag name → `true`.
- `doc.getMap('photos')` — sha256 hex of the blob →
  `{ mime: string, width: number, height: number }`.

The diary registry is one well-known Y.Doc with the reserved doc id
`_diaries` (see `app/src/lib/diaries/ydoc.ts`): `doc.getMap('diaries')` maps
diary id → `{ name }`. The default diary (id `'default'`, name `journal`) is
virtual — never stored, never created.

Server API (`docs/protocol.md`): bearer token auth on everything except
`GET /api/health`; `POST /api/changes` with
`{"changes":[{"entry_id":"...","update":"<base64>"}]}`; raw bytes to
`PUT /api/blobs/<sha256hex>`; `GET /api/changes?since=<seq>&limit=<n>`
(limit capped at 2000) returning `{changes, cursor}` for the verifier.
Server env: `DAYZERO_AUTH_TOKEN` (required), `DAYZERO_PORT` (default 8080),
`DAYZERO_ADDRESS`, `DAYZERO_DB_PATH`.

## step 0 — flake: add deno

Add `pkgs.deno` to the `packages` list in `flake.nix`'s dev shell.

Done when: `nix develop -c deno --version` prints deno 2.x.

## step 1 — scaffolding

Create:

- Repo `.gitignore` (or extend it): add `/test-data/` and
  `tools/node_modules/`.
- `tools/deno.json`:

```json
{
	"tasks": {
		"generate": "deno run --allow-read --allow-write generate-test-data.ts",
		"import": "deno run --allow-read --allow-net --allow-env --allow-run import-test-data.ts",
		"verify": "deno run --allow-read --allow-net --allow-env verify-import.ts"
	},
	"imports": {
		"yjs": "npm:yjs@^13.6.27",
		"jpeg-js": "npm:jpeg-js@^0.4.4",
		"@std/yaml": "jsr:@std/yaml@^1"
	}
}
```

- `tools/run-test-server.sh` — mirrors `server/test-e2e-sync.sh`'s server
  half: `zig build` in `server/`, then exec `dayzero-server` in the
  foreground with `DAYZERO_AUTH_TOKEN=testgen-token`,
  `DAYZERO_PORT=18200`, `DAYZERO_ADDRESS=127.0.0.1`, and
  `DAYZERO_DB_PATH=${1:-$repo_root/test-data-server.sqlite}` (also add
  `/test-data-server.sqlite*` to `.gitignore`). Print the URL and token
  before exec'ing so a human can copy them into the app's settings page.

Done when: `nix develop -c tools/run-test-server.sh` starts a server that
answers `curl http://127.0.0.1:18200/api/health` with `{"status":"ok"}`.

## step 2 — shared library: `tools/lib/`

Small, dependency-light modules; everything downstream imports from here.

### `tools/lib/rng.ts`

Mulberry32, exactly this core, plus helpers:

```ts
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
```

Helpers (all take the rng function): `int(rng, min, max)` inclusive;
`pick(rng, arr)`; `weighted(rng, [[value, weight], ...])`;
`chance(rng, p)`; `bytes(rng, n)` (Uint8Array of `int(rng,0,255)`).

### `tools/lib/ids.ts`

Hand-rolled uuidv7 (do **not** depend on `npm:uuid` — hand-rolling keeps it
seedable and removes API-version doubt). Layout: 48-bit big-endian unix
milliseconds, then version nibble `7`, then 12 random bits, then variant
bits `10`, then 62 random bits — random bits from `bytes(rng, 10)`. Format
as lowercase `8-4-4-4-12` hex.

Also:
- `uuidFromHash(input: string)` — sha256 the input
  (`crypto.subtle.digest`), take the first 16 bytes, force version nibble to
  `4` and variant to `10`, format as uuid. Used for deterministic photo-only
  entry ids.
- `clientIdFrom(id: string)` — first 4 bytes of sha256(id) as a u32. Used
  as the deterministic Y.Doc clientID.

### `tools/lib/yjs-entry.ts`

The one place yjs docs are constructed. Mirror
`createEntry`/`applyEdits` from `app/src/lib/entries/store.ts` exactly:

```ts
import * as Y from 'yjs';

export interface EntryFields {
	id: string;
	entryDate: string; // YYYY-MM-DD
	diaryId: string; // 'default' when unset
	markdown: string; // '' for photo-only entries
	tags: string[];
	location?: { name: string; lat: number; lng: number };
	photos: { hash: string; mime: string; width: number; height: number }[];
}

export async function buildEntryUpdate(f: EntryFields): Promise<Uint8Array> {
	const doc = new Y.Doc();
	doc.clientID = await clientIdFrom(f.id); // determinism — see plan design
	doc.transact(() => {
		const meta = doc.getMap('meta');
		meta.set('deleted', false);
		meta.set('entry_date', f.entryDate);
		meta.set('diary_id', f.diaryId);
		if (f.location) {
			meta.set('location_lat', f.location.lat);
			meta.set('location_lng', f.location.lng);
			meta.set('location_name', f.location.name);
		}
		if (f.markdown !== '') doc.getText('text').insert(0, f.markdown);
		for (const tag of f.tags) doc.getMap('tags').set(tag, true);
		for (const p of f.photos)
			doc.getMap('photos').set(p.hash, { mime: p.mime, width: p.width, height: p.height });
	});
	return Y.encodeStateAsUpdate(doc);
}
```

Plus `buildDiaryUpdate(diaryId, name)`: fresh doc, clientID
`clientIdFrom('_diaries:' + diaryId)`, `doc.getMap('diaries').set(diaryId,
{ name })`, encode. (Six diaries → six updates from six distinct clientIDs
setting six distinct keys; they merge cleanly on the `_diaries` doc.)

Unit-test this file (`deno test`): build an update, apply it to a fresh
`Y.Doc` with `Y.applyUpdate`, and assert every field reads back; assert two
builds of the same fields are byte-identical; assert applying the same
update twice equals applying it once.

### `tools/lib/materialize.ts` and `tools/lib/streak.ts`

Ports (copy the ~40 lines each, do not import across the app's `$lib`
aliases) of `app/src/lib/entries/materialize.ts` and
`app/src/lib/entries/streak.ts`. Used only by the verifier. Keep the
semantics identical: missing `diary_id` → `'default'`, `deleted` truthy →
excluded, tags filtered to value `=== true`, streak walks back from the
reference date (or the day before it).

### `tools/lib/frontmatter.ts`

`splitFrontmatter(md: string): { fm: string; body: string }` — the file must
start with a `---\n` line; take everything up to the next line that is
exactly `---`; the body is everything after it, trimmed of one leading blank
line. Parse `fm` with `@std/yaml`'s `parse`. No `@std/front-matter`
dependency — the split is four lines of code.

## step 3 — `tools/dayzero-cli.ts`

Single-item commands, JSON on stdout, exit 0/1. Connection config:
`--server <url>` / `--token <t>` flags, falling back to env
`DAYZERO_SERVER_URL` / `DAYZERO_AUTH_TOKEN`; missing either → error. All
requests send `Authorization: Bearer <token>`.

Commands:

- `dayzero-cli health` — `GET /api/health` (no auth needed, send it anyway);
  prints the response body.
- `dayzero-cli diary create --id <uuid> --name <name>` —
  `buildDiaryUpdate`, base64 (use `Uint8Array` → `btoa` via a chunked
  helper or `encodeBase64` from `jsr:@std/encoding` — pick one and use it
  everywhere), `POST /api/changes` with `entry_id: "_diaries"`. Prints
  `{"id": "...", "name": "..."}`.
- `dayzero-cli blob push <file>` — read bytes, sha256 → lowercase hex,
  `PUT /api/blobs/<hash>` with the raw bytes as body. Prints
  `{"hash": "...", "bytes": <n>}`. (Re-uploading an existing blob is a
  server-side no-op — always safe.)
- `dayzero-cli entry create --id <uuid> --date <YYYY-MM-DD>
  [--diary <diary-id>] [--text-file <path>] [--tag <t>]...
  [--location-name <s> --lat <f> --lng <f>] [--photo <hash>:<mime>:<WxH>]...`
  — assembles `EntryFields` (diary defaults to `default`, missing
  `--text-file` means empty text; `--photo` splits on `:` into hash, mime,
  and `WxH`), `buildEntryUpdate`, POST as above. The three location flags
  must appear together or not at all. Prints `{"id": "...", "bytes": <n>}`.

Parse args by hand or with `parseArgs` from `jsr:@std/cli` (if used, add it
to the imports map). Any HTTP status other than 200 → print the status and
body to stderr, exit 1.

Done when: against a `run-test-server.sh` server you can create a diary and
an entry with two tags + a location + a pushed blob referenced as a photo,
then pull `GET /api/changes?since=0` with a five-line deno scratch script,
`Y.applyUpdate` each change, and read every field back correctly.

## step 4 — `tools/generate-test-data.ts`

Flags (all optional): `--out <dir>` (default `test-data` at the repo root),
`--seed <int>` (default `42`), `--entries 4000 --streak 2500 --images 3000`
(targets, not exact counts). Wipe-safety per the guardrail above.

### fixed vocabulary (bake these lists into the file)

- **Diaries** (7): `default`/`journal` (virtual — never created), plus six
  created ones named `work`, `travel`, `dreams`, `fitness`, `cooking`,
  `projects`. Mint the six ids with the seeded uuidv7 (timestamp: streak
  start day 08:00Z) so the same seed always yields the same ids.
- **Tags** (40): gratitude, family, friends, work, meeting, deadline, run,
  gym, yoga, cycling, hike, recipe, baking, dinner, coffee, book, movie,
  music, garden, weather, dream, lucid, insomnia, travel, flight, hotel,
  beach, museum, photography, project, sideproject, code, learning, health,
  doctor, mood, anxiety, celebration, birthday, holiday. Global popularity
  weight of the tag at (1-based) rank r is `1 / r ** 0.8`. Each diary gets
  an affinity list of 5–8 of these (work → work/meeting/deadline/code/...,
  fitness → run/gym/yoga/cycling/..., dreams → dream/lucid/insomnia/...,
  cooking → recipe/baking/dinner/coffee, travel →
  travel/flight/hotel/beach/museum/photography, journal and projects get
  broader mixes — write the lists out).
- **Home locations** (~20, Amsterdam-ish, fixed coords you write out):
  `Home` (52.3702, 4.8952), `Office` (52.3676, 4.9041), plus ~18 named city
  spots (cafés, parks, gym, market, library, …) around 52.3–52.4 / 4.8–4.95.
- **Trips** (12): destination cities with center coords — Lisbon, Kyoto,
  New York, Bergen, Rome, Barcelona, Berlin, Prague, Reykjavik, Vienna,
  Marrakech, Ljubljana. Each trip generates 5–8 POI locations named
  `"<City> — <poi>"` with poi drawn from [old town, harbour, market,
  museum, café, viewpoint, park, station], coords = center + uniform
  jitter of ±0.02°. ~20 home + ~80 trip POIs ≈ 100 locations total.
- **Image palette**: 12 pleasant hex colors (write them out).

### calendar plan

- `generatedOn` = today's UTC date. Streak days: `generatedOn - (streak-1)`
  … `generatedOn`, every one gets ≥1 entry. Pre-streak era: the 1500 days
  before that (total span ≈ 11 years).
- Place the 12 trips at non-overlapping random starts across the whole
  span, each 4–14 consecutive days.
- Per streak day, entry count: 1 (76%), 2 (18%), 3 (5%), 4 (1%). Also,
  3% of streak days additionally get one *orphan* image (no md references
  it → becomes a photo-only entry on import).
- Per pre-streak day: nothing at all — no folder — (62%), entry day (30%;
  1 entry 70% / 2 entries 30%), image-only day (8%; 1–2 orphan images, no
  `.md`).
- These knobs land at ≈ 4050 entries (photo-only included) and ≈ 3000
  images; assert at the end that actual totals are within ±10% of the
  `--entries` / `--images` targets and that the streak computed from the
  generated days (via `lib/streak.ts`, reference `generatedOn`) is exactly
  the `--streak` value — abort loudly otherwise.

### per-entry assignment

- **Diary**: on a trip day, `travel` with p=0.5, else the normal table.
  Normal table: journal 0.55, work 0.16, fitness 0.08, dreams 0.07,
  cooking 0.06, projects 0.04, travel 0.04; a `work` draw on a weekend
  rerolls as journal. A `dreams` entry becomes the day's first entry.
- **Time of day** (drives uuidv7 + frontmatter `time`, jittered): dreams
  ~07:15±45m, fitness ~12:00±4h, work ~17:40±90m, cooking ~19:00±90m,
  journal/projects/travel ~21:30±90m. Sort a day's entries by time and
  number `entry1.md`, `entry2.md`, … in that order.
- **Tags**: count 0 (25%), 1 (35%), 2 (25%), 3 (10%), 4 (5%); each drawn
  from the diary's affinity list (70%) or the global rank-weighted pool
  (30%), deduped.
- **Location**: present on 65% of entries. work → `Office` 80% / city spot
  20%; trip-day entries → one of that trip's POIs; otherwise `Home` 45%,
  else a city spot (rank-weighted by list order).
- **Photos per entry**: 0 (55%), 1 (27%), 2 (11%), 3 (5%), 4 (2%); on trip
  days shift to 0 (25%), 1 (40%), 2 (20%), 3 (10%), 4 (5%).
- **Entry id**: seeded uuidv7 with the entry's timestamp.

### text generation

4–8 paragraphs of 3–6 sentences. Build a template engine: sentence
templates with `{slot}`s filled from word banks (`{activity}`, `{place}`,
`{person}`, `{feeling}`, `{food}`, `{weather}`, `{object}`), e.g.
`"Went for a {activity} with {person} this {daypart}."`,
`"The {weather} made everything feel {feeling}."`,
`"Finally finished {object} — {feeling} about how it turned out."` — write
≥15 templates per register (generic + one small set per diary for opening
sentences) and banks of ≥8 words each, in this style. About 10% of entries
get one markdown feature: a `## heading` before a paragraph, a bullet list
of 3–5 items, a `**bold**` phrase, or a `> blockquote` line. No lorem
ipsum. Quality bar: plausible-at-a-glance filler, not literature.

### images

Procedural JPEG via `jpeg-js` (`encode({ data, width, height }, 65)`; data
is RGBA; under deno, wrap in `Buffer.from` from `node:buffer` if jpeg-js
rejects a plain Uint8Array). Dimensions per image drawn from
[800×600, 600×800, 640×640, 1024×768]. Content: vertical gradient between
two palette colors, then 3–8 filled circles/rectangles in other palette
colors, then ±6 per-channel uniform noise on every pixel — the noise (with
the image's own draw order in the rng stream) guarantees no two images are
byte-identical, so no two blobs share a sha256. Target 30–60 KB each; if a
sample comes out larger, lower quality toward 55.

### on-disk layout (exactly the sketch's format)

```
test-data/
  manifest.json
  2017/03/07/            ← zero-padded month/day, folder only if content
    entry1.md
    entry2.md
    image1.jpg           ← numbered per day; each referenced by ≤1 entry
    image2.jpg           ←   or by none (orphan → photo-only entry)
```

Entry file — yaml frontmatter, then the body; image links sit on their own
line between paragraphs of the owning entry:

```markdown
---
id: 01890a5d-ac96-774b-bcce-b302099a8057
time: 2024-03-14T19:23:41Z
diary: travel
tags: [travel, photography]
location:
  name: Lisbon — old town
  lat: 38.7223
  lng: -9.1393
---

First paragraph…

![](image1.jpg)

Second paragraph…
```

`diary:` is omitted for the default diary; `tags:` omitted when empty;
`location:` omitted when absent.

### manifest.json

```ts
interface Manifest {
	seed: number;
	generatedOn: string; // YYYY-MM-DD, streak reference date
	diaries: { id: string; name: string }[]; // the six created ones only
	expected: {
		totalEntries: number; // md entries + future photo-only entries
		photoOnlyEntries: number;
		entriesPerDiary: Record<string, number>; // by diary id, incl. 'default'
		tagCounts: Record<string, number>;
		totalPhotos: number; // every generated image ends up attached
		distinctLocations: number;
		streak: number;
	};
	images: Record<string, { width: number; height: number }>; // '2024/03/14/image1.jpg'
}
```

Count `expected` from what was actually written (photo-only entries counted
under diary `default`). Finish by printing a summary table and running the
self-checks listed under "calendar plan".

Done when: `deno task generate` (in `tools/`) produces the tree in ~a
minute-or-two-scale runtime; running it twice with the same seed produces
identical output (`diff -r` two runs into scratch dirs); the self-checks
pass; total size is ~130 MB or less.

## step 5 — `tools/import-test-data.ts`

Flags: `--data <dir>` (default `test-data`), `--server`/`--token` (same env
fallbacks as the cli), `--limit <n>` (import only the first n day-folders,
ascending — for smoke tests).

The driver never constructs yjs docs itself — it only spawns the cli
(`new Deno.Command(Deno.execPath(), { args: ['run', '--allow-net',
'--allow-read', '--allow-env', cliPath, ...cmdArgs] })`), checking the exit
code of every invocation.

Order of operations:

1. `health` — abort if the server isn't reachable.
2. Read `manifest.json`; for each of the six diaries:
   `diary create --id … --name …`.
3. Walk day folders in ascending date order. Per folder:
   - Parse each `entryN.md` with `lib/frontmatter.ts`.
   - Extract image references with `/^!\[[^\]]*\]\(([^)]+)\)$/gm` — collect
     the filenames, then strip those whole lines from the body (collapse the
     resulting double blank lines) and write the remaining body to a temp
     file under the session scratchpad for `--text-file`.
   - For each referenced image: `blob push <abs path>` and parse the
     printed hash (cache path→hash in memory; identical re-pushes are
     harmless anyway). Look up width/height in `manifest.images` (mime is
     always `image/jpeg`); missing manifest entry → hard error.
   - `entry create` with the frontmatter id/date (date comes from the
     folder path; assert the frontmatter `time` agrees), diary id resolved
     through the manifest by name (absent `diary:` → omit `--diary`), tags,
     location, and the `--photo hash:image/jpeg:WxH` specs.
   - Images in the folder referenced by no entry: `blob push`, then
     `entry create` with id `uuidFromHash(relpath)`, the folder's date, no
     text/tags/location, and the single photo. (Photo-only entries.)
4. Print progress every 100 days and a final summary (diaries, entries,
   photo-only entries, blobs pushed, elapsed).

Expected full-run duration: ~7000 cli subprocess spawns ≈ 10–25 minutes.
Use `--limit 20` while iterating.

Done when: against a fresh server, `--limit 20` completes cleanly, running
it a second time is a no-op server-side (pull the log: applying everything
still yields the same materialized entries, no duplicated text), and then a
full run completes cleanly.

## step 6 — `tools/verify-import.ts`

Flags: `--data <dir>` (for the manifest), `--server`/`--token`.

1. Pull the entire log: `GET /api/changes?since=<cursor>&limit=2000` until a
   page comes back shorter than requested.
2. Group changes by `entry_id`. `_diaries` → apply onto one registry doc;
   every other id → apply onto that entry's doc (`Y.applyUpdate`).
3. Materialize every entry with `lib/materialize.ts` and compute:
   total non-deleted entries; photo-only count (empty markdown + ≥1 photo);
   per-diary counts; tag counts; total photo references; distinct
   location names; streak via `lib/streak.ts` with reference date
   `manifest.generatedOn` (not "now" — verification may run days later).
4. Registry check: the six diaries exist with the manifest's ids and names.
5. Blob check: assert the set of referenced photo hashes has size
   `expected.totalPhotos`… minus nothing — every image is attached exactly
   once, so `sizeof(hash set) === expected.totalPhotos`. Then GET 25
   seeded-random hashes from the set and assert 200 with a non-empty body.
6. Print a PASS/FAIL table comparing every `expected.*` field; exit 1 on
   any mismatch.

Done when: after step 5's full import, `deno task verify` prints all-PASS.

## step 7 — end-to-end run + app check

1. Fresh server: `nix develop -c tools/run-test-server.sh` (in the
   background, fresh db path).
2. `cd tools && deno task generate && deno task import --server
   http://127.0.0.1:18200 --token testgen-token && deno task verify …`.
3. App: run `npm run dev` in `app/`, open it, enter the server url + token
   in `/settings`, let it sync (it will pull ~4050 doc updates in pages of
   500 and then fetch blobs — this takes a while; that load is part of the
   point). Check by hand: streak shows 2500, the calendar's recent months
   are fully dotted, the list view shows photos and markdown, the map shows
   Amsterdam clusters plus the 12 trip cities, tags page shows ~40 tags,
   "on this day" has hits across ~11 years, and photo-only entries render.
   Leave the dev server running afterwards.
4. Note: the app computes the streak against *its* today — if the dataset
   is more than one day old, regenerate + reimport to a fresh db before
   demoing the streak.

## step 8 — docs

`tools/README.md`: one paragraph per tool, the three `deno task` commands,
the run-test-server recipe, the seed/determinism story, and the "fresh db
after regenerating" caveat. Add a line to the repo `README.md`'s relevant
section pointing at it, if the README lists tooling.
