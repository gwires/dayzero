<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EntryEditor, { type EntryEditPayload } from '$lib/ui/EntryEditor.svelte';
	import { createEntry, listTags } from '$lib/entries/store';

	let saving = $state(false);
	let error = $state<string | undefined>();
	let existingTags = $state<string[]>([]);

	function today(): string {
		return new Date().toISOString().slice(0, 10);
	}

	$effect(() => {
		listTags().then((rows) => {
			existingTags = rows.map((row) => row.tag);
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

<EntryEditor initialEntryDate={today()} {existingTags} {saving} onSave={save} />
