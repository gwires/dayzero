<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { getAttachmentUrl } from '$lib/entries/store';
	import type { PhotoWithEntry } from '$lib/entries/store';

	interface Props {
		photo: PhotoWithEntry;
	}

	let { photo }: Props = $props();

	let url = $state<string | undefined>();

	onMount(async () => {
		url = await getAttachmentUrl(photo.hash);
	});

	onDestroy(() => {
		if (url) URL.revokeObjectURL(url);
	});
</script>

<a class="photo-grid-item" href={resolve('/entry/[id]', { id: photo.entry_id })}>
	{#if url}
		<img src={url} alt="" width={photo.width} height={photo.height} />
	{:else}
		<div class="photo-thumb-placeholder"></div>
	{/if}
</a>
