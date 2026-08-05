// Generates the offline SDF glyph range used to render city name labels on
// the map (MapLibre GL requires pre-rendered glyph .pbf files for any
// text-field in a symbol layer — there's no client-side text rasterization
// fallback). Run via build-glyphs.sh, which installs the (build-only)
// fontnik dependency needed here and removes it again afterward.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import fontnik from 'fontnik';

const [, , fontPath, outDir] = process.argv;

const font = readFileSync(fontPath);
mkdirSync(outDir, { recursive: true });

fontnik.range({ font, start: 0, end: 255 }, (err, pbf) => {
	if (err) throw err;
	writeFileSync(`${outDir}/0-255.pbf`, pbf);
	console.log(`wrote ${outDir}/0-255.pbf (${pbf.length} bytes)`);
});
