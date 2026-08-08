import type { DbRequest, DbRequestPayload, DbResponse, SqlValue, Statement } from './rpc';

export class DbClient {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, (res: DbResponse) => void>();
	private ready: Promise<void>;

	constructor() {
		this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		this.ready = new Promise((resolve, reject) => {
			const onReady = (ev: MessageEvent<DbResponse>) => {
				if (ev.data.id !== -1) return;
				this.worker.removeEventListener('message', onReady);
				if (ev.data.ok) resolve();
				else reject(new Error(`local database failed to open: ${ev.data.error}`));
			};
			this.worker.addEventListener('message', onReady);
			// if the worker script itself fails to load, no ready message ever
			// arrives — every query would hang without this.
			this.worker.addEventListener('error', (ev) => {
				reject(new Error(`db worker failed to start: ${ev.message || 'unknown error'}`));
			});
		});
		this.worker.addEventListener('message', (ev: MessageEvent<DbResponse>) => {
			const res = ev.data;
			if (res.id === -1) return;
			const resolve = this.pending.get(res.id);
			if (!resolve) return;
			this.pending.delete(res.id);
			resolve(res);
		});
	}

	private async send(req: DbRequestPayload, transfer: Transferable[] = []): Promise<DbResponse> {
		await this.ready;
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.worker.postMessage({ ...req, id } as DbRequest, transfer);
		});
	}

	async exec(stmt: Statement): Promise<void> {
		const res = await this.send({ kind: 'exec', stmt });
		if (!res.ok) throw new Error(res.error);
	}

	async execBatch(stmts: Statement[]): Promise<void> {
		const res = await this.send({ kind: 'execBatch', stmts });
		if (!res.ok) throw new Error(res.error);
	}

	async select<T = Record<string, SqlValue>>(stmt: Statement): Promise<T[]> {
		const res = await this.send({ kind: 'select', stmt });
		if (!res.ok) throw new Error(res.error);
		if (!('rows' in res)) throw new Error('unexpected response to select');
		return res.rows as T[];
	}

	/** exports the whole local database as a single sqlite file, for backup (see `/settings`). */
	async exportDb(): Promise<Uint8Array> {
		const res = await this.send({ kind: 'exportDb' });
		if (!res.ok) throw new Error(res.error);
		if (!('bytes' in res)) throw new Error('unexpected response to exportDb');
		return res.bytes;
	}

	/** overwrites the whole local database with the contents of a previously exported file. */
	async importDb(bytes: Uint8Array): Promise<void> {
		const res = await this.send({ kind: 'importDb', bytes }, [bytes.buffer]);
		if (!res.ok) throw new Error(res.error);
	}

	/** deletes all local data — entries, tags, photos, diaries, settings. */
	async clearAllData(): Promise<void> {
		const res = await this.send({ kind: 'clearAllData' });
		if (!res.ok) throw new Error(res.error);
	}
}

let instance: DbClient | undefined;

/** lazily creates the (singleton) worker-backed db client. browser-only. */
export function getDb(): DbClient {
	if (!instance) instance = new DbClient();
	return instance;
}
