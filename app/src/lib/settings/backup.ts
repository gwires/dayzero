import { Capacitor } from '@capacitor/core';
import { getDb } from '$lib/db/client';

// btoa expects a binary string, and spreading a large Uint8Array straight
// into String.fromCharCode blows the call stack — chunk it instead.
function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * downloads the entire local database — entries, tags, photos, and settings,
 * all in one file — as a single sqlite file. see PLAN.md "defaults chosen":
 * photos already live inside sqlite as content-addressed blobs specifically
 * so backup/restore is "one file", not a db plus a separate photo directory.
 *
 * inside a Capacitor WebView, a Blob object-URL + `<a download>` silently
 * does nothing, so native writes the file directly and returns where it
 * landed; the web path keeps triggering a browser download and returns
 * nothing.
 */
export async function exportBackup(): Promise<string | void> {
	const bytes = await getDb().exportDb();
	// copy into a fresh Uint8Array<ArrayBuffer>: TS's DOM lib doesn't consider
	// a Uint8Array<ArrayBufferLike> (which is what the worker RPC returns)
	// assignable to BlobPart, since ArrayBufferLike could be a SharedArrayBuffer.
	const bytesCopy = new Uint8Array(bytes);
	const filename = `dayzero-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;

	if (Capacitor.isNativePlatform()) {
		const { Filesystem, Directory } = await import('@capacitor/filesystem');
		const { uri } = await Filesystem.writeFile({
			path: filename,
			data: uint8ArrayToBase64(bytesCopy),
			directory: Directory.Documents
		});
		return uri;
	}

	const blob = new Blob([bytesCopy], { type: 'application/x-sqlite3' });
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
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
