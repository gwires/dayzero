// device-local theme override. 'system' (the default) is a no-op: app.css's
// `color-scheme: light dark` already follows the OS via `light-dark()`.
// 'light'/'dark' pin that by narrowing `color-scheme` on <html>, which wins
// over the stylesheet since it's set as an inline style.
//
// stored in localStorage rather than the sqlite-backed sync_state store (see
// $lib/settings/store.ts) so it's readable synchronously — see the inline
// script in app.html, which applies it before first paint to avoid a flash
// of the wrong theme.

export type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'dayzero_theme';

function readStoredTheme(): Theme {
	const value = localStorage.getItem(THEME_KEY);
	return value === 'light' || value === 'dark' ? value : 'system';
}

export const theme = $state<{ value: Theme }>({ value: 'system' });

function apply(value: Theme): void {
	document.documentElement.style.colorScheme = value === 'system' ? 'light dark' : value;
	const dark =
		value === 'dark' || (value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', dark ? '#111111' : '#ffffff');
}

/** called once from the root layout; the inline script in app.html has
 * already applied the pinned theme to the dom by then, so this just brings
 * the reactive state (e.g. the settings page's select) in sync with it. */
export function initTheme(): void {
	theme.value = readStoredTheme();
	apply(theme.value);
}

export function setTheme(value: Theme): void {
	theme.value = value;
	if (value === 'system') {
		localStorage.removeItem(THEME_KEY);
	} else {
		localStorage.setItem(THEME_KEY, value);
	}
	apply(value);
}
