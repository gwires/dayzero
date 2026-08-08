#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env
// pulls the whole change log back with yjs, re-materializes, and compares
// against manifest.json. See TESTGEN-PLAN.md step 6.
import { parseArgs } from '@std/cli';
import { decodeBase64 } from '@std/encoding/base64';
import * as Y from 'yjs';
import { materialize } from './lib/materialize.ts';
import { computeStreak } from './lib/streak.ts';
import { int, mulberry32 } from './lib/rng.ts';

const repoRootUrl = new URL('..', new URL('.', import.meta.url));
const defaultDataDir = new URL('test-data', repoRootUrl).pathname;

interface Conn {
	server: string;
	token: string;
	username: string;
}

interface Manifest {
	seed: number;
	generatedOn: string;
	diaries: { id: string; name: string }[];
	expected: {
		totalEntries: number;
		photoOnlyEntries: number;
		entriesPerDiary: Record<string, number>;
		tagCounts: Record<string, number>;
		totalPhotos: number;
		distinctLocations: number;
		streak: number;
	};
	images: Record<string, { width: number; height: number }>;
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	Deno.exit(1);
}

interface ChangeRow {
	seq: number;
	entry_id: string;
	update: string;
}

async function pullAllChanges(conn: Conn): Promise<ChangeRow[]> {
	const all: ChangeRow[] = [];
	let since = 0;
	const limit = 2000;
	for (;;) {
		const res = await fetch(`${conn.server}/api/${conn.username}/changes?since=${since}&limit=${limit}`, {
			headers: { Authorization: `Bearer ${conn.token}` },
		});
		if (res.status !== 200) {
			fail(`GET /api/${conn.username}/changes failed: ${res.status} ${await res.text()}`);
		}
		const { changes, cursor } = (await res.json()) as { changes: ChangeRow[]; cursor: number };
		all.push(...changes);
		since = cursor;
		if (changes.length < limit) break;
	}
	return all;
}

interface Row {
	name: string;
	expected: unknown;
	actual: unknown;
}

function compareRecord(
	prefix: string,
	expected: Record<string, number>,
	actual: Record<string, number>,
	rows: Row[],
): void {
	const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
	for (const key of [...keys].sort()) {
		rows.push({ name: `${prefix}.${key}`, expected: expected[key] ?? 0, actual: actual[key] ?? 0 });
	}
}

