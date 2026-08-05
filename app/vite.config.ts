import { defineConfig, type Plugin } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * `.pmtiles` isn't a mime-db-registered extension, so vite/preview's static
 * server falls back to treating it as compressible text and gzips its Range
 * responses — invalid, since a byte range of a binary file isn't a valid
 * standalone gzip stream (browsers fail with ERR_CONTENT_DECODING_FAILED).
 * Setting an explicit content-type before vite's own middleware runs avoids
 * the misdetection. A production static host must do the same.
 */
function pmtilesContentType(): Plugin {
	const middleware: import('vite').Connect.NextHandleFunction = (req, res, next) => {
		if (req.url?.split('?')[0].endsWith('.pmtiles')) {
			res.setHeader('Content-Type', 'application/octet-stream');
		}
		next();
	};
	return {
		name: 'pmtiles-content-type',
		configureServer(server) {
			server.middlewares.use(middleware);
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware);
		}
	};
}

export default defineConfig({
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm']
	},
	worker: {
		format: 'es'
	},
	plugins: [
		pmtilesContentType(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '200.html' })
		}),
		// maplibre-gl loads its worker via a runtime-computed URL that vite can't
		// statically bundle, so its worker + shared chunk are served as-is.
		viteStaticCopy({
			targets: [
				{
					src: 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs',
					dest: '.',
					rename: { stripBase: true }
				},
				{
					src: 'node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs',
					dest: '.',
					rename: { stripBase: true }
				}
			]
		}),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			strategies: 'generateSW',
			injectRegister: false,
			workbox: {
				globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,webmanifest,wasm,pmtiles}'],
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
			},
			manifest: {
				name: 'dayzero',
				short_name: 'dayzero',
				description: 'A local-first diary',
				start_url: '/',
				display: 'standalone',
				background_color: '#111111',
				theme_color: '#111111',
				icons: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{
						src: '/icons/icon-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			devOptions: {
				enabled: true,
				type: 'module'
			},
			kit: {
				includeVersionFile: true,
				spa: true,
				adapterFallback: '200.html'
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
