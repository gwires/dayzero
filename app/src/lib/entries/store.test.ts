import { describe, expect, it } from 'vitest';
import { groupEntriesByDay, groupEntriesByMonth } from './store';
import { NO_DATE } from './dates';
import type { MaterializedEntry } from './materialize';

// only the fields the grouping looks at; the rest never leaves the db row.
function entry(id: string, entry_date: string | null): MaterializedEntry {
	return {
		id,
		diary_id: 'default',
		entry_date,
		markdown: id,
		location_lat: null,
		location_lng: null,
		location_name: null,
		deleted: 0,
		updated_at: '2026-08-07T12:00:00.000Z'
	};
}

// the shape `listEntries` returns: entry_date descending.
const sorted = [
	entry('a', '2026-08-07'),
	entry('b', '2026-08-07'),
	entry('c', '2026-08-01'),
	entry('d', '2026-07-30'),
	entry('e', '2025-08-30')
];

describe('groupEntriesByMonth', () => {
	it('is empty for no entries', () => {
		expect(groupEntriesByMonth([])).toEqual([]);
	});

	it('groups by month, then by day within it', () => {
		const groups = groupEntriesByMonth(sorted);
		expect(groups.map((g) => g.month)).toEqual(['2026-08', '2026-07', '2025-08']);
		expect(groups[0].days.map((d) => d.day)).toEqual(['2026-08-07', '2026-08-01']);
		expect(groups[0].days[0].entries.map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('keeps the same month in different years apart', () => {
		const groups = groupEntriesByMonth([entry('a', '2026-08-07'), entry('b', '2025-08-07')]);
		expect(groups).toHaveLength(2);
	});

	it('buckets undated entries under the no-date key', () => {
		const groups = groupEntriesByMonth([entry('a', '2026-08-07'), entry('b', null)]);
		expect(groups[1].month).toBe(NO_DATE);
		expect(groups[1].days[0].day).toBe(NO_DATE);
	});
});

describe('groupEntriesByDay', () => {
	it('flattens to one group per day', () => {
		const groups = groupEntriesByDay(sorted);
		expect(groups.map((g) => g.day)).toEqual([
			'2026-08-07',
			'2026-08-01',
			'2026-07-30',
			'2025-08-30'
		]);
		expect(groups[0].entries.map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('buckets undated entries under the no-date key', () => {
		expect(groupEntriesByDay([entry('a', null)])[0].day).toBe(NO_DATE);
	});
});
