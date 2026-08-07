// port of app/src/lib/entries/streak.ts for the verifier — same semantics,
// not imported across the app's $lib aliases (see TESTGEN-PLAN.md step 2).
// walk backwards day-by-day from the reference date (or the day before it)
// while a matching entry_date exists, counting as you go.

function addDaysIso(dateIso: string, delta: number): string {
	const [year, month, day] = dateIso.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + delta);
	return date.toISOString().slice(0, 10);
}

export function computeStreak(entryDates: Iterable<string>, referenceDate: Date = new Date()): number {
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
