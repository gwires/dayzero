import { describe, expect, it } from 'vitest';
import { computeStreak } from './streak';

// wednesday, chosen arbitrarily; computeStreak works purely off UTC calendar
// dates, so the specific weekday/timezone don't matter.
const REF = new Date(Date.UTC(2026, 7, 5));

function daysBefore(n: number): string {
	const date = new Date(REF);
	date.setUTCDate(date.getUTCDate() - n);
	return date.toISOString().slice(0, 10);
}

describe('computeStreak', () => {
	it('is 0 with no entries', () => {
		expect(computeStreak([], REF)).toBe(0);
	});

	it('counts an unbroken streak ending today', () => {
		const dates = [daysBefore(0), daysBefore(1), daysBefore(2)];
		expect(computeStreak(dates, REF)).toBe(3);
	});

	it('anchors on yesterday when nothing is logged yet today', () => {
		const dates = [daysBefore(1), daysBefore(2), daysBefore(3)];
		expect(computeStreak(dates, REF)).toBe(3);
	});

	it('stops at the first gap', () => {
		const dates = [daysBefore(0), daysBefore(2), daysBefore(3)]; // missing yesterday
		expect(computeStreak(dates, REF)).toBe(1);
	});

	it('is 0 when neither today nor yesterday has an entry', () => {
		const dates = [daysBefore(5), daysBefore(6)];
		expect(computeStreak(dates, REF)).toBe(0);
	});

	it('ignores duplicate dates (multiple entries per day)', () => {
		const dates = [daysBefore(0), daysBefore(0), daysBefore(1)];
		expect(computeStreak(dates, REF)).toBe(2);
	});

	it('is unaffected by unrelated dates further in the past', () => {
		const dates = [daysBefore(0), daysBefore(1), daysBefore(30), daysBefore(90)];
		expect(computeStreak(dates, REF)).toBe(2);
	});
});
