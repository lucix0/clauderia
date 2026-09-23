/**
 * Pure chunk mesher: turns the blocks of one chunk into per-pass quad lists
 * with baked Classic lighting. No three.js / DOM, so it is unit-testable.
 */
import {
  CHUNK_SIZE,
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
import type { World } from '../world/world';

export interface PassMesh {
  /** xyz per vertex, world coordinates. */
  readonly positions: Float32Array;
  /** uv per vertex, atlas coordinates. */
  readonly uvs: Float32Array;
  /** rgb per vertex, 0–255 in linear space (brightness only). */
  readonly colors: Uint8Array;
  readonly indices: Uint16Array | Uint32Array;
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
    const vertCount = q * 4;
    const indices = vertCount <= 65535 ? new Uint16Array(q * 6) : new Uint32Array(q * 6);
    for (let i = 0, v = 0, k = 0; i < q; i++, v += 4, k += 6) {
      indices[k] = v;
      indices[k + 1] = v + 1;
      indices[k + 2] = v + 2;
      indices[k + 3] = v;
      indices[k + 4] = v + 2;
      indices[k + 5] = v + 3;
    }
    return {
      positions: this.pos.slice(0, q * 12),
      uvs: this.uv.slice(0, q * 8),
      colors: this.col.slice(0, q * 12),
      indices,
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

/** Build the meshes for chunk (cx, cy, cz). */
export function meshChunk(world: World, cx: number, cy: number, cz: number): ChunkMeshData {
  const { sx, sy, sz, blocks } = world;
  const heights = world.heightMap.heights;
  const layer = sx * sz;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const x1 = Math.min(x0 + CHUNK_SIZE, sx);
  const y1 = Math.min(y0 + CHUNK_SIZE, sy);
  const z1 = Math.min(z0 + CHUNK_SIZE, sz);
  const offsets = [1, -1, layer, -layer, sx, -sx];

  for (const b of buffers) b.reset();

  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      let i = (y * sz + z) * sx + x0;
      for (let x = x0; x < x1; x++, i++) {
        const id = blocks[i]!;
        if (id === B.AIR) continue;
        const shape = SHAPE[id]!;
        if (shape === SHAPE_NONE) continue;
        const buf = buffers[PASS[id]!]!;

        if (shape === SHAPE_CROSS) {
          const lit = y > heights[z * sx + x]!;
          emitCross(buf, x, y, z, FACE_TILES[id * 6 + 2]!, SPRITE_BYTES[lit ? 0 : 1]!);
          continue;
        }

        const fullBright = FULL_BRIGHT[id] === 1;
        const slab = shape === SHAPE_SLAB;
        for (let f = 0; f < 6; f++) {
          const dir = FACE_DIRS[f]!;
          const nx = x + dir[0];
          const ny = y + dir[1];
          const nz = z + dir[2];
          const inside = nx >= 0 && ny >= 0 && nz >= 0 && nx < sx && ny < sy && nz < sz;
          const nb = inside ? blocks[i + offsets[f]!]! : world.getVirtual(nx, ny, nz);
          if (!faceVisible(id, shape, nb, f)) continue;

          let shade: number;
          if (fullBright) {
            shade = FULL_BYTE;
          } else {
            let lit: boolean;
            if (ny >= sy || nx < 0 || nz < 0 || nx >= sx || nz >= sz) lit = true;
            else if (ny < 0) lit = false;
            else lit = ny > heights[nz * sx + nx]!;
            shade = FACE_BYTES[lit ? 0 : 1]![f]!;
          }
          emitFace(buf, f, x, y, z, FACE_TILES[id * 6 + f]!, shade, slab);
        }
      }
    }
  }

  return [buffers[0]!.finish(), buffers[1]!.finish(), buffers[2]!.finish()];
}

/** Brightness byte used for a lit top face (exported for tests / sky). */
export const LIT_TOP_BYTE = FACE_BYTES[0]![2]!;
