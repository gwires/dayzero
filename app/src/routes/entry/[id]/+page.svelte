<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import EntryEditor, { type EntryEditPayload } from '$lib/ui/EntryEditor.svelte';
	import {
		addPhoto,
		applyEdits,
		deleteEntry,
		listPhotos,
		listTags,
		removePhoto,
		updateEntry,
		type PhotoEntry
	} from '$lib/entries/store';
	import { type Diary } from '$lib/diaries/ids';
	import { listDiaries } from '$lib/diaries/ydoc';
	import { loadDiariesDoc } from '$lib/diaries/store';

	let { data } = $props();

	let saving = $state(false);
	let error = $state<string | undefined>();
	let existingTags = $state<string[]>([]);
	let diaries = $state<Diary[]>([]);
	// svelte-ignore state_referenced_locally
	let photos = $state<PhotoEntry[]>(data.photos);
	let photosBusy = $state(false);

	$effect(() => {
		listTags().then((rows) => {
			existingTags = rows.map((row) => row.tag);
		});
		loadDiariesDoc().then((doc) => {
			diaries = listDiaries(doc);
		});
	});

	async function save(update: EntryEditPayload) {
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

	async function addPhotos(files: File[]) {
		if (!data.doc) return;
		photosBusy = true;
		error = undefined;
		try {
			for (const file of files) {
				await addPhoto(data.id, data.doc, file);
			}
			photos = listPhotos(data.doc);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			photosBusy = false;
		}
	}

	async function removePhotoByHash(hash: string) {
		if (!data.doc) return;
		photosBusy = true;
		error = undefined;
		try {
			await removePhoto(data.id, data.doc, hash);
			photos = listPhotos(data.doc);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			photosBusy = false;
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
		initialDiaryId={data.diaryId}
		{diaries}
		initialLocationLat={data.locationLat}
		initialLocationLng={data.locationLng}
		initialLocationName={data.locationName}
		{existingTags}
		{photos}
		onAddPhotos={addPhotos}
		onRemovePhoto={removePhotoByHash}
		{photosBusy}
		{saving}
		saveLabel="save changes"
		onSave={save}
		onDelete={remove}
	/>
{/if}
