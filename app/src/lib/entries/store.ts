import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { getDb } from '$lib/db/client';
import { notifyLocalWrite } from '$lib/sync/notify';
import { DEFAULT_DIARY_ID } from '$lib/diaries/ids';
import { getMeta, getPhotos, getTags, getText } from './ydoc';
import { NO_DATE } from './dates';
import { materialize, type MaterializedEntry } from './materialize';
import { encodePhoto } from './photos';
import { likePattern } from './search';
import { computeStreak } from './streak';

/** captures the single update produced by a doc mutation, for the outbox. */
export function captureUpdate(doc: Y.Doc, mutate: (doc: Y.Doc) => void): Uint8Array {
	let update: Uint8Array | undefined;
	const onUpdate = (u: Uint8Array) => {
		update = u;
	};
	doc.on('update', onUpdate);
	doc.transact(() => mutate(doc));
	doc.off('update', onUpdate);
	return update ?? Y.encodeStateAsUpdate(doc);
}

/**
 * writes the entry/entry_tags/entry_photos/ydocs projection of `doc`, and — only when
 * `outboxUpdate` is given — queues that update for push. remote updates
 * (see `applyRemoteUpdate`) pass `null`: they came *from* the sync log
 * already, so re-queuing them would just echo them back to the server.
 */
async function writeMaterialized(
	id: string,
	doc: Y.Doc,
	outboxUpdate: Uint8Array | null
): Promise<MaterializedEntry> {
	const db = getDb();
	const now = new Date().toISOString();
	const { entry, tags, photos } = materialize(id, doc, now);

	const stmts = [
		{
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
				entry.markdown,
				entry.location_lat,
				entry.location_lng,
				entry.location_name,
				entry.deleted,
				entry.updated_at
			]
		},
		{ sql: `delete from entry_tags where entry_id = ?`, params: [id] },
		...tags.map((tag) => ({
			sql: `insert into entry_tags (entry_id, tag) values (?, ?)`,
			params: [id, tag]
		})),
		{ sql: `delete from entry_photos where entry_id = ?`, params: [id] },
		...photos.map((hash) => ({
			sql: `insert into entry_photos (entry_id, hash) values (?, ?)`,
			params: [id, hash]
		})),
		{
			sql: `insert into ydocs (entry_id, snapshot) values (?, ?)
				on conflict(entry_id) do update set snapshot = excluded.snapshot`,
			params: [id, Y.encodeStateAsUpdate(doc)]
		}
	];
	if (outboxUpdate) {
		stmts.push({
			sql: `insert into outbox (entry_id, update_, created_at) values (?, ?, ?)`,
			params: [id, outboxUpdate, now]
		});
	}

	await db.execBatch(stmts);
	return entry;
}

async function persist(id: string, doc: Y.Doc, update: Uint8Array): Promise<MaterializedEntry> {
	const entry = await writeMaterialized(id, doc, update);
	notifyLocalWrite();
	return entry;
}

/**
 * applies an update pulled from the sync server to this device's copy of an
 * entry (creating it locally if this device has never seen it before), and
 * re-materializes. returns the entry's current photos so the caller can
 * fetch any newly-referenced attachment blobs it doesn't have yet.
 */
export async function applyRemoteUpdate(
	id: string,
	update: Uint8Array
): Promise<{ entry: MaterializedEntry; photos: PhotoEntry[] }> {
	const doc = (await loadEntryDoc(id)) ?? new Y.Doc();
	Y.applyUpdate(doc, update);
	const entry = await writeMaterialized(id, doc, null);
	return { entry, photos: listPhotos(doc) };
}

export interface EntryEdits {
	entryDate: string;
	markdown: string;
	tags: string[];
	diaryId: string;
	locationLat?: number | null;
	locationLng?: number | null;
	locationName?: string | null;
}

/**
 * replaces a doc's text/tags/entry_date/location with the given values
 * (add/remove diffed against current state, so unrelated concurrent edits
 * still merge).
 */
