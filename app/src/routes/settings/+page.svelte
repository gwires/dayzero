<script lang="ts">
	import { getMapTileUrl, setMapTileUrl } from '$lib/settings/store';

	let mapTileUrl = $state('');
	let saved = $state(false);

	$effect(() => {
		getMapTileUrl().then((url) => {
			mapTileUrl = url ?? '';
		});
	});

	async function save() {
		await setMapTileUrl(mapTileUrl.trim() || undefined);
		saved = true;
		setTimeout(() => (saved = false), 1500);
	}
</script>

<h1>settings</h1>

<section class="field">
	<label for="map-tile-url">map tile url</label>
	<input
		id="map-tile-url"
		class="location-name"
		placeholder={'https://your-tileserver/{z}/{x}/{y}.png'}
		bind:value={mapTileUrl}
		onblur={save}
	/>
	<p class="filter-banner">
		leave empty to use the bundled offline basemap (country borders + top 10k cities, ©
		<a href="https://naturalearthdata.com">Natural Earth</a>,
		<a href="https://geonames.org">GeoNames</a> CC BY 4.0). set a raster tile url template
		(self-hosted, or osm.org if you've read and accept
		<a href="https://operations.osmfoundation.org/policies/tiles/">their usage policy</a>) for more
		detail when online.
	</p>
	{#if saved}<p class="filter-banner">saved.</p>{/if}
</section>

<p>sync server url + token, export/import, storage usage: coming soon.</p>
