/**
 * Pure section mesher: turns one padded 16³ section into per-pass quad lists
 * with baked lighting. No three.js / DOM, so it is unit-testable and runs in
 * workers.
 */
import {
  SHADE_BOTTOM,
  SHADE_TOP,
  SHADE_X,
  SHADE_Z,
  SHADOW,
} from '../config';
import {
  ATLAS_TILES_PER_ROW,
  B,
  CULL_SAME,
  FACE_TILES,
  FULL_BRIGHT,
  OCCLUDES,
  PASS,
  PASS_COUNT,
  SHAPE,
  SHAPE_CROSS,
  SHAPE_NONE,
  SHAPE_SLAB,
} from '../world/blocks';
import { PAD, padIndex, type PaddedSection } from './padded';

export interface PassMesh {
  /** xyz per vertex, local to the chunk column. */
  readonly positions: Float32Array;
  /** uv per vertex, atlas coordinates. */
  readonly uvs: Float32Array;
  /** rgb per vertex, 0–255 in linear space (brightness only). */
  readonly colors: Uint8Array;
  readonly quads: number;
}

/** Index by render pass: [opaque, cutout, translucent]. */
export type ChunkMeshData = [PassMesh | null, PassMesh | null, PassMesh | null];

// ---- Static tables ----

/** Neighbour direction per face: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const PAD_LAYER = PAD * PAD;
/** Padded-array offset to the neighbour through each face. */
const PAD_OFFSETS = [1, -1, PAD_LAYER, -PAD_LAYER, PAD, -PAD];

/** Four corners per face, counter-clockwise seen from outside; uv (0,0),(1,0),(1,1),(0,1). */
const FACE_VERTS: ReadonlyArray<readonly number[]> = [
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1], // +X
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0], // -X
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0], // +Y
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], // -Y
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], // +Z
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0], // -Z
];
const CORNER_U = [0, 1, 1, 0];
const CORNER_V = [0, 0, 1, 1];

const FACE_SHADE = [SHADE_X, SHADE_X, SHADE_TOP, SHADE_BOTTOM, SHADE_Z, SHADE_Z];

/** sRGB-space brightness → linear byte, so shading matches Classic after output encoding. */
function toLinearByte(b: number): number {
  const lin = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  return Math.round(Math.min(1, lin) * 255);
}

/** [shadowed ? 1 : 0][face] → vertex colour byte. */
const FACE_BYTES: readonly Uint8Array[] = [
  Uint8Array.from(FACE_SHADE, (s) => toLinearByte(s)),
  Uint8Array.from(FACE_SHADE, (s) => toLinearByte(s * SHADOW)),
];
const FULL_BYTE = 255;
const SPRITE_BYTES = [toLinearByte(1), toLinearByte(SHADOW)];

/** Inset (in UV units) that keeps nearest sampling inside a tile. */
const UV_INSET = 1 / (ATLAS_TILES_PER_ROW * 16 * 64);

/** Atlas UV rectangle per tile id: u0, v0, u1, v1 (v up, canvas row 0 at the top). */
export const TILE_UVS = new Float32Array(256 * 4);
for (let t = 0; t < 256; t++) {
  const col = t % ATLAS_TILES_PER_ROW;
  const row = Math.floor(t / ATLAS_TILES_PER_ROW);
  const n = ATLAS_TILES_PER_ROW;
  TILE_UVS[t * 4] = col / n + UV_INSET;
  TILE_UVS[t * 4 + 1] = 1 - (row + 1) / n + UV_INSET;
  TILE_UVS[t * 4 + 2] = (col + 1) / n - UV_INSET;
  TILE_UVS[t * 4 + 3] = 1 - row / n - UV_INSET;
}

// ---- Growable quad buffer (reused across calls) ----

class QuadBuffer {
  pos = new Float32Array(4 * 3 * 1024);
  uv = new Float32Array(4 * 2 * 1024);
  col = new Uint8Array(4 * 3 * 1024);
  quads = 0;

  reset(): void {
    this.quads = 0;
  }

