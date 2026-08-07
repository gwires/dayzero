<script lang="ts">
	import { resolve } from '$app/paths';
	import { groupEntriesByDay, searchEntries, type MaterializedEntry } from '$lib/entries/store';
	import { matchSnippet } from '$lib/entries/search';
	import { currentDiary, currentDiaryFilter } from '$lib/diaries/current.svelte';
	import { ALL_DIARIES, DEFAULT_DIARY_ID } from '$lib/diaries/ids';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { loadDiariesDoc } from '$lib/diaries/store';

	let query = $state('');
	let results = $state<MaterializedEntry[]>([]);
	// the term the current results belong to — snippets highlight against this,
	// not against what's been typed since.
	let matched = $state('');
	let searching = $state(false);
	let error = $state<string | undefined>();
	let diaryNames = $state<Map<string, string>>(new Map());

	const filteredByDiary = $derived(currentDiary.id !== ALL_DIARIES);
	const grouped = $derived(groupEntriesByDay(results));

	// searches are fired per keystroke, so a slow one landing after a newer one
	// must not overwrite it.
	let latest = 0;

	async function run(term: string, diaryId: string | undefined) {
		const seq = ++latest;
		try {
			const rows = await searchEntries(term, diaryId);
			const names = diaryId
				? new Map<string, string>()
				: new Map(listDiaries(await loadDiariesDoc()).map((d) => [d.id, d.name]));
			if (seq !== latest) return;
			results = rows;
			diaryNames = names;
			matched = term;
			error = undefined;
		} catch (err) {
			if (seq !== latest) return;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			if (seq === latest) searching = false;
		}
	}

	$effect(() => {
		const term = query.trim();
		const diaryId = currentDiaryFilter();
		if (!term) {
			latest++; // abandon anything in flight
			results = [];
			matched = '';
			searching = false;
			error = undefined;
			return;
		}
		searching = true;
		const timer = setTimeout(() => void run(term, diaryId), 150);
		return () => clearTimeout(timer);
	});
</script>

<h1>search</h1>

<!-- svelte-ignore a11y_autofocus -->
<input
	class="search-input"
	type="search"
	autofocus
	autocomplete="off"
	placeholder="search entries…"
	aria-label="search entries"
	bind:value={query}
/>

<p class="search-hint">
	searching entry text{filteredByDiary ? ' in this diary' : ''} — or
	<a href={resolve('/tags')}>browse tags</a>.
</p>

{#if error}
	<p class="error">{error}</p>
{:else if !query.trim()}
	<p>type to search your entries.</p>
{:else if searching}
	<p>searching…</p>
{:else if results.length === 0}
	<p>no entries match “{query.trim()}”.</p>
{:else}
	<p class="filter-banner">
		{results.length} match{results.length === 1 ? '' : 'es'}
	</p>
	{#each grouped as { day, entries: dayEntries } (day)}
		<section class="day-group">
			<h2>{day}</h2>
			{#each dayEntries as entry (entry.id)}
				<a class="entry-card" href={resolve('/entry/[id]', { id: entry.id })}>
					<p class="entry-preview">{matchSnippet(entry.markdown, matched) || '(empty entry)'}</p>
					{#if !filteredByDiary && entry.diary_id !== DEFAULT_DIARY_ID}
						<span class="diary-badge">{diaryNames.get(entry.diary_id) ?? 'unknown diary'}</span>
					{/if}
				</a>
			{/each}
		</section>
	{/each}
{/if}
