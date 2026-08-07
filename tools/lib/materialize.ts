// port of app/src/lib/entries/materialize.ts for the verifier — same
// semantics, not imported across the app's $lib aliases (see
// TESTGEN-PLAN.md step 2). Keep in lockstep with the app original.
import type * as Y from 'yjs';

export const DEFAULT_DIARY_ID = 'default';

export interface MaterializedEntry {
	id: string;
	diary_id: string;
	entry_date: string | null;
	markdown: string;
	location_lat: number | null;
	location_lng: number | null;
	location_name: string | null;
	deleted: 0 | 1;
	photos: string[];
	tags: string[];
}

/** derives the plain-column projection of an entry's Y.Doc (source of truth). */
export function materialize(id: string, doc: Y.Doc): MaterializedEntry {
	const meta = doc.getMap('meta');
	const tags = doc.getMap('tags');
	const photos = doc.getMap('photos');

	return {
		id,
		diary_id: (meta.get('diary_id') as string | undefined) ?? DEFAULT_DIARY_ID,
		entry_date: (meta.get('entry_date') as string | undefined) ?? null,
		markdown: doc.getText('text').toString(),
		location_lat: (meta.get('location_lat') as number | undefined) ?? null,
		location_lng: (meta.get('location_lng') as number | undefined) ?? null,
		location_name: (meta.get('location_name') as string | undefined) ?? null,
		deleted: meta.get('deleted') ? 1 : 0,
		tags: [...tags.keys()].filter((tag) => tags.get(tag) === true).sort(),
		photos: [...photos.keys()].sort(),
	};
}
