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
	import { exportBackup, importBackup } from '$lib/settings/backup';
	import { loadDiariesDoc, createDiary, renameDiary, deleteDiary } from '$lib/diaries/store';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { DEFAULT_DIARY_ID, ALL_DIARIES, type Diary } from '$lib/diaries/ids';
	import { currentDiary, selectDiary } from '$lib/diaries/current.svelte';
	import { countEntriesByDiary } from '$lib/entries/store';
	import type * as Y from 'yjs';

	let mapTileUrl = $state('');
	let saved = $state(false);

	let syncServerUrl = $state('');
	let syncToken = $state('');
	let syncSaved = $state(false);
	let syncStatus = $state<'idle' | 'syncing' | 'ok' | 'error'>('idle');
	let syncError = $state('');

	let exporting = $state(false);
	let exportedPath = $state('');
	let importing = $state(false);
	let importError = $state('');
	let storageUsage = $state<{ usageBytes: number; quotaBytes: number } | undefined>();

	let diariesDoc = $state<Y.Doc | undefined>();
	let diaries = $state<Diary[]>([]);
	let diaryCounts = $state<Record<string, number>>({});
	let newDiaryName = $state('');
	let diaryError = $state('');

	async function reloadDiaries() {
		diariesDoc = await loadDiariesDoc();
		diaries = listDiaries(diariesDoc);
		diaryCounts = await countEntriesByDiary();
	}

	async function handleCreateDiary() {
		const name = newDiaryName.trim();
		if (!name || !diariesDoc) return;
		diaryError = '';
		await createDiary(diariesDoc, name);
		newDiaryName = '';
		await reloadDiaries();
	}

	async function handleRenameDiary(id: string, name: string) {
		const trimmed = name.trim();
		const current = diaries.find((d) => d.id === id);
		if (!trimmed || !diariesDoc || trimmed === current?.name) return;
		await renameDiary(diariesDoc, id, trimmed);
		await reloadDiaries();
	}

	async function handleDeleteDiary(id: string) {
		if (!diariesDoc) return;
		diaryError = '';
		if ((diaryCounts[id] ?? 0) > 0) {
			diaryError = 'this diary still has entries — move or delete them first.';
			return;
		}
		if (!confirm('delete this diary?')) return;
		await deleteDiary(diariesDoc, id);
		if (currentDiary.id === id) await selectDiary(ALL_DIARIES);
		await reloadDiaries();
	}

	$effect(() => {
		getMapTileUrl().then((url) => {
			mapTileUrl = url ?? '';
		});
		Promise.all([getSyncServerUrl(), getSyncToken()]).then(([url, token]) => {
			syncServerUrl = url ?? '';
			syncToken = token ?? '';
		});
		navigator.storage?.estimate().then((estimate) => {
			if (estimate.usage != null && estimate.quota != null) {
				storageUsage = { usageBytes: estimate.usage, quotaBytes: estimate.quota };
			}
		});
		reloadDiaries();
	});

	function formatBytes(bytes: number): string {
		const mb = bytes / (1024 * 1024);
		return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
	}

	async function handleExport() {
		exporting = true;
		exportedPath = '';
		try {
			exportedPath = (await exportBackup()) ?? '';
		} finally {
			exporting = false;
		}
	}

	async function handleImportChange(ev: Event) {
		const input = ev.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const confirmed = confirm(
			'importing replaces all data on this device with the contents of this backup file. anything created or changed on this device since its last sync will be lost. continue?'
		);
		if (!confirmed) return;
		importing = true;
		importError = '';
		try {
			await importBackup(file);
			location.reload();
		} catch (err) {
			importError = err instanceof Error ? err.message : String(err);
			importing = false;
		}
	}

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
		leave empty to use the bundled offline basemap (country borders + top 50k cities, ©
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

<section class="field">
	<h2>diaries</h2>
	<p class="filter-banner">
		renames and new diaries sync to other devices; which diary is currently selected is per-device.
	</p>
	<ul class="tag-list">
		{#each diaries as diary (diary.id)}
			<li>
				<input
					class="location-name"
					value={diary.name}
					onblur={(e) => handleRenameDiary(diary.id, e.currentTarget.value)}
				/>
				<span class="tag-count">{diaryCounts[diary.id] ?? 0}</span>
				<button
					type="button"
					class="danger"
					disabled={diary.id === DEFAULT_DIARY_ID}
					onclick={() => handleDeleteDiary(diary.id)}
				>
					delete
				</button>
			</li>
		{/each}
	</ul>
	<div class="location-row">
		<input class="location-name" placeholder="new diary name…" bind:value={newDiaryName} />
		<button type="button" onclick={handleCreateDiary}>create diary</button>
	</div>
	{#if diaryError}<p class="error">{diaryError}</p>{/if}
</section>

<section class="field">
	<h2>backup</h2>
	<p class="filter-banner">
		export downloads the entire journal — entries, tags, photos, and these settings — as a single
		sqlite file. import replaces everything on this device with a previously exported file.
	</p>
	<button type="button" onclick={handleExport} disabled={exporting}>
		{exporting ? 'exporting…' : 'export backup'}
	</button>
	{#if exportedPath}<p class="filter-banner">saved to {exportedPath}</p>{/if}
	<label class="import-label">
		import backup
		<input
			type="file"
			accept=".sqlite,application/x-sqlite3"
			disabled={importing}
			onchange={handleImportChange}
		/>
	</label>
	{#if importing}<p class="filter-banner">importing…</p>{/if}
	{#if importError}<p class="error">import failed: {importError}</p>{/if}
</section>

<section class="field">
	<h2>storage</h2>
	{#if storageUsage}
		<p class="filter-banner">
			using {formatBytes(storageUsage.usageBytes)} of {formatBytes(storageUsage.quotaBytes)} available
			to this browser.
		</p>
	{:else}
		<p class="filter-banner">storage usage isn't available in this browser.</p>
	{/if}
</section>
