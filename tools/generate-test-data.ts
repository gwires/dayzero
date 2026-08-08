#!/usr/bin/env -S deno run --allow-read --allow-write
// writes the on-disk test-data markdown tree + manifest.json. Knows nothing
// about the server. See TESTGEN-PLAN.md step 4 for the full spec this
// mirrors — calendar plan, per-entry assignment, text/image generation,
// on-disk layout, and the self-checks run at the end.
import { parseArgs } from '@std/cli';
import { chance, int, mulberry32, pick, type Rng, shuffle, weighted } from './lib/rng.ts';
import { uuidv7 } from './lib/ids.ts';
import { generateImage } from './lib/image-gen.ts';
import { generateEntryParagraphs } from './lib/text-gen.ts';
import { computeStreak } from './lib/streak.ts';
import {
	CITY_SPOT_WEIGHTS,
	DIARY_KEYS,
	DIARY_NAMES,
	DIARY_TAG_AFFINITY,
	type DiaryKey,
	HOME,
	type NamedLocation,
	OFFICE,
	TAG_WEIGHTS,
	type Trip,
	TRIP_POI_TYPES,
	TRIPS,
} from './lib/vocab.ts';

interface SizePreset {
	entries: number;
	streak: number;
	images: number;
	preStreakDays: number;
}

// full-size default: ~4000 entries / 2500-day streak / ~3000 images over an
// 11-year span — see TESTGEN-PLAN.md "calendar plan". Generation takes
// ~5-8 minutes and import ~7-25 minutes (tools/README.md).
const DEFAULT_PRESET: SizePreset = { entries: 4000, streak: 2500, images: 3000, preStreakDays: 1500 };
// `--small`: same shape (streak + trip-dotted pre-streak history) at
// roughly 1/30th the scale, so generate+import+verify finishes in well
// under a minute — for iterating on the pipeline itself, not for
// exercising large-diary UI performance.
const SMALL_PRESET: SizePreset = { entries: 170, streak: 60, images: 170, preStreakDays: 200 };

const repoRootUrl = new URL('..', import.meta.url);
const defaultOutDir = new URL('test-data', repoRootUrl).pathname;

// ---------------------------------------------------------------------------
// date helpers (span is defined purely in terms of YYYY-MM-DD, UTC)

function addDaysIso(dateIso: string, delta: number): string {
	const [y, m, d] = dateIso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	dt.setUTCDate(dt.getUTCDate() + delta);
	return dt.toISOString().slice(0, 10);
}

function isWeekendIso(dateIso: string): boolean {
	const [y, m, d] = dateIso.split('-').map(Number);
	const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return day === 0 || day === 6;
}

// ---------------------------------------------------------------------------
// distributions (see TESTGEN-PLAN.md "calendar plan" / "per-entry assignment")

const STREAK_ENTRY_COUNT_DIST: [number, number][] = [
	[1, 76],
	[2, 18],
	[3, 5],
	[4, 1],
];
const PRESTREAK_DAY_KIND_DIST: ['nothing' | 'entries' | 'images', number][] = [
	['nothing', 62],
	['entries', 30],
	['images', 8],
];
const PRESTREAK_ENTRY_COUNT_DIST: [number, number][] = [
	[1, 70],
	[2, 30],
];
const NORMAL_DIARY_DIST: [DiaryKey, number][] = [
	['default', 0.55],
	['work', 0.16],
	['fitness', 0.08],
	['dreams', 0.07],
	['cooking', 0.06],
	['projects', 0.04],
	['travel', 0.04],
];
const TAG_COUNT_DIST: [number, number][] = [
	[0, 25],
	[1, 35],
	[2, 25],
	[3, 10],
	[4, 5],
];
const NORMAL_PHOTO_DIST: [number, number][] = [
	[0, 55],
	[1, 27],
	[2, 11],
	[3, 5],
	[4, 2],
];
const TRIP_PHOTO_DIST: [number, number][] = [
	[0, 25],
	[1, 40],
	[2, 20],
	[3, 10],
	[4, 5],
];

