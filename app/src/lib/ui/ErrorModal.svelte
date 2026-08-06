<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { dismissError, onErrorsChanged, type AppError } from '$lib/errors';

	let errors = $state<AppError[]>([]);
	let unsubscribe: (() => void) | undefined;

	onMount(() => {
		unsubscribe = onErrorsChanged((next) => {
			errors = next;
		});
	});

	onDestroy(() => unsubscribe?.());
</script>

{#if errors.length > 0}
	<div class="error-modal-backdrop">
		<div class="error-modal" role="alertdialog" aria-live="assertive">
			<h2>something went wrong</h2>
			<ul>
				{#each errors as err (err.id)}
					<li>
						<span>{err.message}</span>
						<button type="button" onclick={() => dismissError(err.id)} aria-label="dismiss">
							×
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.error-modal-backdrop {
		position: fixed;
		inset: 0;
		background: light-dark(rgb(0 0 0 / 0.3), rgb(0 0 0 / 0.6));
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 1rem;
		z-index: 1000;
	}

	.error-modal {
		background: light-dark(#fff, #1a1a1a);
		border: 1px solid light-dark(#ddd, #333);
		border-radius: 0.5rem;
		padding: 1rem;
		max-width: 480px;
		width: 100%;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
	}

	.error-modal h2 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
		color: light-dark(#b00020, #ff6b6b);
	}

	.error-modal ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.error-modal li {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		font-size: 0.9rem;
		word-break: break-word;
	}

	.error-modal button {
		background: none;
		border: none;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		color: inherit;
		opacity: 0.6;
		padding: 0;
	}

	.error-modal button:hover {
		opacity: 1;
	}
</style>
