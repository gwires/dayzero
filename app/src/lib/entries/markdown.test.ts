import { describe, expect, it } from 'vitest';
import { clipMarkdown } from './markdown';

describe('clipMarkdown', () => {
	it('returns short markdown whole, trimmed', () => {
		expect(clipMarkdown('  # a heading\n\nsome text  ', 100)).toBe('# a heading\n\nsome text');
	});

	it('cuts back to a word boundary', () => {
		const text = 'one two three four five six seven eight nine ten';
		const clipped = clipMarkdown(text, 20);
		expect(clipped).toBe('one two three four…');
		expect(clipped.length).toBeLessThanOrEqual(21);
	});

	it('cuts at a newline when that is the last boundary', () => {
		expect(clipMarkdown('# heading\nbodybodybodybody', 12)).toBe('# heading…');
	});

	it('cuts mid-token rather than gut the preview for one long word', () => {
		const url = `see https://example.com/${'a'.repeat(200)}`;
		// the only boundary sits at char 3, far too early to keep
		expect(clipMarkdown(url, 50)).toBe(`${url.slice(0, 50)}…`);
	});

	it('keeps enough characters to outrun a three-line clamp', () => {
		const long = 'word '.repeat(400);
		expect(clipMarkdown(long, 500).length).toBeGreaterThan(400);
	});
});
