// pure streak calculation over the entry_date values already materialized
// in `entries`. see PLAN.md "client data model": walk backwards day-by-day
// from today (or yesterday, if nothing is logged yet today) while a
// matching entry_date exists, counting as you go.

function addDaysIso(dateIso: string, delta: number): string {
	const [year, month, day] = dateIso.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}

export function computeStreak(
	entryDates: Iterable<string>,
	referenceDate: Date = new Date()
): number {
	const dates = new Set(entryDates);
	let cursor = referenceDate.toISOString().slice(0, 10);

	if (!dates.has(cursor)) {
		cursor = addDaysIso(cursor, -1);
		if (!dates.has(cursor)) return 0;
	}

	let streak = 0;
	while (dates.has(cursor)) {
		streak++;
		cursor = addDaysIso(cursor, -1);
	}
	return streak;
}
