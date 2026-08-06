// persistence + sync for the diary registry: one well-known Y.Doc (see
// PLAN.md "multiple diaries") whose updates travel through the same outbox
// and /api/changes log as entries, under the reserved id `_diaries`.
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { getDb } from '$lib/db/client';
import { notifyLocalWrite } from '$lib/sync/notify';
import { captureUpdate } from '$lib/entries/store';
import { DEFAULT_DIARY_ID, DIARIES_DOC_ID } from './ids';
import { getDiariesMap, type DiaryMeta } from './ydoc';

export async function loadDiariesDoc(): Promise<Y.Doc> {
	const db = getDb();
	const rows = await db.select<{ snapshot: Uint8Array }>({
		sql: `select snapshot from meta_ydocs where doc_id = ?`,
		params: [DIARIES_DOC_ID]
	});
	const doc = new Y.Doc();
	if (rows.length) Y.applyUpdate(doc, rows[0].snapshot);
	return doc;
}

/** saves the merged snapshot; when `outboxUpdate` is given, also queues it
 * for push (remote applies pass null — same contract as entries). */
async function saveDiariesDoc(doc: Y.Doc, outboxUpdate: Uint8Array | null): Promise<void> {
	const db = getDb();
	const stmts = [
		{
			sql: `insert into meta_ydocs (doc_id, snapshot) values (?, ?)
				on conflict(doc_id) do update set snapshot = excluded.snapshot`,
			params: [DIARIES_DOC_ID, Y.encodeStateAsUpdate(doc)]
		}
	];
	if (outboxUpdate) {
		stmts.push({
			sql: `insert into outbox (entry_id, update_, created_at) values (?, ?, ?)`,
			params: [DIARIES_DOC_ID, outboxUpdate, new Date().toISOString()]
		});
	}
	await db.execBatch(stmts);
}

/** every local registry change funnels through here so the update is always
 * both persisted and queued — an unpushed local yjs op would diverge forever. */
async function mutateDiaries(doc: Y.Doc, fn: (map: Y.Map<DiaryMeta>) => void): Promise<void> {
	const update = captureUpdate(doc, (d) => fn(getDiariesMap(d)));
	await saveDiariesDoc(doc, update);
	notifyLocalWrite();
}

export async function createDiary(doc: Y.Doc, name: string): Promise<string> {
	const id = uuidv7();
	await mutateDiaries(doc, (map) => map.set(id, { name }));
	return id;
}

export async function renameDiary(doc: Y.Doc, id: string, name: string): Promise<void> {
	await mutateDiaries(doc, (map) => map.set(id, { ...map.get(id), name }));
}

export async function deleteDiary(doc: Y.Doc, id: string): Promise<void> {
	if (id === DEFAULT_DIARY_ID) throw new Error('the default diary cannot be deleted');
	await mutateDiaries(doc, (map) => {
		const meta = map.get(id);
		if (meta) map.set(id, { ...meta, deleted: true });
	});
}

/** applies a pulled `_diaries` update — no outbox (it came from the log). */
export async function applyRemoteDiariesUpdate(update: Uint8Array): Promise<void> {
	const doc = await loadDiariesDoc();
	Y.applyUpdate(doc, update);
	await saveDiariesDoc(doc, null);
}
