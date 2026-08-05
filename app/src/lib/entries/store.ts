import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { getDb } from '$lib/db/client';
import { getMeta, getPhotos, getTags, getText } from './ydoc';
import { materialize, type MaterializedEntry } from './materialize';
import { encodePhoto } from './photos';

/** captures the single update produced by a doc mutation, for the outbox. */
function captureUpdate(doc: Y.Doc, mutate: (doc: Y.Doc) => void): Uint8Array {
	let update: Uint8Array | undefined;
	const onUpdate = (u: Uint8Array) => {
		update = u;
	};
	doc.on('update', onUpdate);
	doc.transact(() => mutate(doc));
	doc.off('update', onUpdate);
	return update ?? Y.encodeStateAsUpdate(doc);
}

async function persist(id: string, doc: Y.Doc, update: Uint8Array): Promise<MaterializedEntry> {
	const db = getDb();
	const now = new Date().toISOString();
	const { entry, tags } = materialize(id, doc, now);

	await db.execBatch([
		{
			sql: `insert into entries
				(id, entry_date, markdown, location_lat, location_lng, location_name, deleted, updated_at)
				values (?, ?, ?, ?, ?, ?, ?, ?)
				on conflict(id) do update set
					entry_date = excluded.entry_date,
					markdown = excluded.markdown,
					location_lat = excluded.location_lat,
					location_lng = excluded.location_lng,
					location_name = excluded.location_name,
					deleted = excluded.deleted,
					updated_at = excluded.updated_at`,
			params: [
				entry.id,
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
		{
			sql: `insert into ydocs (entry_id, snapshot) values (?, ?)
				on conflict(entry_id) do update set snapshot = excluded.snapshot`,
			params: [id, Y.encodeStateAsUpdate(doc)]
		},
		{
			sql: `insert into outbox (entry_id, update_, created_at) values (?, ?, ?)`,
			params: [id, update, now]
		}
	]);

	return entry;
}

export interface EntryEdits {
	entryDate: string;
	markdown: string;
	tags: string[];
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

export async function listEntries(opts: { tag?: string } = {}): Promise<MaterializedEntry[]> {
	const db = getDb();
	if (opts.tag) {
		return db.select<MaterializedEntry>({
			sql: `select e.* from entries e
				join entry_tags t on t.entry_id = e.id
				where e.deleted = 0 and t.tag = ?
				order by e.entry_date desc, e.updated_at desc`,
			params: [opts.tag]
		});
	}
	return db.select<MaterializedEntry>({
		sql: `select * from entries where deleted = 0 order by entry_date desc, updated_at desc`
	});
}

export async function listTags(): Promise<{ tag: string; count: number }[]> {
	const db = getDb();
	return db.select<{ tag: string; count: number }>({
		sql: `select t.tag as tag, count(*) as count from entry_tags t
			join entries e on e.id = t.entry_id
			where e.deleted = 0
			group by t.tag
			order by t.tag asc`
	});
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
