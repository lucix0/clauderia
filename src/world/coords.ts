/**
 * Chunk / block coordinate math. Everything here is safe for negative
 * coordinates: chunk = floorDiv(x, 16), local = mod(x, 16).
 */

/** Chunk width and depth in blocks. */
export const CHUNK_SIZE = 16;
export const CHUNK_SHIFT = 4;
/** Chunk column height in blocks. */
export const CHUNK_HEIGHT = 128;
/** 16³ sections per column. */
export const SECTION_SIZE = 16;
export const SECTIONS = CHUNK_HEIGHT / SECTION_SIZE;
/** Cells in one column. */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT;
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE;

/** Floor division that rounds toward −∞ (unlike `Math.trunc`). */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Always-positive modulo: mod(−1, 16) = 15. */
export function mod(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + b : r + 0; // + 0 turns −0 into 0
}

/** Chunk coordinate containing block coordinate `v`. */
export function toChunk(v: number): number {
  return v >> CHUNK_SHIFT; // arithmetic shift = floor division by 16 for ints
}

/** Local (0–15) coordinate of block coordinate `v` within its chunk. */
export function toLocal(v: number): number {
  return v & (CHUNK_SIZE - 1); // two's complement: −1 & 15 = 15
}

/** Index of a cell inside a chunk column: y-major, then z, then x. */
export function localIndex(lx: number, y: number, lz: number): number {
  return (y << 8) | (lz << 4) | lx;
}

const KEY_OFFSET = 1 << 24;
const KEY_SPAN = 1 << 25;

/** Exact numeric key for chunk (cx, cz); valid for |c| < 2^24. */
export function chunkKey(cx: number, cz: number): number {
  return (cx + KEY_OFFSET) * KEY_SPAN + (cz + KEY_OFFSET);
}

export function chunkFromKey(key: number): [number, number] {
  const cz = (key % KEY_SPAN) - KEY_OFFSET;
  const cx = Math.round((key - (cz + KEY_OFFSET)) / KEY_SPAN) - KEY_OFFSET;
  return [cx, cz];
}

const POS_OFFSET = 1 << 22;
const POS_SPAN = 1 << 23;

/** Exact numeric key for a block position; valid for |x|, |z| < 2^22, 0 ≤ y < 128. */
export function posKey(x: number, y: number, z: number): number {
  return ((x + POS_OFFSET) * POS_SPAN + (z + POS_OFFSET)) * CHUNK_HEIGHT + y;
}

export function posFromKey(key: number): [number, number, number] {
  const y = key % CHUNK_HEIGHT;
  const xz = (key - y) / CHUNK_HEIGHT;
  const z = (xz % POS_SPAN) - POS_OFFSET;
  const x = (xz - (z + POS_OFFSET)) / POS_SPAN - POS_OFFSET;
  return [x, y, z];
}
