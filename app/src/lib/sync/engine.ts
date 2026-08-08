// orchestrates one pull-then-push sync pass, and the app-level wiring that
// decides *when* to run one (start, `online` event, debounced after local
// writes). see PLAN.md "sync" and "encryption", and docs/protocol.md.
import { applyRemoteUpdate } from '$lib/entries/store';
import { applyRemoteDiariesUpdate } from '$lib/diaries/store';
import { DIARIES_DOC_ID } from '$lib/diaries/ids';
import { decryptBytes, encryptBytes } from '$lib/e2ee/crypto';
import { ensureSessionKeyRestored, getSessionKey } from '$lib/e2ee/session';
import { applyRemoteE2eeMetaUpdate } from '$lib/e2ee/store';
import { E2EE_META_DOC_ID } from '$lib/e2ee/ids';
import {
	getSyncCursor,
	getSyncServerUrl,
	getSyncToken,
	getSyncUsername,
	setSyncCursor
} from '$lib/settings/store';
import type { SyncConfig } from './api';
import { pullChanges, pushChanges } from './api';
import { fetchMissingBlobs, pushPendingBlobs } from './blobs';
import { deleteOutboxRows, listOutbox } from './outbox';
import { onLocalWrite } from './notify';

const PULL_PAGE_SIZE = 500;
const OUTBOX_BATCH_SIZE = 500;
const DEBOUNCE_MS = 2000;

/** returns undefined (sync is a no-op, not an error) unless a server, a
 * username, and a token are all configured — same gate as before encryption
 * existed, just with the multi-tenant username added. A missing passphrase
 * does *not* block this: a fresh device must still be able to reach the
 * server to pull the always-plaintext `_e2ee_meta` bootstrap doc before it
 * has any key at all (see pull() below). */
async function getConfig(): Promise<SyncConfig | undefined> {
	const [serverUrl, username, token] = await Promise.all([
		getSyncServerUrl(),
		getSyncUsername(),
		getSyncToken()
	]);
	if (!serverUrl || !username || !token) return undefined;
	return { serverUrl, username, token };
}

/**
 * pulls everything new since our cursor, applying each update and fetching
 * any newly-referenced blobs. `_e2ee_meta` changes are always applied,
 * regardless of whether we have a key yet — that's how a fresh device
 * learns the salt in the first place. The first change after that this
 * device *can't* decrypt (no key) stops the pull right there: the cursor is
 * saved at the last change actually applied, so the next pull resumes
 * exactly there once unlocked, and `locked: true` tells the caller there's
 * real work waiting on a passphrase.
 */
async function pull(cfg: SyncConfig): Promise<{ locked: boolean }> {
	let cursor = await getSyncCursor();
	for (;;) {
		const { changes } = await pullChanges(cfg, cursor, PULL_PAGE_SIZE);
		if (changes.length === 0) return { locked: false };

		for (const change of changes) {
			if (change.entryId === E2EE_META_DOC_ID) {
				await applyRemoteE2eeMetaUpdate(change.update);
				cursor = change.seq;
				continue;
			}

			const key = getSessionKey();
			if (!key) {
				await setSyncCursor(cursor);
				return { locked: true };
			}

			const payload = await decryptBytes(key, change.update);

			// the diary registry travels the same log as entries but is not an
			// entry — apply it to its own doc instead of materializing.
			if (change.entryId === DIARIES_DOC_ID) {
				await applyRemoteDiariesUpdate(payload);
			} else {
				const { photos } = await applyRemoteUpdate(change.entryId, payload);
				if (photos.length > 0) await fetchMissingBlobs(cfg, key, photos);
			}
			cursor = change.seq;
		}

		await setSyncCursor(cursor);
		if (changes.length < PULL_PAGE_SIZE) return { locked: false };
	}
}

/**
 * pushes everything queued locally: doc updates first, then their
 * attachment blobs. Without a key, nothing here can be sent safely (it
 * would either leak plaintext or fail the same push our own `_e2ee_meta`
 * setup already went through) — `locked: true` iff there's actually
 * something queued, so an unconfigured device with zero local writes isn't
 * reported as blocked.
 */
async function push(cfg: SyncConfig): Promise<{ locked: boolean }> {
	const key = getSessionKey();
	if (!key) {
		const rows = await listOutbox(1);
		return { locked: rows.length > 0 };
	}

	for (;;) {
		const rows = await listOutbox(OUTBOX_BATCH_SIZE);
		if (rows.length === 0) break;
		const changes = await Promise.all(
			rows.map(async (r) => ({
				entryId: r.entry_id,
				update: r.entry_id === E2EE_META_DOC_ID ? r.update : await encryptBytes(key, r.update)
			}))
		);
		await pushChanges(cfg, changes);
		await deleteOutboxRows(rows.map((r) => r.rowid));
		if (rows.length < OUTBOX_BATCH_SIZE) break;
	}
	await pushPendingBlobs(cfg, key);
	return { locked: false };
}

export interface SyncResult {
	/** false when no server/token is configured — not an error, just nothing to do. */
	attempted: boolean;
	/** true when there's real work (remote or local) waiting on a passphrase
	 * that hasn't been entered/verified on this device yet — distinct from
	 * `error`: this is expected and recoverable, not a failure. */
	locked?: boolean;
	error?: string;
}

export async function syncOnce(): Promise<SyncResult> {
	const cfg = await getConfig();
	if (!cfg) return { attempted: false };

	try {
		const { locked: pullLocked } = await pull(cfg);
		const { locked: pushLocked } = await push(cfg);
		return { attempted: true, locked: pullLocked || pushLocked };
	} catch (err) {
		return { attempted: true, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * wires the sync engine into the running app: restores this device's
 * unlocked E2EE key (if any) from local settings, then an immediate pass,
 * one on every `online` event, and a debounced one after local writes. call
 * once from the root layout; call the returned cleanup if it's ever torn
 * down.
 */
export function initSyncEngine(): () => void {
	void ensureSessionKeyRestored().then(() => syncOnce());

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
