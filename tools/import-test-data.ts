#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-run
// walks the on-disk test-data tree and drives dayzero-cli once per item.
// Never constructs yjs docs itself. See TESTGEN-PLAN.md step 5.
import { parseArgs } from '@std/cli';
import { parse as parseYaml } from '@std/yaml';
import { splitFrontmatter } from './lib/frontmatter.ts';
import { uuidFromHash } from './lib/ids.ts';

const toolsDirUrl = new URL('.', import.meta.url);
const cliPath = new URL('dayzero-cli.ts', toolsDirUrl).pathname;
const repoRootUrl = new URL('..', toolsDirUrl);
const defaultDataDir = new URL('test-data', repoRootUrl).pathname;

interface Conn {
	server: string;
	token: string;
}

interface Manifest {
	seed: number;
	generatedOn: string;
	diaries: { id: string; name: string }[];
	expected: Record<string, unknown>;
	images: Record<string, { width: number; height: number }>;
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	Deno.exit(1);
}

async function runCli(args: string[], conn: Conn): Promise<string> {
	const cmd = new Deno.Command(Deno.execPath(), {
		args: [
			'run',
			'--allow-net',
			'--allow-read',
			'--allow-env',
			cliPath,
			...args,
			'--server',
			conn.server,
			'--token',
			conn.token,
		],
		stdout: 'piped',
		stderr: 'piped',
	});
	const { code, stdout, stderr } = await cmd.output();
	if (code !== 0) {
		fail(`dayzero-cli ${args.join(' ')} failed:\n${new TextDecoder().decode(stderr)}`);
	}
	return new TextDecoder().decode(stdout).trim();
}

interface DayFolder {
	dateIso: string;
	dir: string;
}

async function subDirs(dir: string): Promise<string[]> {
	const names: string[] = [];
	for await (const entry of Deno.readDir(dir)) if (entry.isDirectory) names.push(entry.name);
	names.sort();
	return names;
}

async function listDayFolders(dataDir: string): Promise<DayFolder[]> {
	const days: DayFolder[] = [];
	for (const year of await subDirs(dataDir)) {
		for (const month of await subDirs(`${dataDir}/${year}`)) {
			for (const day of await subDirs(`${dataDir}/${year}/${month}`)) {
				days.push({ dateIso: `${year}-${month}-${day}`, dir: `${dataDir}/${year}/${month}/${day}` });
			}
		}
	}
	return days;
}

function entryFileNum(name: string): number {
	return Number(name.match(/^entry(\d+)\.md$/)?.[1] ?? 0);
}

function imageFileNum(name: string): number {
	return Number(name.match(/^image(\d+)\.jpg$/)?.[1] ?? 0);
}

const IMAGE_LINK_RE = /^!\[[^\]]*\]\(([^)]+)\)$/;

/** strips whole `![](imageN.jpg)` lines out of the body, collapsing the resulting blank runs. */
function stripImageLinks(body: string): { text: string; images: string[] } {
	const images: string[] = [];
	const kept: string[] = [];
	for (const line of body.split('\n')) {
		const m = line.match(IMAGE_LINK_RE);
		if (m) images.push(m[1]);
		else kept.push(line);
	}
	const text = kept.join('\n').replace(/\n{3,}/g, '\n\n');
	return { text, images };
}

interface Tally {
	diaries: number;
	entries: number;
	photoOnlyEntries: number;
	blobsPushed: number;
}

async function pushBlobCached(
	absPath: string,
	cache: Map<string, string>,
	conn: Conn,
	tally: Tally,
): Promise<string> {
	const cached = cache.get(absPath);
	if (cached) return cached;
	const out = await runCli(['blob', 'push', absPath], conn);
	const { hash } = JSON.parse(out) as { hash: string };
	cache.set(absPath, hash);
	tally.blobsPushed++;
	return hash;
}

function manifestImageKey(dateIso: string, filename: string): string {
	return `${dateIso.replaceAll('-', '/')}/${filename}`;
}