const TIME_OF_DAY: Record<DiaryKey, { mean: number; jitter: number }> = {
	dreams: { mean: 7 * 60 + 15, jitter: 45 },
	fitness: { mean: 12 * 60, jitter: 4 * 60 },
	work: { mean: 17 * 60 + 40, jitter: 90 },
	cooking: { mean: 19 * 60, jitter: 90 },
	default: { mean: 21 * 60 + 30, jitter: 90 },
	projects: { mean: 21 * 60 + 30, jitter: 90 },
	travel: { mean: 21 * 60 + 30, jitter: 90 },
};

// ---------------------------------------------------------------------------
// trip placement

interface PlacedTrip {
	trip: Trip;
	startDayIndex: number;
	length: number;
	pois: NamedLocation[];
}

function placeTrips(
	rng: Rng,
	totalDays: number,
): { placedTrips: PlacedTrip[]; dayTripMap: (PlacedTrip | undefined)[] } {
	const placedIntervals: [number, number][] = [];
	const placedTrips: PlacedTrip[] = [];
	const dayTripMap: (PlacedTrip | undefined)[] = new Array(totalDays).fill(undefined);

	for (const trip of TRIPS) {
		const length = int(rng, 4, 14);
		let startDayIndex = -1;
		for (let attempt = 0; attempt < 2000; attempt++) {
			const candidate = int(rng, 0, totalDays - length);
			const overlaps = placedIntervals.some(([s, e]) => candidate < e && candidate + length > s);
			if (!overlaps) {
				startDayIndex = candidate;
				break;
			}
		}
		if (startDayIndex === -1) startDayIndex = int(rng, 0, totalDays - length);
		placedIntervals.push([startDayIndex, startDayIndex + length]);

		const poiCount = int(rng, 5, 8);
		const poiTypes = shuffle(rng, TRIP_POI_TYPES).slice(0, poiCount);
		const pois: NamedLocation[] = poiTypes.map((poi) => ({
			name: `${trip.city} — ${poi}`,
			lat: Math.round((trip.lat + (rng() * 0.04 - 0.02)) * 1e6) / 1e6,
			lng: Math.round((trip.lng + (rng() * 0.04 - 0.02)) * 1e6) / 1e6,
		}));

		const placed: PlacedTrip = { trip, startDayIndex, length, pois };
		placedTrips.push(placed);
		for (let d = startDayIndex; d < startDayIndex + length; d++) dayTripMap[d] = placed;
	}

	return { placedTrips, dayTripMap };
}

// ---------------------------------------------------------------------------
// per-entry assignment

function pickDiaryKey(rng: Rng, isTripDay: boolean, isWeekend: boolean): DiaryKey {
	if (isTripDay && chance(rng, 0.5)) return 'travel';
	const key = weighted(rng, NORMAL_DIARY_DIST);
	if (key === 'work' && isWeekend) return 'default';
	return key;
}

function pickTags(rng: Rng, diaryKey: DiaryKey): string[] {
	const count = weighted(rng, TAG_COUNT_DIST);
	const affinity = DIARY_TAG_AFFINITY[diaryKey];
	const chosen: string[] = [];
	const seen = new Set<string>();
	let guard = 0;
	while (chosen.length < count && guard < 50) {
		guard++;
		const tag = chance(rng, 0.7) ? pick(rng, affinity) : weighted(rng, TAG_WEIGHTS);
		if (!seen.has(tag)) {
			seen.add(tag);
			chosen.push(tag);
		}
	}
	return chosen;
}

function pickCitySpotWeighted(rng: Rng): NamedLocation {
	return weighted(rng, CITY_SPOT_WEIGHTS);
}

function pickLocation(rng: Rng, diaryKey: DiaryKey, trip: PlacedTrip | undefined): NamedLocation | undefined {
	if (!chance(rng, 0.65)) return undefined;
	if (trip) return pick(rng, trip.pois);
	if (diaryKey === 'work') return chance(rng, 0.8) ? OFFICE : pickCitySpotWeighted(rng);
	return chance(rng, 0.45) ? HOME : pickCitySpotWeighted(rng);
}

function pickEntryTimeMs(rng: Rng, dateIso: string, diaryKey: DiaryKey): number {
	const { mean, jitter } = TIME_OF_DAY[diaryKey];
	const minutes = ((mean + int(rng, -jitter, jitter)) % 1440 + 1440) % 1440;
	const seconds = int(rng, 0, 59);
	const [y, m, d] = dateIso.split('-').map(Number);
	return Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, seconds);
}

