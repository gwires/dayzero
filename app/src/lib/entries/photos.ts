// client-side photo pipeline: resize -> re-encode to webp -> content hash.
// see PLAN.md "photos: file input / drag-drop -> resize to max ~2048px,
// re-encode to webp via canvas -> stored content-addressed (sha-256)".

const MAX_DIMENSION = 2048;
const WEBP_QUALITY = 0.85;

export interface EncodedPhoto {
	bytes: Uint8Array;
	mime: string;
	width: number;
	height: number;
	hash: string;
}

/** scales down (never up) so the longer edge is at most `maxDimension`. */
export function computeResizedDimensions(
	width: number,
	height: number,
	maxDimension: number = MAX_DIMENSION
): { width: number; height: number } {
	const scale = Math.min(1, maxDimension / Math.max(width, height));
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// `bytes` may come in backed by an ArrayBufferLike (e.g. from yjs); copy
	// into a fresh, plain ArrayBuffer-backed view for `crypto.subtle`.
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function encodePhoto(file: Blob): Promise<EncodedPhoto> {
	const bitmap = await createImageBitmap(file);
	const { width, height } = computeResizedDimensions(bitmap.width, bitmap.height);

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('canvas 2d context unavailable');
	ctx.drawImage(bitmap, 0, 0, width, height);
	bitmap.close();

	const blob = await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const hash = await sha256Hex(bytes);

	return { bytes, mime: blob.type, width, height, hash };
}
