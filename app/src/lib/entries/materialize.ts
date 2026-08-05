import type * as Y from 'yjs';
import { getMeta, getTags, getText } from './ydoc';

export interface MaterializedEntry {
	id: string;
	entry_date: string | null;
	markdown: string;
	location_lat: number | null;
	location_lng: number | null;
	location_name: string | null;
	deleted: 0 | 1;
	updated_at: string;
}

/** derives the plain-column projection of an entry's Y.Doc (source of truth). */
export function materialize(
	id: string,
	doc: Y.Doc,
	updatedAt: string = new Date().toISOString()
): { entry: MaterializedEntry; tags: string[] } {
	const meta = getMeta(doc);
	const tags = getTags(doc);

	return {
		entry: {
			id,
			entry_date: (meta.get('entry_date') as string | undefined) ?? null,
			markdown: getText(doc).toString(),
			location_lat: (meta.get('location_lat') as number | undefined) ?? null,
			location_lng: (meta.get('location_lng') as number | undefined) ?? null,
			location_name: (meta.get('location_name') as string | undefined) ?? null,
			deleted: meta.get('deleted') ? 1 : 0,
			updated_at: updatedAt
		},
		tags: [...tags.keys()].filter((tag) => tags.get(tag) === true).sort()
	};
}
