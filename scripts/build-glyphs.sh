#!/usr/bin/env bash
# Rebuilds app/static/glyphs/dejavu-sans/0-255.pbf: the offline SDF glyph
# range used to render city name labels on the map (codepoints 0-255, i.e.
# ASCII + Latin-1 — covers GeoNames' asciiname field, which is what city
# labels are drawn from; see prepare-basemap-geojson.mjs and PLAN.md "map").
# It's checked into the repo like basemap.pmtiles, so this only needs to run
# when the font or range changes. Run from the nix devshell (needs node and
# dejavu_fonts).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/app/static/glyphs/dejavu-sans"

font="$(fc-list | grep 'DejaVu Sans:style=Book' | head -1 | cut -d: -f1)"
if [ -z "$font" ]; then
	echo "error: DejaVu Sans not found (needs pkgs.dejavu_fonts in the nix devshell)" >&2
	exit 1
fi

cd "$repo_root/app"
# fontnik must resolve as a real dependency of app/ (node's ESM resolution
# walks up from the importing file, and scripts/ has no node_modules of its
# own), so run the generator from a copy placed inside app/ temporarily.
trap 'rm -f "$repo_root/app/.build-glyphs.mjs"; npm prune --silent' EXIT
echo "==> installing fontnik (build-only, removed afterward)"
npm install --no-save --silent fontnik
cp "$repo_root/scripts/build-glyphs.mjs" "$repo_root/app/.build-glyphs.mjs"

node "$repo_root/app/.build-glyphs.mjs" "$font" "$out_dir"

echo "==> done: $out_dir ($(du -sh "$out_dir" | cut -f1))"
