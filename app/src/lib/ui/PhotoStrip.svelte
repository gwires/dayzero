<script lang="ts">
	import PhotoThumb from './PhotoThumb.svelte';
	import type { PhotoEntry } from '$lib/entries/store';

	interface Props {
		photos: PhotoEntry[];
		onAdd: (files: File[]) => void | Promise<void>;
		onRemove: (hash: string) => void | Promise<void>;
		busy?: boolean;
	}

	let { photos, onAdd, onRemove, busy = false }: Props = $props();

	let dragOver = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();

	function imageFiles(list: FileList | null): File[] {
		return list ? [...list].filter((file) => file.type.startsWith('image/')) : [];
	}

	function handleChange(event: Event) {
		const files = imageFiles((event.target as HTMLInputElement).files);
		if (files.length) onAdd(files);
		if (fileInput) fileInput.value = '';
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		dragOver = false;
		const files = imageFiles(event.dataTransfer?.files ?? null);
		if (files.length) onAdd(files);
	}
</script>

<div class="photo-strip">
	{#each photos as photo (photo.hash)}
		<PhotoThumb {photo} onRemove={() => onRemove(photo.hash)} />
	{/each}

	<label
		class="photo-drop"
		class:drag-over={dragOver}
		ondragover={(event) => {
			event.preventDefault();
			dragOver = true;
		}}
		ondragleave={() => (dragOver = false)}
		ondrop={handleDrop}
	>
		{busy ? 'adding…' : '+ add photo'}
		<input
			bind:this={fileInput}
			type="file"
			accept="image/*"
			multiple
			hidden
			disabled={busy}
			onchange={handleChange}
		/>
	</label>
</div>
