#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env
// single-item operations against a dayzero-server, see TESTGEN-PLAN.md step
// 3. Knows nothing about the on-disk test-data format — import-test-data.ts
// is the only thing that shells out to this, once per item.
import { parseArgs } from '@std/cli';
import { encodeBase64 } from '@std/encoding/base64';
import { buildDiaryUpdate, buildEntryUpdate, type EntryFields } from './lib/yjs-entry.ts';

interface Conn {
	server: string;
	token: string;
	username: string;
}

function fail(message: string): never {
	console.error(message);
	Deno.exit(1);
}

function requireFlag(flags: Record<string, unknown>, name: string): string {
	const value = flags[name];
	if (typeof value !== 'string' || value === '') fail(`error: missing --${name}`);
	return value as string;
}

// note: DAYZERO_AUTH_TOKEN post-multi-tenant is the server's own secret, not
// a bearer token — pass the per-username token computed by
// scripts/invite-user.sh (or run-test-server.sh's startup log) as --token.
function getConn(flags: Record<string, unknown>): Conn {
	const server = (flags.server as string | undefined) ?? Deno.env.get('DAYZERO_SERVER_URL');
	const token = (flags.token as string | undefined) ?? Deno.env.get('DAYZERO_AUTH_TOKEN');
	const username = (flags.username as string | undefined) ?? Deno.env.get('DAYZERO_USERNAME');
	if (!server) fail('error: missing --server (or DAYZERO_SERVER_URL)');
	if (!token) fail('error: missing --token (or DAYZERO_AUTH_TOKEN)');
	if (!username) fail('error: missing --username (or DAYZERO_USERNAME)');
	return { server: server.replace(/\/$/, ''), token, username };
}

async function apiRequest(
	conn: Conn,
	method: string,
	path: string,
	body?: BodyInit,
	contentType?: string,
): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${conn.token}` };
	if (contentType) headers['Content-Type'] = contentType;
	const res = await fetch(`${conn.server}${path}`, { method, headers, body });
	if (res.status !== 200) {
		const text = await res.text();
		console.error(`${method} ${path} failed: ${res.status} ${text}`);
		Deno.exit(1);
	}
	return res;
}

async function postChanges(conn: Conn, entryId: string, update: Uint8Array): Promise<void> {
	await apiRequest(
		conn,
		'POST',
		`/api/${conn.username}/changes`,
		JSON.stringify({ changes: [{ entry_id: entryId, update: encodeBase64(update) }] }),
		'application/json',
	);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// Deno.readFile's Uint8Array<ArrayBufferLike> is too broad for
	// crypto.subtle.digest's BufferSource — copy into a plain ArrayBuffer-backed one.
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
	return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cmdHealth(conn: Conn): Promise<void> {
	const res = await apiRequest(conn, 'GET', '/api/health');
	console.log(await res.text());
}

async function cmdDiaryCreate(conn: Conn, flags: Record<string, unknown>): Promise<void> {
	const id = requireFlag(flags, 'id');
	const name = requireFlag(flags, 'name');
	const update = await buildDiaryUpdate(id, name);
	await postChanges(conn, '_diaries', update);
	console.log(JSON.stringify({ id, name }));
}

async function cmdBlobPush(conn: Conn, file: string | undefined): Promise<void> {
	if (!file) fail('error: usage: dayzero-cli blob push <file>');
	const bytes = await Deno.readFile(file);
	const hash = await sha256Hex(bytes);
	await apiRequest(conn, 'PUT', `/api/${conn.username}/blobs/${hash}`, bytes, 'application/octet-stream');
	console.log(JSON.stringify({ hash, bytes: bytes.length }));
}

function parsePhotoSpec(spec: string): { hash: string; mime: string; width: number; height: number } {
	const [hash, mime, dims] = spec.split(':');
	if (!hash || !mime || !dims) fail(`error: invalid --photo spec "${spec}", expected <hash>:<mime>:<WxH>`);
	const [width, height] = dims.split('x').map(Number);
	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		fail(`error: invalid dimensions in --photo spec "${spec}", expected WxH`);
	}
	return { hash, mime, width, height };
}

async function cmdEntryCreate(conn: Conn, flags: Record<string, unknown>): Promise<void> {
	const id = requireFlag(flags, 'id');
	const date = requireFlag(flags, 'date');
	const diaryId = (flags.diary as string | undefined) ?? 'default';
	const textFile = flags['text-file'] as string | undefined;
	const markdown = textFile ? await Deno.readTextFile(textFile) : '';
	const tags = flags.tag as string[];

	const locationName = flags['location-name'] as string | undefined;
	const lat = flags.lat as string | undefined;
	const lng = flags.lng as string | undefined;
	const locationFlagCount = [locationName, lat, lng].filter((v) => v !== undefined).length;
	if (locationFlagCount !== 0 && locationFlagCount !== 3) {
		fail('error: --location-name, --lat, and --lng must appear together or not at all');
	}
	const location = locationFlagCount === 3
		? { name: locationName as string, lat: Number(lat), lng: Number(lng) }
		: undefined;

	const photos = (flags.photo as string[]).map(parsePhotoSpec);

	const fields: EntryFields = { id, entryDate: date, diaryId, markdown, tags, location, photos };
	const update = await buildEntryUpdate(fields);
	await postChanges(conn, id, update);
	console.log(JSON.stringify({ id, bytes: update.length }));
}

const NUMERIC_FLAGS = new Set(['lat', 'lng']);

// parseArgs (minimist-style) misreads `--lng -9.1393` as the short flag
// combo `-9` with value `.1393`, dropping --lng's value entirely — a real
// problem since trip POI longitudes are negative. Rewrite `--flag -N` to
// `--flag=-N` first so parseArgs never sees a bare negative-number token.
function normalizeNegativeNumberArgs(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		const name = tok.startsWith('--') ? tok.slice(2) : undefined;
		const next = argv[i + 1];
		if (name && NUMERIC_FLAGS.has(name) && next !== undefined && /^-\d/.test(next)) {
			out.push(`${tok}=${next}`);
			i++;
		} else {
			out.push(tok);
		}
	}
	return out;
}

async function main(): Promise<void> {
	const [command, ...restAll] = Deno.args;
	// only diary/blob/entry take a subcommand word; health's own args (e.g.
	// --server) would otherwise be misread as one.
	const hasSubcommand = command === 'diary' || command === 'blob' || command === 'entry';
	const subcommand = hasSubcommand ? restAll[0] : undefined;
	const rest = hasSubcommand ? restAll.slice(1) : restAll;
	const flags = parseArgs(normalizeNegativeNumberArgs(rest), {
		string: [
			'server',
			'token',
			'username',
			'id',
			'name',
			'date',
			'diary',
			'text-file',
			'tag',
			'location-name',
			'lat',
			'lng',
			'photo',
		],
		collect: ['tag', 'photo'],
	});
	const conn = getConn(flags);

	if (command === 'health') {
		await cmdHealth(conn);
	} else if (command === 'diary' && subcommand === 'create') {
		await cmdDiaryCreate(conn, flags);
	} else if (command === 'blob' && subcommand === 'push') {
		await cmdBlobPush(conn, flags._[0] as string | undefined);
	} else if (command === 'entry' && subcommand === 'create') {
		await cmdEntryCreate(conn, flags);
	} else {
		fail(
			'usage: dayzero-cli <health | diary create | blob push <file> | entry create> ' +
				'[--server <url>] [--token <t>] [--username <u>] ...',
		);
	}
}

if (import.meta.main) await main();
