import type { DbRequest, DbRequestPayload, DbResponse, SqlValue, Statement } from './rpc';

export class DbClient {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (rows: Record<string, SqlValue>[]) => void; reject: (err: Error) => void }
	>();
	private ready: Promise<void>;

	constructor() {
		this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		this.ready = new Promise((resolve) => {
			const onReady = (ev: MessageEvent<DbResponse>) => {
				if (ev.data.id === -1) {
					this.worker.removeEventListener('message', onReady);
					resolve();
				}
			};
			this.worker.addEventListener('message', onReady);
		});
		this.worker.addEventListener('message', (ev: MessageEvent<DbResponse>) => {
			const res = ev.data;
			if (res.id === -1) return;
			const entry = this.pending.get(res.id);
			if (!entry) return;
			this.pending.delete(res.id);
			if (res.ok) entry.resolve(res.rows);
			else entry.reject(new Error(res.error));
		});
	}

	private async send(req: DbRequestPayload): Promise<Record<string, SqlValue>[]> {
		await this.ready;
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker.postMessage({ ...req, id } as DbRequest);
		});
	}

	async exec(stmt: Statement): Promise<void> {
		await this.send({ kind: 'exec', stmt });
	}

	async execBatch(stmts: Statement[]): Promise<void> {
		await this.send({ kind: 'execBatch', stmts });
	}

	async select<T = Record<string, SqlValue>>(stmt: Statement): Promise<T[]> {
		return (await this.send({ kind: 'select', stmt })) as T[];
	}
}

let instance: DbClient | undefined;

/** lazily creates the (singleton) worker-backed db client. browser-only. */
export function getDb(): DbClient {
	if (!instance) instance = new DbClient();
	return instance;
}