interface EntryDraft {
	diaryKey: DiaryKey;
	timestampMs: number;
	tags: string[];
	location?: NamedLocation;
	photoCount: number;
	paragraphs: string[];
}

function draftEntry(
	rng: Rng,
	dateIso: string,
	isTripDay: boolean,
	isWeekend: boolean,
	trip: PlacedTrip | undefined,
): EntryDraft {
	const diaryKey = pickDiaryKey(rng, isTripDay, isWeekend);
	const timestampMs = pickEntryTimeMs(rng, dateIso, diaryKey);
	const tags = pickTags(rng, diaryKey);
	const location = pickLocation(rng, diaryKey, trip);
	const photoCount = weighted(rng, isTripDay ? TRIP_PHOTO_DIST : NORMAL_PHOTO_DIST);
	const paragraphs = generateEntryParagraphs(rng, diaryKey);
	return { diaryKey, timestampMs, tags, location, photoCount, paragraphs };
}

interface DayPlan {
	dateIso: string;
	entries: EntryDraft[];
	orphanCount: number;
}

function planDay(
	rng: Rng,
	dayIndex: number,
	dateIso: string,
	trip: PlacedTrip | undefined,
	preStreakDays: number,
): DayPlan | undefined {
	const isTripDay = trip !== undefined;
	const isWeekend = isWeekendIso(dateIso);
	const isStreakDay = dayIndex >= preStreakDays;
	// the day right before the streak starts must never get content, or the
	// generated streak would run longer than the target — see TESTGEN-PLAN.md
	// "assert ... that the streak computed from the generated days ... is
	// exactly the --streak value".
	const isForcedEmptyBoundaryDay = dayIndex === preStreakDays - 1;

	let entryCount = 0;
	let orphanCount = 0;

	if (isStreakDay) {
		entryCount = weighted(rng, STREAK_ENTRY_COUNT_DIST);
		if (chance(rng, 0.03)) orphanCount = 1;
	} else if (!isForcedEmptyBoundaryDay) {
		const kind = weighted(rng, PRESTREAK_DAY_KIND_DIST);
		if (kind === 'entries') entryCount = weighted(rng, PRESTREAK_ENTRY_COUNT_DIST);
		else if (kind === 'images') orphanCount = int(rng, 1, 2);
	}

	if (entryCount === 0 && orphanCount === 0) return undefined;

	const entries: EntryDraft[] = [];
	for (let i = 0; i < entryCount; i++) entries.push(draftEntry(rng, dateIso, isTripDay, isWeekend, trip));
	entries.sort((a, b) => a.timestampMs - b.timestampMs);

	return { dateIso, entries, orphanCount };
}

// ---------------------------------------------------------------------------
// markdown assembly

