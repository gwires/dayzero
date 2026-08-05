// Turns the raw Natural Earth countries GeoJSON and GeoNames cities15000.txt
// into two small, trimmed GeoJSON files ready for tippecanoe. See
// build-basemap.sh and scripts/README.md.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , countriesInPath, citiesInPath, countriesOutPath, citiesOutPath, topN] = process.argv;

// countries: keep only the fields the map style actually uses.
const rawCountries = JSON.parse(readFileSync(countriesInPath, 'utf8'));
const countries = {
	type: 'FeatureCollection',
	features: rawCountries.features.map((f) => ({
		type: 'Feature',
		properties: {
			name: f.properties.ADMIN ?? f.properties.NAME ?? '',
			iso_a2: f.properties.ISO_A2 ?? ''
		},
		geometry: f.geometry
	}))
};
writeFileSync(countriesOutPath, JSON.stringify(countries));

// cities15000.txt is GeoNames' tab-separated dump, one row per populated
// place with population >= 15000:
// geonameid, name, asciiname, alternatenames, lat, lng, feature class,
// feature code, country code, cc2, admin1, admin2, admin3, admin4,
// population, elevation, dem, timezone, modification date
const lines = readFileSync(citiesInPath, 'utf8').split('\n').filter(Boolean);
const rows = lines.map((line) => line.split('\t'));
rows.sort((a, b) => Number(b[14]) - Number(a[14]));
const top = rows.slice(0, Number(topN));

const cities = {
	type: 'FeatureCollection',
	features: top.map((row) => ({
		type: 'Feature',
		properties: {
			name: row[1],
			country: row[8],
			population: Number(row[14])
		},
		geometry: {
			type: 'Point',
			coordinates: [Number(row[5]), Number(row[4])]
		}
	}))
};
writeFileSync(citiesOutPath, JSON.stringify(cities));

console.log(`countries: ${countries.features.length} features`);
console.log(`cities: ${cities.features.length} features (top ${topN} by population)`);