export function applyEdits(doc: Y.Doc, data: EntryEdits): void {
	const meta = getMeta(doc);
	const text = getText(doc);
	const tagsMap = getTags(doc);

	meta.set('entry_date', data.entryDate);
	meta.set('diary_id', data.diaryId);

	if (data.locationLat != null) meta.set('location_lat', data.locationLat);
	else meta.delete('location_lat');
	if (data.locationLng != null) meta.set('location_lng', data.locationLng);
	else meta.delete('location_lng');
	if (data.locationName) meta.set('location_name', data.locationName);
	else meta.delete('location_name');

	if (text.toString() !== data.markdown) {
		text.delete(0, text.length);
		text.insert(0, data.markdown);
	}

	const currentTags = new Set([...tagsMap.keys()].filter((tag) => tagsMap.get(tag) === true));
	const nextTags = new Set(data.tags);
	for (const tag of currentTags) if (!nextTags.has(tag)) tagsMap.delete(tag);
	for (const tag of nextTags) if (!currentTags.has(tag)) tagsMap.set(tag, true);
}

export async function createEntry(
	opts: Partial<Omit<EntryEdits, 'entryDate'>> & { entryDate: string }
): Promise<string> {
	const id = uuidv7();
	const doc = new Y.Doc();
	const update = captureUpdate(doc, (d) => {
		getMeta(d).set('deleted', false);
		applyEdits(d, {
			entryDate: opts.entryDate,
			markdown: opts.markdown ?? '',
			tags: opts.tags ?? [],
			diaryId: opts.diaryId ?? DEFAULT_DIARY_ID,
			locationLat: opts.locationLat,
			locationLng: opts.locationLng,
			locationName: opts.locationName
		});
	});
	await persist(id, doc, update);
	return id;
}

export async function loadEntryDoc(id: string): Promise<Y.Doc | undefined> {
	const db = getDb();
	const rows = await db.select<{ snapshot: Uint8Array }>({
		sql: `select snapshot from ydocs where entry_id = ?`,
		params: [id]
	});
	if (!rows.length) return undefined;
	const doc = new Y.Doc();
	Y.applyUpdate(doc, rows[0].snapshot);
	return doc;
}

export async function updateEntry(
	id: string,
	doc: Y.Doc,
	mutate: (doc: Y.Doc) => void
): Promise<MaterializedEntry> {
	const update = captureUpdate(doc, mutate);
	return persist(id, doc, update);
}

export async function deleteEntry(id: string, doc: Y.Doc): Promise<void> {
	await updateEntry(id, doc, (d) => {
		getMeta(d).set('deleted', true);
	});
}

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

/**
 * plain-text substring search over entry text, for the /search page. `like` is
 * case-insensitive for ascii; a real fts index can replace this later without
 * changing the call site.
 */
