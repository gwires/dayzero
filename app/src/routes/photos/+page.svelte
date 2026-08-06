<script lang="ts">
	import PhotoGridItem from '$lib/ui/PhotoGridItem.svelte';
	import { groupPhotosByDay, listAllPhotos, type PhotoWithEntry } from '$lib/entries/store';
	import { currentDiaryFilter } from '$lib/diaries/current.svelte';

	let photos = $state<PhotoWithEntry[]>([]);
	let loading = $state(true);
	let error = $state<string | undefined>();

	$effect(() => {
		listAllPhotos(currentDiaryFilter())
			.then((rows) => {
				photos = rows;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				loading = false;
			});
	});

	const grouped = $derived(groupPhotosByDay(photos));
</script>

<h1>photos</h1>

{#if loading}
	<p>loading…</p>
{:else if error}
	<p class="error">{error}</p>
{:else if photos.length === 0}
	<p>no photos yet.</p>
{:else}
	{#each grouped as { day, photos: dayPhotos } (day)}
		<section class="day-group">
			<h2>{day}</h2>
			<div class="photo-grid">
				{#each dayPhotos as photo (photo.entry_id + photo.hash)}
					<PhotoGridItem {photo} />
				{/each}
			</div>
		</section>
	{/each}
{/if}
