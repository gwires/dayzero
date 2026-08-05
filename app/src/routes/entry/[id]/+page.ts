import type { PageLoad } from './$types';
import { loadEntryDoc } from '$lib/entries/store';
import { materialize } from '$lib/entries/materialize';

export const load: PageLoad = async ({ params }) => {
	const doc = await loadEntryDoc(params.id);
	if (!doc) {
		return { id: params.id, doc: undefined, entryDate: '', markdown: '', tags: [] as string[] };
	}
	const { entry, tags } = materialize(params.id, doc);
	return { id: params.id, doc, entryDate: entry.entry_date ?? '', markdown: entry.markdown, tags };
};