export async function searchEntries(query: string, diaryId?: string): Promise<MaterializedEntry[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const db = getDb();
	const diaryCond = diaryId ? ` and diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	return db.select<MaterializedEntry>({
		sql: `select * from entries
			where deleted = 0 and markdown like ? escape '\\'${diaryCond}
			order by entry_date desc, updated_at desc`,
		params: [likePattern(trimmed), ...diaryParams]
	});
}

export interface DayGroup {
	day: string;
	entries: MaterializedEntry[];
}

// entries arrive pre-sorted by entry_date desc, so same-day entries are
// already adjacent — a single pass is enough to group them.
export function groupEntriesByDay(list: MaterializedEntry[]): DayGroup[] {
	const groups: DayGroup[] = [];
	for (const entry of list) {
		const day = entry.entry_date ?? NO_DATE;
		const last = groups.at(-1);
		if (last?.day === day) last.entries.push(entry);
		else groups.push({ day, entries: [entry] });
	}
	return groups;
}

export interface MonthGroup {
	/** 'YYYY-MM', or NO_DATE for entries whose doc carries no entry_date. */
	month: string;
	days: DayGroup[];
}

// same single pass as `groupEntriesByDay`, one level deeper: the sort puts
// every day of a month together, and every entry of a day together within it.
export function groupEntriesByMonth(list: MaterializedEntry[]): MonthGroup[] {
	const groups: MonthGroup[] = [];
	for (const entry of list) {
		const day = entry.entry_date ?? NO_DATE;
		const month = entry.entry_date ? entry.entry_date.slice(0, 7) : NO_DATE;
		const lastMonth = groups.at(-1);
		if (lastMonth?.month !== month) {
			groups.push({ month, days: [{ day, entries: [entry] }] });
			continue;
		}
		const lastDay = lastMonth.days.at(-1);
		if (lastDay?.day === day) lastDay.entries.push(entry);
		else lastMonth.days.push({ day, entries: [entry] });
	}
	return groups;
}

/**
 * entries from the same month/day in earlier years. see PLAN.md
 * "\"on this day\" is just: WHERE deleted=0 AND strftime('%m-%d', entry_date)
 * = strftime('%m-%d', 'now') AND entry_date < date('now')".
 */
export async function listOnThisDay(
	referenceDate: Date = new Date(),
	diaryId?: string
): Promise<MaterializedEntry[]> {
	const db = getDb();
	const today = referenceDate.toISOString().slice(0, 10);
	const diaryCond = diaryId ? ` and diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	return db.select<MaterializedEntry>({
		sql: `select * from entries
			where deleted = 0
				and strftime('%m-%d', entry_date) = strftime('%m-%d', ?)
				and entry_date < ?${diaryCond}
			order by entry_date desc`,
		params: [today, today, ...diaryParams]
	});
}

/** which days in a given month (1-12) have at least one entry, for the calendar view. */
export async function listEntryDatesInMonth(
	year: number,
	month: number,
	diaryId?: string
): Promise<{ date: string; count: number }[]> {
	const db = getDb();
	const monthStr = `${year}-${String(month).padStart(2, '0')}`;
	const diaryCond = diaryId ? ` and diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	return db.select<{ date: string; count: number }>({
		sql: `select entry_date as date, count(*) as count from entries
			where deleted = 0 and strftime('%Y-%m', entry_date) = ?${diaryCond}
			group by entry_date`,
		params: [monthStr, ...diaryParams]
	});
}

/** consecutive days with at least one entry, ending today (or yesterday). */
export async function getCurrentStreak(
	referenceDate: Date = new Date(),
	diaryId?: string
): Promise<number> {
	const db = getDb();
	const diaryCond = diaryId ? ` and diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	const rows = await db.select<{ entry_date: string }>({
		sql: `select distinct entry_date from entries where deleted = 0 and entry_date is not null${diaryCond}`,
		params: diaryParams
	});
	return computeStreak(
		rows.map((row) => row.entry_date),
		referenceDate
	);
}

/** entries with a captured location, for the map overview page. */
export async function listEntriesWithLocation(diaryId?: string): Promise<MaterializedEntry[]> {
	const db = getDb();
	const diaryCond = diaryId ? ` and diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	return db.select<MaterializedEntry>({
		sql: `select * from entries
			where deleted = 0 and location_lat is not null and location_lng is not null${diaryCond}
			order by entry_date desc, updated_at desc`,
		params: diaryParams
	});
}

export async function listTags(diaryId?: string): Promise<{ tag: string; count: number }[]> {
	const db = getDb();
	const diaryCond = diaryId ? ` and e.diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	return db.select<{ tag: string; count: number }>({
		sql: `select t.tag as tag, count(*) as count from entry_tags t
			join entries e on e.id = t.entry_id
			where e.deleted = 0${diaryCond}
			group by t.tag
			order by t.tag asc`,
		params: diaryParams
	});
}

