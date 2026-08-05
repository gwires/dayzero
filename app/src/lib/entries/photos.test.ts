import { describe, expect, it } from 'vitest';
import { computeResizedDimensions, sha256Hex } from './photos';

describe('computeResizedDimensions', () => {
	it('downscales so the longer edge is at most the max dimension', () => {
		expect(computeResizedDimensions(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
	});

	it('never upscales a smaller image', () => {
		expect(computeResizedDimensions(800, 600, 2048)).toEqual({ width: 800, height: 600 });
	});

	it('handles portrait orientation the same way', () => {
		expect(computeResizedDimensions(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
	});
});

describe('sha256Hex', () => {
	it('matches known test vectors', async () => {
		expect(await sha256Hex(new TextEncoder().encode(''))).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('is deterministic and content-addressed', async () => {
		const a = await sha256Hex(new TextEncoder().encode('same bytes'));
		const b = await sha256Hex(new TextEncoder().encode('same bytes'));
		const c = await sha256Hex(new TextEncoder().encode('different bytes'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});
