// persistence + sync for the always-plaintext E2EE bootstrap doc (see
// PLAN.md "encryption"): one well-known Y.Doc, id `_e2ee_meta`, holding the
// PBKDF2 salt/iteration-count and an AES-GCM verifier. Travels through the
// same outbox/log as `_diaries` (reusing meta_ydocs — no schema change),
// but its own updates are never encrypted.
import * as Y from 'yjs';
import { getDb } from '$lib/db/client';
import { notifyLocalWrite } from '$lib/sync/notify';
import { captureUpdate } from '$lib/entries/store';
import {
	checkVerifier,
	computeVerifier,
	deriveKey,
	generateSalt,
	PBKDF2_ITERATIONS
} from './crypto';
import { E2EE_META_DOC_ID } from './ids';
import { getE2eeConfig, setE2eeConfig, type E2eeConfig } from './ydoc';

export async function loadE2eeMetaDoc(): Promise<Y.Doc> {
	const db = getDb();
	const rows = await db.select<{ snapshot: Uint8Array }>({
		sql: `select snapshot from meta_ydocs where doc_id = ?`,
		params: [E2EE_META_DOC_ID]
	});
	const doc = new Y.Doc();
	if (rows.length) Y.applyUpdate(doc, rows[0].snapshot);
	return doc;
}

async function saveE2eeMetaDoc(doc: Y.Doc, outboxUpdate: Uint8Array | null): Promise<void> {
	const db = getDb();
	const stmts = [
		{
			sql: `insert into meta_ydocs (doc_id, snapshot) values (?, ?)
				on conflict(doc_id) do update set snapshot = excluded.snapshot`,
			params: [E2EE_META_DOC_ID, Y.encodeStateAsUpdate(doc)]
		}
	];
	if (outboxUpdate) {
		stmts.push({
			sql: `insert into outbox (entry_id, update_, created_at) values (?, ?, ?)`,
			params: [E2EE_META_DOC_ID, outboxUpdate, new Date().toISOString()]
		});
	}
	await db.execBatch(stmts);
}

/** creates the bootstrap doc's config the first time a passphrase is set on
 * any device — a no-op (returns the pre-existing config unchanged) if one
 * already exists, so a second device doesn't clobber the first device's
 * salt/verifier out from under it. */
async function createE2eeConfig(config: E2eeConfig): Promise<E2eeConfig> {
	const doc = await loadE2eeMetaDoc();
	const existing = getE2eeConfig(doc);
	if (existing) return existing;
	const update = captureUpdate(doc, (d) => setE2eeConfig(d, config));
	await saveE2eeMetaDoc(doc, update);
	notifyLocalWrite();
	return config;
}

/** applies a pulled `_e2ee_meta` update — no outbox (it came from the log). */
export async function applyRemoteE2eeMetaUpdate(update: Uint8Array): Promise<void> {
	const doc = await loadE2eeMetaDoc();
	Y.applyUpdate(doc, update);
	await saveE2eeMetaDoc(doc, null);
}

export type UnlockResult = { ok: true; key: CryptoKey } | { ok: false };

/**
 * the settings page's single entry point for the passphrase field: unlocks
 * against an existing `_e2ee_meta` config if one already exists locally (it
 * always will, on any device that has ever pulled since encryption was set
 * up elsewhere), or bootstraps a brand new one if this is the very first
 * device to ever set a passphrase. Idempotent — safe to call on every blur.
 * Does NOT touch the session cache or persisted key material; the caller
 * (settings page) does that with the returned key on success.
 */
export async function unlockOrCreateE2ee(passphrase: string): Promise<UnlockResult> {
	const doc = await loadE2eeMetaDoc();
	const existing = getE2eeConfig(doc);

	if (existing) {
		const key = await deriveKey(passphrase, existing.salt, existing.iterations);
		return (await checkVerifier(key, existing.verifier)) ? { ok: true, key } : { ok: false };
	}

	const salt = generateSalt();
	const iterations = PBKDF2_ITERATIONS;
	const candidateKey = await deriveKey(passphrase, salt, iterations);
	const verifier = await computeVerifier(candidateKey);
	const config = await createE2eeConfig({ salt, iterations, verifier });

	// createE2eeConfig no-ops (returns a pre-existing config) if another
	// device won a concurrent first-time setup race — fall back to unlocking
	// against whatever won, same as the `existing` branch above. If the user
	// typed the same passphrase on both devices (the common case — it's
	// their own passphrase), this still succeeds transparently.
	if (config.verifier !== verifier) {
		const key = await deriveKey(passphrase, config.salt, config.iterations);
		return (await checkVerifier(key, config.verifier)) ? { ok: true, key } : { ok: false };
	}

	return { ok: true, key: candidateKey };
}
