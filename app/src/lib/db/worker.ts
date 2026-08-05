/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database, SAHPoolUtil } from '@sqlite.org/sqlite-wasm';
import { migrations } from './migrations';
import type { DbRequest, DbResponse, SqlValue, Statement } from './rpc';

declare const self: DedicatedWorkerGlobalScope;

const DB_FILENAME = '/dayzero.sqlite';

let db: Database;
let pool: SAHPoolUtil;

async function openDb(): Promise<Database> {
	const sqlite3 = await sqlite3InitModule();
	pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'dayzero-opfs' });
	return new pool.OpfsSAHPoolDb(DB_FILENAME);
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
				// copy into a fresh, exactly-sized buffer so the caller can
				// safely transfer it (rather than structured-cloning a
				// potentially large sqlite file across the worker boundary).
				const bytes = new Uint8Array(await pool.exportFile(DB_FILENAME));
				return { id: req.id, ok: true, bytes };
			}
			case 'importDb': {
				// the SAH pool VFS manages this file across several handles
				// internally, so a live `Database` can't just be pointed at
				// new bytes — close it, let the pool overwrite the file, then
				// reopen and bring it up to the current schema version (the
				// imported file may be an older export).
				db.close();
				await pool.importDb(DB_FILENAME, req.bytes);
				db = new pool.OpfsSAHPoolDb(DB_FILENAME);
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
