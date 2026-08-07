import { describe, expect, it } from 'vitest';
import { likePattern, matchSnippet } from './search';

describe('likePattern', () => {
	it('wraps a plain query as a substring match', () => {
		expect(likePattern('coffee')).toBe('%coffee%');
	});

	it('escapes wildcards so they match literally', () => {
		expect(likePattern('100%')).toBe('%100\\%%');
		expect(likePattern('snake_case')).toBe('%snake\\_case%');
		expect(likePattern('back\\slash')).toBe('%back\\\\slash%');
	});
});

describe('matchSnippet', () => {
	it('returns short entries whole', () => {
		expect(matchSnippet('  a short entry  ', 'short')).toBe('a short entry');
	});

	it('centres the window on the match', () => {
		const text = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
		const snippet = matchSnippet(text, 'needle');
		expect(snippet).toContain('needle');
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
		// the ellipses are the only characters beyond the window itself.
		expect(snippet.length).toBe(142);
	});

	it('matches case-insensitively', () => {
		const text = `${'a'.repeat(200)} NeEdLe ${'b'.repeat(200)}`;
		expect(matchSnippet(text, 'needle')).toContain('NeEdLe');
	});

	it('keeps the leading ellipsis off a match near the start', () => {
		const text = `needle ${'b'.repeat(300)}`;
		const snippet = matchSnippet(text, 'needle');
		expect(snippet.startsWith('needle')).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
	});

	it('keeps the trailing ellipsis off a match near the end', () => {
		const text = `${'a'.repeat(300)} needle`;
		const snippet = matchSnippet(text, 'needle');
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet.endsWith('needle')).toBe(true);
	});

	it('falls back to the opening when the query is not found', () => {
		const text = 'c'.repeat(300);
		expect(matchSnippet(text, 'needle')).toBe(`${'c'.repeat(140)}…`);
	});
});
