<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { getAttachmentUrl, type PhotoEntry } from '$lib/entries/store';
	import ConfirmDialog from './ConfirmDialog.svelte';

	interface Props {
		photo: Pick<PhotoEntry, 'hash' | 'width' | 'height'>;
		onRemove: () => void | Promise<void>;
	}

	let { photo, onRemove }: Props = $props();

	let confirmRemoveOpen = $state(false);
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
	<button
		type="button"
		class="photo-remove"
		aria-label="remove photo"
		onclick={() => (confirmRemoveOpen = true)}>×</button
	>
</figure>

<ConfirmDialog
	open={confirmRemoveOpen}
	message="remove this photo from the entry?"
	confirmLabel="remove"
	onConfirm={() => {
		confirmRemoveOpen = false;
		onRemove();
	}}
	onCancel={() => (confirmRemoveOpen = false)}
/>
