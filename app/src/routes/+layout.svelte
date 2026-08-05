<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import { initSyncEngine } from '$lib/sync/engine';
	import '../app.css';

	let { children } = $props();

	onMount(() => {
		// fire-and-forget: onMount only honors a *synchronously* returned
		// cleanup function, so the async SW registration can't itself be the
		// mount callback if initSyncEngine's cleanup is also going to be returned.
		void (async () => {
			const { useRegisterSW } = await import('virtual:pwa-register/svelte');
			useRegisterSW({ immediate: true });
		})();

		return initSyncEngine();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app">
	<nav>
		<a href={resolve('/')}>timeline</a>
		<a href={resolve('/new')}>new</a>
		<a href={resolve('/tags')}>tags</a>
		<a href={resolve('/calendar')}>calendar</a>
		<a href={resolve('/map')}>map</a>
		<a href={resolve('/settings')}>settings</a>
	</nav>
	<main>
		{@render children()}
	</main>
</div>
