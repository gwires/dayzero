<script lang="ts">
	interface ConfirmInput {
		label: string;
		expected: string;
	}

	interface Props {
		open: boolean;
		title?: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
		confirmInput?: ConfirmInput;
		onConfirm: () => void | Promise<void>;
		onCancel: () => void;
	}

	let {
		open,
		title = 'are you sure?',
		message,
		confirmLabel = 'delete',
		cancelLabel = 'cancel',
		danger = true,
		confirmInput,
		onConfirm,
		onCancel
	}: Props = $props();

	let inputValue = $state('');
	const canConfirm = $derived(
		!confirmInput || inputValue.trim() === confirmInput.expected
	);

	$effect(() => {
		if (!open) inputValue = '';
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') onCancel();
	}}
/>

{#if open}
	<div class="confirm-dialog-backdrop">
		<div
			class="confirm-dialog"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="confirm-dialog-title"
		>
			<h2 id="confirm-dialog-title">{title}</h2>
			<p>{message}</p>
			{#if confirmInput}
				<div class="confirm-dialog-input">
					<label>{confirmInput.label}</label>
					<input
						type="text"
						bind:value={inputValue}
						autofocus
						autocomplete="off"
					/>
				</div>
			{/if}
			<div class="confirm-dialog-actions">
				<button type="button" onclick={onCancel}>{cancelLabel}</button>
				<button
					type="button"
					class:danger
					disabled={!canConfirm}
					onclick={() => canConfirm && onConfirm()}
				>
					{confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}
