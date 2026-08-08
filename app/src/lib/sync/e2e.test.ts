// end-to-end convergence test against a *real* running dayzero-server —
// see server/test-e2e-sync.sh, which builds/starts the server and points
// this at it via env vars, then tears it down. Skipped otherwise, so
// `npm test` never needs a server; this exercises the actual wire protocol
// (docs/protocol.md) that sync/api.test.ts only mocks.
//
// Deliberately doesn't touch entries/store.ts or sqlite: that stack needs a
// browser (OPFS), so "two devices" here are two independent Y.Docs plus
// this module's own pull/push calls — enough to prove the server correctly
// relays updates and that yjs converges regardless of push/pull order,
// without needing two real browser profiles.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { pullChanges, pushChanges, type PulledChange, type SyncConfig } from './api';
import {
	checkVerifier,
	computeVerifier,
	decryptBytes,
	deriveKey,
	encryptBytes,
	generateSalt
} from '$lib/e2ee/crypto';
import { E2EE_META_DOC_ID } from '$lib/e2ee/ids';
import { getE2eeConfig, setE2eeConfig } from '$lib/e2ee/ydoc';

const serverUrl = process.env.DAYZERO_E2E_SERVER_URL;
const username = process.env.DAYZERO_E2E_USERNAME;
const token = process.env.DAYZERO_E2E_TOKEN;

/** a minimal stand-in for entries/store.ts's pull loop, scoped to one entry_id for test isolation. */
async function pullAllFor(
	cfg: SyncConfig,
	entryId: string,
	since: number
): Promise<{ changes: PulledChange[]; cursor: number }> {
	const { changes, cursor } = await pullChanges(cfg, since, 1000);
	return { changes: changes.filter((c) => c.entryId === entryId), cursor };
}

describe.skipIf(!serverUrl || !username || !token)('sync e2e against a real server', () => {
	const cfg: SyncConfig = {
		serverUrl: serverUrl ?? '',
		username: username ?? '',
		token: token ?? ''
	};

	it('two devices converge after concurrent offline edits', async () => {
		const entryId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		// device A creates the entry and pushes it — the only update either
		// device has seen so far.
		const deviceA = new Y.Doc();
		deviceA.getText('text').insert(0, 'hello');
		deviceA.getMap('meta').set('entry_date', '2026-08-05');
		const created = Y.encodeStateAsUpdate(deviceA);
		await pushChanges(cfg, [{ entryId, update: created }]);

		let cursorA = 0;
		{
			const { cursor } = await pullAllFor(cfg, entryId, cursorA);
			cursorA = cursor;
		}

		// device B has never seen this entry before; pulls from scratch and
		// catches up to the same state device A already has.
		const deviceB = new Y.Doc();
		let cursorB = 0;
		{
			const { changes, cursor } = await pullAllFor(cfg, entryId, cursorB);
			for (const change of changes) Y.applyUpdate(deviceB, change.update);
			cursorB = cursor;
		}
		expect(deviceB.getText('text').toString()).toBe('hello');

		// both devices go offline and edit concurrently, on top of the same
		// base state, without seeing each other's edit yet.
		let updateA: Uint8Array | undefined;
		deviceA.on('update', (u: Uint8Array) => (updateA = u));
		deviceA.transact(() => {
			deviceA.getText('text').insert(deviceA.getText('text').length, ' world');
		});

		let updateB: Uint8Array | undefined;
		deviceB.on('update', (u: Uint8Array) => (updateB = u));
		deviceB.transact(() => {
			deviceB.getMap('meta').set('location_name', 'Amsterdam');
		});

		// each pushes its own edit, still unaware of the other's.
		await pushChanges(cfg, [{ entryId, update: updateA! }]);
		await pushChanges(cfg, [{ entryId, update: updateB! }]);

		// now both come back online: A pulls B's edit, B pulls A's edit.
		{
			const { changes } = await pullAllFor(cfg, entryId, cursorA);
			for (const change of changes) Y.applyUpdate(deviceA, change.update);
		}
		{
			const { changes } = await pullAllFor(cfg, entryId, cursorB);
			for (const change of changes) Y.applyUpdate(deviceB, change.update);
		}

		// both devices should now agree, with both edits present.
		expect(deviceA.getText('text').toString()).toBe(deviceB.getText('text').toString());
		expect(deviceA.getText('text').toString()).toBe('hello world');
		expect(deviceA.getMap('meta').toJSON()).toEqual(deviceB.getMap('meta').toJSON());
		expect(deviceA.getMap('meta').get('location_name')).toBe('Amsterdam');
	});

	it('two devices with the same passphrase converge over ciphertext; a wrong passphrase cannot decrypt it', async () => {
		const entryId = `e2e-e2ee-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		// device A bootstraps encryption: generates a salt, derives a key from
		// its own passphrase, and pushes the (always-plaintext) `_e2ee_meta`
		// doc — the same mechanism entries/`_diaries` updates rely on to reach
		// other devices, just never encrypted itself.
		const metaDocA = new Y.Doc();
		const salt = generateSalt();
		const keyA = await deriveKey('correct horse battery staple', salt, 1000);
		const verifier = await computeVerifier(keyA);
		setE2eeConfig(metaDocA, { salt, iterations: 1000, verifier });
		await pushChanges(cfg, [
			{ entryId: E2EE_META_DOC_ID, update: Y.encodeStateAsUpdate(metaDocA) }
		]);

		// device A creates an entry and pushes it encrypted.
		const deviceA = new Y.Doc();
		deviceA.getText('text').insert(0, 'a secret entry');
		const createdPlaintext = Y.encodeStateAsUpdate(deviceA);
		await pushChanges(cfg, [{ entryId, update: await encryptBytes(keyA, createdPlaintext) }]);

		// device B has never synced before: a single pull sees both pushes
		// (the `_e2ee_meta` doc and the encrypted entry). It applies
		// `_e2ee_meta` first regardless of lock state (exactly as
		// sync/engine.ts's pull loop does), derives its own key from the same
		// passphrase + the synced salt, and confirms it via the verifier
		// before trusting it against real data.
		const { changes } = await pullChanges(cfg, 0, 1000);
		const metaUpdate = changes.find((c) => c.entryId === E2EE_META_DOC_ID)!.update;
		const metaDocB = new Y.Doc();
		Y.applyUpdate(metaDocB, metaUpdate);
		const pulledConfig = getE2eeConfig(metaDocB)!;
		const keyB = await deriveKey(
			'correct horse battery staple',
			pulledConfig.salt,
			pulledConfig.iterations
		);
		expect(await checkVerifier(keyB, pulledConfig.verifier)).toBe(true);

		const encryptedEntryUpdate = changes.find((c) => c.entryId === entryId)!.update;

		const deviceB = new Y.Doc();
		Y.applyUpdate(deviceB, await decryptBytes(keyB, encryptedEntryUpdate));
		expect(deviceB.getText('text').toString()).toBe('a secret entry');

		// a third device with the wrong passphrase derives a different key
		// from the same (public) salt, fails the verifier check, and cannot
		// decrypt device A's real ciphertext — AES-GCM's own authentication is
		// what backs "wrong passphrase" detection, not just garbled output.
		const keyC = await deriveKey(
			'wrong passphrase entirely',
			pulledConfig.salt,
			pulledConfig.iterations
		);
		expect(await checkVerifier(keyC, pulledConfig.verifier)).toBe(false);
		await expect(decryptBytes(keyC, encryptedEntryUpdate)).rejects.toThrow();
	});
});
