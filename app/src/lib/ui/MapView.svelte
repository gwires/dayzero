<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		LngLatBounds,
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

	export interface MapMarker {
		id: string;
		lat: number;
		lng: number;
	}

	interface Props {
		/** single-location mode: centers on lat/lng with a marker (used by the entry editor's locator map). */
		lat?: number;
		lng?: number;
		/** overview mode: plots one marker per entry and fits the view to all of them (used by the map overview page). ignores lat/lng when given. */
		markers?: MapMarker[];
		onMarkerClick?: (id: string) => void;
		/**
		 * custom raster tile url template (e.g. a self-hosted tileserver or
		 * osm.org's `{z}/{x}/{y}.png` scheme, from the "map tile url" setting).
		 * falls back to the bundled offline vector basemap when unset.
		 */
		tileUrl?: string | null;
		class?: string;
	}

	let { lat, lng, markers, onMarkerClick, tileUrl, class: className = '' }: Props = $props();

	let container: HTMLDivElement;
	let map: InstanceType<typeof MaplibreMap> | undefined;
	let protocol: Protocol | undefined;

	const offlineStyle: StyleSpecification = {
		version: 8,
		// self-hosted glyph range (ASCII + Latin-1 only, from
		// app/static/glyphs/ — see scripts/build-glyphs.sh) matching the
		// asciiname labels baked into basemap.pmtiles's cities layer.
		glyphs: '/glyphs/{fontstack}/{range}.pbf',
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
			},
			{
				id: 'cities-label',
				type: 'symbol',
				source: 'basemap',
				'source-layer': 'cities',
				minzoom: 3,
				layout: {
					'text-field': ['get', 'name'],
					'text-font': ['dejavu-sans'],
					'text-size': 11,
					'text-anchor': 'left',
					'text-offset': [0.6, 0]
				},
				paint: {
					'text-color': '#4a4335',
					'text-halo-color': '#f2efe9',
					'text-halo-width': 1
				}
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

		const hasMarkers = markers && markers.length > 0;
		const instance = new MaplibreMap({
			container,
			style: tileUrl ? rasterStyle(tileUrl) : offlineStyle,
			center: hasMarkers ? [markers![0].lng, markers![0].lat] : [lng ?? 0, lat ?? 0],
			zoom: hasMarkers ? 2 : tileUrl ? 12 : 6,
			attributionControl: { compact: true }
		});
		instance.addControl(new NavigationControl({ showCompass: false }), 'top-right');

		if (hasMarkers) {
			const bounds = new LngLatBounds();
			for (const m of markers!) {
				const el = document.createElement('button');
				el.type = 'button';
				el.className = 'map-marker-button';
				el.setAttribute('aria-label', 'open entry');
				el.onclick = () => onMarkerClick?.(m.id);
				new Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(instance);
				bounds.extend([m.lng, m.lat]);
			}
			instance.fitBounds(bounds, { padding: 40, maxZoom: 10, animate: false });
		} else if (lat != null && lng != null) {
			new Marker().setLngLat([lng, lat]).addTo(instance);
		}
		map = instance;
	});

	onDestroy(() => {
		map?.remove();
		if (protocol) removeProtocol('pmtiles');
	});
</script>

<div class="map-view {className}" bind:this={container}></div>
