import { describe, expect, it } from 'vitest';
import { NO_DATE, dayNumber, monthLabel, weekdayLabel } from './dates';

describe('monthLabel', () => {
	it('names the month and year', () => {
		expect(monthLabel('2026-08')).toBe('August 2026');
		expect(monthLabel('2025-01')).toBe('January 2025');
	});

	it('passes the undated bucket through', () => {
		expect(monthLabel(NO_DATE)).toBe(NO_DATE);
	});
});

describe('dayNumber', () => {
	it('drops the leading zero', () => {
		expect(dayNumber('2026-08-07')).toBe('7');
		expect(dayNumber('2026-08-31')).toBe('31');
	});

	it('shows a dash for the undated bucket', () => {
		expect(dayNumber(NO_DATE)).toBe('–');
	});
});

describe('weekdayLabel', () => {
	it('abbreviates the weekday in lowercase', () => {
		expect(weekdayLabel('2026-08-07')).toBe('fri');
		expect(weekdayLabel('2026-08-09')).toBe('sun');
	});

	// dates carry no time or zone, so they must not be read as local midnight —
	// that would land on the previous day anywhere west of the meridian.
	it('reads the date in utc, not the host zone', () => {
		const tz = process.env.TZ;
		try {
			process.env.TZ = 'America/Los_Angeles';
			expect(weekdayLabel('2026-08-07')).toBe('fri');
			expect(dayNumber('2026-08-07')).toBe('7');
			expect(monthLabel('2026-08')).toBe('August 2026');
		} finally {
			process.env.TZ = tz;
		}
	});

	it('is empty for the undated bucket', () => {
		expect(weekdayLabel(NO_DATE)).toBe('');
	});
});
