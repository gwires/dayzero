// message shapes for the typed rpc between the ui thread and the db worker.
export type SqlValue = string | number | Uint8Array | null;

export interface Statement {
	sql: string;
	params?: SqlValue[];
}

export type DbRequest =
	| { id: number; kind: 'exec'; stmt: Statement }
	| { id: number; kind: 'execBatch'; stmts: Statement[] }
	| { id: number; kind: 'select'; stmt: Statement }
	| { id: number; kind: 'exportDb' }
	| { id: number; kind: 'importDb'; bytes: Uint8Array }
	| { id: number; kind: 'clearAllData' };

// plain `Omit<DbRequest, 'id'>` collapses the union to its common properties;
// a distributive omit (naked type param in the `extends` clause) keeps each
// member's own payload shape instead.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DbRequestPayload = DistributiveOmit<DbRequest, 'id'>;

export type DbResponse =
	| { id: number; ok: true; rows: Record<string, SqlValue>[] }
	| { id: number; ok: true; bytes: Uint8Array }
	| { id: number; ok: false; error: string };
