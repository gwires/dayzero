<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		getAttachmentUrl,
		groupPhotosByDay,
		listAllPhotos,
		type PhotoWithEntry
	} from '$lib/entries/store';
	import { currentDiaryFilter } from '$lib/diaries/current.svelte';
	import type { PageProps } from './$types';

	let { params }: PageProps = $props();

	let groups = $state<ReturnType<typeof groupPhotosByDay>>([]);
	let loading = $state(true);
	let error = $state<string | undefined>();
	let url = $state<string | undefined>();

	$effect(() => {
		listAllPhotos(currentDiaryFilter())
			.then((rows) => {
				groups = groupPhotosByDay(rows);
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				loading = false;
			});
	});

	const hash = $derived(params.hash);

	interface Position {
		photo: PhotoWithEntry;
		prevHash?: string;
		nextHash?: string;
	}

	// prev/next only step within the same day's photos — moving across days
	// would make "next" jump an unpredictable distance through the timeline.
	const current = $derived.by((): Position | undefined => {
		for (const group of groups) {
			const index = group.photos.findIndex((p) => p.hash === hash);
			if (index !== -1) {
				return {
					photo: group.photos[index],
					prevHash: group.photos[index - 1]?.hash,
					nextHash: group.photos[index + 1]?.hash
				};
			}
		}
		return undefined;
	});

	$effect(() => {
		const requested = hash;
		let objectUrl: string | undefined;
		let cancelled = false;
		url = undefined;
		getAttachmentUrl(requested).then((next) => {
			if (cancelled) {
				if (next) URL.revokeObjectURL(next);
				return;
			}
			objectUrl = next;
			url = next;
		});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	});

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			goto(resolve('/photos'));
		} else if (event.key === 'ArrowLeft' && current?.prevHash) {
			goto(resolve('/photos/[hash]', { hash: current.prevHash }));
		} else if (event.key === 'ArrowRight' && current?.nextHash) {
			goto(resolve('/photos/[hash]', { hash: current.nextHash }));
		}
	}

	// swipe left -> next, swipe right -> prev. a minimum distance keeps a
	// vertical scroll/tap from registering as an accidental navigation.
	const SWIPE_THRESHOLD_PX = 50;
	let touchStartX: number | undefined;
	let touchStartY: number | undefined;

	function handleTouchStart(event: TouchEvent) {
		touchStartX = event.touches[0].clientX;
		touchStartY = event.touches[0].clientY;
	}

	function handleTouchEnd(event: TouchEvent) {
		if (touchStartX === undefined || touchStartY === undefined) return;
		const touch = event.changedTouches[0];
		const dx = touch.clientX - touchStartX;
		const dy = touch.clientY - touchStartY;
		touchStartX = undefined;
		touchStartY = undefined;
		if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy)) return;
		if (dx < 0 && current?.nextHash) {
			goto(resolve('/photos/[hash]', { hash: current.nextHash }));
		} else if (dx > 0 && current?.prevHash) {
			goto(resolve('/photos/[hash]', { hash: current.prevHash }));
		}
	}

	onMount(() => {
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		window.addEventListener('keydown', handleKeydown);
		return () => {
			document.body.style.overflow = previousOverflow;
			window.removeEventListener('keydown', handleKeydown);
		};
	});

	onDestroy(() => {
		if (url) URL.revokeObjectURL(url);
	});
</script>

<div
	class="photo-viewer-backdrop"
	role="dialog"
	aria-modal="true"
	aria-label="photo viewer"
	tabindex="-1"
	ontouchstart={handleTouchStart}
	ontouchend={handleTouchEnd}
>
	<a class="photo-viewer-close" href={resolve('/photos')} aria-label="close">×</a>

	{#if loading}
		<p>loading…</p>
	{:else if error}
		<p class="error">{error}</p>
	{:else if !current}
		<p>photo not found.</p>
	{:else}
		{#if current.prevHash}
			<a
				class="photo-viewer-nav photo-viewer-prev"
				href={resolve('/photos/[hash]', { hash: current.prevHash })}
				aria-label="previous photo"
			>
				‹
			</a>
		{/if}

		{#if url}
			<img class="photo-viewer-image" src={url} alt="" />
		{/if}

		{#if current.nextHash}
			<a
				class="photo-viewer-nav photo-viewer-next"
				href={resolve('/photos/[hash]', { hash: current.nextHash })}
				aria-label="next photo"
			>
				›
			</a>
		{/if}

		<a
			class="photo-viewer-entry-link"
			href={resolve('/entry/[id]', { id: current.photo.entry_id })}
		>
			view entry — {current.photo.entry_date ?? 'no date'}
		</a>
	{/if}
</div>
