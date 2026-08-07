// labels for the list view's month headings and day bubbles. every entry_date
// is a plain 'YYYY-MM-DD' calendar date with no time or zone attached, so the
// formatting stays in UTC — read as local time, a date would show up as the
// day before for anyone west of the meridian.

/** bucket key and label for entries whose doc carries no entry_date. */
export const NO_DATE = 'no date';

/** '2026-08' → 'August 2026'. */
export function monthLabel(month: string): string {
	if (month === NO_DATE) return NO_DATE;
	return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
}

/** '2026-08-07' → '7'. */
export function dayNumber(day: string): string {
	if (day === NO_DATE) return '–';
	return String(Number(day.slice(8, 10)));
}

/** '2026-08-07' → 'fri'. */
export function weekdayLabel(day: string): string {
	if (day === NO_DATE) return '';
	return new Date(`${day}T00:00:00Z`)
		.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
		.toLowerCase();
}
