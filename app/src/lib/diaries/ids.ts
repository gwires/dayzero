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
