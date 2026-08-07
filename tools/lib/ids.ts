// hand-rolled id generation — see TESTGEN-PLAN.md "design": entry ids are
// seedable uuidv7s (never depend on npm:uuid, which isn't seedable), and
// clientIdFrom gives every doc a deterministic yjs clientID so re-running
// the importer produces byte-identical updates (idempotent import).
import { bytes, type Rng } from './rng.ts';

function formatUuid(b: Uint8Array): string {
	const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
		hex.slice(20, 32)
	}`;
}

/** seeded uuidv7: 48-bit big-endian unix ms, version 7, 12+62 random bits, variant 10. */
export function uuidv7(rng: Rng, timestampMs: number): string {
	const ts = BigInt(Math.floor(timestampMs));
	const b = new Uint8Array(16);
	b[0] = Number((ts >> 40n) & 0xffn);
	b[1] = Number((ts >> 32n) & 0xffn);
	b[2] = Number((ts >> 24n) & 0xffn);
	b[3] = Number((ts >> 16n) & 0xffn);
	b[4] = Number((ts >> 8n) & 0xffn);
	b[5] = Number(ts & 0xffn);

	const rnd = bytes(rng, 10);
	b[6] = 0x70 | (rnd[0] & 0x0f); // version nibble 7 + top 4 random bits
	b[7] = rnd[1]; // remaining 8 random bits (12 total)
	b[8] = 0x80 | (rnd[2] & 0x3f); // variant bits 10 + 6 random bits
	for (let i = 0; i < 7; i++) b[9 + i] = rnd[3 + i]; // remaining 56 random bits (62 total)

	return formatUuid(b);
}

async function sha256(input: string): Promise<Uint8Array> {
	const data = new TextEncoder().encode(input);
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** deterministic id for photo-only entries: sha256(input) forced into a valid uuidv4 shape. */
export async function uuidFromHash(input: string): Promise<string> {
	const digest = await sha256(input);
	const b = digest.slice(0, 16);
	b[6] = 0x40 | (b[6] & 0x0f);
	b[8] = 0x80 | (b[8] & 0x3f);
	return formatUuid(b);
}

/** deterministic Y.Doc clientID derived from an entry/registry-key id. */
export async function clientIdFrom(id: string): Promise<number> {
	const digest = await sha256(id);
	return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}
