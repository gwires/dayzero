<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import MapView, { type MapMarker } from '$lib/ui/MapView.svelte';
	import { listEntriesWithLocation } from '$lib/entries/store';
	import { getMapTileUrl } from '$lib/settings/store';

	let markers = $state<MapMarker[]>([]);
	let mapTileUrl = $state<string | undefined>();
	let loading = $state(true);
	let error = $state<string | undefined>();

	$effect(() => {
		Promise.all([listEntriesWithLocation(), getMapTileUrl()])
			.then(([entries, tileUrl]) => {
				markers = entries
					.filter((e) => e.location_lat != null && e.location_lng != null)
					.map((e) => ({ id: e.id, lat: e.location_lat!, lng: e.location_lng! }));
				mapTileUrl = tileUrl;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				loading = false;
			});
	});

	function openEntry(id: string) {
		goto(resolve('/entry/[id]', { id }));
	}
</script>

<h1>map</h1>

{#if loading}
	<p>loading…</p>
{:else if error}
	<p class="error">{error}</p>
{:else if markers.length === 0}
	<p>no entries with a location yet.</p>
{:else}
	<MapView class="map-view-overview" {markers} onMarkerClick={openEntry} tileUrl={mapTileUrl} />
{/if}