/** non-deleted entry counts per diary id, for the settings management ui. */
export async function countEntriesByDiary(): Promise<Record<string, number>> {
	const db = getDb();
	const rows = await db.select<{ diary_id: string; count: number }>({
		sql: `select diary_id, count(*) as count from entries where deleted = 0 group by diary_id`
	});
	return Object.fromEntries(rows.map((row) => [row.diary_id, row.count]));
}

export interface PhotoEntry {
	hash: string;
	mime: string;
	width: number;
	height: number;
}

/** the entry's photos, derived straight from its Y.Doc (source of truth). */
export function listPhotos(doc: Y.Doc): PhotoEntry[] {
	return [...getPhotos(doc).entries()]
		.map(([hash, meta]) => ({ hash, ...meta }))
		.sort((a, b) => a.hash.localeCompare(b.hash));
}

export interface PhotoWithEntry extends PhotoEntry {
	entry_id: string;
	entry_date: string | null;
}

/** every photo across all (non-deleted) entries, newest entry first, for the /photos overview. */
export async function listAllPhotos(diaryId?: string): Promise<PhotoWithEntry[]> {
	const db = getDb();
	const diaryCond = diaryId ? ` and e.diary_id = ?` : ``;
	const diaryParams = diaryId ? [diaryId] : [];
	return db.select<PhotoWithEntry>({
		sql: `select a.id as hash, a.mime, a.width, a.height, e.id as entry_id, e.entry_date as entry_date
			from entry_photos p
			join entries e on e.id = p.entry_id
			join attachments a on a.id = p.hash
			where e.deleted = 0${diaryCond}
			order by e.entry_date desc, e.updated_at desc, p.hash asc`,
		params: diaryParams
	});
}

export interface PhotoDayGroup {
	day: string;
	photos: PhotoWithEntry[];
}

// `listAllPhotos` returns rows pre-sorted by entry_date desc, so same-day
// photos are already adjacent — a single pass is enough to group them.
export function groupPhotosByDay(list: PhotoWithEntry[]): PhotoDayGroup[] {
	const groups: PhotoDayGroup[] = [];
	for (const photo of list) {
		const day = photo.entry_date ?? 'no date';
		const last = groups.at(-1);
		if (last?.day === day) last.photos.push(photo);
		else groups.push({ day, photos: [photo] });
	}
	return groups;
}

/**
 * resizes/re-encodes the file, stores it content-addressed in `attachments`,
 * and references its hash from the doc's `photos` map. the bytes themselves
 * sync separately from the doc updates (see PLAN.md "entries as CRDTs").
 */
export async function addPhoto(id: string, doc: Y.Doc, file: Blob): Promise<void> {
	const photo = await encodePhoto(file);
	const db = getDb();
	await db.exec({
		sql: `insert into attachments (id, mime, width, height, bytes, pushed)
			values (?, ?, ?, ?, ?, 0)
			on conflict(id) do nothing`,
		params: [photo.hash, photo.mime, photo.width, photo.height, photo.bytes]
	});
	await updateEntry(id, doc, (d) => {
		getPhotos(d).set(photo.hash, { mime: photo.mime, width: photo.width, height: photo.height });
	});
}

export async function removePhoto(id: string, doc: Y.Doc, hash: string): Promise<void> {
	await updateEntry(id, doc, (d) => {
		getPhotos(d).delete(hash);
	});
}

/** loads an attachment's bytes and returns a fresh object URL for display. */
export async function getAttachmentUrl(hash: string): Promise<string | undefined> {
	const db = getDb();
	const rows = await db.select<{ bytes: Uint8Array; mime: string }>({
		sql: `select bytes, mime from attachments where id = ?`,
		params: [hash]
	});
	if (!rows.length) return undefined;
	return URL.createObjectURL(new Blob([new Uint8Array(rows[0].bytes)], { type: rows[0].mime }));
}

export type { MaterializedEntry };
