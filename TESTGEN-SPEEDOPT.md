# app speed observations from testgen verification

While testing the app against the generated dataset (4,125 entries, 3,264
photos, see `TESTGEN-FINDINGS.md`), a few real client-side performance
patterns turned up. These are observations about `app/`, not something this
session changed — `tools/` isn't allowed to touch `app/` per
`TESTGEN-PLAN.md`'s guardrails, so these are handed off rather than fixed.
Each is grounded in the actual code, not just "it felt slow."

## 1. blob fetching during sync is fully sequential — the biggest one

`app/src/lib/sync/blobs.ts`, `fetchMissingBlobs`:

```ts
for (const item of wanted) {
	if (have.has(item.hash) || seen.has(item.hash)) continue;
	seen.add(item.hash);
	const bytes = await getBlob(cfg, item.hash);       // one HTTP GET…
	await db.exec({ sql: `insert into attachments ...` }); // …then one db write, awaited in turn
}
```

And the caller, `app/src/lib/sync/engine.ts`'s `pull()`, awaits this once
*per changed entry* inside the page loop — so across a large sync, every
single photo is: fetched, then written, one at a time, with nothing else
happening concurrently. With 3,264 photos this is 3,264 serialized
round-trips. It's very likely the dominant cost of the multi-minute sync
observed in testing (the CLI-driven import — a different, subprocess-based
path — pushed the same volume in 7.4 minutes; the in-app sync, doing this
sequential fetch-then-write dance, took noticeably longer for the same
data).

**Suggested fix**: fetch blobs with bounded concurrency (e.g. 8-16 at once
via a small worker-pool `Promise.all`), and/or batch the `insert into
attachments` calls instead of one `db.exec` per blob. `pushPendingBlobs` in
the same file has the identical one-at-a-time pattern for the upload
direction and would benefit the same way.

## 2. one DB round-trip per photo thumbnail, fired all at once, no virtualization

`app/src/lib/ui/PhotoGridItem.svelte` and `EntryThumb.svelte` both do:

```ts
onMount(async () => {
	url = await getAttachmentUrl(photo.hash); // → app/src/lib/entries/store.ts
});
```

`getAttachmentUrl` runs its own `select bytes, mime from attachments where
id = ?` per call — one sqlite-worker round-trip per thumbnail, no batching
across the ones a page is about to render. `/photos` mounts one
`PhotoGridItem` per photo with **no lazy-loading based on scroll
position** — visiting `/photos` with this dataset means all 3,264 of these
fire close to simultaneously on mount. This is a likely reason `/photos`
was the slowest page to clear "loading…" in testing (once past the
`listAllPhotos()` query itself, which is fast — see the "not a problem"
section below).

**Suggested fix**: either batch-fetch bytes for the visible page's hashes
in one query (`where id in (...)`, mirroring the existing pattern in
`fetchMissingBlobs`'s "which do we already have" check), or — better for a
photo grid at this scale — lazy-load thumbnails with an `IntersectionObserver`
so only on/near-viewport items fetch bytes at all.

## 3. no pagination on the list view — every entry mounts at once

`app/src/routes/+page.svelte` calls `listEntries({ tag, date, diaryId })`
with no `LIMIT`, and `app/src/lib/entries/store.ts`'s `listEntries` has none
either — the query returns every non-deleted entry unconditionally. On this
dataset that's 4,125 `<a class="entry-card">` elements mounted in one page,
each running its own `MarkdownPreview` render and (for the ~45% with a
photo) its own `EntryThumb` → `getAttachmentUrl` round-trip per **item #2**
above. It rendered correctly in testing, but this scales linearly with
total entry count with no ceiling — a multi-year-old real account would
keep growing this same unpaginated DOM tree and query result set.

**Suggested fix**: paginate or virtualize the list (infinite-scroll with a
`LIMIT`/`OFFSET` or keyset-paginated query would be the natural fit given
entries are already fetched sorted by `entry_date desc, updated_at desc`).

## checked and *not* found to be a problem

For balance — these were the other plausible suspects, and code inspection
plus a clean browser run ruled them out:

- **`/tags` and `/calendar` query performance**: `listTags()` joins
  `entry_tags` to `entries` and groups by tag; `entry_tags`'s composite
  primary key `(entry_id, tag)` and the separate `entry_tags_tag` index
  cover the relevant access patterns. A clean, isolated run (single
  `goto('/tags')` right after sync genuinely finished) loaded all 40 tags
  in **10 seconds including full page navigation and WASM/worker boot** —
  not a query problem. Earlier test runs that looked like `/tags` was stuck
  forever were a false signal from the *test script* doing rapid full-page
  reloads that raced the sqlite-wasm/OPFS worker's async teardown
  (`NoModificationAllowedError`), not the app — see `TESTGEN-FINDINGS.md`'s
  methodology note.
- **the map**: `app/src/lib/ui/MapView.svelte` renders markers as maplibre-gl
  `circle`/`symbol` GL layers off a GeoJSON source, not one DOM `Marker` per
  entry — this is the right approach and scales fine to thousands of points
  (confirmed: `/map` with ~2,681 located entries rendered in ~10 seconds).
  `map/+page.svelte` does build one marker object per entry rather than
  deduping by coordinate first, which is slightly wasteful (this dataset
  only has ~100 distinct locations) but is not what's costing time —
  GL-layer rendering doesn't care about duplicate coincident points the way
  DOM markers would.
- **entry materialization on sync** (`writeMaterialized` in
  `app/src/lib/entries/store.ts`, called once per applied update): does
  `delete from entry_tags where entry_id = ?` and `delete from entry_photos
  where entry_id = ?` on every write. These looked like candidates for a
  missing-index full-table-scan problem, but both tables' composite primary
  keys — `(entry_id, tag)` and `(entry_id, hash)` respectively — have
  `entry_id` as the leading column, so SQLite's automatic PK index already
  covers an `entry_id = ?` lookup. Not a bottleneck.

## general note

Most of the above only bites at this dataset's scale (thousands of entries
and photos on one device) or during a large first-time sync — a normal,
organically-grown journal wouldn't reach these numbers for years, if ever.
That's arguably the actual point of generating a dataset this large: milestone
9's Lighthouse pass and normal manual testing wouldn't have surfaced any of
this at realistic day-to-day data volumes.
