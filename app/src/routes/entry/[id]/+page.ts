import type { PageLoad } from './$types';
import { loadEntryDoc, listPhotos } from '$lib/entries/store';
import { materialize } from '$lib/entries/materialize';
import { DEFAULT_DIARY_ID } from '$lib/diaries/ids';

export const load: PageLoad = async ({ params }) => {
	const doc = await loadEntryDoc(params.id);
	if (!doc) {
		return {
			id: params.id,
			doc: undefined,
			entryDate: '',
			markdown: '',
			tags: [] as string[],
			diaryId: DEFAULT_DIARY_ID,
			locationLat: null,
			locationLng: null,
			locationName: null,
			photos: []
		};
	}
	const { entry, tags } = materialize(params.id, doc);
	return {
		id: params.id,
		doc,
		entryDate: entry.entry_date ?? '',
		markdown: entry.markdown,
		tags,
		diaryId: entry.diary_id,
		locationLat: entry.location_lat,
		locationLng: entry.location_lng,
		locationName: entry.location_name,
		photos: listPhotos(doc)
	};
};
