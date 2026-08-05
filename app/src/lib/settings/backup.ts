import { getDb } from '$lib/db/client';

/**
 * downloads the entire local database — entries, tags, photos, and settings,
 * all in one file — as a single sqlite file. see PLAN.md "defaults chosen":
 * photos already live inside sqlite as content-addressed blobs specifically
 * so backup/restore is "one file", not a db plus a separate photo directory.
 */
export async function exportBackup(): Promise<void> {
	const bytes = await getDb().exportDb();
	// copy into a fresh Uint8Array<ArrayBuffer>: TS's DOM lib doesn't consider
	// a Uint8Array<ArrayBufferLike> (which is what the worker RPC returns)
	// assignable to BlobPart, since ArrayBufferLike could be a SharedArrayBuffer.
	const blob = new Blob([new Uint8Array(bytes)], { type: 'application/x-sqlite3' });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = `dayzero-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
		a.click();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** replaces all local data with the contents of a previously exported sqlite file. */
export async function importBackup(file: File): Promise<void> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	await getDb().importDb(bytes);
}