function buildFrontmatter(id: string, entry: EntryDraft): string {
	const lines = [
		'---',
		`id: ${id}`,
		`time: ${new Date(entry.timestampMs).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
	];
	if (entry.diaryKey !== 'default') lines.push(`diary: ${DIARY_NAMES[entry.diaryKey]}`);
	if (entry.tags.length > 0) lines.push(`tags: [${entry.tags.join(', ')}]`);
	if (entry.location) {
		lines.push('location:');
		lines.push(`  name: ${entry.location.name}`);
		lines.push(`  lat: ${entry.location.lat}`);
		lines.push(`  lng: ${entry.location.lng}`);
	}
	lines.push('---');
	return lines.join('\n');
}

/** image links sit on their own line between paragraphs, spread across the entry. */
function assembleBody(paragraphs: string[], imageFilenames: string[]): string {
	if (imageFilenames.length === 0) return paragraphs.join('\n\n');
	const perGap = Math.ceil(imageFilenames.length / paragraphs.length);
	const blocks: string[] = [];
	let imgIdx = 0;
	for (const paragraph of paragraphs) {
		blocks.push(paragraph);
		for (let k = 0; k < perGap && imgIdx < imageFilenames.length; k++) {
			blocks.push(`![](${imageFilenames[imgIdx]})`);
			imgIdx++;
		}
	}
	while (imgIdx < imageFilenames.length) blocks.push(`![](${imageFilenames[imgIdx++]})`);
	return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// tallying for manifest.json's `expected` block

class Tally {
	totalEntries = 0;
	photoOnlyEntries = 0;
	entriesPerDiary: Record<string, number> = {};
	tagCounts: Record<string, number> = {};
	totalPhotos = 0;
	locationNames = new Set<string>();
	entryDates = new Set<string>();

	recordEntry(entry: EntryDraft, photoCount: number, dateIso: string, diaryId: string): void {
		this.totalEntries++;
		this.entriesPerDiary[diaryId] = (this.entriesPerDiary[diaryId] ?? 0) + 1;
		for (const tag of entry.tags) this.tagCounts[tag] = (this.tagCounts[tag] ?? 0) + 1;
		this.totalPhotos += photoCount;
		if (entry.location) this.locationNames.add(entry.location.name);
		this.entryDates.add(dateIso);
	}

	recordOrphanImage(dateIso: string): void {
		this.totalEntries++;
		this.photoOnlyEntries++;
		this.entriesPerDiary['default'] = (this.entriesPerDiary['default'] ?? 0) + 1;
		this.totalPhotos += 1;
		this.entryDates.add(dateIso);
	}
}

// ---------------------------------------------------------------------------
// wipe-safety (see TESTGEN-PLAN.md guardrails)

async function ensureOutDir(outDir: string): Promise<void> {
	const entries: string[] = [];
	try {
		for await (const entry of Deno.readDir(outDir)) entries.push(entry.name);
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) {
			await Deno.mkdir(outDir, { recursive: true });
			return;
		}
		throw e;
	}
	if (entries.length === 0) return;
	if (entries.includes('manifest.json')) {
		await Deno.remove(outDir, { recursive: true });
		await Deno.mkdir(outDir, { recursive: true });
		return;
	}
	console.error(
		`error: ${outDir} exists, is non-empty, and has no manifest.json from a prior run — refusing to overwrite`,
	);
	Deno.exit(1);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const flags = parseArgs(Deno.args, {
		string: ['out', 'seed', 'entries', 'streak', 'images', 'pre-streak-days'],
		boolean: ['small'],
	});
	const preset = flags.small ? SMALL_PRESET : DEFAULT_PRESET;
	const outDir = flags.out ?? defaultOutDir;
	const seed = Number(flags.seed ?? 42);
	const entriesTarget = Number(flags.entries ?? preset.entries);
	const streakTarget = Number(flags.streak ?? preset.streak);
	const imagesTarget = Number(flags.images ?? preset.images);
	const preStreakDays = Number(flags['pre-streak-days'] ?? preset.preStreakDays);

	await ensureOutDir(outDir);

	const rng = mulberry32(seed);
	const generatedOnIso = new Date().toISOString().slice(0, 10);
	const streakStartIso = addDaysIso(generatedOnIso, -(streakTarget - 1));
	const spanStartIso = addDaysIso(streakStartIso, -preStreakDays);
	const totalDays = preStreakDays + streakTarget;

	console.log(
		`seed=${seed} generatedOn=${generatedOnIso} streakStart=${streakStartIso} totalDays=${totalDays}`,
	);

	// mint the six created diaries' ids — same timestamp (streak-start 08:00Z)
	// for all six, differentiated by their random bits, so the same seed
	// always yields the same ids.
	const diaryTimestamp = Date.parse(`${streakStartIso}T08:00:00Z`);
	const diaryIds = { default: 'default' } as Record<DiaryKey, string>;
	for (const key of DIARY_KEYS) diaryIds[key] = uuidv7(rng, diaryTimestamp);

	const { placedTrips, dayTripMap } = placeTrips(rng, totalDays);

	const tally = new Tally();
	const manifestImages: Record<string, { width: number; height: number }> = {};
	let daysWithContent = 0;

	for (let dayIndex = 0; dayIndex < totalDays; dayIndex++) {
		const dateIso = addDaysIso(spanStartIso, dayIndex);
		const day = planDay(rng, dayIndex, dateIso, dayTripMap[dayIndex], preStreakDays);
		if (!day) continue;
		daysWithContent++;

		const [y, m, d] = dateIso.split('-');
		const dayDir = `${outDir}/${y}/${m}/${d}`;
		await Deno.mkdir(dayDir, { recursive: true });

		// number images across the whole day: entries first (in file order), then orphans
		let imgCounter = 1;
		const entryImageNames: string[][] = day.entries.map((entry) => {
			const names: string[] = [];
			for (let k = 0; k < entry.photoCount; k++) names.push(`image${imgCounter++}.jpg`);
			return names;
		});
		const orphanImageNames: string[] = [];
		for (let k = 0; k < day.orphanCount; k++) orphanImageNames.push(`image${imgCounter++}.jpg`);

		for (let i = 0; i < day.entries.length; i++) {
			const entry = day.entries[i];
			const id = uuidv7(rng, entry.timestampMs);
			const imageNames = entryImageNames[i];

			for (const name of imageNames) {
				const img = generateImage(rng);
				await Deno.writeFile(`${dayDir}/${name}`, img.bytes);
				manifestImages[`${y}/${m}/${d}/${name}`] = { width: img.width, height: img.height };
			}

			const frontmatter = buildFrontmatter(id, entry);
			const body = assembleBody(entry.paragraphs, imageNames);
			await Deno.writeTextFile(`${dayDir}/entry${i + 1}.md`, `${frontmatter}\n\n${body}\n`);

			tally.recordEntry(entry, imageNames.length, dateIso, diaryIds[entry.diaryKey]);
		}

		for (const name of orphanImageNames) {
			const img = generateImage(rng);
			await Deno.writeFile(`${dayDir}/${name}`, img.bytes);
			manifestImages[`${y}/${m}/${d}/${name}`] = { width: img.width, height: img.height };
			tally.recordOrphanImage(dateIso);
		}

		if ((dayIndex + 1) % 400 === 0) {
			console.log(`... day ${dayIndex + 1}/${totalDays} (${daysWithContent} with content)`);
		}
	}

	const streak = computeStreak(tally.entryDates, new Date(`${generatedOnIso}T00:00:00Z`));

	const manifest = {
		seed,
		generatedOn: generatedOnIso,
		diaries: DIARY_KEYS.map((key) => ({ id: diaryIds[key], name: DIARY_NAMES[key] })),
		expected: {
			totalEntries: tally.totalEntries,
			photoOnlyEntries: tally.photoOnlyEntries,
			entriesPerDiary: tally.entriesPerDiary,
			tagCounts: tally.tagCounts,
			totalPhotos: tally.totalPhotos,
			distinctLocations: tally.locationNames.size,
			streak,
		},
		images: manifestImages,
	};
	await Deno.writeTextFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, '\t') + '\n');

	console.log('');
	console.log('summary:');
	console.log(`  days with content:  ${daysWithContent} / ${totalDays}`);
	console.log(`  total entries:      ${tally.totalEntries} (target ${entriesTarget})`);
	console.log(`  photo-only entries: ${tally.photoOnlyEntries}`);
	console.log(`  total photos:       ${tally.totalPhotos} (target ${imagesTarget})`);
	console.log(`  distinct locations: ${tally.locationNames.size}`);
	console.log(`  streak:             ${streak} (target ${streakTarget})`);
	console.log(`  trips placed:       ${placedTrips.map((t) => t.trip.city).join(', ')}`);

	let ok = true;
	const entriesDelta = Math.abs(tally.totalEntries - entriesTarget) / entriesTarget;
	if (entriesDelta > 0.1) {
		console.error(`FAIL: totalEntries ${tally.totalEntries} is more than ±10% from target ${entriesTarget}`);
		ok = false;
	}
	const photosDelta = Math.abs(tally.totalPhotos - imagesTarget) / imagesTarget;
	if (photosDelta > 0.1) {
		console.error(`FAIL: totalPhotos ${tally.totalPhotos} is more than ±10% from target ${imagesTarget}`);
		ok = false;
	}
	if (streak !== streakTarget) {
		console.error(`FAIL: computed streak ${streak} does not exactly equal target ${streakTarget}`);
		ok = false;
	}
	if (!ok) Deno.exit(1);
	console.log('');
	console.log('all self-checks passed.');
}

if (import.meta.main) await main();
