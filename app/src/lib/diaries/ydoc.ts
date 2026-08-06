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