  reserve(): void {
    const needed = (this.quads + 1) * 12;
    if (needed <= this.pos.length) return;
    const cap = this.pos.length * 2;
    const pos = new Float32Array(cap);
    pos.set(this.pos);
    this.pos = pos;
    const uv = new Float32Array((cap / 12) * 8);
    uv.set(this.uv);
    this.uv = uv;
    const col = new Uint8Array(cap);
    col.set(this.col);
    this.col = col;
  }

  finish(): PassMesh | null {
    const q = this.quads;
    if (q === 0) return null;
    return {
      positions: this.pos.slice(0, q * 12),
      uvs: this.uv.slice(0, q * 8),
      colors: this.col.slice(0, q * 12),
      quads: q,
    };
  }
}

const buffers: QuadBuffer[] = Array.from({ length: PASS_COUNT }, () => new QuadBuffer());

function emitFace(
  buf: QuadBuffer,
  face: number,
  x: number,
  y: number,
  z: number,
  tile: number,
  shade: number,
  slab: boolean,
): void {
  buf.reserve();
  const q = buf.quads++;
  const pos = buf.pos;
  const uv = buf.uv;
  const col = buf.col;
  const verts = FACE_VERTS[face]!;
  const u0 = TILE_UVS[tile * 4]!;
  const v0 = TILE_UVS[tile * 4 + 1]!;
  const u1 = TILE_UVS[tile * 4 + 2]!;
  let v1 = TILE_UVS[tile * 4 + 3]!;
  const side = face !== 2 && face !== 3;
  // Half-height sides show the lower half of the tile.
  if (slab && side) v1 = v0 + (v1 - v0) * 0.5;
  const top = slab ? 0.5 : 1;
  for (let c = 0; c < 4; c++) {
    const p = q * 12 + c * 3;
    const vy = verts[c * 3 + 1]!;
    pos[p] = x + verts[c * 3]!;
    pos[p + 1] = y + (vy === 1 ? top : 0);
    pos[p + 2] = z + verts[c * 3 + 2]!;
    const t = q * 8 + c * 2;
    uv[t] = CORNER_U[c] ? u1 : u0;
    uv[t + 1] = CORNER_V[c] ? v1 : v0;
    col[p] = shade;
    col[p + 1] = shade;
    col[p + 2] = shade;
  }
}

/** Two diagonal quads, each emitted with both windings (double-sided). */
const CROSS_QUADS: ReadonlyArray<readonly number[]> = (() => {
  const a = 0.5 - 0.45;
  const b = 0.5 + 0.45;
  const d1 = [a, 0, a, b, 0, b, b, 1, b, a, 1, a];
  const d2 = [a, 0, b, b, 0, a, b, 1, a, a, 1, b];
  const reverse = (q: number[]): number[] => [
    q[3]!, q[4]!, q[5]!, q[0]!, q[1]!, q[2]!, q[9]!, q[10]!, q[11]!, q[6]!, q[7]!, q[8]!,
  ];
  return [d1, reverse(d1), d2, reverse(d2)];
})();

function emitCross(buf: QuadBuffer, x: number, y: number, z: number, tile: number, shade: number): void {
  const u0 = TILE_UVS[tile * 4]!;
  const v0 = TILE_UVS[tile * 4 + 1]!;
  const u1 = TILE_UVS[tile * 4 + 2]!;
  const v1 = TILE_UVS[tile * 4 + 3]!;
  for (let k = 0; k < 4; k++) {
    const verts = CROSS_QUADS[k]!;
    // Reversed quads swap corners 0↔1 and 2↔3, so mirror u to keep the sprite upright.
    const flip = k % 2 === 1;
    buf.reserve();
    const q = buf.quads++;
    for (let c = 0; c < 4; c++) {
      const p = q * 12 + c * 3;
      buf.pos[p] = x + verts[c * 3]!;
      buf.pos[p + 1] = y + verts[c * 3 + 1]!;
      buf.pos[p + 2] = z + verts[c * 3 + 2]!;
      const t = q * 8 + c * 2;
      const cu = flip ? 1 - CORNER_U[c]! : CORNER_U[c]!;
      buf.uv[t] = cu ? u1 : u0;
      buf.uv[t + 1] = CORNER_V[c] ? v1 : v0;
      buf.col[p] = shade;
      buf.col[p + 1] = shade;
      buf.col[p + 2] = shade;
    }
  }
}

