import { describe, expect, it } from 'vitest';
import {
	checkVerifier,
	computeVerifier,
	decryptBytes,
	deriveKey,
	encryptBytes,
	exportKeyMaterial,
	generateSalt,
	importKeyMaterial
} from './crypto';

describe('e2ee/crypto', () => {
	it('derives interoperable keys from the same passphrase, salt, and iterations', async () => {
		const salt = generateSalt();
		const keyA = await deriveKey('correct horse', salt, 1000);
		const keyB = await deriveKey('correct horse', salt, 1000);

		const plaintext = new TextEncoder().encode('hello diary');
		const envelope = await encryptBytes(keyA, plaintext);
		expect(await decryptBytes(keyB, envelope)).toEqual(plaintext);
	});

	it('fails to decrypt when the passphrase differs', async () => {
		const salt = generateSalt();
		const right = await deriveKey('correct horse', salt, 1000);
		const wrong = await deriveKey('battery staple', salt, 1000);

		const envelope = await encryptBytes(right, new TextEncoder().encode('secret'));
		await expect(decryptBytes(wrong, envelope)).rejects.toThrow();
	});

	it('fails to decrypt when the salt differs', async () => {
		const right = await deriveKey('correct horse', generateSalt(), 1000);
		const wrong = await deriveKey('correct horse', generateSalt(), 1000);

		const envelope = await encryptBytes(right, new TextEncoder().encode('secret'));
		await expect(decryptBytes(wrong, envelope)).rejects.toThrow();
	});

	it('round-trips arbitrary bytes, including empty input', async () => {
		const key = await deriveKey('correct horse', generateSalt(), 1000);

		const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 42]);
		expect(await decryptBytes(key, await encryptBytes(key, bytes))).toEqual(bytes);

		const empty = new Uint8Array(0);
		expect(await decryptBytes(key, await encryptBytes(key, empty))).toEqual(empty);
	});

	it('uses a fresh random IV on every call, so the same plaintext never produces the same envelope twice', async () => {
		const key = await deriveKey('correct horse', generateSalt(), 1000);
		const plaintext = new TextEncoder().encode('same content every time');

		const first = await encryptBytes(key, plaintext);
		const second = await encryptBytes(key, plaintext);
		expect(first).not.toEqual(second);
	});

	it('accepts a verifier computed under the same key, and rejects one computed under a different key', async () => {
		const salt = generateSalt();
		const right = await deriveKey('correct horse', salt, 1000);
		const wrong = await deriveKey('battery staple', salt, 1000);

		const verifier = await computeVerifier(right);
		expect(await checkVerifier(right, verifier)).toBe(true);
		expect(await checkVerifier(wrong, verifier)).toBe(false);
	});

	it('round-trips a key through exportKeyMaterial/importKeyMaterial', async () => {
		const original = await deriveKey('correct horse', generateSalt(), 1000);
		const restored = await importKeyMaterial(await exportKeyMaterial(original));

		const plaintext = new TextEncoder().encode('still readable after export/import');
		const envelope = await encryptBytes(original, plaintext);
		expect(await decryptBytes(restored, envelope)).toEqual(plaintext);
	});
});
