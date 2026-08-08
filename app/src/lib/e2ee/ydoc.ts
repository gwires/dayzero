// pure Y.Doc shape for the E2EE bootstrap doc — see PLAN.md "encryption".
// mirrors diaries/ydoc.ts.
import type * as Y from 'yjs';

/** PBKDF2 salt + iteration count, and an AES-GCM ciphertext of a fixed known
 * plaintext (e2ee/crypto.ts's VERIFIER_PLAINTEXT) used to tell a candidate
 * passphrase apart from a wrong one. Stored as ONE atomic value under a
 * single map key — not three separate keys — so a Y.Map merge between two
 * devices that raced to set up e2ee concurrently (offline, different
 * passphrases) can never mix salt from one setup with a verifier from the
 * other: one whole config wins, deterministically, on every device. */
export interface E2eeConfig {
	salt: Uint8Array;
	iterations: number;
	verifier: Uint8Array;
}

const CONFIG_KEY = 'config';

export function getE2eeMap(doc: Y.Doc): Y.Map<E2eeConfig> {
	return doc.getMap('e2ee');
}

export function getE2eeConfig(doc: Y.Doc): E2eeConfig | undefined {
	return getE2eeMap(doc).get(CONFIG_KEY);
}

export function setE2eeConfig(doc: Y.Doc, config: E2eeConfig): void {
	getE2eeMap(doc).set(CONFIG_KEY, config);
}
