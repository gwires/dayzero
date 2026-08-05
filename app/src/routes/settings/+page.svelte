<script lang="ts">
	import {
		getMapTileUrl,
		getSyncServerUrl,
		getSyncToken,
		setMapTileUrl,
		setSyncServerUrl,
		setSyncToken
	} from '$lib/settings/store';
	import { syncOnce } from '$lib/sync/engine';

	let mapTileUrl = $state('');
	let saved = $state(false);

	let syncServerUrl = $state('');
	let syncToken = $state('');
	let syncSaved = $state(false);
	let syncStatus = $state<'idle' | 'syncing' | 'ok' | 'error'>('idle');
	let syncError = $state('');

	$effect(() => {
		getMapTileUrl().then((url) => {
			mapTileUrl = url ?? '';
		});
		Promise.all([getSyncServerUrl(), getSyncToken()]).then(([url, token]) => {
			syncServerUrl = url ?? '';
			syncToken = token ?? '';
		});
	});

	async function save() {
		await setMapTileUrl(mapTileUrl.trim() || undefined);
		saved = true;
		setTimeout(() => (saved = false), 1500);
	}

	async function saveSyncSettings() {
		await Promise.all([
			setSyncServerUrl(syncServerUrl.trim() || undefined),
			setSyncToken(syncToken.trim() || undefined)
		]);
		syncSaved = true;
		setTimeout(() => (syncSaved = false), 1500);
	}

	async function syncNow() {
		syncStatus = 'syncing';
		const result = await syncOnce();
		if (!result.attempted) {
			syncStatus = 'idle';
		} else if (result.error) {
			syncStatus = 'error';
			syncError = result.error;
		} else {
			syncStatus = 'ok';
			setTimeout(() => (syncStatus = 'idle'), 2000);
		}
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

<section class="field">
	<label for="sync-server-url">sync server url</label>
	<input
		id="sync-server-url"
		class="location-name"
		placeholder="https://your-dayzero-server"
		bind:value={syncServerUrl}
		onblur={saveSyncSettings}
	/>
	<label for="sync-token">sync token</label>
	<input
		id="sync-token"
		class="location-name"
		type="password"
		placeholder="bearer token"
		bind:value={syncToken}
		onblur={saveSyncSettings}
	/>
	<p class="filter-banner">
		leave empty to keep this device offline-only. see <code>DAYZERO_AUTH_TOKEN</code> in the server's
		config for the token.
	</p>
	{#if syncSaved}<p class="filter-banner">saved.</p>{/if}
	<button type="button" onclick={syncNow} disabled={syncStatus === 'syncing'}>
		{syncStatus === 'syncing' ? 'syncing…' : 'sync now'}
	</button>
	{#if syncStatus === 'ok'}<span class="filter-banner">synced.</span>{/if}
	{#if syncStatus === 'error'}<p class="error">sync failed: {syncError}</p>{/if}
</section>

<p>export/import, storage usage: coming soon.</p>
