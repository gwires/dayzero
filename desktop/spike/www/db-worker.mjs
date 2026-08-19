import sqlite3InitModule from './sqlite/index.mjs';

const post = (step, ok, detail) => postMessage({ step, ok, detail });

post(
	`worker context: isSecureContext=${self.isSecureContext}, navigator.storage=${!!self.navigator.storage}, getDirectory=${typeof self.navigator.storage?.getDirectory}`,
	true
);

// Probe the raw OPFS SAH primitives directly, independent of sqlite-wasm.
async function probeOpfs() {
	try {
		const root = await self.navigator.storage.getDirectory();
		post('worker: navigator.storage.getDirectory() resolved', true);
		const fh = await root.getFileHandle('spike-probe', { create: true });
		post('worker: getFileHandle(create)', true);
		const sah = await fh.createSyncAccessHandle();
		post('worker: createSyncAccessHandle()', true);
		sah.close();
		await root.removeEntry('spike-probe');
	} catch (e) {
		post('worker: raw OPFS probe failed', false, `${e?.name}: ${e?.message}`);
	}
}

await probeOpfs();

async function main() {
	let sqlite3;
	try {
		sqlite3 = await sqlite3InitModule();
		post(`sqlite-wasm initialized in worker (sqlite ${sqlite3.version.libVersion})`, true);
	} catch (e) {
		post('sqlite-wasm initialization in worker', false, String(e));
		return;
	}

	let pool;
	try {
		// This is the call that needs createSyncAccessHandle support.
		pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'spike-opfs' });
		post('installOpfsSAHPoolVfs (OPFS sync access handles)', true, `capacity: ${pool.getCapacity()}`);
	} catch (e) {
		post('installOpfsSAHPoolVfs (OPFS sync access handles)', false, String(e));
		return;
	}

	const DB = '/spike.sqlite';
	try {
		let written;
		{
			const db = new pool.OpfsSAHPoolDb(DB);
			db.exec('create table if not exists spike(id integer primary key, ts text)');
			db.exec({ sql: 'insert into spike(ts) values (?)', bind: [new Date().toISOString()] });
			written = db.selectValue('select count(*) from spike');
			db.close();
		}
		{
			// Reopen to prove the data survived closing the handle.
			const db = new pool.OpfsSAHPoolDb(DB);
			const count = db.selectValue('select count(*) from spike');
			db.close();
			if (count !== written) throw new Error(`read-back mismatch: ${count} != ${written}`);
			post(`sqlite round-trip on OPFS (row count: ${count})`, true, 'reload the window — the count should increase');
		}
	} catch (e) {
		post('sqlite round-trip on OPFS', false, String(e));
		return;
	}

	post('ALL CHECKS PASSED — OPFS SAH pool works in this webview', true);
}

main();
