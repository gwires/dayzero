/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database, SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { migrations } from './migrations';
import type { DbRequest, DbResponse, SqlValue, Statement } from './rpc';

declare const self: DedicatedWorkerGlobalScope;

const DB_FILENAME = '/dayzero.sqlite';

let db: Database;
let pool: SAHPoolUtil | null;
let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;

async function openDb(): Promise<Database> {
	sqlite3 = await sqlite3InitModule();
	try {
		pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'dayzero-opfs' });
		return new pool.OpfsSAHPoolDb(DB_FILENAME);
	} catch (err) {
		// SAH pool can fail with "No modification allowed" when OPFS handles
		// are read-only (storage partitioning, third-party cookie blocking, or
		// an existing file locked by another tab). Fall back to the simpler
		// opfs VFS which uses the direct OPFS file API without SAH pooling.
		if (err instanceof Error && err.message.includes('modification')) {
			pool = null;
			const vfsName = 'opfs';
			await sqlite3.installOpfsVfs({ name: vfsName, default: true });
			return new sqlite3.oo1.DB(DB_FILENAME, { vfs: vfsName, create: true });
		}
		throw err;
	}
}

function applyMigrations(conn: Database) {
	const currentVersion = conn.selectValue('pragma user_version') as number;
	for (let i = currentVersion; i < migrations.length; i++) {
		conn.transaction((t) => {
			t.exec(migrations[i]);
			t.exec(`pragma user_version = ${i + 1}`);
		});
	}
}

function runStatement(stmt: Statement): Record<string, SqlValue>[] {
	return db.exec(stmt.sql, {
		bind: stmt.params ?? [],
		rowMode: 'object',
		returnValue: 'resultRows'
	}) as unknown as Record<string, SqlValue>[];
}

async function handle(req: DbRequest): Promise<DbResponse> {
	try {
		switch (req.kind) {
			case 'exec': {
				const rows = runStatement(req.stmt);
				return { id: req.id, ok: true, rows };
			}
			case 'execBatch': {
				db.transaction(() => {
					for (const stmt of req.stmts) runStatement(stmt);
				});
				return { id: req.id, ok: true, rows: [] };
			}
			case 'select': {
				const rows = runStatement(req.stmt);
				return { id: req.id, ok: true, rows };
			}
			case 'exportDb': {
				if (pool) {
					const bytes = new Uint8Array(await pool.exportFile(DB_FILENAME));
					return { id: req.id, ok: true, bytes };
				}
				// fallback: serialize from the db pointer directly
				const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer);
				return { id: req.id, ok: true, bytes };
			}
			case 'importDb': {
				if (pool) {
					db.close();
					await pool.importDb(DB_FILENAME, req.bytes);
					db = new pool.OpfsSAHPoolDb(DB_FILENAME);
				} else {
					db.close();
					await sqlite3.oo1.OpfsDb.importDb(DB_FILENAME, req.bytes);
					db = new sqlite3.oo1.OpfsDb(DB_FILENAME);
				}
				applyMigrations(db);
				return { id: req.id, ok: true, rows: [] };
			}
			case 'clearAllData': {
				if (pool) {
					db.close();
					pool.unlink(DB_FILENAME);
					db = new pool.OpfsSAHPoolDb(DB_FILENAME);
				} else {
					db.close();
					const root = await navigator.storage.getDirectory();
					const dir = await root.getDirectoryHandle('opfs', { create: true });
					try {
						await dir.removeEntry(DB_FILENAME.replace(/^\//, ''));
					} catch {
						// file may not exist if the db was just created
					}
					db = new sqlite3.oo1.OpfsDb(DB_FILENAME);
				}
				applyMigrations(db);
				return { id: req.id, ok: true, rows: [] };
			}
		}
	} catch (err) {
		return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// if opening the database fails (e.g. no OPFS because of an insecure context
// or an old browser), remember why: the ready promise must still resolve so
// requests get an error response instead of hanging the client forever.
let initError: string | undefined;

const ready = openDb()
	.then((conn) => {
		db = conn;
		applyMigrations(db);
		self.postMessage({ id: -1, ok: true, rows: [] } satisfies DbResponse);
	})
	.catch((err: unknown) => {
		initError = err instanceof Error ? err.message : String(err);
		self.postMessage({ id: -1, ok: false, error: initError } satisfies DbResponse);
	});

self.onmessage = async (ev: MessageEvent<DbRequest>) => {
	await ready;
	if (initError !== undefined) {
		self.postMessage({ id: ev.data.id, ok: false, error: initError } satisfies DbResponse);
		return;
	}
	const res = await handle(ev.data);
	if (res.ok && 'bytes' in res) self.postMessage(res, [res.bytes.buffer]);
	else self.postMessage(res);
};
