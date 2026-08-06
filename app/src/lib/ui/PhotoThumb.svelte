<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { getAttachmentUrl, type PhotoEntry } from '$lib/entries/store';

	interface Props {
		photo: Pick<PhotoEntry, 'hash' | 'width' | 'height'>;
		onRemove: () => void | Promise<void>;
	}

	let { photo, onRemove }: Props = $props();

	let url = $state<string | undefined>();

	onMount(async () => {
		url = await getAttachmentUrl(photo.hash);
	});

	onDestroy(() => {
		if (url) URL.revokeObjectURL(url);
	});
</script>

<figure class="photo-thumb">
	<a
		class="photo-thumb-link"
		href={resolve('/photos/[hash]', { hash: photo.hash })}
		aria-label="view photo full screen"
	>
		{#if url}
			<img src={url} alt="" width={photo.width} height={photo.height} />
		{:else}
			<div class="photo-thumb-placeholder"></div>
		{/if}
	</a>
	<button type="button" class="photo-remove" aria-label="remove photo" onclick={onRemove}>×</button>
</figure>
