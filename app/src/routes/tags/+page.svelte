<script lang="ts">
	import { resolve } from '$app/paths';
	import { listTags } from '$lib/entries/store';
	import { currentDiaryFilter } from '$lib/diaries/current.svelte';

	let tags = $state<{ tag: string; count: number }[]>([]);
	let loading = $state(true);
	let error = $state<string | undefined>();

	$effect(() => {
		listTags(currentDiaryFilter())
			.then((rows) => {
				tags = rows;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				loading = false;
			});
	});
</script>

<h1>tags</h1>

{#if loading}
	<p>loading…</p>
{:else if error}
	<p class="error">{error}</p>
{:else if tags.length === 0}
	<p>no tags yet.</p>
{:else}
	<ul class="tag-list">
		{#each tags as { tag, count } (tag)}
			<li>
				<a href="{resolve('/')}?tag={encodeURIComponent(tag)}">#{tag}</a>
				<span class="tag-count">{count}</span>
			</li>
		{/each}
	</ul>
{/if}
