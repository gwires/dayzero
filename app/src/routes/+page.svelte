<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { listEntries, type MaterializedEntry } from '$lib/entries/store';

	let entries = $state<MaterializedEntry[]>([]);
	let loading = $state(true);
	let error = $state<string | undefined>();

	const tag = $derived(page.url.searchParams.get('tag') ?? undefined);

	async function load(currentTag: string | undefined) {
		loading = true;
		error = undefined;
		try {
			entries = await listEntries({ tag: currentTag });
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		load(tag);
	});

	interface DayGroup {
		day: string;
		entries: MaterializedEntry[];
	}

	// entries arrive pre-sorted by entry_date desc, so same-day entries are
	// already adjacent — a single pass is enough to group them.
	function groupByDay(list: MaterializedEntry[]): DayGroup[] {
		const groups: DayGroup[] = [];
		for (const entry of list) {
			const day = entry.entry_date ?? 'no date';
			const last = groups.at(-1);
			if (last?.day === day) last.entries.push(entry);
			else groups.push({ day, entries: [entry] });
		}
		return groups;
	}

	const grouped = $derived(groupByDay(entries));
</script>

<h1>timeline</h1>

{#if tag}
	<p class="filter-banner">
		filtering by <strong>#{tag}</strong> — <a href={resolve('/')}>clear</a>
	</p>
{/if}

{#if loading}
	<p>loading…</p>
{:else if error}
	<p class="error">{error}</p>
{:else if entries.length === 0}
	<p>no entries yet. <a href={resolve('/new')}>write your first one</a>.</p>
{:else}
	{#each grouped as { day, entries: dayEntries } (day)}
		<section class="day-group">
			<h2>{day}</h2>
			{#each dayEntries as entry (entry.id)}
				<a class="entry-card" href={resolve('/entry/[id]', { id: entry.id })}>
					<p class="entry-preview">{entry.markdown.trim().slice(0, 140) || '(empty entry)'}</p>
				</a>
			{/each}
		</section>
	{/each}
{/if}