async function processDayFolder(
	day: DayFolder,
	manifest: Manifest,
	diaryIdByName: Map<string, string>,
	conn: Conn,
	blobCache: Map<string, string>,
	scratchDir: string,
	tally: Tally,
): Promise<void> {
	const allEntries: string[] = [];
	const allImages: string[] = [];
	for await (const entry of Deno.readDir(day.dir)) {
		if (!entry.isFile) continue;
		if (/^entry\d+\.md$/.test(entry.name)) allEntries.push(entry.name);
		else if (/^image\d+\.jpg$/.test(entry.name)) allImages.push(entry.name);
	}
	allEntries.sort((a, b) => entryFileNum(a) - entryFileNum(b));
	allImages.sort((a, b) => imageFileNum(a) - imageFileNum(b));

	const referencedImages = new Set<string>();

	for (const entryFile of allEntries) {
		const raw = await Deno.readTextFile(`${day.dir}/${entryFile}`);
		const { fm, body } = splitFrontmatter(raw);
		const meta = parseYaml(fm) as {
			id: string;
			time: Date;
			diary?: string;
			tags?: string[];
			location?: { name: string; lat: number; lng: number };
		};

		const frontmatterDate = meta.time.toISOString().slice(0, 10);
		if (frontmatterDate !== day.dateIso) {
			fail(
				`${day.dir}/${entryFile}: frontmatter time ${meta.time.toISOString()} disagrees with folder date ${day.dateIso}`,
			);
		}

		const { text, images } = stripImageLinks(body);
		for (const img of images) referencedImages.add(img);

		const textFile = `${scratchDir}/${meta.id}.md`;
		await Deno.writeTextFile(textFile, text);

		const photoSpecs: string[] = [];
		for (const img of images) {
			const hash = await pushBlobCached(`${day.dir}/${img}`, blobCache, conn, tally);
			const key = manifestImageKey(day.dateIso, img);
			const dims = manifest.images[key];
			if (!dims) fail(`manifest.json has no image entry for ${key} (referenced by ${day.dir}/${entryFile})`);
			photoSpecs.push(`${hash}:image/jpeg:${dims.width}x${dims.height}`);
		}

		let diaryId: string | undefined;
		if (meta.diary) {
			diaryId = diaryIdByName.get(meta.diary);
			if (!diaryId) fail(`${day.dir}/${entryFile}: unknown diary "${meta.diary}"`);
		}

		const args = ['entry', 'create', '--id', meta.id, '--date', day.dateIso, '--text-file', textFile];
		if (diaryId) args.push('--diary', diaryId);
		for (const tag of meta.tags ?? []) args.push('--tag', tag);
		if (meta.location) {
			args.push(
				'--location-name',
				meta.location.name,
				'--lat',
				String(meta.location.lat),
				'--lng',
				String(meta.location.lng),
			);
		}
		for (const spec of photoSpecs) args.push('--photo', spec);

		await runCli(args, conn);
		tally.entries++;
	}

	// images in the folder referenced by no entry become photo-only entries
	for (const img of allImages) {
		if (referencedImages.has(img)) continue;
		const key = manifestImageKey(day.dateIso, img);
		const dims = manifest.images[key];
		if (!dims) fail(`manifest.json has no image entry for ${key} (orphan image ${day.dir}/${img})`);
		const hash = await pushBlobCached(`${day.dir}/${img}`, blobCache, conn, tally);
		const id = await uuidFromHash(key);
		await runCli([
			'entry',
			'create',
			'--id',
			id,
			'--date',
			day.dateIso,
			'--photo',
			`${hash}:image/jpeg:${dims.width}x${dims.height}`,
		], conn);
		tally.entries++;
		tally.photoOnlyEntries++;
	}
}

async function main(): Promise<void> {
	const flags = parseArgs(Deno.args, { string: ['data', 'server', 'token', 'limit'] });
	const dataDir = flags.data ?? defaultDataDir;
	const server = flags.server ?? Deno.env.get('DAYZERO_SERVER_URL');
	const token = flags.token ?? Deno.env.get('DAYZERO_AUTH_TOKEN');
	if (!server) fail('missing --server (or DAYZERO_SERVER_URL)');
	if (!token) fail('missing --token (or DAYZERO_AUTH_TOKEN)');
	const conn: Conn = { server, token };
	const limit = flags.limit ? Number(flags.limit) : undefined;

	console.log('==> health check');
	await runCli(['health'], conn);

	console.log(`==> reading manifest from ${dataDir}`);
	const manifest = JSON.parse(await Deno.readTextFile(`${dataDir}/manifest.json`)) as Manifest;

	const tally: Tally = { diaries: 0, entries: 0, photoOnlyEntries: 0, blobsPushed: 0 };

	console.log(`==> creating ${manifest.diaries.length} diaries`);
	const diaryIdByName = new Map<string, string>();
	for (const diary of manifest.diaries) {
		await runCli(['diary', 'create', '--id', diary.id, '--name', diary.name], conn);
		diaryIdByName.set(diary.name, diary.id);
		tally.diaries++;
	}

	let days = await listDayFolders(dataDir);
	if (limit !== undefined) days = days.slice(0, limit);
	console.log(`==> importing ${days.length} day folders`);

	const scratchDir = await Deno.makeTempDir({ prefix: 'dayzero-import-' });
	const blobCache = new Map<string, string>();
	const start = performance.now();
	try {
		for (let i = 0; i < days.length; i++) {
			await processDayFolder(days[i], manifest, diaryIdByName, conn, blobCache, scratchDir, tally);
			if ((i + 1) % 100 === 0) {
				const elapsed = (performance.now() - start) / 1000;
				console.log(
					`... ${i + 1}/${days.length} days (${tally.entries} entries, ${tally.blobsPushed} blobs, ${
						elapsed.toFixed(0)
					}s)`,
				);
			}
		}
	} finally {
		await Deno.remove(scratchDir, { recursive: true });
	}

	const elapsed = (performance.now() - start) / 1000;
	console.log('');
	console.log('summary:');
	console.log(`  diaries created:    ${tally.diaries}`);
	console.log(`  entries created:    ${tally.entries}`);
	console.log(`  photo-only entries: ${tally.photoOnlyEntries}`);
	console.log(`  blobs pushed:       ${tally.blobsPushed}`);
	console.log(`  elapsed:            ${elapsed.toFixed(0)}s`);
}

if (import.meta.main) await main();
