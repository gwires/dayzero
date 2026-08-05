<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EntryEditor from '$lib/ui/EntryEditor.svelte';
	import { applyEdits, deleteEntry, listTags, updateEntry } from '$lib/entries/store';

	let { data } = $props();

	let saving = $state(false);
	let error = $state<string | undefined>();
	let existingTags = $state<string[]>([]);

	$effect(() => {
		listTags().then((rows) => {
			existingTags = rows.map((row) => row.tag);
		});
	});

	async function save(update: { entryDate: string; markdown: string; tags: string[] }) {
		if (!data.doc) return;
		saving = true;
		error = undefined;
		try {
			await updateEntry(data.id, data.doc, (doc) => applyEdits(doc, update));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!data.doc) return;
		saving = true;
		error = undefined;
		try {
			await deleteEntry(data.id, data.doc);
			await goto(resolve('/'));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			saving = false;
		}
	}
</script>

<h1>entry</h1>

{#if error}
	<p class="error">{error}</p>
{/if}

{#if !data.doc}
	<p>entry not found.</p>
{:else}
	<EntryEditor
		initialEntryDate={data.entryDate}
		initialMarkdown={data.markdown}
		initialTags={data.tags}
		{existingTags}
		{saving}
		saveLabel="save changes"
		onSave={save}
		onDelete={remove}
	/>
{/if}
