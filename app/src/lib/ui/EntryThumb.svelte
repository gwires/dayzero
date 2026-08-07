<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getAttachmentUrl } from '$lib/entries/store';

	interface Props {
		hash: string;
	}

	let { hash }: Props = $props();

	let url = $state<string | undefined>();

	// an entry pulled down by sync can reference a blob this device hasn't
	// fetched yet — that resolves to undefined, and the placeholder stands in.
	onMount(async () => {
		url = await getAttachmentUrl(hash);
	});

	onDestroy(() => {
		if (url) URL.revokeObjectURL(url);
	});
</script>

<div class="entry-thumb">
	{#if url}
		<img src={url} alt="" />
	{:else}
		<div class="photo-thumb-placeholder"></div>
	{/if}
</div>
