<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EntryEditor, { type EntryEditPayload } from '$lib/ui/EntryEditor.svelte';
	import { createEntry, listTags } from '$lib/entries/store';
	import { currentDiaryFilter } from '$lib/diaries/current.svelte';
	import { DEFAULT_DIARY_ID, type Diary } from '$lib/diaries/ids';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { loadDiariesDoc } from '$lib/diaries/store';

	let saving = $state(false);
	let error = $state<string | undefined>();
	let existingTags = $state<string[]>([]);
	let diaries = $state<Diary[]>([]);

	function today(): string {
		return new Date().toISOString().slice(0, 10);
	}

	$effect(() => {
		listTags().then((rows) => {
			existingTags = rows.map((row) => row.tag);
		});
		loadDiariesDoc().then((doc) => {
			diaries = listDiaries(doc);
		});
	});

	async function save(data: EntryEditPayload) {
		saving = true;
		error = undefined;
		try {
			const id = await createEntry(data);
			await goto(resolve('/entry/[id]', { id }));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			saving = false;
		}
	}
</script>

<h1>new entry</h1>

{#if error}
	<p class="error">{error}</p>
{/if}

<EntryEditor
	initialEntryDate={today()}
	initialDiaryId={currentDiaryFilter() ?? DEFAULT_DIARY_ID}
	{diaries}
	{existingTags}
	{saving}
	onSave={save}
/>
