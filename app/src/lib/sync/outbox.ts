import { getDb } from '$lib/db/client';

export interface OutboxRow {
	rowid: number;
	entry_id: string;
	update: Uint8Array;
}

/** oldest-first, so a batch pushed together preserves each entry_id's edit order. */
export async function listOutbox(limit: number): Promise<OutboxRow[]> {
	const db = getDb();
	return db.select<OutboxRow>({
		sql: `select rowid as rowid, entry_id as entry_id, update_ as "update" from outbox
			order by rowid asc limit ?`,
		params: [limit]
	});
}

/** deletes exactly these rows (by rowid) — not "all of outbox" — so rows added
 * concurrently with an in-flight push aren't dropped without being sent. */
export async function deleteOutboxRows(rowids: number[]): Promise<void> {
	if (rowids.length === 0) return;
	const db = getDb();
	await db.execBatch(
		rowids.map((rowid) => ({ sql: `delete from outbox where rowid = ?`, params: [rowid] }))
	);
}
