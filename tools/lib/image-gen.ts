// procedural JPEG generation. see TESTGEN-PLAN.md step 4 "images": vertical
// gradient between two palette colors, then a handful of filled shapes,
// then per-pixel noise so no two images (and thus no two blobs' sha256)
// collide. Target 30-60 KB per image; drop quality toward 55 if a sample
// comes out larger.
import jpeg from 'jpeg-js';
import { Buffer } from 'node:buffer';
import { int, pick, type Rng } from './rng.ts';
import { hexToRgb, IMAGE_DIMENSIONS, IMAGE_PALETTE } from './vocab.ts';

const PALETTE_RGB = IMAGE_PALETTE.map(hexToRgb);
const TARGET_MAX_BYTES = 60 * 1024;

export interface GeneratedImage {
	bytes: Uint8Array;
	width: number;
	height: number;
}

function clamp255(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

function fillGradient(data: Uint8Array, width: number, height: number, rng: Rng): void {
	const i1 = int(rng, 0, PALETTE_RGB.length - 1);
	let i2 = int(rng, 0, PALETTE_RGB.length - 1);
	if (i2 === i1) i2 = (i2 + 1) % PALETTE_RGB.length;
	const [r1, g1, b1] = PALETTE_RGB[i1];
	const [r2, g2, b2] = PALETTE_RGB[i2];
	for (let y = 0; y < height; y++) {
		const t = height === 1 ? 0 : y / (height - 1);
		const r = Math.round(r1 + (r2 - r1) * t);
		const g = Math.round(g1 + (g2 - g1) * t);
		const b = Math.round(b1 + (b2 - b1) * t);
		let o = y * width * 4;
		for (let x = 0; x < width; x++) {
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = 255;
			o += 4;
		}
	}
}

function fillShapes(data: Uint8Array, width: number, height: number, rng: Rng): void {
	const shapeCount = int(rng, 3, 8);
	const minDim = Math.min(width, height);
	for (let s = 0; s < shapeCount; s++) {
		const [cr, cg, cb] = pick(rng, PALETTE_RGB);
		const isCircle = rng() < 0.5;
		const cx = int(rng, 0, width - 1);
		const cy = int(rng, 0, height - 1);
		const size = int(rng, Math.floor(minDim * 0.05), Math.floor(minDim * 0.25));
		const x0 = Math.max(0, cx - size);
		const x1 = Math.min(width - 1, cx + size);
		const y0 = Math.max(0, cy - size);
		const y1 = Math.min(height - 1, cy + size);
		const rad2 = size * size;
		for (let y = y0; y <= y1; y++) {
			const dy = y - cy;
			let o = (y * width + x0) * 4;
			for (let x = x0; x <= x1; x++) {
				if (!isCircle || dy * dy + (x - cx) * (x - cx) <= rad2) {
					data[o] = cr;
					data[o + 1] = cg;
					data[o + 2] = cb;
					data[o + 3] = 255;
				}
				o += 4;
			}
		}
	}
}

// one rng() draw yields 24 bits, split into 3 independent-ish per-channel
// deltas in [-6, 6] — three draws per pixel would dominate total runtime
// across ~3000 images, so this trades a little noise independence for a
// large constant-factor speedup while staying fully deterministic.
function addNoise(data: Uint8Array, rng: Rng): void {
	for (let o = 0; o < data.length; o += 4) {
		const v = (rng() * 16777216) | 0;
		data[o] = clamp255(data[o] + (((v >> 16) & 0xff) % 13) - 6);
		data[o + 1] = clamp255(data[o + 1] + (((v >> 8) & 0xff) % 13) - 6);
		data[o + 2] = clamp255(data[o + 2] + (v & 0xff) % 13 - 6);
	}
}

export function generateImage(rng: Rng): GeneratedImage {
	const [width, height] = pick(rng, IMAGE_DIMENSIONS);
	const data = new Uint8Array(width * height * 4);

	fillGradient(data, width, height, rng);
	fillShapes(data, width, height, rng);
	addNoise(data, rng);

	const raw = { data: Buffer.from(data), width, height };
	let encoded = jpeg.encode(raw, 85);
	if (encoded.data.length > TARGET_MAX_BYTES) encoded = jpeg.encode(raw, 55);

	return { bytes: new Uint8Array(encoded.data), width, height };
}
