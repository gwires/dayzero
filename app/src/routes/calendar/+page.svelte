<script lang="ts">
	import { resolve } from '$app/paths';
	import { listEntryDatesInMonth } from '$lib/entries/store';

	const now = new Date();
	let year = $state(now.getFullYear());
	let month = $state(now.getMonth() + 1); // 1-12

	let markedDates = $state<Set<string>>(new Set());
	let loading = $state(true);
	let error = $state<string | undefined>();

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	async function load(y: number, m: number) {
		loading = true;
		error = undefined;
		try {
			const rows = await listEntryDatesInMonth(y, m);
			markedDates = new Set(rows.map((row) => row.date));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		load(year, month);
	});

	function prevMonth() {
		if (month === 1) {
			month = 12;
			year -= 1;
		} else {
			month -= 1;
		}
	}

	function nextMonth() {
		if (month === 12) {
			month = 1;
			year += 1;
		} else {
			month += 1;
		}
	}

	interface DayCell {
		date: string | null;
		day: number | null;
	}

	// monday-first grid, per ISO 8601.
	function buildGrid(y: number, m: number): DayCell[] {
		const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
		const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

		const cells: DayCell[] = [];
		for (let i = 0; i < firstWeekday; i++) cells.push({ date: null, day: null });
		for (let day = 1; day <= daysInMonth; day++) {
			cells.push({ date: `${y}-${pad(m)}-${pad(day)}`, day });
		}
		return cells;
	}

	const grid = $derived(buildGrid(year, month));
	const monthLabel = $derived(
		new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		})
	);
	const today = now.toISOString().slice(0, 10);
</script>

<h1>calendar</h1>

<div class="calendar-nav">
	<button type="button" onclick={prevMonth} aria-label="previous month">‹</button>
	<span>{monthLabel}</span>
	<button type="button" onclick={nextMonth} aria-label="next month">›</button>
</div>

{#if loading}
	<p>loading…</p>
{:else if error}
	<p class="error">{error}</p>
{:else}
	<div class="calendar-grid">
		{#each ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as label (label)}
			<div class="calendar-weekday">{label}</div>
		{/each}
		{#each grid as cell, i (i)}
			{#if cell.date}
				<a
					class="calendar-day"
					class:has-entries={markedDates.has(cell.date)}
					class:today={cell.date === today}
					href="{resolve('/')}?date={encodeURIComponent(cell.date)}"
				>
					{cell.day}
				</a>
			{:else}
				<div class="calendar-day empty"></div>
			{/if}
		{/each}
	</div>
{/if}