async function main(): Promise<void> {
	const flags = parseArgs(Deno.args, { string: ['data', 'server', 'token', 'username'] });
	const dataDir = flags.data ?? defaultDataDir;
	const server = flags.server ?? Deno.env.get('DAYZERO_SERVER_URL');
	const token = flags.token ?? Deno.env.get('DAYZERO_AUTH_TOKEN');
	const username = flags.username ?? Deno.env.get('DAYZERO_USERNAME');
	if (!server) fail('missing --server (or DAYZERO_SERVER_URL)');
	if (!token) fail('missing --token (or DAYZERO_AUTH_TOKEN)');
	if (!username) fail('missing --username (or DAYZERO_USERNAME)');
	const conn: Conn = { server, token, username };

	const manifest = JSON.parse(await Deno.readTextFile(`${dataDir}/manifest.json`)) as Manifest;

	console.log('==> pulling change log');
	const changes = await pullAllChanges(conn);
	console.log(`    ${changes.length} changes`);

	const docs = new Map<string, Y.Doc>();
	for (const change of changes) {
		let doc = docs.get(change.entry_id);
		if (!doc) {
			doc = new Y.Doc();
			docs.set(change.entry_id, doc);
		}
		Y.applyUpdate(doc, decodeBase64(change.update));
	}

	const rows: Row[] = [];

	// registry check
	const registryDoc = docs.get('_diaries');
	const diariesMap = registryDoc?.getMap('diaries');
	for (const diary of manifest.diaries) {
		const val = diariesMap?.get(diary.id) as { name: string } | undefined;
		rows.push({ name: `diary[${diary.name}].exists`, expected: true, actual: val !== undefined });
		rows.push({ name: `diary[${diary.name}].name`, expected: diary.name, actual: val?.name });
	}

	// materialize every non-registry entry
	const live = [];
	for (const [id, doc] of docs) {
		if (id === '_diaries') continue;
		const entry = materialize(id, doc);
		if (entry.deleted === 0) live.push(entry);
	}

	const totalEntries = live.length;
	const photoOnlyEntries = live.filter((e) => e.markdown === '' && e.photos.length > 0).length;
	const entriesPerDiary: Record<string, number> = {};
	const tagCounts: Record<string, number> = {};
	const photoHashes = new Set<string>();
	const locationNames = new Set<string>();
	const entryDates = new Set<string>();
	for (const e of live) {
		entriesPerDiary[e.diary_id] = (entriesPerDiary[e.diary_id] ?? 0) + 1;
		for (const tag of e.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
		for (const hash of e.photos) photoHashes.add(hash);
		if (e.location_name) locationNames.add(e.location_name);
		if (e.entry_date) entryDates.add(e.entry_date);
	}
	const totalPhotos = photoHashes.size;
	const distinctLocations = locationNames.size;
	const streak = computeStreak(entryDates, new Date(`${manifest.generatedOn}T00:00:00Z`));

	rows.push({ name: 'totalEntries', expected: manifest.expected.totalEntries, actual: totalEntries });
	rows.push({
		name: 'photoOnlyEntries',
		expected: manifest.expected.photoOnlyEntries,
		actual: photoOnlyEntries,
	});
	rows.push({ name: 'totalPhotos', expected: manifest.expected.totalPhotos, actual: totalPhotos });
	rows.push({
		name: 'distinctLocations',
		expected: manifest.expected.distinctLocations,
		actual: distinctLocations,
	});
	rows.push({ name: 'streak', expected: manifest.expected.streak, actual: streak });
	compareRecord('entriesPerDiary', manifest.expected.entriesPerDiary, entriesPerDiary, rows);
	compareRecord('tagCounts', manifest.expected.tagCounts, tagCounts, rows);

	// blob check: every generated image ends up attached exactly once
	rows.push({
		name: 'blobs.distinctHashCount',
		expected: manifest.expected.totalPhotos,
		actual: photoHashes.size,
	});

	console.log('==> spot-checking 25 blobs');
	const hashArray = [...photoHashes];
	const sampleRng = mulberry32(manifest.seed);
	const sampleCount = Math.min(25, hashArray.length);
	const sampledIdx = new Set<number>();
	while (sampledIdx.size < sampleCount && sampledIdx.size < hashArray.length) {
		sampledIdx.add(int(sampleRng, 0, hashArray.length - 1));
	}
	let blobFailures = 0;
	for (const idx of sampledIdx) {
		const hash = hashArray[idx];
		const res = await fetch(`${conn.server}/api/${conn.username}/blobs/${hash}`, {
			headers: { Authorization: `Bearer ${conn.token}` },
		});
		const body = await res.arrayBuffer();
		if (res.status !== 200 || body.byteLength === 0) {
			blobFailures++;
			console.error(`    blob ${hash}: status ${res.status}, ${body.byteLength} bytes`);
		}
	}
	rows.push({ name: 'blobs.spotCheckFailures', expected: 0, actual: blobFailures });

	console.log('');
	console.log('check                                          expected            actual         result');
	console.log('-'.repeat(90));
	let allPass = true;
	for (const row of rows) {
		const pass = JSON.stringify(row.expected) === JSON.stringify(row.actual);
		if (!pass) allPass = false;
		console.log(
			`${row.name.padEnd(46)} ${String(row.expected).padEnd(18)} ${String(row.actual).padEnd(14)} ${
				pass ? 'PASS' : 'FAIL'
			}`,
		);
	}
	console.log('-'.repeat(90));
	console.log(allPass ? 'ALL PASS' : 'SOME CHECKS FAILED');
	if (!allPass) Deno.exit(1);
}

if (import.meta.main) await main();
