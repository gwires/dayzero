<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Map as MaplibreMap,
		Marker,
		NavigationControl,
		addProtocol,
		removeProtocol,
		setWorkerUrl,
		type StyleSpecification
	} from 'maplibre-gl';
	import { Protocol } from 'pmtiles';
	import 'maplibre-gl/dist/maplibre-gl.css';

	// vite can't statically discover maplibre's internally-constructed worker
	// url, so point it at the static copy vite.config.ts places at the site
	// root (via vite-plugin-static-copy).
	setWorkerUrl('/maplibre-gl-worker.mjs');

	interface Props {
		lat: number;
		lng: number;
		/**
		 * custom raster tile url template (e.g. a self-hosted tileserver or
		 * osm.org's `{z}/{x}/{y}.png` scheme, from the "map tile url" setting).
		 * falls back to the bundled offline vector basemap when unset.
		 */
		tileUrl?: string | null;
	}

	let { lat, lng, tileUrl }: Props = $props();

	let container: HTMLDivElement;
	let map: InstanceType<typeof MaplibreMap> | undefined;
	let protocol: Protocol | undefined;

	const offlineStyle: StyleSpecification = {
		version: 8,
		sources: {
			basemap: {
				type: 'vector',
				url: 'pmtiles:///basemap.pmtiles',
				attribution:
					'© <a href="https://naturalearthdata.com">Natural Earth</a>, <a href="https://geonames.org">GeoNames</a>'
			}
		},
		layers: [
			{ id: 'background', type: 'background', paint: { 'background-color': '#dce6f0' } },
			{
				id: 'countries-fill',
				type: 'fill',
				source: 'basemap',
				'source-layer': 'countries',
				paint: { 'fill-color': '#f2efe9' }
			},
			{
				id: 'countries-line',
				type: 'line',
				source: 'basemap',
				'source-layer': 'countries',
				paint: { 'line-color': '#b3aa9c', 'line-width': 0.75 }
			},
			{
				id: 'cities-point',
				type: 'circle',
				source: 'basemap',
				'source-layer': 'cities',
				paint: { 'circle-radius': 2, 'circle-color': '#8a7f6a' }
			}
		]
	};

	function rasterStyle(url: string): StyleSpecification {
		return {
			version: 8,
			sources: {
				raster: {
					type: 'raster',
					tiles: [url],
					tileSize: 256
				}
			},
			layers: [{ id: 'raster', type: 'raster', source: 'raster' }]
		};
	}

	onMount(() => {
		protocol = new Protocol();
		addProtocol('pmtiles', protocol.tile);

		const instance = new MaplibreMap({
			container,
			style: tileUrl ? rasterStyle(tileUrl) : offlineStyle,
			center: [lng, lat],
			zoom: tileUrl ? 12 : 6,
			attributionControl: { compact: true }
		});
		instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');
		new Marker().setLngLat([lng, lat]).addTo(instance);
		map = instance;
	});

	onDestroy(() => {
		map?.remove();
		if (protocol) removeProtocol('pmtiles');
	});
</script>

<div class="map-view" bind:this={container}></div>
