<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { clipMarkdown } from '$lib/entries/markdown';

	interface Props {
		markdown: string;
		/** cap on the source characters parsed; omit to render all of it. */
		limit?: number;
		class?: string;
	}

	let { markdown, limit, class: className }: Props = $props();

	const source = $derived(limit === undefined ? markdown : clipMarkdown(markdown, limit));
	const html = $derived(DOMPurify.sanitize(marked.parse(source, { async: false })));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- html is DOMPurify-sanitized above -->
<div class={className}>{@html html}</div>
