<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { Capacitor } from '@capacitor/core';
	import PhotoStrip from './PhotoStrip.svelte';
	import MapView from './MapView.svelte';
	import type { PhotoEntry } from '$lib/entries/store';
	import { getMapTileUrl } from '$lib/settings/store';

	export interface EntryEditPayload {
		entryDate: string;
		markdown: string;
		tags: string[];
		locationLat: number | null;
		locationLng: number | null;
		locationName: string | null;
	}

	interface Props {
		initialEntryDate: string;
		initialMarkdown?: string;
		initialTags?: string[];
		initialLocationLat?: number | null;
		initialLocationLng?: number | null;
		initialLocationName?: string | null;
		existingTags?: string[];
		photos?: PhotoEntry[];
		onAddPhotos?: (files: File[]) => void | Promise<void>;
		onRemovePhoto?: (hash: string) => void | Promise<void>;
		photosBusy?: boolean;
		saving?: boolean;
		saveLabel?: string;
		onSave: (data: EntryEditPayload) => void | Promise<void>;
		onDelete?: () => void | Promise<void>;
	}

	let {
		initialEntryDate,
		initialMarkdown = '',
		initialTags = [],
		initialLocationLat = null,
		initialLocationLng = null,
		initialLocationName = null,
		existingTags = [],
		photos,
		onAddPhotos,
		onRemovePhoto,
		photosBusy = false,
		saving = false,
		saveLabel = 'save',
		onSave,
		onDelete
	}: Props = $props();

	// intentionally a one-time snapshot: this is local, editable scratch state
	// seeded from the loaded entry, not meant to track later prop changes.
	// svelte-ignore state_referenced_locally
	let entryDate = $state(initialEntryDate);
	// svelte-ignore state_referenced_locally
	let markdown = $state(initialMarkdown);
	// svelte-ignore state_referenced_locally
	let tags = $state([...initialTags]);
	// svelte-ignore state_referenced_locally
	let locationLat = $state(initialLocationLat);
	// svelte-ignore state_referenced_locally
	let locationLng = $state(initialLocationLng);
	// svelte-ignore state_referenced_locally
	let locationName = $state(initialLocationName ?? '');
	let tagDraft = $state('');
	let preview = $state(false);
	let locating = $state(false);
	let locationError = $state<string | undefined>();
	let mapTileUrl = $state<string | undefined>();

	$effect(() => {
		getMapTileUrl().then((url) => {
			mapTileUrl = url;
		});
	});

	const previewHtml = $derived(
		preview ? DOMPurify.sanitize(marked.parse(markdown, { async: false })) : ''
	);

	function addTag(raw: string) {
		const tag = raw.trim().toLowerCase();
		if (tag && !tags.includes(tag)) tags = [...tags, tag];
		tagDraft = '';
	}

	function removeTag(tag: string) {
		tags = tags.filter((t) => t !== tag);
	}

	function handleTagKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addTag(tagDraft);
		}
	}

	function geolocationErrorMessage(err: GeolocationPositionError): string {
		switch (err.code) {
			case err.PERMISSION_DENIED:
				return 'location permission denied';
			case err.POSITION_UNAVAILABLE:
				return 'location unavailable';
			case err.TIMEOUT:
				return 'location request timed out';
			default:
				return 'failed to get location';
		}
	}

	function getPosition(options: PositionOptions): Promise<GeolocationPosition> {
		return new Promise((resolve, reject) => {
			navigator.geolocation.getCurrentPosition(resolve, reject, options);
		});
	}

	// the plain web geolocation API doesn't get a permission prompt inside a
	// Capacitor WebView — Android requires the host app to implement that
	// prompt itself — so native goes through the Capacitor plugin instead.
	function nativeGeolocationErrorMessage(err: unknown): string {
		const message = err instanceof Error ? err.message.toLowerCase() : '';
		if (message.includes('denied')) return 'location permission denied';
		if (message.includes('disabled') || message.includes('unavailable'))
			return 'location unavailable';
		if (message.includes('timeout')) return 'location request timed out';
		return 'failed to get location';
	}

	async function useNativeCurrentLocation() {
		locating = true;
		locationError = undefined;
		try {
			const { Geolocation } = await import('@capacitor/geolocation');
			const position = await Geolocation.getCurrentPosition({ timeout: 30000 });
			locationLat = position.coords.latitude;
			locationLng = position.coords.longitude;
		} catch (err) {
			locationError = nativeGeolocationErrorMessage(err);
		} finally {
			locating = false;
		}
	}

	async function useCurrentLocation() {
		if (Capacitor.isNativePlatform()) {
			await useNativeCurrentLocation();
			return;
		}
		if (!navigator.geolocation) {
			locationError = 'geolocation is not available in this browser';
			return;
		}
		locating = true;
		locationError = undefined;
		try {
			let position: GeolocationPosition;
			try {
				// a diary entry needs city-level accuracy, so prefer a fast
				// network fix (or a recent cached one) over waiting on GPS —
				// a cold GPS fix on phones routinely takes longer than 10s.
				position = await getPosition({ maximumAge: 60000, timeout: 10000 });
			} catch (err) {
				if (err instanceof GeolocationPositionError && err.code === err.PERMISSION_DENIED) {
					throw err;
				}
				position = await getPosition({ enableHighAccuracy: true, timeout: 60000 });
			}
			locationLat = position.coords.latitude;
			locationLng = position.coords.longitude;
		} catch (err) {
			locationError =
				err instanceof GeolocationPositionError
					? geolocationErrorMessage(err)
					: 'failed to get location';
		} finally {
			locating = false;
		}
	}

	function clearLocation() {
		locationLat = null;
		locationLng = null;
	}

	function save() {
		onSave({
			entryDate,
			markdown,
			tags,
			locationLat,
			locationLng,
			locationName: locationName.trim() || null
		});
	}
