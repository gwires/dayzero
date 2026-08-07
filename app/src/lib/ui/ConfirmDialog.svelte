<script lang="ts">
	interface Props {
		open: boolean;
		title?: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		danger?: boolean;
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
		onConfirm,
		onCancel
	}: Props = $props();
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
			<div class="confirm-dialog-actions">
				<button type="button" onclick={onCancel}>{cancelLabel}</button>
				<button type="button" class:danger onclick={onConfirm}>{confirmLabel}</button>
			</div>
		</div>
	</div>
{/if}
