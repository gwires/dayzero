// splits a generated entry .md file into its yaml frontmatter and body.
// see TESTGEN-PLAN.md step 2 — deliberately not the @std/front-matter
// package; the split itself is a handful of lines, callers parse `fm`
// with @std/yaml's `parse`.

export function splitFrontmatter(md: string): { fm: string; body: string } {
	const lines = md.split('\n');
	if (lines[0] !== '---') throw new Error('frontmatter must start with a "---" line');

	let endIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === '---') {
			endIdx = i;
			break;
		}
	}
	if (endIdx === -1) throw new Error('unterminated frontmatter (no closing "---" line)');

	const fm = lines.slice(1, endIdx).join('\n');
	let bodyLines = lines.slice(endIdx + 1);
	if (bodyLines[0] === '') bodyLines = bodyLines.slice(1); // one leading blank line
	return { fm, body: bodyLines.join('\n') };
}
