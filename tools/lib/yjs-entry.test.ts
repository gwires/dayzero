import { assertEquals } from '@std/assert';
import * as Y from 'yjs';
import { buildDiaryUpdate, buildEntryUpdate, type EntryFields } from './yjs-entry.ts';

const fields: EntryFields = {
	id: '01890a5d-ac96-774b-bcce-b302099a8057',
	entryDate: '2024-03-14',
	diaryId: 'travel',
	markdown: 'First paragraph.\n\nSecond paragraph.',
	tags: ['travel', 'photography'],
	location: { name: 'Lisbon — old town', lat: 38.7223, lng: -9.1393 },
	photos: [{ hash: 'abc123', mime: 'image/jpeg', width: 800, height: 600 }],
};

Deno.test('buildEntryUpdate round-trips every field', async () => {
	const update = await buildEntryUpdate(fields);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, update);

	assertEquals(doc.getText('text').toString(), fields.markdown);
	const meta = doc.getMap('meta');
	assertEquals(meta.get('deleted'), false);
	assertEquals(meta.get('entry_date'), fields.entryDate);
	assertEquals(meta.get('diary_id'), fields.diaryId);
	assertEquals(meta.get('location_lat'), fields.location!.lat);
	assertEquals(meta.get('location_lng'), fields.location!.lng);
	assertEquals(meta.get('location_name'), fields.location!.name);

	const tags = doc.getMap('tags');
	for (const tag of fields.tags) assertEquals(tags.get(tag), true);

	const photos = doc.getMap('photos');
	for (const p of fields.photos) {
		assertEquals(photos.get(p.hash), { mime: p.mime, width: p.width, height: p.height });
	}
});

Deno.test('buildEntryUpdate omits location fields entirely when absent', async () => {
	const update = await buildEntryUpdate({ ...fields, location: undefined });
	const doc = new Y.Doc();
	Y.applyUpdate(doc, update);
	const meta = doc.getMap('meta');
	assertEquals(meta.has('location_lat'), false);
	assertEquals(meta.has('location_lng'), false);
	assertEquals(meta.has('location_name'), false);
});

Deno.test('buildEntryUpdate is deterministic: two builds are byte-identical', async () => {
	const a = await buildEntryUpdate(fields);
	const b = await buildEntryUpdate(fields);
	assertEquals(a, b);
});

Deno.test('applying the same update twice equals applying it once', async () => {
	const update = await buildEntryUpdate(fields);

	const once = new Y.Doc();
	Y.applyUpdate(once, update);

	const twice = new Y.Doc();
	Y.applyUpdate(twice, update);
	Y.applyUpdate(twice, update);

	assertEquals(Y.encodeStateAsUpdate(once), Y.encodeStateAsUpdate(twice));
	assertEquals(twice.getText('text').toString(), fields.markdown);
});

Deno.test('buildDiaryUpdate round-trips onto the registry doc', async () => {
	const update = await buildDiaryUpdate('work', 'work');
	const doc = new Y.Doc();
	Y.applyUpdate(doc, update);
	assertEquals(doc.getMap('diaries').get('work'), { name: 'work' });
});

Deno.test('buildDiaryUpdate is deterministic and merges cleanly across distinct diaries', async () => {
	const a = await buildDiaryUpdate('work', 'work');
	const b = await buildDiaryUpdate('work', 'work');
	assertEquals(a, b);

	const travel = await buildDiaryUpdate('travel', 'travel');
	const registry = new Y.Doc();
	Y.applyUpdate(registry, a);
	Y.applyUpdate(registry, travel);
	assertEquals(registry.getMap('diaries').get('work'), { name: 'work' });
	assertEquals(registry.getMap('diaries').get('travel'), { name: 'travel' });
});
