import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	base64ToBytes,
	bytesToBase64,
	getBlob,
	pullChanges,
	pushChanges,
	putBlob,
	type SyncConfig
} from './api';

const cfg: SyncConfig = { serverUrl: 'https://sync.example.com', token: 'secret-token' };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bytesToBase64 / base64ToBytes', () => {
	it('round-trips arbitrary bytes, including all 256 byte values', () => {
		const bytes = new Uint8Array(256).map((_, i) => i);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	it('round-trips a payload larger than the chunking threshold', () => {
		const bytes = new Uint8Array(0x8000 + 137).map((_, i) => i % 256);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	it('round-trips an empty array', () => {
		expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
	});
});

describe('pushChanges', () => {
	it('base64-encodes updates and sends them as entry_id/update pairs', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await pushChanges(cfg, [{ entryId: 'entry-1', update: new Uint8Array([1, 2, 3]) }]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://sync.example.com/api/changes');
		expect(init.method).toBe('POST');
		expect(init.headers.Authorization).toBe('Bearer secret-token');
		expect(JSON.parse(init.body)).toEqual({
			changes: [{ entry_id: 'entry-1', update: bytesToBase64(new Uint8Array([1, 2, 3])) }]
		});
	});

	it('does not make a request when there are no changes', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await pushChanges(cfg, []);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws on a non-ok response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

		await expect(pushChanges(cfg, [{ entryId: 'e', update: new Uint8Array() }])).rejects.toThrow(
			'401'
		);
	});
});

describe('pullChanges', () => {
	it('decodes base64 updates and passes since/limit as query params', async () => {
		const serverBody = {
			changes: [{ seq: 5, entry_id: 'entry-1', update: bytesToBase64(new Uint8Array([9, 8, 7])) }],
			cursor: 5
		};
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(serverBody)));
		vi.stubGlobal('fetch', fetchMock);

		const result = await pullChanges(cfg, 2, 100);

		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://sync.example.com/api/changes?since=2&limit=100'
		);
		expect(result.cursor).toBe(5);
		expect(result.changes).toEqual([
			{ seq: 5, entryId: 'entry-1', update: new Uint8Array([9, 8, 7]) }
		]);
	});
});

describe('putBlob / getBlob', () => {
	it('PUTs raw bytes to /api/blobs/<hash>', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await putBlob(cfg, 'abc123', new Uint8Array([1, 2, 3]));

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://sync.example.com/api/blobs/abc123');
		expect(init.method).toBe('PUT');
		expect(init.headers.Authorization).toBe('Bearer secret-token');
	});

	it('GETs and returns raw bytes', async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));

		const result = await getBlob(cfg, 'abc123');

		expect(result).toEqual(bytes);
	});

	it('throws a 404 as an error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

		await expect(getBlob(cfg, 'missing')).rejects.toThrow('404');
	});
});
