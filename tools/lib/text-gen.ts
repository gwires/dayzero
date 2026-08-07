// template-based filler text generator. see TESTGEN-PLAN.md step 4 "text
// generation": sentence templates with {slot}s filled from word banks,
// generic templates plus a small per-diary set for opening sentences.
// Quality bar is "plausible-at-a-glance filler, not literature" — no lorem
// ipsum, but no attempt at real prose either.
import { chance, int, pick, type Rng } from './rng.ts';
import type { DiaryKey } from './vocab.ts';

const WORD_BANKS = {
	activity: [
		'a run',
		'a long walk',
		'a bike ride',
		'a swim',
		'a hike',
		'some stretching',
		'a yoga session',
		'a workout',
		'a short jog',
		'a slow ride',
	],
	place: [
		'the park',
		'the old town',
		'the harbour',
		'the market',
		'the café down the street',
		'the office',
		'the kitchen',
		'the garden',
		'the library',
		'the waterfront',
	],
	person: [
		'my sister',
		'an old friend',
		'a colleague',
		'my neighbor',
		'my partner',
		'a new acquaintance',
		'my brother',
		'a few friends',
		'my parents',
		'a stranger on the train',
	],
	feeling: [
		'calm',
		'a little tired',
		'surprisingly good',
		'restless',
		'content',
		'quietly proud',
		'a bit anxious',
		'grateful',
		'energized',
		'pleasantly worn out',
	],
	food: [
		'a bowl of soup',
		'fresh bread',
		'a plate of pasta',
		'some roasted vegetables',
		'a slice of cake',
		'strong coffee',
		'a simple salad',
		'grilled fish',
		'a pot of tea',
		'leftovers from last night',
	],
	// bare noun phrases — every template that uses {weather} prepends its own
	// "the"/"The", so these must never carry their own leading article.
	weather: [
		'grey sky',
		'bright sunshine',
		'light drizzle',
		'crisp autumn air',
		'fresh snow',
		'warm breeze',
		'heavy rain',
		'thick fog',
		'clear blue sky',
		'unseasonable heat',
	],
	object: [
		'the report',
		'an old photograph',
		'a half-finished sketch',
		'the garden fence',
		'a new recipe',
		'the spare bedroom',
		'a stack of notes',
		'the bike',
		'a birthday gift',
		'the bookshelf',
	],
	// pure time-of-day nouns only (no "before work"/"after dinner" phrases) —
	// templates use both "this {daypart}" and "the {daypart}", which only
	// reads right for a noun.
	daypart: ['morning', 'afternoon', 'evening', 'dusk', 'night', 'midday', 'dawn', 'twilight'],
} satisfies Record<string, string[]>;

type Slot = keyof typeof WORD_BANKS;

const GENERIC_TEMPLATES = [
	'Went for {activity} with {person} this {daypart}.',
	'The {weather} made everything feel {feeling}.',
	'Finally finished {object} — {feeling} about how it turned out.',
	'Spent some time at {place}, mostly just thinking.',
	'Had {food} for lunch and it hit the spot.',
	'{person} stopped by and we talked for hours.',
	'Woke up feeling {feeling}, not sure why.',
	'The {weather} kept me indoors most of the {daypart}.',
	'Tried a new recipe involving {food} — turned out {feeling}.',
	'Took a break to visit {place} before heading home.',
	'Nothing major happened today, just {activity} and some quiet time.',
	'Kept thinking about {object} on and off all day.',
	'Caught up with {person} over {food}.',
	'The {daypart} was quiet — just me, {object}, and some music.',
	'Feeling {feeling} after {activity} earlier.',
	'Noted the {weather} on the way to {place}.',
	'Small win today: {object} is finally done.',
	'{person} and I went to {place} in the {daypart}.',
	'Ended the day {feeling}, which felt earned.',
	'A quiet {daypart}, mostly {activity} and {food}.',
];

