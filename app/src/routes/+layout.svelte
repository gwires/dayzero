<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import { initGlobalErrorHandlers } from '$lib/errors';
	import { initSyncEngine } from '$lib/sync/engine';
	import ErrorModal from '$lib/ui/ErrorModal.svelte';
	import { currentDiary, initCurrentDiary, selectDiary } from '$lib/diaries/current.svelte';
	import { ALL_DIARIES, type Diary } from '$lib/diaries/ids';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { loadDiariesDoc } from '$lib/diaries/store';
	import { initTheme } from '$lib/settings/theme.svelte';
	import '../app.css';

	let { children } = $props();

	let diaries = $state<Diary[]>([]);

	// refresh the switcher on every navigation, so registry changes made in
	// settings or pulled by sync show up without a manual reload.
	$effect(() => {
		void page.url;
		loadDiariesDoc().then((doc) => {
			diaries = listDiaries(doc);
			// a stale persisted scope (diary deleted / db imported) falls back
			// to 'all' instead of silently filtering everything out.
			if (currentDiary.id !== ALL_DIARIES && !diaries.some((d) => d.id === currentDiary.id)) {
				void selectDiary(ALL_DIARIES);
			}
		});
	});

	onMount(() => {
		initTheme();
		void initCurrentDiary();

		// fire-and-forget: onMount only honors a *synchronously* returned
		// cleanup function, so the async SW registration can't itself be the
		// mount callback if initSyncEngine's cleanup is also going to be returned.
		void (async () => {
			const { useRegisterSW } = await import('virtual:pwa-register/svelte');
			useRegisterSW({ immediate: true });
		})();

		const offErrors = initGlobalErrorHandlers();
		const offSync = initSyncEngine();
		return () => {
			offErrors();
			offSync();
		};
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<ErrorModal />

<div class="app">
	<nav>
		<a href={resolve('/')}>list</a>
		<a href={resolve('/new')}>new</a>
		<a href={resolve('/calendar')}>calendar</a>
		<a href={resolve('/photos')}>photos</a>
		<a href={resolve('/map')}>map</a>
		<a href={resolve('/settings')} aria-label="settings">
			<span class="settings-label">settings</span>
			<span class="settings-icon" aria-hidden="true">⋮</span>
		</a>
		<span class="diary-switcher">
			<span class="diary-icon" aria-hidden="true">📓</span>
			<select
				class="diary-select"
				aria-label="diary"
				value={currentDiary.id}
				onchange={(e) => selectDiary(e.currentTarget.value)}
			>
				<option value={ALL_DIARIES}>all diaries</option>
				{#each diaries as diary (diary.id)}
					<option value={diary.id}>{diary.name}</option>
				{/each}
			</select>
		</span>
		<a href={resolve('/search')} class="search-link" aria-label="search">
			<span class="search-label">search</span>
			<span class="search-icon" aria-hidden="true">🔍</span>
		</a>
	</nav>
	<main>
		{@render children()}
	</main>
</div>

<a href={resolve('/new')} class="fab" aria-label="new entry">+</a>
