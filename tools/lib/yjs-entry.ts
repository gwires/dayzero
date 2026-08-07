// the one place yjs docs are constructed. mirrors createEntry/applyEdits in
// app/src/lib/entries/store.ts exactly (see TESTGEN-PLAN.md "background —
// what an entry is on the wire") so the server never has to know these
// updates didn't come from the real app.
import * as Y from 'yjs';
import { clientIdFrom } from './ids.ts';

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
	doc.clientID = await clientIdFrom(f.id);
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
		for (const p of f.photos) {
			doc.getMap('photos').set(p.hash, { mime: p.mime, width: p.width, height: p.height });
		}
	});
	return Y.encodeStateAsUpdate(doc);
}

export async function buildDiaryUpdate(diaryId: string, name: string): Promise<Uint8Array> {
	const doc = new Y.Doc();
	doc.clientID = await clientIdFrom('_diaries:' + diaryId);
	doc.transact(() => {
		doc.getMap('diaries').set(diaryId, { name });
	});
	return Y.encodeStateAsUpdate(doc);
}
