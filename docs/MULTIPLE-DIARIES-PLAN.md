# multiple diaries — implementation plan

Support several named diaries (like Day One's journals): every entry belongs to
exactly one diary, the UI can be scoped to one diary (or all of them), entries
can be moved between diaries, and diaries can be created/renamed/deleted from
settings. Diary membership and the diary list itself must sync between devices.

This plan is decision-complete: follow it step by step, in order, without
re-deciding the design. Read PLAN.md ("entries as CRDTs", "client data model",
"sync") first for background. Steps 1–6 are the data/sync layer, steps 7–11 the
UI, steps 12–14 tests/docs/verification.

## design (already decided — do not revisit)

- **An entry's diary is a key in its existing `meta` Y.Map** (`diary_id`). It
  syncs like every other entry field, merges LWW per key, and needs no protocol
  change. A `meta` map with **no** `diary_id` key means the **default diary** —
  every pre-existing entry therefore lands in the default diary with no data
  rewrite.
- **The default diary is virtual**: id `'default'`, display name `journal`. It
  always exists, is never stored anywhere, and cannot be deleted. (It *can* be
  renamed — see next point.)
- **The diary registry is one well-known Y.Doc** with the reserved doc id
  `_diaries`, synced through the same append-only log as entries (the server
  treats `entry_id` as an opaque string — `server/src/api.zig` never validates
  its shape, and the e2e test already pushes non-uuid ids — so **no server
  changes at all**). Inside the doc, a `diaries: Y.Map` maps diary id →
  `{ name, deleted? }`. Creating a diary sets a new uuidv7 key; renaming
  re-sets the key with a new name; deleting re-sets it with `deleted: true`
  (a tombstone, mirroring how entries are deleted). A map entry under the key
  `'default'` overrides the virtual default diary's display name.
- **The current diary scope is device-local UI state**, stored in the existing
  `sync_state` table under key `current_diary_id` (not synced — each device
  keeps its own view). The value is a diary id, or the sentinel `'all'`
  (show everything, which is also the default so existing users see no change).
- **Deleting a diary requires it to be empty** (zero non-deleted entries in it
  on this device). Entries are never bulk-moved or cascade-deleted.
- Timeline, on-this-day, streak, calendar, tags, and map are all scoped by the
  current diary; scope `'all'` reproduces today's behavior exactly.
- Backup export/import needs **no changes** — it copies the whole sqlite file,
  which now simply includes the new column/table.

## guardrails

- **Do not touch anything under `server/`** or `docs/protocol.md`'s wire
  format. The server relays opaque blobs; `_diaries` is just another entry_id
  to it.
- **Never mutate the diaries Y.Doc without queueing the resulting update into
  `outbox`.** A local-only yjs op that is never pushed can make two devices
  disagree forever (convergence requires all ops to reach all peers). Every
  mutation goes through the `mutateDiaries` helper below, which does both.
- **Do not backfill `diary_id` into existing entry Y.Docs** (no migration that
  rewrites docs, no mass outbox writes). Absence of the key *is* the default
  diary.
- **Do not edit migration index 0** in `app/src/lib/db/migrations.ts` — append
  a new array element (index 1 → `user_version` 2). Existing databases must
  upgrade in place.
- Mind the existing quirks: the outbox blob column is named `update_` (trailing
  underscore), and sql params are positional `?`.
- Run every shell command through the dev shell: `nix develop -c <command>`
  from the repo root (bare shells lack node). App commands run in `app/`.
- Match the existing code style (tabs, lowercase comments); finish with
  `npm run format`.

## step 1 — shared constants: `app/src/lib/diaries/ids.ts` (new file)

A leaf module (imports nothing) so `materialize.ts`, the stores, and the UI can
all use these without import cycles:

```ts
// well-known ids for the diaries feature. kept in a leaf module (no imports)
// so both the entry materializer and the diaries store can depend on it
// without cycles.

/** reserved doc id for the diary-registry Y.Doc in the sync log — can never
 * collide with entry ids, which are uuidv7s. */
export const DIARIES_DOC_ID = '_diaries';

/** the always-existing virtual diary that entries without a meta.diary_id
 * belong to. never stored, never deletable. */
export const DEFAULT_DIARY_ID = 'default';
export const DEFAULT_DIARY_NAME = 'journal';

/** ui scope sentinel: no diary filter. stored in sync_state, never in docs. */
export const ALL_DIARIES = 'all';

export interface Diary {
	id: string;
	name: string;
}
```

## step 2 — schema migration: `app/src/lib/db/migrations.ts`

Append a **second element** to the `migrations` array (after the existing
initial-schema string, comma-separated):

```ts
	// 2: multiple diaries — entries.diary_id materialized from meta.diary_id
	// ('default' when the doc has no such key), plus a snapshot table for
	// non-entry well-known docs (the `_diaries` registry). that snapshot can't
	// live in `ydocs`, whose entry_id references entries(id).
	`
	alter table entries add column diary_id text not null default 'default';
	create index entries_diary_id on entries(diary_id);

	create table meta_ydocs (
		doc_id text primary key,
		snapshot blob not null
	);
	`
```

No worker changes: `applyMigrations` in `worker.ts` already applies new
elements on startup and after `importDb`. SQLite applies a constant default to
existing rows on `alter table add column`, so all pre-existing entries become
`diary_id = 'default'` automatically.

## step 3 — materialization: diary_id as a column

In `app/src/lib/entries/materialize.ts`:

- Import: `import { DEFAULT_DIARY_ID } from '$lib/diaries/ids';`
- Add `diary_id: string;` to `MaterializedEntry` (put it after `id`).
- In `materialize()`'s returned entry object add:
  `diary_id: (meta.get('diary_id') as string | undefined) ?? DEFAULT_DIARY_ID,`

In `app/src/lib/entries/store.ts`, function `writeMaterialized`, extend the
entries upsert to carry the new column — the statement becomes:

```ts
			sql: `insert into entries
				(id, diary_id, entry_date, markdown, location_lat, location_lng, location_name, deleted, updated_at)
				values (?, ?, ?, ?, ?, ?, ?, ?, ?)
				on conflict(id) do update set
					diary_id = excluded.diary_id,
					entry_date = excluded.entry_date,
					markdown = excluded.markdown,
					location_lat = excluded.location_lat,
					location_lng = excluded.location_lng,
					location_name = excluded.location_name,
					deleted = excluded.deleted,
					updated_at = excluded.updated_at`,
			params: [
				entry.id,
				entry.diary_id,
				entry.entry_date,
				...  // rest unchanged, same order as before
			]
```

## step 4 — writing diary membership on entries

Still in `app/src/lib/entries/store.ts`:

- Import `DEFAULT_DIARY_ID` from `'$lib/diaries/ids'`.
- Add `diaryId: string;` to the `EntryEdits` interface.
- In `applyEdits`, right after `meta.set('entry_date', data.entryDate);` add
  `meta.set('diary_id', data.diaryId);` (unconditional set, matching how
  entry_date is handled).
- In `createEntry`, inside the `applyEdits` call's object add
  `diaryId: opts.diaryId ?? DEFAULT_DIARY_ID,` (the `Partial<...>` in
  `createEntry`'s signature makes `diaryId` optional automatically).
- Change `captureUpdate` from a private function to an **exported** one
  (`export function captureUpdate`) — the diaries store (step 5) reuses it.
  Note the import direction is diaries/store → entries/store only; entries
  code must only ever import the leaf `$lib/diaries/ids`, never
  `$lib/diaries/store`, or you create a cycle.

## step 5 — the diary registry

### `app/src/lib/diaries/ydoc.ts` (new file — pure doc logic, unit-testable)

```ts
import type * as Y from 'yjs';
import { DEFAULT_DIARY_ID, DEFAULT_DIARY_NAME, type Diary } from './ids';

/** value stored per diary id in the registry map. re-set whole on any change
 * (Y.Map is last-write-wins per key — same trade-off as entry meta). */
export interface DiaryMeta {
	name: string;
	deleted?: boolean;
}

export function getDiariesMap(doc: Y.Doc): Y.Map<DiaryMeta> {
	return doc.getMap('diaries');
}

/**
 * live diaries: the virtual default first (name overridable by a map entry
 * under 'default'), then the rest sorted by name. tombstoned diaries are
 * hidden but their entries stay reachable under the "all" scope.
 */
export function listDiaries(doc: Y.Doc): Diary[] {
	const map = getDiariesMap(doc);
	let defaultName = DEFAULT_DIARY_NAME;
	const rest: Diary[] = [];
	for (const [id, meta] of map.entries()) {
		if (id === DEFAULT_DIARY_ID) {
			defaultName = meta.name;
		} else if (!meta.deleted) {
			rest.push({ id, name: meta.name });
		}
	}
	rest.sort((a, b) => a.name.localeCompare(b.name));
	return [{ id: DEFAULT_DIARY_ID, name: defaultName }, ...rest];
}
```

### `app/src/lib/diaries/store.ts` (new file — db-backed persistence)

```ts
// persistence + sync for the diary registry: one well-known Y.Doc (see
// PLAN.md "multiple diaries") whose updates travel through the same outbox
// and /api/changes log as entries, under the reserved id `_diaries`.
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { getDb } from '$lib/db/client';
import { notifyLocalWrite } from '$lib/sync/notify';
import { captureUpdate } from '$lib/entries/store';
import { DEFAULT_DIARY_ID, DIARIES_DOC_ID } from './ids';
import { getDiariesMap, type DiaryMeta } from './ydoc';

export async function loadDiariesDoc(): Promise<Y.Doc> {
	const db = getDb();
	const rows = await db.select<{ snapshot: Uint8Array }>({
		sql: `select snapshot from meta_ydocs where doc_id = ?`,
		params: [DIARIES_DOC_ID]
	});
	const doc = new Y.Doc();
	if (rows.length) Y.applyUpdate(doc, rows[0].snapshot);
	return doc;
}

/** saves the merged snapshot; when `outboxUpdate` is given, also queues it
 * for push (remote applies pass null — same contract as entries). */
async function saveDiariesDoc(doc: Y.Doc, outboxUpdate: Uint8Array | null): Promise<void> {
	const db = getDb();
	const stmts = [
		{
			sql: `insert into meta_ydocs (doc_id, snapshot) values (?, ?)
				on conflict(doc_id) do update set snapshot = excluded.snapshot`,
			params: [DIARIES_DOC_ID, Y.encodeStateAsUpdate(doc)]
		}
	];
	if (outboxUpdate) {
		stmts.push({
			sql: `insert into outbox (entry_id, update_, created_at) values (?, ?, ?)`,
			params: [DIARIES_DOC_ID, outboxUpdate, new Date().toISOString()]
		});
	}
	await db.execBatch(stmts);
}

/** every local registry change funnels through here so the update is always
 * both persisted and queued — an unpushed local yjs op would diverge forever. */
async function mutateDiaries(doc: Y.Doc, fn: (map: Y.Map<DiaryMeta>) => void): Promise<void> {
	const update = captureUpdate(doc, (d) => fn(getDiariesMap(d)));
	await saveDiariesDoc(doc, update);
	notifyLocalWrite();
}

export async function createDiary(doc: Y.Doc, name: string): Promise<string> {
	const id = uuidv7();
	await mutateDiaries(doc, (map) => map.set(id, { name }));
	return id;
}

export async function renameDiary(doc: Y.Doc, id: string, name: string): Promise<void> {
	await mutateDiaries(doc, (map) => map.set(id, { ...map.get(id), name }));
}

export async function deleteDiary(doc: Y.Doc, id: string): Promise<void> {
	if (id === DEFAULT_DIARY_ID) throw new Error('the default diary cannot be deleted');
	await mutateDiaries(doc, (map) => {
		const meta = map.get(id);
		if (meta) map.set(id, { ...meta, deleted: true });
	});
}

/** applies a pulled `_diaries` update — no outbox (it came from the log). */
export async function applyRemoteDiariesUpdate(update: Uint8Array): Promise<void> {
	const doc = await loadDiariesDoc();
	Y.applyUpdate(doc, update);
	await saveDiariesDoc(doc, null);
}
```

## step 6 — sync engine: route `_diaries` pulls to the registry

In `app/src/lib/sync/engine.ts`, add imports:

```ts
import { applyRemoteDiariesUpdate } from '$lib/diaries/store';
import { DIARIES_DOC_ID } from '$lib/diaries/ids';
```

and change the loop body inside `pull()`:

```ts
		for (const change of changes) {
			// the diary registry travels the same log as entries but is not an
			// entry — apply it to its own doc instead of materializing.
			if (change.entryId === DIARIES_DOC_ID) {
				await applyRemoteDiariesUpdate(change.update);
				continue;
			}
			const { photos } = await applyRemoteUpdate(change.entryId, change.update);
			if (photos.length > 0) await fetchMissingBlobs(cfg, photos);
		}
```

`push()` needs **no change**: outbox rows for `_diaries` already flow through
`listOutbox`/`pushChanges` like any other row.

## step 7 — diary-scoped queries: `app/src/lib/entries/store.ts`

Every list/aggregate function gains an optional diary filter; `undefined`
means all diaries (today's behavior). Replace the functions as follows:

```ts
export async function listEntries(
	opts: { tag?: string; date?: string; diaryId?: string } = {}
): Promise<MaterializedEntry[]> {
	const db = getDb();
	const diaryCond = opts.diaryId ? ` and diary_id = ?` : ``;
	const diaryParams = opts.diaryId ? [opts.diaryId] : [];
	if (opts.date) {
		return db.select<MaterializedEntry>({
			sql: `select * from entries
				where deleted = 0 and entry_date = ?${diaryCond}
				order by updated_at desc`,
			params: [opts.date, ...diaryParams]
		});
	}
	if (opts.tag) {
		return db.select<MaterializedEntry>({
			sql: `select e.* from entries e
				join entry_tags t on t.entry_id = e.id
				where e.deleted = 0 and t.tag = ?${opts.diaryId ? ` and e.diary_id = ?` : ``}
				order by e.entry_date desc, e.updated_at desc`,
			params: [opts.tag, ...diaryParams]
		});
	}
	return db.select<MaterializedEntry>({
		sql: `select * from entries where deleted = 0${diaryCond}
			order by entry_date desc, updated_at desc`,
		params: diaryParams
	});
}
```

Apply the same pattern (append `and diary_id = ?` + param when `diaryId` is
given) to:

- `listOnThisDay(referenceDate?, diaryId?: string)` — second positional param.
- `listEntryDatesInMonth(year, month, diaryId?: string)` — third param.
- `getCurrentStreak(referenceDate?, diaryId?: string)` — filter the
  `select distinct entry_date …` query.
- `listEntriesWithLocation(diaryId?: string)`.
- `listTags(diaryId?: string)` — condition on `e.diary_id`.

Add one new aggregate (used by settings to guard deletion and show counts):

```ts
/** non-deleted entry counts per diary id, for the settings management ui. */
export async function countEntriesByDiary(): Promise<Record<string, number>> {
	const db = getDb();
	const rows = await db.select<{ diary_id: string; count: number }>({
		sql: `select diary_id, count(*) as count from entries where deleted = 0 group by diary_id`
	});
	return Object.fromEntries(rows.map((row) => [row.diary_id, row.count]));
}
```

## step 8 — current-diary scope state

### `app/src/lib/settings/store.ts`

Add, following the existing getter/setter pattern in that file:

```ts
const CURRENT_DIARY_KEY = 'current_diary_id';

/** device-local diary scope for the ui — a diary id, or 'all'. not synced. */
export async function getCurrentDiaryId(): Promise<string> {
	return (await getSetting(CURRENT_DIARY_KEY)) ?? 'all';
}

export function setCurrentDiaryId(id: string): Promise<void> {
	return setSetting(CURRENT_DIARY_KEY, id);
}
```

### `app/src/lib/diaries/current.svelte.ts` (new file — note `.svelte.ts`, runes need it)

```ts
// the device-local diary scope, shared reactively by every page. persisted
// in sync_state so it survives reloads; 'all' means no filter.
import { getCurrentDiaryId, setCurrentDiaryId } from '$lib/settings/store';
import { ALL_DIARIES } from './ids';

export const currentDiary = $state({ id: ALL_DIARIES });

/** called once from the root layout; pages rendered before this resolves
 * just show the 'all' scope and re-render when it lands. */
export async function initCurrentDiary(): Promise<void> {
	currentDiary.id = await getCurrentDiaryId();
}

export async function selectDiary(id: string): Promise<void> {
	currentDiary.id = id;
	await setCurrentDiaryId(id);
}

/** the query filter for the current scope: undefined = all diaries. */
export function currentDiaryFilter(): string | undefined {
	return currentDiary.id === ALL_DIARIES ? undefined : currentDiary.id;
}
```

## step 9 — layout: diary switcher in the nav

In `app/src/routes/+layout.svelte`:

- Imports:

```ts
	import { page } from '$app/state';
	import { currentDiary, initCurrentDiary, selectDiary } from '$lib/diaries/current.svelte';
	import { ALL_DIARIES, type Diary } from '$lib/diaries/ids';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { loadDiariesDoc } from '$lib/diaries/store';
```

- State + loading (add to the script; keep the existing `onMount` body and add
  `void initCurrentDiary();` at its start):

```ts
	let diaries = $state<Diary[]>([]);

	// refresh the switcher on every navigation, so registry changes made in
	// settings or pulled by sync show up without a manual reload.
	$effect(() => {
		void page.url;
		loadDiariesDoc().then((doc) => {
			diaries = listDiaries(doc);
			// a stale persisted scope (diary deleted / db imported) falls back
			// to 'all' instead of silently filtering everything out.
			if (currentDiary.id !== ALL_DIARIES && !diaries.some((d) => d.id === currentDiary.id)) {
				void selectDiary(ALL_DIARIES);
			}
		});
	});
```

- Markup — inside `<nav>`, after the settings link:

```svelte
		<select
			class="diary-select"
			aria-label="diary"
			value={currentDiary.id}
			onchange={(e) => selectDiary(e.currentTarget.value)}
		>
			<option value={ALL_DIARIES}>all diaries</option>
			{#each diaries as diary (diary.id)}
				<option value={diary.id}>{diary.name}</option>
			{/each}
		</select>
```

- In `app/src/app.css`, add a minimal rule near the existing nav styles so the
  select doesn't look foreign (match the nav's font-size/colors; keep it
  small):

```css
.diary-select {
	margin-left: auto;
	max-width: 10rem;
}
```

## step 10 — scope the pages

Pattern for all four pages: read the scope via `currentDiaryFilter()` *inside*
the `$effect` that loads data (calling it there makes the effect re-run when
the switcher changes), and pass it to the queries. Import from
`'$lib/diaries/current.svelte'`.

- `app/src/routes/+page.svelte` (timeline):
  - `load()` gains a `diaryId: string | undefined` param; pass it to
    `listEntries({ tag, date, diaryId })`, `listOnThisDay(undefined, diaryId)`
    — adjust: call as `listOnThisDay(new Date(), diaryId)` — and
    `getCurrentStreak(new Date(), diaryId)`.
  - The `$effect` becomes `load(tag, date, currentDiaryFilter());`.
  - **Diary badge**: when the scope is 'all', label entries that are not in
    the default diary. Load names once per `load()` (when unscoped):
    `const names = new Map(listDiaries(await loadDiariesDoc()).map((d) => [d.id, d.name]))`
    into a `$state` map, and in both entry-card templates add, next to the
    preview text:

    ```svelte
    {#if !filteredByDiary && entry.diary_id !== DEFAULT_DIARY_ID}
    	<span class="diary-badge">{diaryNames.get(entry.diary_id) ?? 'unknown diary'}</span>
    {/if}
    ```

    where `filteredByDiary = $derived(currentDiary.id !== ALL_DIARIES)`. The
    `?? 'unknown diary'` matters: an entry's diary_id can arrive in a pull
    before the registry update naming it. Add css:

    ```css
    .diary-badge {
    	font-size: 0.75rem;
    	opacity: 0.7;
    }
    ```
- `app/src/routes/calendar/+page.svelte`: `load(y, m)` →
  `listEntryDatesInMonth(y, m, currentDiaryFilter())`, with the filter read in
  the `$effect` and passed in as a third `load` param.
- `app/src/routes/tags/+page.svelte`: `listTags(currentDiaryFilter())` —
  move the load into a `$effect` that reads the filter (it already is one;
  just read the filter inside it).
- `app/src/routes/map/+page.svelte`: `listEntriesWithLocation(currentDiaryFilter())`,
  same treatment.

## step 11 — choosing/moving an entry's diary, and managing diaries

### `app/src/lib/ui/EntryEditor.svelte`

- Add to `EntryEditPayload`: `diaryId: string;`
- Add to `Props` and destructuring: `initialDiaryId?: string;` (default
  `DEFAULT_DIARY_ID`, import from `'$lib/diaries/ids'`) and
  `diaries?: Diary[];` (default `[]`).
- Local state next to the other snapshots (with the same
  `svelte-ignore state_referenced_locally` comment):
  `let diaryId = $state(initialDiaryId);`
- Include `diaryId` in the `onSave({...})` object in `save()`.
- Markup — only when there is a real choice, directly after the date field
  `</label>`:

```svelte
	{#if diaries.length > 1}
		<label class="field">
			diary
			<select bind:value={diaryId}>
				{#each diaries as diary (diary.id)}
					<option value={diary.id}>{diary.name}</option>
				{/each}
			</select>
		</label>
	{/if}
```

### `app/src/routes/new/+page.svelte`

- Load the diary list in the existing `$effect` (via
  `loadDiariesDoc().then(...)` + `listDiaries`) into `let diaries = $state<Diary[]>([])`.
- Pass to the editor: `{diaries}` and
  `initialDiaryId={currentDiaryFilter() ?? DEFAULT_DIARY_ID}` — a new entry
  lands in the diary you're currently looking at, or the default under 'all'.
- `createEntry(data)` needs no change (the payload now carries `diaryId`).

### `app/src/routes/entry/[id]/+page.ts`

Return `diaryId: entry.diary_id` from the loaded branch, and
`diaryId: DEFAULT_DIARY_ID` (imported from `$lib/diaries/ids`) in the
not-found branch.

### `app/src/routes/entry/[id]/+page.svelte`

Load `diaries` the same way as the new page, and pass
`initialDiaryId={data.diaryId}` and `{diaries}` to the editor. Saving with a
different diary selected *is* the "move entry" feature — `applyEdits` re-sets
`meta.diary_id`, and it syncs like any edit.

### `app/src/routes/settings/+page.svelte` — diaries management section

Add a `<section class="field"><h2>diaries</h2>…</section>` between the sync
and backup sections. Script side:

```ts
	import { loadDiariesDoc, createDiary, renameDiary, deleteDiary } from '$lib/diaries/store';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { DEFAULT_DIARY_ID, ALL_DIARIES, type Diary } from '$lib/diaries/ids';
	import { currentDiary, selectDiary } from '$lib/diaries/current.svelte';
	import { countEntriesByDiary } from '$lib/entries/store';
	import type * as Y from 'yjs';

	let diariesDoc = $state<Y.Doc | undefined>();
	let diaries = $state<Diary[]>([]);
	let diaryCounts = $state<Record<string, number>>({});
	let newDiaryName = $state('');
	let diaryError = $state('');

	async function reloadDiaries() {
		diariesDoc = await loadDiariesDoc();
		diaries = listDiaries(diariesDoc);
		diaryCounts = await countEntriesByDiary();
	}

	async function handleCreateDiary() {
		const name = newDiaryName.trim();
		if (!name || !diariesDoc) return;
		diaryError = '';
		await createDiary(diariesDoc, name);
		newDiaryName = '';
		await reloadDiaries();
	}

	async function handleRenameDiary(id: string, name: string) {
		const trimmed = name.trim();
		const current = diaries.find((d) => d.id === id);
		if (!trimmed || !diariesDoc || trimmed === current?.name) return;
		await renameDiary(diariesDoc, id, trimmed);
		await reloadDiaries();
	}

	async function handleDeleteDiary(id: string) {
		if (!diariesDoc) return;
		diaryError = '';
		if ((diaryCounts[id] ?? 0) > 0) {
			diaryError = 'this diary still has entries — move or delete them first.';
			return;
		}
		if (!confirm('delete this diary?')) return;
		await deleteDiary(diariesDoc, id);
		if (currentDiary.id === id) await selectDiary(ALL_DIARIES);
		await reloadDiaries();
	}
```

Call `reloadDiaries()` from the page's existing `$effect`. Markup: one row per
diary — a text `<input class="location-name" value={diary.name}
onblur={(e) => handleRenameDiary(diary.id, e.currentTarget.value)} />`, an
entry count `<span class="tag-count">{diaryCounts[diary.id] ?? 0}</span>`, and
a `<button type="button" class="danger" disabled={diary.id === DEFAULT_DIARY_ID}
onclick={() => handleDeleteDiary(diary.id)}>delete</button>`. Below the rows:
the `newDiaryName` input plus a "create diary" button wired to
`handleCreateDiary`, and `{#if diaryError}<p class="error">{diaryError}</p>{/if}`.
A short `filter-banner` paragraph explaining that renames and new diaries sync
to other devices, but which diary is *selected* is per-device.

## step 12 — tests

### `app/src/lib/entries/materialize.test.ts`

Add two cases to the existing suite (style-match the file):

- a doc with no `diary_id` key materializes `diary_id: 'default'`;
- a doc where `getMeta(doc).set('diary_id', 'abc')` materializes
  `diary_id: 'abc'`.

If existing assertions compare full materialized objects, extend the expected
objects with `diary_id: 'default'`.

### `app/src/lib/diaries/ydoc.test.ts` (new file)

Pure-yjs tests, modeled on `materialize.test.ts` (no db, runs in node):

- an empty doc lists exactly the virtual default `[{ id: 'default', name: 'journal' }]`;
- setting keys via `getDiariesMap` lists them sorted by name after the default;
- a map entry under `'default'` overrides the default's name (and is not
  duplicated in the list);
- a `deleted: true` value hides a diary;
- convergence: two docs from a common base each `set` a different new diary
  offline, exchange `Y.encodeStateAsUpdate` both ways → both docs list both
  diaries, and both lists are deeply equal;
- concurrent rename vs delete of the same id on two docs → after exchanging
  updates both docs agree (either outcome, but the same on both — assert deep
  equality of the two lists, not a specific winner).

Run: `nix develop -c bash -c 'cd app && npm test'`.

## step 13 — docs

- `PLAN.md`:
  - "entries as CRDTs": add `diary_id` to the `meta: Y.Map` bullet, and a
    short paragraph on the `_diaries` well-known doc (registry map, virtual
    default, tombstone deletes, synced through the same log — server unaware).
  - "client data model" sql block: add `diary_id TEXT` to `entries(...)` and a
    `meta_ydocs(doc_id TEXT PRIMARY KEY, snapshot BLOB)` line.
  - "routes": mention the nav diary switcher and the settings diaries section.
  - "milestones": append `11. **multiple diaries**: …` summarizing the above
    (one entry, same style as its neighbors).
- `docs/protocol.md`: in the intro or the changes section, one note: clients
  reserve the entry_id `_diaries` for the diary-registry doc; the server needs
  no knowledge of this (any opaque id is already accepted).
- `README.md`: extend the Status section with one sentence noting multiple-
  diary support.

## step 14 — verification

1. `nix develop -c bash -c 'cd app && npm run format && npm run check && npm run lint && npm test'`
   — all clean/green.
2. **Migration upgrade path**: start `nix develop -c npm run dev` (in `app/`)
   in a browser profile that already has entries from before this change —
   they must all appear under "all diaries" and under "journal", and the
   console must show no migration errors.
3. **Manual pass** (dev server):
   - create a diary "work" in settings; the nav switcher lists it;
   - new entry while scoped to "work" lands in "work"; timeline scoped to
     "journal" hides it; "all diaries" shows it with a `work` badge;
   - move an entry between diaries via the editor's diary select;
   - calendar, tags, and map all change with the switcher;
   - deleting "work" while it has entries is refused with the error message;
     after moving its entries away, deletion succeeds and the switcher resets
     if it was selected;
   - rename the default diary; the switcher and badges update.
4. **Two-profile sync** (mirrors PLAN.md "verification"): run the server
   (`server/`, see its README/scripts), point two isolated browser profiles at
   it. Create a diary + an entry in it on A, sync both → B shows the diary
   (switcher) and the entry in it. Rename the diary on B, sync both → A shows
   the new name. Confirm scope selection itself does NOT sync (select "work"
   on A; B's selection is unchanged).
5. Commit in the repo's style: a single commit, subject like
   `Milestone 11: multiple diaries`, with a body covering what changed, why,
   and how it was verified (see `git log` for the pattern).
