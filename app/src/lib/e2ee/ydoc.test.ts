import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getE2eeConfig, setE2eeConfig, type E2eeConfig } from './ydoc';

function config(seed: number): E2eeConfig {
	return {
		salt: new Uint8Array([seed, seed + 1, seed + 2]),
		iterations: 600_000 + seed,
		verifier: new Uint8Array([seed + 10, seed + 11])
	};
}

describe('e2ee/ydoc', () => {
	it('has no config on an empty doc', () => {
		const doc = new Y.Doc();
		expect(getE2eeConfig(doc)).toBeUndefined();
	});

	it('round-trips a config through a real Y.Doc update exchange between two docs', () => {
		const a = new Y.Doc();
		setE2eeConfig(a, config(1));

		const b = new Y.Doc();
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		expect(getE2eeConfig(b)).toEqual(config(1));
	});

	it('converges on exactly one whole config when two docs concurrently set different configs', () => {
		const a = new Y.Doc();
		const b = new Y.Doc();

		setE2eeConfig(a, config(1));
		setE2eeConfig(b, config(2));

		const updateA = Y.encodeStateAsUpdate(a);
		const updateB = Y.encodeStateAsUpdate(b);
		Y.applyUpdate(a, updateB);
		Y.applyUpdate(b, updateA);

		const configA = getE2eeConfig(a);
		const configB = getE2eeConfig(b);
		expect(configA).toEqual(configB);
		expect([config(1), config(2)]).toContainEqual(configA);
	});
});
