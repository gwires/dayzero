// pure helpers behind the /search page: turning what someone typed into a
// literal `like` pattern, and picking the part of an entry worth showing.

const SNIPPET_LENGTH = 140;

/**
 * wraps a plain-text query as a substring `like` pattern, escaping the
 * wildcards so searching for `100%` or `snake_case` matches literally.
 * pairs with `escape '\'` in the query.
 */
export function likePattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * a ~`length`-character window of `text` centred on the first (case-insensitive)
 * occurrence of `query`, so a result shows why it matched rather than just its
 * opening line. elided sides are marked with an ellipsis.
 */
export function matchSnippet(text: string, query: string, length = SNIPPET_LENGTH): string {
	const trimmed = text.trim();
	if (trimmed.length <= length) return trimmed;

	const needle = query.trim().toLowerCase();
	const at = needle ? trimmed.toLowerCase().indexOf(needle) : -1;
	// a miss (or an empty query) falls back to the opening, same as the list page.
	const start =
		at < 0
			? 0
			: Math.max(
					0,
					Math.min(at - Math.floor((length - needle.length) / 2), trimmed.length - length)
				);
	const end = start + length;
	return `${start > 0 ? '…' : ''}${trimmed.slice(start, end)}${end < trimmed.length ? '…' : ''}`;
}
