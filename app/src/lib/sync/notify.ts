// tiny pub/sub so entries/store.ts (a local write happened) and sync/engine.ts
// (schedule a debounced sync) can talk without either module importing the
// other — store.ts doesn't know sync exists, engine.ts just listens.
type Listener = () => void;

const listeners = new Set<Listener>();

export function onLocalWrite(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function notifyLocalWrite(): void {
	for (const fn of listeners) fn();
}
