<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		getCurrentStreak,
		groupEntriesByDay,
		listEntries,
		listOnThisDay,
		type MaterializedEntry
	} from '$lib/entries/store';
	import { currentDiary, currentDiaryFilter } from '$lib/diaries/current.svelte';
	import { ALL_DIARIES, DEFAULT_DIARY_ID } from '$lib/diaries/ids';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { loadDiariesDoc } from '$lib/diaries/store';

	let entries = $state<MaterializedEntry[]>([]);
	let onThisDay = $state<MaterializedEntry[]>([]);
	let streak = $state(0);
	let loading = $state(true);
	let error = $state<string | undefined>();
	let diaryNames = $state<Map<string, string>>(new Map());

	const tag = $derived(page.url.searchParams.get('tag') ?? undefined);
	const date = $derived(page.url.searchParams.get('date') ?? undefined);
	const filtered = $derived(Boolean(tag || date));
	const filteredByDiary = $derived(currentDiary.id !== ALL_DIARIES);

	async function load(
		currentTag: string | undefined,
		currentDate: string | undefined,
		diaryId: string | undefined
	) {
		loading = true;
		error = undefined;
		try {
			entries = await listEntries({ tag: currentTag, date: currentDate, diaryId });
			const isFiltered = Boolean(currentTag || currentDate);
			onThisDay = isFiltered ? [] : await listOnThisDay(new Date(), diaryId);
			streak = isFiltered ? 0 : await getCurrentStreak(new Date(), diaryId);
			if (!diaryId) {
				diaryNames = new Map(listDiaries(await loadDiariesDoc()).map((d) => [d.id, d.name]));
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		load(tag, date, currentDiaryFilter());
	});

	function entryYear(entry: MaterializedEntry): string {
		return entry.entry_date?.slice(0, 4) ?? '';
	}

	const grouped = $derived(groupEntriesByDay(entries));
</script>

<h1>list</h1>

{#if tag}
	<p class="filter-banner">
		filtering by <strong>#{tag}</strong> — <a href={resolve('/')}>clear</a>
	</p>
{:else if date}
	<p class="filter-banner">
		showing entries from <strong>{date}</strong> — <a href={resolve('/')}>clear</a>
	</p>
{/if}

{#if loading}
	<p>loading…</p>
{:else if error}
	<p class="error">{error}</p>
{:else}
	{#if !filtered && streak > 0}
		<p class="streak">
			current streak: <strong>{streak} day{streak === 1 ? '' : 's'}</strong>
		</p>
	{/if}

	{#if onThisDay.length > 0}
		<section class="on-this-day">
			<h2>on this day</h2>
			<div class="on-this-day-strip">
				{#each onThisDay as entry (entry.id)}
					<a class="entry-card on-this-day-card" href={resolve('/entry/[id]', { id: entry.id })}>
						<p class="on-this-day-year">{entryYear(entry)}</p>
						<p class="entry-preview">{entry.markdown.trim().slice(0, 100) || '(empty entry)'}</p>
						{#if !filteredByDiary && entry.diary_id !== DEFAULT_DIARY_ID}
							<span class="diary-badge">{diaryNames.get(entry.diary_id) ?? 'unknown diary'}</span>
						{/if}
					</a>
				{/each}
			</div>
		</section>
	{/if}

	{#if entries.length === 0}
		{#if filtered}
			<p>no entries match this filter.</p>
		{:else}
			<p>no entries yet. <a href={resolve('/new')}>write your first one</a>.</p>
		{/if}
	{:else}
		{#each grouped as { day, entries: dayEntries } (day)}
			<section class="day-group">
				<h2>{day}</h2>
				{#each dayEntries as entry (entry.id)}
					<a class="entry-card" href={resolve('/entry/[id]', { id: entry.id })}>
						<p class="entry-preview">{entry.markdown.trim().slice(0, 140) || '(empty entry)'}</p>
						{#if !filteredByDiary && entry.diary_id !== DEFAULT_DIARY_ID}
							<span class="diary-badge">{diaryNames.get(entry.diary_id) ?? 'unknown diary'}</span>
						{/if}
					</a>
				{/each}
			</section>
		{/each}
	{/if}
{/if}
