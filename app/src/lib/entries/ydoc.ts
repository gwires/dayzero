import * as Y from 'yjs';

export interface PhotoMeta {
	mime: string;
	width: number;
	height: number;
}

// typed accessors for the shared structures inside an entry's Y.Doc.
// see PLAN.md "entries as CRDTs".
export function getText(doc: Y.Doc): Y.Text {
	return doc.getText('text');
}

export function getMeta(doc: Y.Doc): Y.Map<string | number | boolean> {
	return doc.getMap('meta');
}

export function getTags(doc: Y.Doc): Y.Map<boolean> {
	return doc.getMap('tags');
}

export function getPhotos(doc: Y.Doc): Y.Map<PhotoMeta> {
	return doc.getMap('photos');
}
