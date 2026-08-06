#!/usr/bin/env bash
# Rebuilds app/static/basemap.pmtiles: the offline vector basemap (country
# borders + top 50k cities by population) bundled with the app. See
# scripts/README.md and PLAN.md "map" for context. Run from the nix devshell
# (needs node, tippecanoe, pmtiles).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$repo_root/app/static/basemap.pmtiles"
top_n_cities=50000

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> downloading natural earth admin-0 countries (1:110m)"
curl -sSL -o "$work/countries.raw.geojson" \
	"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"

echo "==> downloading geonames cities5000"
curl -sSL -o "$work/cities5000.zip" "https://download.geonames.org/export/dump/cities5000.zip"
unzip -q -o "$work/cities5000.zip" -d "$work"

echo "==> trimming properties, selecting top $top_n_cities cities by population"
node "$repo_root/scripts/prepare-basemap-geojson.mjs" \
	"$work/countries.raw.geojson" "$work/cities5000.txt" \
	"$work/countries.geojson" "$work/cities.geojson" "$top_n_cities"

echo "==> building mbtiles with tippecanoe"
tippecanoe -o "$work/basemap.mbtiles" \
	--force \
	-Z0 -z8 \
	-L countries:"$work/countries.geojson" \
	-L cities:"$work/cities.geojson"

echo "==> converting to pmtiles"
pmtiles convert "$work/basemap.mbtiles" "$work/basemap.pmtiles"

mkdir -p "$(dirname "$out")"
mv "$work/basemap.pmtiles" "$out"

echo "==> done: $out ($(du -h "$out" | cut -f1))"
