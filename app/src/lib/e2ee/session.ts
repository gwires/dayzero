// in-memory cache of this device's unlocked E2EE key, if any. Cleared on
// reload — restored from settings/store.ts's persisted key material the
// first time anything calls ensureSessionKeyRestored(). Never holds the
// passphrase itself, only the derived CryptoKey.
import { importKeyMaterial } from './crypto';
import { getE2eeKeyMaterial } from '$lib/settings/store';

let sessionKey: CryptoKey | undefined;

export function getSessionKey(): CryptoKey | undefined {
	return sessionKey;
}

export function setSessionKey(key: CryptoKey | undefined): void {
	sessionKey = key;
}

let restored: Promise<void> | undefined;

/**
 * attempts to restore this device's persisted key material into the
 * session cache, at most once — memoized so every caller (the root
 * layout's initSyncEngine(), the settings page's own status check on
 * mount, ...) can safely await it without racing each other or redoing the
 * db read/import more than once per page load.
 */
export function ensureSessionKeyRestored(): Promise<void> {
	if (!restored) {
		restored = (async () => {
			const material = await getE2eeKeyMaterial();
			if (!material) return;
			try {
				sessionKey = await importKeyMaterial(material);
			} catch {
				// corrupt/incompatible persisted key material — stay locked; the
				// user re-enters their passphrase in settings, overwriting it.
			}
		})();
	}
	return restored;
}
