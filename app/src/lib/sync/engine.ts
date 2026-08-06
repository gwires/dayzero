// orchestrates one pull-then-push sync pass, and the app-level wiring that
// decides *when* to run one (start, `online` event, debounced after local
// writes). see PLAN.md "sync" and docs/protocol.md.
import { applyRemoteUpdate } from '$lib/entries/store';
import { applyRemoteDiariesUpdate } from '$lib/diaries/store';
import { DIARIES_DOC_ID } from '$lib/diaries/ids';
import { getSyncCursor, getSyncServerUrl, getSyncToken, setSyncCursor } from '$lib/settings/store';
import type { SyncConfig } from './api';
import { pullChanges, pushChanges } from './api';
import { fetchMissingBlobs, pushPendingBlobs } from './blobs';
import { deleteOutboxRows, listOutbox } from './outbox';
import { onLocalWrite } from './notify';

const PULL_PAGE_SIZE = 500;
const OUTBOX_BATCH_SIZE = 500;
const DEBOUNCE_MS = 2000;

async function getConfig(): Promise<SyncConfig | undefined> {
	const [serverUrl, token] = await Promise.all([getSyncServerUrl(), getSyncToken()]);
	if (!serverUrl || !token) return undefined;
	return { serverUrl, token };
}

/** pulls everything new since our cursor, applying each update and fetching any newly-referenced blobs. */
async function pull(cfg: SyncConfig): Promise<void> {
	let cursor = await getSyncCursor();
	for (;;) {
		const { changes, cursor: nextCursor } = await pullChanges(cfg, cursor, PULL_PAGE_SIZE);
		if (changes.length === 0) break;

		for (const change of changes) {
			// the diary registry travels the same log as entries but is not an
			// entry — apply it to its own doc instead of materializing.
			if (change.entryId === DIARIES_DOC_ID) {
				await applyRemoteDiariesUpdate(change.update);
				continue;
			}
			const { photos } = await applyRemoteUpdate(change.entryId, change.update);
			if (photos.length > 0) await fetchMissingBlobs(cfg, photos);
		}

		cursor = nextCursor;
		await setSyncCursor(cursor);
		if (changes.length < PULL_PAGE_SIZE) break;
	}
}

/** pushes everything queued locally: doc updates first, then their attachment blobs. */
async function push(cfg: SyncConfig): Promise<void> {
	for (;;) {
		const rows = await listOutbox(OUTBOX_BATCH_SIZE);
		if (rows.length === 0) break;
		await pushChanges(
			cfg,
			rows.map((r) => ({ entryId: r.entry_id, update: r.update }))
		);
		await deleteOutboxRows(rows.map((r) => r.rowid));
		if (rows.length < OUTBOX_BATCH_SIZE) break;
	}
	await pushPendingBlobs(cfg);
}

export interface SyncResult {
	/** false when no server/token is configured — not an error, just nothing to do. */
	attempted: boolean;
	error?: string;
}

export async function syncOnce(): Promise<SyncResult> {
	const cfg = await getConfig();
	if (!cfg) return { attempted: false };

	try {
		await pull(cfg);
		await push(cfg);
		return { attempted: true };
	} catch (err) {
		return { attempted: true, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * wires the sync engine into the running app: an immediate pass, one on
 * every `online` event, and a debounced one after local writes. call once
 * from the root layout; call the returned cleanup if it's ever torn down.
 */
export function initSyncEngine(): () => void {
	void syncOnce();

	const onOnline = () => void syncOnce();
	window.addEventListener('online', onOnline);

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const offLocalWrite = onLocalWrite(() => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => void syncOnce(), DEBOUNCE_MS);
	});

	return () => {
		window.removeEventListener('online', onOnline);
		offLocalWrite();
		clearTimeout(debounceTimer);
	};
}
