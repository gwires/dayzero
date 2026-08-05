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

const serverUrl = process.env.DAYZERO_E2E_SERVER_URL;
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

describe.skipIf(!serverUrl || !token)('sync e2e against a real server', () => {
	const cfg: SyncConfig = { serverUrl: serverUrl ?? '', token: token ?? '' };

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
});
