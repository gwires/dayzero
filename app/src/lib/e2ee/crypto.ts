// PBKDF2-HMAC-SHA256 key derivation + AES-256-GCM authenticated encryption
// for the sync wire payload (see PLAN.md "encryption"). Pure Web Crypto, no
// new dependency — crypto.subtle is available in every runtime this app
// ships to (browsers, the Capacitor Android WebView, and Node's vitest
// environment, which is what lets these unit tests run without a browser).
//
// Encryption is unconditional once a passphrase is set (see sync/engine.ts):
// there's no plaintext/ciphertext ambiguity to resolve per update, so the
// envelope carries no format marker, just an IV.

export const PBKDF2_ITERATIONS = 600_000; // OWASP's current PBKDF2-SHA256 recommendation
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit — the recommended, most-efficient AES-GCM IV size

const VERIFIER_PLAINTEXT = new TextEncoder().encode('dayzero-e2ee-verifier-v1');

// chunked base64 (btoa/atob work on "binary strings"; chunking avoids
// blowing the call stack on String.fromCharCode(...bigArray) — same
// approach as sync/api.ts's bytesToBase64/base64ToBytes).
const CHUNK_SIZE = 0x8000;
function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
	}
	return btoa(binary);
}
function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** derives an extractable AES-256-GCM CryptoKey from a passphrase + salt via
 * PBKDF2-HMAC-SHA256. extractable (not the Web Crypto default) because
 * settings/store.ts needs to export its raw bytes for local persistence. */
export async function deriveKey(
	passphrase: string,
	salt: Uint8Array,
	iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
	const baseKey = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		true,
		['encrypt', 'decrypt']
	);
}

/** AES-256-GCM encrypt: random 12-byte IV || ciphertext+tag. a fresh random
 * IV every call (never counter-based) is safe here because this app's
 * update/photo volume is nowhere near AES-GCM's birthday-bound risk for a
 * 96-bit random IV. */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(plaintext))
	);
	const out = new Uint8Array(IV_BYTES + ciphertext.length);
	out.set(iv, 0);
	out.set(ciphertext, IV_BYTES);
	return out;
}

/** inverse of encryptBytes. Throws if AES-GCM's auth tag doesn't verify
 * (wrong key or corrupt data) — callers let this bubble up rather than
 * handling it specially; see sync/engine.ts. */
export async function decryptBytes(key: CryptoKey, envelope: Uint8Array): Promise<Uint8Array> {
	// copy into fresh Uint8Array<ArrayBuffer>s: `subarray` views (and `envelope`
	// itself, which may come from yjs) are typed Uint8Array<ArrayBufferLike>,
	// which current TS/DOM lib versions don't consider assignable to
	// BufferSource — same pattern as sync/api.ts's putBlob.
	const iv = new Uint8Array(envelope.subarray(0, IV_BYTES));
	const ciphertext = new Uint8Array(envelope.subarray(IV_BYTES));
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
	return new Uint8Array(plaintext);
}

/** encrypts a fixed known plaintext under `key` — stored in `_e2ee_meta` so
 * a later device can tell a candidate passphrase apart from a wrong one
 * before trusting it against real data: AES-GCM's auth tag simply fails to
 * verify under the wrong key, so checkVerifier catching that failure *is*
 * the check. */
export function computeVerifier(key: CryptoKey): Promise<Uint8Array> {
	return encryptBytes(key, VERIFIER_PLAINTEXT);
}

export async function checkVerifier(key: CryptoKey, verifier: Uint8Array): Promise<boolean> {
	try {
		const plaintext = await decryptBytes(key, verifier);
		return (
			plaintext.length === VERIFIER_PLAINTEXT.length &&
			plaintext.every((b, i) => b === VERIFIER_PLAINTEXT[i])
		);
	} catch {
		return false;
	}
}

/** raw key bytes for local persistence (settings/store.ts) — same trust
 * model as the already-plaintext-stored sync bearer token: local
 * sqlite/OPFS is this app's existing trust boundary. Never the passphrase
 * itself. */
export async function exportKeyMaterial(key: CryptoKey): Promise<string> {
	return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export function importKeyMaterial(base64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new Uint8Array(base64ToBytes(base64)),
		{ name: 'AES-GCM' },
		true,
		['encrypt', 'decrypt']
	);
}
