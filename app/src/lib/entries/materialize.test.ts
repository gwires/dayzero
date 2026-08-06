import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getMeta, getTags, getText } from './ydoc';
import { materialize } from './materialize';

function baseDoc(): Y.Doc {
	const doc = new Y.Doc();
	getMeta(doc).set('entry_date', '2026-08-05');
	getMeta(doc).set('deleted', false);
	getText(doc).insert(0, 'Started the day well.');
	getTags(doc).set('mood', true);
	return doc;
}

/** two devices start from the same base doc, then edit independently while offline. */
function diverge(): { a: Y.Doc; b: Y.Doc } {
	const a = baseDoc();
	const b = new Y.Doc();
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

	getText(a).insert(getText(a).length, ' Went for a run.');
	getTags(a).set('sunny', true);
	getMeta(a).set('location_name', 'Amsterdam');

	getText(b).insert(0, 'Woke up early. ');
	getTags(b).set('family', true);
	getTags(b).delete('mood');
	getMeta(b).set('location_lat', 52.37);

	return { a, b };
}

describe('materialize', () => {
	it('defaults an empty doc to blank fields', () => {
		const doc = new Y.Doc();
		const { entry, tags } = materialize('entry-empty', doc, '2026-01-01T00:00:00.000Z');
		expect(entry).toEqual({
			id: 'entry-empty',
			diary_id: 'default',
			entry_date: null,
			markdown: '',
			location_lat: null,
			location_lng: null,
			location_name: null,
			deleted: 0,
			updated_at: '2026-01-01T00:00:00.000Z'
		});
		expect(tags).toEqual([]);
	});

	it('converges to identical state regardless of merge order', () => {
		const { a, b } = diverge();
		const updateA = Y.encodeStateAsUpdate(a);
		const updateB = Y.encodeStateAsUpdate(b);

		const mergedAB = new Y.Doc();
		Y.applyUpdate(mergedAB, updateA);
		Y.applyUpdate(mergedAB, updateB);

		const mergedBA = new Y.Doc();
		Y.applyUpdate(mergedBA, updateB);
		Y.applyUpdate(mergedBA, updateA);

		// same underlying yjs state regardless of application order
		expect(getText(mergedAB).toString()).toBe(getText(mergedBA).toString());
		expect(getTags(mergedAB).toJSON()).toEqual(getTags(mergedBA).toJSON());
		expect(getMeta(mergedAB).toJSON()).toEqual(getMeta(mergedBA).toJSON());

		// and identical materialized sql rows
		const asOfAB = materialize('entry-1', mergedAB, '2026-08-05T12:00:00.000Z');
		const asOfBA = materialize('entry-1', mergedBA, '2026-08-05T12:00:00.000Z');
		expect(asOfAB).toEqual(asOfBA);

		// concurrent, non-conflicting edits from both sides all survive
		expect(asOfAB.tags).toEqual(['family', 'sunny']);
		expect(asOfAB.entry.location_name).toBe('Amsterdam');
		expect(asOfAB.entry.location_lat).toBeCloseTo(52.37);
		expect(asOfAB.entry.markdown).toContain('Woke up early.');
		expect(asOfAB.entry.markdown).toContain('Went for a run.');
	});

	it('is idempotent under duplicate/replayed updates', () => {
		const { a, b } = diverge();
		const updateB = Y.encodeStateAsUpdate(b);

		const doc = new Y.Doc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(a));
		Y.applyUpdate(doc, updateB);
		const once = materialize('entry-1', doc, 'fixed');

		Y.applyUpdate(doc, updateB);
		Y.applyUpdate(doc, updateB);
		const thrice = materialize('entry-1', doc, 'fixed');

		expect(thrice).toEqual(once);
	});

	it('propagates a deletion tombstone like any other edit', () => {
		const a = baseDoc();
		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		getMeta(a).set('deleted', true);

		const merged = new Y.Doc();
		Y.applyUpdate(merged, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(merged, Y.encodeStateAsUpdate(a));

		expect(materialize('entry-1', merged).entry.deleted).toBe(1);
	});

	it('materializes diary_id as "default" when the doc has no such key', () => {
		const doc = baseDoc();
		expect(materialize('entry-1', doc).entry.diary_id).toBe('default');
	});

	it('materializes diary_id from meta.diary_id when set', () => {
		const doc = baseDoc();
		getMeta(doc).set('diary_id', 'abc');
		expect(materialize('entry-1', doc).entry.diary_id).toBe('abc');
	});
});
