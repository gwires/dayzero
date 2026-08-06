// catches uncaught errors and promise rejections that would otherwise be
// silently invisible on mobile (no devtools) — see BUGS.md "meta: errors
// are invisible on mobile". consumed by ui/ErrorModal.svelte.

export interface AppError {
	id: number;
	message: string;
}

type Listener = (errors: AppError[]) => void;

let nextId = 0;
const errors: AppError[] = [];
const listeners = new Set<Listener>();

function notify(): void {
	for (const fn of listeners) fn(errors);
}

export function onErrorsChanged(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function reportError(message: string): void {
	errors.push({ id: nextId++, message });
	notify();
}

export function dismissError(id: number): void {
	const idx = errors.findIndex((e) => e.id === id);
	if (idx !== -1) errors.splice(idx, 1);
	notify();
}

/**
 * wires window-level `error`/`unhandledrejection` handlers into the error
 * store so uncaught failures surface as a dismissible modal instead of
 * failing silently. call once from the root layout.
 */
export function initGlobalErrorHandlers(): () => void {
	const onError = (event: ErrorEvent) => {
		reportError(event.message);
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		const { reason } = event;
		reportError(reason instanceof Error ? reason.message : String(reason));
	};

	window.addEventListener('error', onError);
	window.addEventListener('unhandledrejection', onRejection);

	return () => {
		window.removeEventListener('error', onError);
		window.removeEventListener('unhandledrejection', onRejection);
	};
}
