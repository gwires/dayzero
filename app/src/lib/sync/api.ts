// thin http client for the sync server's wire protocol — see
// docs/protocol.md. deliberately dumb: no retry/backoff here, that's
// engine.ts's job; this module just knows how to shape one request/response.

export interface SyncConfig {
	serverUrl: string;
	username: string;
	token: string;
}

export interface PushChange {
	entryId: string;
	update: Uint8Array;
}

export interface PulledChange {
	seq: number;
	entryId: string;
	update: Uint8Array;
}

export interface PullResult {
	changes: PulledChange[];
	cursor: number;
}

// JSON has no binary type, so updates travel as base64 (see docs/protocol.md).
// btoa/atob work on "binary strings" (one char per byte), not Uint8Arrays
// directly; chunk the conversion so `String.fromCharCode(...bytes)` doesn't
// blow the call stack on large photos-adjacent updates.
const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function url(cfg: SyncConfig, path: string): string {
	return `${cfg.serverUrl.replace(/\/+$/, '')}/api/${cfg.username}${path}`;
}

async function authedFetch(
	cfg: SyncConfig,
	path: string,
	init: RequestInit = {}
): Promise<Response> {
	const res = await fetch(url(cfg, path), {
		...init,
		headers: { ...init.headers, Authorization: `Bearer ${cfg.token}` }
	});
	if (!res.ok) {
		throw new Error(`sync request failed: ${init.method ?? 'GET'} ${path} -> ${res.status}`);
	}
	return res;
}

export async function pushChanges(cfg: SyncConfig, changes: PushChange[]): Promise<void> {
	if (changes.length === 0) return;
	await authedFetch(cfg, '/changes', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			changes: changes.map((c) => ({
				entry_id: c.entryId,
				update: bytesToBase64(c.update)
			}))
		})
	});
}

export async function pullChanges(
	cfg: SyncConfig,
	since: number,
	limit: number
): Promise<PullResult> {
	const res = await authedFetch(cfg, `/changes?since=${since}&limit=${limit}`);
	const body = (await res.json()) as {
		changes: { seq: number; entry_id: string; update: string }[];
		cursor: number;
	};
	return {
		changes: body.changes.map((c) => ({
			seq: c.seq,
			entryId: c.entry_id,
			update: base64ToBytes(c.update)
		})),
		cursor: body.cursor
	};
}

export async function putBlob(cfg: SyncConfig, hash: string, bytes: Uint8Array): Promise<void> {
	// copy into a fresh Uint8Array<ArrayBuffer>: `bytes` may be typed
	// Uint8Array<ArrayBufferLike> (e.g. coming from sqlite-wasm), which
	// current TS/DOM lib versions don't consider assignable to BlobPart.
	await authedFetch(cfg, `/blobs/${hash}`, {
		method: 'PUT',
		body: new Blob([new Uint8Array(bytes)])
	});
}

export async function getBlob(cfg: SyncConfig, hash: string): Promise<Uint8Array> {
	const res = await authedFetch(cfg, `/blobs/${hash}`);
	return new Uint8Array(await res.arrayBuffer());
}
