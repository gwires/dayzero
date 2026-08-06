import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getDiariesMap, listDiaries } from './ydoc';

describe('diaries/ydoc', () => {
	it('lists exactly the virtual default diary on an empty doc', () => {
		const doc = new Y.Doc();
		expect(listDiaries(doc)).toEqual([{ id: 'default', name: 'journal' }]);
	});

	it('lists diaries sorted by name, after the default', () => {
		const doc = new Y.Doc();
		const map = getDiariesMap(doc);
		map.set('id-work', { name: 'work' });
		map.set('id-travel', { name: 'travel' });

		expect(listDiaries(doc)).toEqual([
			{ id: 'default', name: 'journal' },
			{ id: 'id-travel', name: 'travel' },
			{ id: 'id-work', name: 'work' }
		]);
	});

	it('lets a map entry under "default" override the default diary name, without duplicating it', () => {
		const doc = new Y.Doc();
		getDiariesMap(doc).set('default', { name: 'my journal' });

		expect(listDiaries(doc)).toEqual([{ id: 'default', name: 'my journal' }]);
	});

	it('hides a diary tombstoned with deleted: true', () => {
		const doc = new Y.Doc();
		const map = getDiariesMap(doc);
		map.set('id-work', { name: 'work' });
		map.set('id-work', { name: 'work', deleted: true });

		expect(listDiaries(doc)).toEqual([{ id: 'default', name: 'journal' }]);
	});

	it('converges when two docs each create a different diary offline', () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		getDiariesMap(a).set('id-work', { name: 'work' });
		getDiariesMap(b).set('id-travel', { name: 'travel' });

		const updateA = Y.encodeStateAsUpdate(a);
		const updateB = Y.encodeStateAsUpdate(b);
		Y.applyUpdate(a, updateB);
		Y.applyUpdate(b, updateA);

		const listA = listDiaries(a);
		const listB = listDiaries(b);
		expect(listA).toEqual(listB);
		expect(listA).toEqual([
			{ id: 'default', name: 'journal' },
			{ id: 'id-travel', name: 'travel' },
			{ id: 'id-work', name: 'work' }
		]);
	});

	it('agrees on the same outcome after a concurrent rename vs delete of the same diary', () => {
		const a = new Y.Doc();
		getDiariesMap(a).set('id-work', { name: 'work' });

		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		getDiariesMap(a).set('id-work', { name: 'job' });
		getDiariesMap(b).set('id-work', { name: 'work', deleted: true });

		const updateA = Y.encodeStateAsUpdate(a);
		const updateB = Y.encodeStateAsUpdate(b);
		Y.applyUpdate(a, updateB);
		Y.applyUpdate(b, updateA);

		expect(listDiaries(a)).toEqual(listDiaries(b));
	});
});
