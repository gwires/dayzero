// seeded PRNG + helpers. see TESTGEN-PLAN.md "design": one integer seed
// drives everything so the same seed always produces a bit-identical tree.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** integer in [min, max], inclusive on both ends. */
export function int(rng: Rng, min: number, max: number): number {
	return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
	return arr[int(rng, 0, arr.length - 1)];
}

/** weighted random choice from [value, weight] pairs. weights need not sum to 1. */
export function weighted<T>(rng: Rng, choices: readonly (readonly [T, number])[]): T {
	const total = choices.reduce((sum, [, w]) => sum + w, 0);
	let roll = rng() * total;
	for (const [value, w] of choices) {
		roll -= w;
		if (roll <= 0) return value;
	}
	return choices[choices.length - 1][0];
}

/** true with probability p. */
export function chance(rng: Rng, p: number): boolean {
	return rng() < p;
}

export function bytes(rng: Rng, n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = int(rng, 0, 255);
	return out;
}

/** Fisher-Yates shuffle, for sampling without replacement (e.g. trip POI types). */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
	const out = [...arr];
	for (let i = out.length - 1; i > 0; i--) {
		const j = int(rng, 0, i);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