</script>

<div class="editor">
	<label class="field">
		date
		<input type="date" bind:value={entryDate} />
	</label>

	<div class="editor-toolbar">
		<button type="button" onclick={() => (preview = false)} disabled={!preview}>write</button>
		<button type="button" onclick={() => (preview = true)} disabled={preview}>preview</button>
	</div>

	{#if preview}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- previewHtml is DOMPurify-sanitized above -->
		<div class="markdown-preview">{@html previewHtml}</div>
	{:else}
		<textarea
			class="markdown-input"
			bind:value={markdown}
			rows="12"
			placeholder="write in markdown…"></textarea>
	{/if}

	<div class="tag-editor">
		{#each tags as tag (tag)}
			<span class="tag-pill">
				#{tag}
				<button type="button" aria-label="remove tag {tag}" onclick={() => removeTag(tag)}>×</button
				>
			</span>
		{/each}
		<input
			class="tag-input"
			list="existing-tags"
			placeholder="add tag…"
			bind:value={tagDraft}
			onkeydown={handleTagKeydown}
			onblur={() => addTag(tagDraft)}
		/>
		<datalist id="existing-tags">
			{#each existingTags as tag (tag)}
				<option value={tag}></option>
			{/each}
		</datalist>
	</div>

	<div class="location-editor">
		<div class="location-row">
			<button type="button" onclick={useCurrentLocation} disabled={locating}>
				{locating ? 'locating…' : 'use current location'}
			</button>
			{#if locationLat != null && locationLng != null}
				<span class="location-coords">{locationLat.toFixed(4)}, {locationLng.toFixed(4)}</span>
				<button type="button" onclick={clearLocation}>clear</button>
			{/if}
		</div>
		{#if locationError}
			<p class="error">{locationError}</p>
		{/if}
		<input class="location-name" placeholder="place name…" bind:value={locationName} />
		{#if locationLat != null && locationLng != null}
			<MapView lat={locationLat} lng={locationLng} tileUrl={mapTileUrl} />
		{/if}
	</div>

	{#if onAddPhotos && onRemovePhoto}
		<PhotoStrip
			photos={photos ?? []}
			onAdd={onAddPhotos}
			onRemove={onRemovePhoto}
			busy={photosBusy}
		/>
	{/if}

	<div class="editor-actions">
		<button type="button" onclick={save} disabled={saving}>
			{saving ? 'saving…' : saveLabel}
		</button>
		{#if onDelete}
			<button type="button" class="danger" onclick={onDelete} disabled={saving}>delete</button>
		{/if}
	</div>
</div>
