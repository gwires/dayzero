// fixed vocabulary for test-data generation: diaries, tags, locations,
// trips, and the image color palette. see TESTGEN-PLAN.md step 4 "fixed
// vocabulary" — pure data + small derived tables, no rng calls here (trip
// POI jitter and all other randomness happens in generate-test-data.ts so
// every rng draw lives in one traceable, deterministic stream).

export type DiaryKey = 'default' | 'work' | 'travel' | 'dreams' | 'fitness' | 'cooking' | 'projects';

/** the six diaries actually created on the server; 'default'/journal is virtual (never created). */
export const DIARY_KEYS: Exclude<DiaryKey, 'default'>[] = [
	'work',
	'travel',
	'dreams',
	'fitness',
	'cooking',
	'projects',
];

export const DIARY_NAMES: Record<DiaryKey, string> = {
	default: 'journal',
	work: 'work',
	travel: 'travel',
	dreams: 'dreams',
	fitness: 'fitness',
	cooking: 'cooking',
	projects: 'projects',
};

export const TAGS = [
	'gratitude',
	'family',
	'friends',
	'work',
	'meeting',
	'deadline',
	'run',
	'gym',
	'yoga',
	'cycling',
	'hike',
	'recipe',
	'baking',
	'dinner',
	'coffee',
	'book',
	'movie',
	'music',
	'garden',
	'weather',
	'dream',
	'lucid',
	'insomnia',
	'travel',
	'flight',
	'hotel',
	'beach',
	'museum',
	'photography',
	'project',
	'sideproject',
	'code',
	'learning',
	'health',
	'doctor',
	'mood',
	'anxiety',
	'celebration',
	'birthday',
	'holiday',
] as const;

/** [tag, weight] pairs, weight(r) = 1 / r**0.8 at 1-based rank r (list order above). */
export const TAG_WEIGHTS: [string, number][] = TAGS.map((tag, i) => [tag, 1 / Math.pow(i + 1, 0.8)]);

/** 5-8 tags per diary the entry's tags are drawn from 70% of the time (see TESTGEN-PLAN.md). */
export const DIARY_TAG_AFFINITY: Record<DiaryKey, string[]> = {
	default: ['gratitude', 'family', 'friends', 'mood', 'weather', 'health', 'celebration', 'holiday'],
	work: ['work', 'meeting', 'deadline', 'code', 'project', 'learning', 'coffee'],
	travel: ['travel', 'flight', 'hotel', 'beach', 'museum', 'photography'],
	dreams: ['dream', 'lucid', 'insomnia', 'mood', 'anxiety'],
	fitness: ['run', 'gym', 'yoga', 'cycling', 'hike', 'health', 'mood'],
	cooking: ['recipe', 'baking', 'dinner', 'coffee', 'family', 'friends'],
	projects: ['project', 'sideproject', 'code', 'deadline', 'learning', 'meeting'],
};

export interface NamedLocation {
	name: string;
	lat: number;
	lng: number;
}

export const HOME: NamedLocation = { name: 'Home', lat: 52.3702, lng: 4.8952 };
export const OFFICE: NamedLocation = { name: 'Office', lat: 52.3676, lng: 4.9041 };

/** ~18 named Amsterdam-ish spots, fixed rank order (list order feeds the rank-weighted pick). */
export const CITY_SPOTS: NamedLocation[] = [
	{ name: 'Café de Jaren', lat: 52.3676, lng: 4.8998 },
	{ name: 'Vondelpark', lat: 52.358, lng: 4.8686 },
	{ name: 'Albert Cuyp Market', lat: 52.3565, lng: 4.8916 },
	{ name: 'Rijksmuseum', lat: 52.36, lng: 4.8852 },
	{ name: 'De Pijp Coffee House', lat: 52.3557, lng: 4.8934 },
	{ name: 'Sportfondsenbad Gym', lat: 52.3639, lng: 4.8709 },
	{ name: 'Oosterpark', lat: 52.3606, lng: 4.9214 },
	{ name: 'Public Library OBA', lat: 52.3773, lng: 4.9004 },
	{ name: 'Foodhallen', lat: 52.3661, lng: 4.8636 },
	{ name: 'Westerpark', lat: 52.3868, lng: 4.8703 },
	{ name: 'Artis Zoo', lat: 52.3667, lng: 4.9161 },
	{ name: 'Dappermarkt', lat: 52.3627, lng: 4.9295 },
	{ name: 'Sarphatipark', lat: 52.3538, lng: 4.8952 },
	{ name: 'De Hallen Cinema', lat: 52.3672, lng: 4.8698 },
	{ name: 'Amsterdamse Bos Trailhead', lat: 52.3305, lng: 4.833 },
	{ name: 'NDSM Wharf', lat: 52.4, lng: 4.8969 },
	{ name: 'Java-eiland Café', lat: 52.3752, lng: 4.9339 },
	{ name: 'Vrijburcht Community Garden', lat: 52.3467, lng: 4.948 },
];

/** [location, weight] pairs, weight(r) = 1 / r**0.8 at 1-based rank r (list order above). */
export const CITY_SPOT_WEIGHTS: [NamedLocation, number][] = CITY_SPOTS.map((loc, i) => [
	loc,
	1 / Math.pow(i + 1, 0.8),
]);

export interface Trip {
	city: string;
	lat: number;
	lng: number;
}

/** 12 trip destinations, center coords. Processed in this fixed order. */
export const TRIPS: Trip[] = [
	{ city: 'Lisbon', lat: 38.7223, lng: -9.1393 },
	{ city: 'Kyoto', lat: 35.0116, lng: 135.7681 },
	{ city: 'New York', lat: 40.7128, lng: -74.006 },
	{ city: 'Bergen', lat: 60.3913, lng: 5.3221 },
	{ city: 'Rome', lat: 41.9028, lng: 12.4964 },
	{ city: 'Barcelona', lat: 41.3874, lng: 2.1686 },
	{ city: 'Berlin', lat: 52.52, lng: 13.405 },
	{ city: 'Prague', lat: 50.0755, lng: 14.4378 },
	{ city: 'Reykjavik', lat: 64.1466, lng: -21.9426 },
	{ city: 'Vienna', lat: 48.2082, lng: 16.3738 },
	{ city: 'Marrakech', lat: 31.6295, lng: -7.9811 },
	{ city: 'Ljubljana', lat: 46.0569, lng: 14.5058 },
];

export const TRIP_POI_TYPES = [
	'old town',
	'harbour',
	'market',
	'museum',
	'café',
	'viewpoint',
	'park',
	'station',
];

/** 12 pleasant hex colors for procedural image generation. */
export const IMAGE_PALETTE = [
	'#E8B4B8',
	'#8FBC94',
	'#6B9AC4',
	'#F4D35E',
	'#EE964B',
	'#5C6B73',
	'#C9ADA7',
	'#457B9D',
	'#A8DADC',
	'#F1FAEE',
	'#E76F51',
	'#2A9D8F',
];

export function hexToRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export const IMAGE_DIMENSIONS: [number, number][] = [
	[800, 600],
	[600, 800],
	[640, 640],
	[1024, 768],
];