/**
 * Should the face of block `id` (shape `shape`) pointing at neighbour `nb`
 * through face `face` be drawn?
 */
export function faceVisible(id: number, shape: number, nb: number, face: number): boolean {
  if (nb === B.AIR) return true;
  if (OCCLUDES[nb]) {
    // A slab's top sits mid-cell and never touches the block above.
    return shape === SHAPE_SLAB && face === 2;
  }
  if (nb === id && CULL_SAME[id]) return false;
  if (SHAPE[nb] === SHAPE_SLAB) {
    if (face === 2) return shape === SHAPE_SLAB; // slab bottom covers our top face
    if (shape === SHAPE_SLAB && face !== 3) return false; // slab beside slab
  }
  return true;
}

/**
 * Build the meshes of one 16³ section from its padded neighbourhood.
 * Positions are local to the chunk column: x, z in 0..16, y in 0..128.
 */
export function meshSection(pad: PaddedSection): ChunkMeshData {
  const blocks = pad.blocks;
  const light = pad.light;
  const y0 = pad.sy * 16;

  for (const b of buffers) b.reset();

  for (let ly = 0; ly < 16; ly++) {
    const y = y0 + ly;
    for (let z = 0; z < 16; z++) {
      let i = padIndex(0, ly, z);
      for (let x = 0; x < 16; x++, i++) {
        const value = blocks[i]!;
        const id = value & 0xff;
        if (id === B.AIR) continue;
        const shape = SHAPE[id]!;
        if (shape === SHAPE_NONE) continue;

        // Fast reject for buried opaque cubes (the vast majority of cells).
        if (
          OCCLUDES[id] === 1 &&
          OCCLUDES[blocks[i + 1]! & 0xff] &&
          OCCLUDES[blocks[i - 1]! & 0xff] &&
          OCCLUDES[blocks[i + PAD_LAYER]! & 0xff] &&
          OCCLUDES[blocks[i - PAD_LAYER]! & 0xff] &&
          OCCLUDES[blocks[i + PAD]! & 0xff] &&
          OCCLUDES[blocks[i - PAD]! & 0xff]
        ) {
          continue;
        }

        const buf = buffers[PASS[id]!]!;
        if (shape === SHAPE_CROSS) {
          const lit = light[i]! >> 4 > 0;
          emitCross(buf, x, y, z, FACE_TILES[id * 6 + 2]!, SPRITE_BYTES[lit ? 0 : 1]!);
          continue;
        }

        const fullBright = FULL_BRIGHT[id] === 1;
        const slab = shape === SHAPE_SLAB;
        for (let f = 0; f < 6; f++) {
          const ni = i + PAD_OFFSETS[f]!;
          const nb = blocks[ni]! & 0xff;
          if (OCCLUDES[nb] && !(slab && f === 2)) continue;
          if (!faceVisible(id, shape, nb, f)) continue;
          const shade = fullBright ? FULL_BYTE : FACE_BYTES[light[ni]! >> 4 > 0 ? 0 : 1]![f]!;
          emitFace(buf, f, x, y, z, FACE_TILES[id * 6 + f]!, shade, slab);
        }
      }
    }
  }

  return [buffers[0]!.finish(), buffers[1]!.finish(), buffers[2]!.finish()];
}

/** Index buffer for `quads` quads (two triangles each). */
export function quadIndices(quads: number): Uint16Array | Uint32Array {
  const indices = quads * 4 <= 65535 ? new Uint16Array(quads * 6) : new Uint32Array(quads * 6);
  for (let i = 0, v = 0, k = 0; i < quads; i++, v += 4, k += 6) {
    indices[k] = v;
    indices[k + 1] = v + 1;
    indices[k + 2] = v + 2;
    indices[k + 3] = v;
    indices[k + 4] = v + 2;
    indices[k + 5] = v + 3;
  }
  return indices;
}

/** Brightness byte used for a lit top face (exported for tests / sky). */
export const LIT_TOP_BYTE = FACE_BYTES[0]![2]!;
