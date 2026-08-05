<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	interface Props {
		initialEntryDate: string;
		initialMarkdown?: string;
		initialTags?: string[];
		existingTags?: string[];
		saving?: boolean;
		saveLabel?: string;
		onSave: (data: { entryDate: string; markdown: string; tags: string[] }) => void | Promise<void>;
		onDelete?: () => void | Promise<void>;
	}

	let {
		initialEntryDate,
		initialMarkdown = '',
		initialTags = [],
		existingTags = [],
		saving = false,
		saveLabel = 'save',
		onSave,
		onDelete
	}: Props = $props();

	// intentionally a one-time snapshot: this is local, editable scratch state
	// seeded from the loaded entry, not meant to track later prop changes.
	// svelte-ignore state_referenced_locally
	let entryDate = $state(initialEntryDate);
	// svelte-ignore state_referenced_locally
	let markdown = $state(initialMarkdown);
	// svelte-ignore state_referenced_locally
	let tags = $state([...initialTags]);
	let tagDraft = $state('');
	let preview = $state(false);

	const previewHtml = $derived(
		preview ? DOMPurify.sanitize(marked.parse(markdown, { async: false })) : ''
	);

	function addTag(raw: string) {
		const tag = raw.trim().toLowerCase();
		if (tag && !tags.includes(tag)) tags = [...tags, tag];
		tagDraft = '';
	}

	function removeTag(tag: string) {
		tags = tags.filter((t) => t !== tag);
	}

	function handleTagKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addTag(tagDraft);
		}
	}
</script>

<div class="editor">
	<label class="field">
		date
		<input type="date" bind:value={entryDate} />
	</label>

	<div class="editor-toolbar">
		<button type="button" onclick={() => (preview = false)} disabled={!preview}>write</button>
		<button type="button" onclick={() => (preview = true)} disabled={preview}>preview</button>
	</div>

	{#if preview}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- previewHtml is DOMPurify-sanitized above -->
		<div class="markdown-preview">{@html previewHtml}</div>
	{:else}
		<textarea
			class="markdown-input"
			bind:value={markdown}
			rows="12"
			placeholder="write in markdown…"></textarea>
	{/if}

	<div class="tag-editor">
		{#each tags as tag (tag)}
			<span class="tag-pill">
				#{tag}
				<button type="button" aria-label="remove tag {tag}" onclick={() => removeTag(tag)}>×</button
				>
			</span>
		{/each}
		<input
			class="tag-input"
			list="existing-tags"
			placeholder="add tag…"
			bind:value={tagDraft}
			onkeydown={handleTagKeydown}
			onblur={() => addTag(tagDraft)}
		/>
		<datalist id="existing-tags">
			{#each existingTags as tag (tag)}
				<option value={tag}></option>
			{/each}
		</datalist>
	</div>

	<div class="editor-actions">
		<button type="button" onclick={() => onSave({ entryDate, markdown, tags })} disabled={saving}>
			{saving ? 'saving…' : saveLabel}
		</button>
		{#if onDelete}
			<button type="button" class="danger" onclick={onDelete} disabled={saving}>delete</button>
		{/if}
	</div>
</div>
