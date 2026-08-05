/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { migrations } from './migrations';
import type { DbRequest, DbResponse, SqlValue, Statement } from './rpc';

declare const self: DedicatedWorkerGlobalScope;

let db: Database;

async function openDb(): Promise<Database> {
	const sqlite3 = await sqlite3InitModule();
	const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'dayzero-opfs' });
	return new poolUtil.OpfsSAHPoolDb('/dayzero.sqlite');
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
		}
	} catch (err) {
		return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

const ready = openDb().then((conn) => {
	db = conn;
	applyMigrations(db);
	self.postMessage({ id: -1, ok: true, rows: [] } satisfies DbResponse);
});

self.onmessage = async (ev: MessageEvent<DbRequest>) => {
	await ready;
	const res = await handle(ev.data);
	self.postMessage(res);
};
