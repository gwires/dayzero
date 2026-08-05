import { getDb } from '$lib/db/client';
import type { PhotoEntry } from '$lib/entries/store';
import { getBlob, putBlob, type SyncConfig } from './api';

/** uploads any attachment not yet marked pushed, one at a time (server dedupes by hash anyway). */
export async function pushPendingBlobs(cfg: SyncConfig): Promise<void> {
	const db = getDb();
	const pending = await db.select<{ id: string; bytes: Uint8Array }>({
		sql: `select id, bytes from attachments where pushed = 0`
	});
	for (const blob of pending) {
		await putBlob(cfg, blob.id, blob.bytes);
		await db.exec({ sql: `update attachments set pushed = 1 where id = ?`, params: [blob.id] });
	}
}

/**
 * fetches and stores any of `wanted` (hashes referenced by newly-pulled docs'
 * photos maps) not already present locally. see PLAN.md "sync": "pull learns
 * needed hashes from the docs' photos maps and fetches any it doesn't have
 * locally".
 */
export async function fetchMissingBlobs(cfg: SyncConfig, wanted: PhotoEntry[]): Promise<void> {
	if (wanted.length === 0) return;
	const db = getDb();

	const ids = [...new Set(wanted.map((w) => w.hash))];
	const placeholders = ids.map(() => '?').join(',');
	const existing = await db.select<{ id: string }>({
		sql: `select id from attachments where id in (${placeholders})`,
		params: ids
	});
	const have = new Set(existing.map((row) => row.id));

	const seen = new Set<string>();
	for (const item of wanted) {
		if (have.has(item.hash) || seen.has(item.hash)) continue;
		seen.add(item.hash);

		const bytes = await getBlob(cfg, item.hash);
		await db.exec({
			sql: `insert into attachments (id, mime, width, height, bytes, pushed) values (?, ?, ?, ?, ?, 1)
				on conflict(id) do nothing`,
			params: [item.hash, item.mime, item.width, item.height, bytes]
		});
	}
}
