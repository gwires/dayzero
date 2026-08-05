<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import '../app.css';

	let { children } = $props();

	onMount(async () => {
		const { useRegisterSW } = await import('virtual:pwa-register/svelte');
		useRegisterSW({ immediate: true });
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
		<a href={resolve('/settings')}>settings</a>
	</nav>
	<main>
		{@render children()}
	</main>
</div>