const OPENING_TEMPLATES: Record<DiaryKey, string[]> = {
	default: [
		'Quiet {daypart}, nothing much to report.',
		'Grateful for {person} today.',
		'The {weather} set the tone for the whole day.',
		'Feeling {feeling} tonight, hard to say exactly why.',
		'Small moments today: {food}, {person}, and {place}.',
	],
	work: [
		'Long day at {place}, mostly {object}.',
		'Meeting with {person} ran long, but it was productive.',
		'Deadline pressure again — spent the {daypart} on {object}.',
		'Finally made progress on {object} today.',
		'Work felt {feeling} today, for once.',
	],
	travel: [
		'Spent the {daypart} exploring {place}.',
		'The {weather} today was something else.',
		'Wandered around with {person}, no real plan.',
		'Tried the local food — {food} was the highlight.',
		'Took photos all over {place} today.',
	],
	dreams: [
		'Had a strange dream involving {object} and {person}.',
		'Woke up at 3am and couldn’t fall back asleep.',
		'Dreamt I was at {place}, felt {feeling} the whole time.',
		'Vivid dream last night — barely remember the details now.',
		'Slept badly again, kept half-waking through the {daypart}.',
	],
	fitness: [
		'Got in {activity} before the {daypart} got busy.',
		'Legs are sore from yesterday, but pushed through {activity} anyway.',
		'Felt {feeling} during {activity} today.',
		'Skipped {activity} today, just wasn’t feeling it.',
		'New personal best during {activity} this {daypart}.',
	],
	cooking: [
		'Tried making {food} from scratch today.',
		'{person} came over and we cooked {food} together.',
		'Kitchen experiment with {food} — {feeling} with the result.',
		'Spent the {daypart} testing a new recipe involving {food}.',
		'Simple dinner tonight: {food} and not much else.',
	],
	projects: [
		'Made some progress on {object} tonight.',
		'Side project time — mostly {object} again.',
		'Debugged {object} for way too long today.',
		'Finally shipped {object}, {feeling} about it.',
		'Spent the {daypart} sketching out ideas for {object}.',
	],
};

const BULLET_ITEMS = [
	'{activity}',
	'{food}',
	'a chat with {person}',
	'time at {place}',
	'progress on {object}',
	'{feeling} mood all day',
	'the {weather}',
	'a short nap',
];

function fillTemplate(rng: Rng, template: string): string {
	return template.replace(/\{(\w+)\}/g, (_, slot: Slot) => pick(rng, WORD_BANKS[slot]));
}

function generateParagraph(rng: Rng, opening?: string): string {
	const sentenceCount = int(rng, 3, 6);
	const sentences: string[] = [];
	if (opening) sentences.push(fillTemplate(rng, opening));
	while (sentences.length < sentenceCount) sentences.push(fillTemplate(rng, pick(rng, GENERIC_TEMPLATES)));
	return sentences.join(' ');
}

type MarkdownFeature = 'heading' | 'bullet' | 'bold' | 'blockquote';
const MARKDOWN_FEATURES: MarkdownFeature[] = ['heading', 'bullet', 'bold', 'blockquote'];

function applyMarkdownFeature(rng: Rng, paragraphs: string[]): string[] {
	const feature = pick(rng, MARKDOWN_FEATURES);
	const idx = int(rng, 0, paragraphs.length - 1);
	switch (feature) {
		case 'heading': {
			const headings = ['Notes', 'Later', 'Also', 'Aside', 'Update'];
			paragraphs.splice(idx, 0, `## ${pick(rng, headings)}`);
			return paragraphs;
		}
		case 'bullet': {
			const itemCount = int(rng, 3, 5);
			const items: string[] = [];
			for (let i = 0; i < itemCount; i++) items.push(`- ${fillTemplate(rng, pick(rng, BULLET_ITEMS))}`);
			paragraphs.splice(idx, 0, items.join('\n'));
			return paragraphs;
		}
		case 'bold': {
			paragraphs[idx] = `${paragraphs[idx]} **${pick(rng, WORD_BANKS.feeling)}**.`;
			return paragraphs;
		}
		case 'blockquote': {
			paragraphs.splice(idx, 0, `> ${fillTemplate(rng, pick(rng, GENERIC_TEMPLATES))}`);
			return paragraphs;
		}
	}
}

/** 4-8 paragraphs of filler text; ~10% of entries get one markdown feature. */
export function generateEntryParagraphs(rng: Rng, diaryKey: DiaryKey): string[] {
	const paragraphCount = int(rng, 4, 8);
	const paragraphs: string[] = [];
	for (let i = 0; i < paragraphCount; i++) {
		const opening = i === 0 ? pick(rng, OPENING_TEMPLATES[diaryKey]) : undefined;
		paragraphs.push(generateParagraph(rng, opening));
	}
	if (chance(rng, 0.1)) return applyMarkdownFeature(rng, paragraphs);
	return paragraphs;
}
