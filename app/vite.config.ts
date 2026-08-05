import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm']
	},
	worker: {
		format: 'es'
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '200.html' })
		}),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			strategies: 'generateSW',
			injectRegister: false,
			workbox: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm}'],
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
