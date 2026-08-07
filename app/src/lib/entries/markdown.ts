/**
 * cuts markdown down to roughly `limit` characters on a word boundary, so a
 * list preview only parses as much of a long entry as it could ever show. the
 * rendered block is line-clamped on top of this — the cut is generous on
 * purpose, since clipping mid-syntax (`**bo`) is what renders badly.
 */
export function clipMarkdown(markdown: string, limit: number): string {
	const trimmed = markdown.trim();
	if (trimmed.length <= limit) return trimmed;

	const cut = trimmed.slice(0, limit);
	const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
	// only honour the boundary if it isn't so far back that it eats the preview
	// (one very long unbroken token, say a url).
	return `${boundary > limit * 0.6 ? cut.slice(0, boundary) : cut}…`;
}
