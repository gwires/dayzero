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
		<span class="diary-switcher">
			<svg class="nav-icon diary-icon" viewBox="0 0 24 24" aria-hidden="true">
				<rect x="3.6" y="3" width="16.8" height="18" rx="2" />
				<path d="M8.4 3v18M11.6 9.5h5.2M11.6 14h5.2" />
			</svg>
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
			<svg class="nav-icon search-icon" viewBox="0 0 24 24" aria-hidden="true">
				<circle cx="10.5" cy="10.5" r="6.5" />
				<path d="M15.4 15.4 20.5 20.5" />
			</svg>
		</a>
		<a href={resolve('/')}>list</a>
		<a href={resolve('/new')}>new</a>
		<a href={resolve('/calendar')}>calendar</a>
		<a href={resolve('/map')}>map</a>
		<a href={resolve('/photos')}>photos</a>
		<a href={resolve('/settings')} aria-label="settings">
			<span class="settings-label">settings</span>
			<svg class="nav-icon settings-icon" viewBox="0 0 24 24" aria-hidden="true">
				<path
					d="M10 2.6A9.6 9.6 0 0 1 14 2.6L14.5 5.4A7.1 7.1 0 0 1 16.5 6.5L19.1 5.6A9.6 9.6 0 0 1 21.1 9L19 10.9A7.1 7.1 0 0 1 19 13.1L21.1 15A9.6 9.6 0 0 1 19.1 18.4L16.5 17.5A7.1 7.1 0 0 1 14.5 18.6L14 21.4A9.6 9.6 0 0 1 10 21.4L9.5 18.6A7.1 7.1 0 0 1 7.5 17.5L4.9 18.4A9.6 9.6 0 0 1 2.9 15L5 13.1A7.1 7.1 0 0 1 5 10.9L2.9 9A9.6 9.6 0 0 1 4.9 5.6L7.5 6.5A7.1 7.1 0 0 1 9.5 5.4L10 2.6Z"
				/>
				<circle cx="12" cy="12" r="3.2" />
			</svg>
		</a>
	</nav>
	<main>
		{@render children()}
	</main>
</div>

<a href={resolve('/new')} class="fab" aria-label="new entry">+</a>
