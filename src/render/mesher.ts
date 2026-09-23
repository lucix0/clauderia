/**
 * Pure section mesher: turns one padded 16³ section into per-pass quad lists.
 * Vertex colours carry the directional face shade; sky and block light go in
 * their own per-vertex attributes so the shader can apply the time of day.
 * No three.js / DOM, so it is unit-testable and runs in workers.
 */
import { SHADE_BOTTOM, SHADE_TOP, SHADE_X, SHADE_Z } from '../config';
import {
  ATLAS_TILES_PER_ROW,
  B,
  BED_HEAD,
  CULL_SAME,
  DEFAULT_FOLIAGE_TINT,
  DEFAULT_GRASS_TINT,
  DEFAULT_WATER_TINT,
  FACE_TILES,
  FACING_FACES,
  frontTile,
  FULL_BRIGHT,
  HAS_AXIS,
  HAS_FACING,
  IS_LIQUID,
  OCCLUDES,
  PASS,
  PASS_COUNT,
  SHAPE,
  SHAPE_CACTUS,
  SHAPE_CROSS,
  SHAPE_LAYER,
  SHAPE_NONE,
  SHAPE_SLAB,
  SHAPE_TORCH,
  T,
  TINT_COLOR,
  TINT_FIXED,
  TINT_MODE,
  TINT_NONE,
  TORCH_ATTACH,
} from '../world/blocks';
import { fluidHeight } from '../world/fluids';
import { PAD, padIndex, type PaddedSection } from './padded';

export interface PassMesh {
  /** xyz per vertex, local to the chunk column. */
  readonly positions: Float32Array;
  /** uv per vertex, atlas coordinates. */
  readonly uvs: Float32Array;
  /** rgb per vertex, 0–255 in linear space (face shade × tint). */
  readonly colors: Uint8Array;
  /** Sky light per vertex, 0–255 (= level × 17). */
  readonly sky: Uint8Array;
  /** Block light per vertex, 0–255 (= level × 17). */
  readonly block: Uint8Array;
  /** Biome / block tint per vertex, rgb 0–255 (sRGB). */
  readonly tints: Uint8Array;
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

/**
 * Logs lying along X (state 1) or Z (state 2): which faces show the end
 * grain (top tile) and which bark faces need their texture turned 90°.
 */
const AXIS_END = new Uint8Array(3 * 6);
const AXIS_ROTATE = new Uint8Array(3 * 6);
{
  // Direction of each face's texture v axis: ±X and ±Z faces run along Y, ±Y along Z.
  const vAxis = [1, 1, 2, 2, 1, 1];
  const faceAxis = [0, 0, 1, 1, 2, 2];
  const stateAxis = [1, 0, 2]; // state → world axis (0 x, 1 y, 2 z)
  for (let s = 0; s < 3; s++) {
    const axis = stateAxis[s]!;
    for (let f = 0; f < 6; f++) {
      AXIS_END[s * 6 + f] = faceAxis[f] === axis ? 1 : 0;
      AXIS_ROTATE[s * 6 + f] = faceAxis[f] !== axis && vAxis[f] !== axis ? 1 : 0;
    }
  }
}

/** Default tint per TINT_* mode for columns without biome colours. */
const DEFAULT_TINTS = [0xffffff, DEFAULT_GRASS_TINT, DEFAULT_FOLIAGE_TINT, DEFAULT_WATER_TINT];

const FACE_SHADE = [SHADE_X, SHADE_X, SHADE_TOP, SHADE_BOTTOM, SHADE_Z, SHADE_Z];

/** sRGB-space brightness → linear byte, so shading matches Classic after output encoding. */
function toLinearByte(b: number): number {
  const lin = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  return Math.round(Math.min(1, lin) * 255);
}

/** Face → vertex colour byte (directional shade, linear). */
const FACE_BYTES = Uint8Array.from(FACE_SHADE, (s) => toLinearByte(s));
const FULL_BYTE = 255;

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
  sky = new Uint8Array(4 * 1024);
  blk = new Uint8Array(4 * 1024);
  tnt = new Uint8Array(4 * 3 * 1024);
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
    const sky = new Uint8Array(cap / 3);
    sky.set(this.sky);
    this.sky = sky;
    const blk = new Uint8Array(cap / 3);
    blk.set(this.blk);
    this.blk = blk;
    const tnt = new Uint8Array(cap);
    tnt.set(this.tnt);
    this.tnt = tnt;
  }

  /** Light every vertex of quad q from a packed light byte and give it the current tint. */
  light(q: number, packed: number): void {
    const s = (packed >> 4) * 17;
    const b = (packed & 15) * 17;
    const v = q * 4;
    this.sky[v] = s;
    this.sky[v + 1] = s;
    this.sky[v + 2] = s;
    this.sky[v + 3] = s;
    this.blk[v] = b;
    this.blk[v + 1] = b;
    this.blk[v + 2] = b;
    this.blk[v + 3] = b;
    const t = v * 3;
    const tn = this.tnt;
    for (let k = 0; k < 12; k += 3) {
      tn[t + k] = tintR;
      tn[t + k + 1] = tintG;
      tn[t + k + 2] = tintB;
    }
  }

  finish(): PassMesh | null {
    const q = this.quads;
    if (q === 0) return null;
    return {
      positions: this.pos.slice(0, q * 12),
      uvs: this.uv.slice(0, q * 8),
      colors: this.col.slice(0, q * 12),
      sky: this.sky.slice(0, q * 4),
      block: this.blk.slice(0, q * 4),
      tints: this.tnt.slice(0, q * 12),
      quads: q,
    };
  }
}

const buffers: QuadBuffer[] = Array.from({ length: PASS_COUNT }, () => new QuadBuffer());

/** Tint of the block being emitted (sRGB bytes); written by QuadBuffer.light. */
let tintR = 255;
let tintG = 255;
let tintB = 255;

function setTint(rgb: number): void {
  tintR = (rgb >> 16) & 255;
  tintG = (rgb >> 8) & 255;
  tintB = rgb & 255;
}

/**
 * One face of a cube-like block. `top` is the block's height (slabs, snow
 * layers); `turn` rotates the texture by quarter turns (logs lying on their
 * side, beds).
 */
function emitFace(
  buf: QuadBuffer,
  face: number,
  x: number,
  y: number,
  z: number,
  tile: number,
  shade: number,
  light: number,
  top: number,
  turn: number,
): void {
  buf.reserve();
  const q = buf.quads++;
  buf.light(q, light);
  const pos = buf.pos;
  const uv = buf.uv;
  const col = buf.col;
  const verts = FACE_VERTS[face]!;
  const u0 = TILE_UVS[tile * 4]!;
  const v0 = TILE_UVS[tile * 4 + 1]!;
  const u1 = TILE_UVS[tile * 4 + 2]!;
  let v1 = TILE_UVS[tile * 4 + 3]!;
  const side = face !== 2 && face !== 3;
  // Partial-height sides show the lower part of the tile.
  if (top < 1 && side) v1 = v0 + (v1 - v0) * top;
  for (let c = 0; c < 4; c++) {
    const p = q * 12 + c * 3;
    const vy = verts[c * 3 + 1]!;
    pos[p] = x + verts[c * 3]!;
    pos[p + 1] = y + (vy === 1 ? top : 0);
    pos[p + 2] = z + verts[c * 3 + 2]!;
    const t = q * 8 + c * 2;
    const k = (c + turn) & 3;
    uv[t] = CORNER_U[k] ? u1 : u0;
    uv[t + 1] = CORNER_V[k] ? v1 : v0;
    col[p] = shade;
    col[p + 1] = shade;
    col[p + 2] = shade;
  }
}

/** Brightness per ambient-occlusion level (0 = both sides blocked … 3 = open), linear. */
const AO_LINEAR = [0.5, 0.68, 0.84, 1].map((v) => Math.pow(v, 2.2));

/** For each face, the two in-plane axes (0 x, 1 y, 2 z). */
const FACE_AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [1, 2],
  [0, 2],
  [0, 2],
  [0, 1],
  [0, 1],
];
const AXIS_STEP = [1, PAD * PAD, PAD];

// Scratch per-corner values.
const cornerSky = new Float32Array(4);
const cornerBlock = new Float32Array(4);
const cornerAO = new Uint8Array(4);

/**
 * A full-height cube face with smooth lighting: each corner averages the
 * light of the four cells around it in front of the face, and darkens by
 * how many of those are solid (ambient occlusion).
 */
function emitSmoothFace(
  buf: QuadBuffer,
  face: number,
  x: number,
  y: number,
  z: number,
  tile: number,
  shade: number,
  front: number,
  blocks: Uint16Array,
  light: Uint8Array,
  turn: number,
): void {
  const verts = FACE_VERTS[face]!;
  const [a1, a2] = FACE_AXES[face]!;
  const s1 = AXIS_STEP[a1]!;
  const s2 = AXIS_STEP[a2]!;
  const fl = light[front]!;
  const fSky = fl >> 4;
  const fBlock = fl & 15;
  for (let c = 0; c < 4; c++) {
    const d1 = verts[c * 3 + a1]! ? s1 : -s1;
    const d2 = verts[c * 3 + a2]! ? s2 : -s2;
    const i1 = front + d1;
    const i2 = front + d2;
    const ic = front + d1 + d2;
    const o1 = OCCLUDES[blocks[i1]! & 0xff]!;
    const o2 = OCCLUDES[blocks[i2]! & 0xff]!;
    // A corner hidden behind both sides doesn't count.
    const oc = o1 && o2 ? 1 : OCCLUDES[blocks[ic]! & 0xff]!;
    const l1 = o1 ? fl : light[i1]!;
    const l2 = o2 ? fl : light[i2]!;
    const lc = oc ? fl : light[ic]!;
    cornerSky[c] = (fSky + (l1 >> 4) + (l2 >> 4) + (lc >> 4)) / 4;
    cornerBlock[c] = (fBlock + (l1 & 15) + (l2 & 15) + (lc & 15)) / 4;
    cornerAO[c] = o1 && o2 ? 0 : 3 - o1 - o2 - oc;
  }
  // Split the quad along the diagonal that keeps the shading smooth.
  const flip = cornerAO[0]! + cornerAO[2]! < cornerAO[1]! + cornerAO[3]!;
  buf.reserve();
  const q = buf.quads++;
  buf.light(q, fl); // sets the tint; light is overwritten per vertex below
  const u0 = TILE_UVS[tile * 4]!;
  const v0 = TILE_UVS[tile * 4 + 1]!;
  const u1 = TILE_UVS[tile * 4 + 2]!;
  const v1 = TILE_UVS[tile * 4 + 3]!;
  for (let k = 0; k < 4; k++) {
    const c = flip ? (k + 1) & 3 : k;
    const p = q * 12 + k * 3;
    buf.pos[p] = x + verts[c * 3]!;
    buf.pos[p + 1] = y + verts[c * 3 + 1]!;
    buf.pos[p + 2] = z + verts[c * 3 + 2]!;
    const t = q * 8 + k * 2;
    const uvc = (c + turn) & 3;
    buf.uv[t] = CORNER_U[uvc] ? u1 : u0;
    buf.uv[t + 1] = CORNER_V[uvc] ? v1 : v0;
    const col = Math.round(shade * AO_LINEAR[cornerAO[c]!]!);
    buf.col[p] = col;
    buf.col[p + 1] = col;
    buf.col[p + 2] = col;
    buf.sky[q * 4 + k] = Math.round(cornerSky[c]! * 17);
    buf.blk[q * 4 + k] = Math.round(cornerBlock[c]! * 17);
  }
}

const CACTUS_INSET = 1 / 16;

/**
 * One face of an axis-aligned box inside the cell (cactus). UVs follow the
 * box so the texture keeps its pixel scale.
 */
function emitBoxFace(
  buf: QuadBuffer,
  face: number,
  x: number,
  y: number,
  z: number,
  box: readonly number[],
  tile: number,
  shade: number,
  light: number,
): void {
  buf.reserve();
  const q = buf.quads++;
  buf.light(q, light);
  const verts = FACE_VERTS[face]!;
  const u0 = TILE_UVS[tile * 4]!;
  const v0 = TILE_UVS[tile * 4 + 1]!;
  const du = TILE_UVS[tile * 4 + 2]! - u0;
  const dv = TILE_UVS[tile * 4 + 3]! - v0;
  for (let c = 0; c < 4; c++) {
    const p = q * 12 + c * 3;
    const px = verts[c * 3]! ? box[3]! : box[0]!;
    const py = verts[c * 3 + 1]! ? box[4]! : box[1]!;
    const pz = verts[c * 3 + 2]! ? box[5]! : box[2]!;
    buf.pos[p] = x + px;
    buf.pos[p + 1] = y + py;
    buf.pos[p + 2] = z + pz;
    // Texture coordinates from the position, per face orientation.
    let u: number;
    let v: number;
    if (face === 0) [u, v] = [1 - pz, py];
    else if (face === 1) [u, v] = [pz, py];
    else if (face === 2) [u, v] = [px, 1 - pz];
    else if (face === 3) [u, v] = [px, pz];
    else if (face === 4) [u, v] = [px, py];
    else [u, v] = [1 - px, py];
    buf.uv[q * 8 + c * 2] = u0 + du * u;
    buf.uv[q * 8 + c * 2 + 1] = v0 + dv * v;
    buf.col[p] = shade;
    buf.col[p + 1] = shade;
    buf.col[p + 2] = shade;
  }
}

const CACTUS_BOX = [CACTUS_INSET, 0, CACTUS_INSET, 1 - CACTUS_INSET, 1, 1 - CACTUS_INSET];

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

function emitCross(buf: QuadBuffer, x: number, y: number, z: number, tile: number, light: number): void {
  const shade = FULL_BYTE;
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
    buf.light(q, light);
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

const TORCH_FLOOR = 0;

/**
 * A torch: four thin planes through the middle of the cell using the full
 * tile (only the 2-pixel stick is opaque), plus a small top cap. Wall
 * torches sit low against the wall and lean away from it.
 */
function emitTorch(buf: QuadBuffer, x: number, y: number, z: number, tile: number, attach: number, light: number): void {
  const [lx, lz] = TORCH_ATTACH[attach] ?? TORCH_ATTACH[0]!;
  const u0 = TILE_UVS[tile * 4]!;
  const v0 = TILE_UVS[tile * 4 + 1]!;
  const u1 = TILE_UVS[tile * 4 + 2]!;
  const v1 = TILE_UVS[tile * 4 + 3]!;
  const du = (u1 - u0) / 16;
  const dv = (v1 - v0) / 16;
  const wall = attach !== TORCH_FLOOR;
  const lift = wall ? 0.2 : 0;
  // Offset toward the wall at the bottom, leaning out toward the top.
  const place = (px: number, py: number, pz: number, out: number[]): void => {
    const k = wall ? -0.36 + py * 0.42 : 0;
    out.push(x + px + lx * k, y + py + lift, z + pz + lz * k);
  };
  const a = 7 / 16;
  const b = 9 / 16;
  const planes: number[][] = [
    [a, 0, 0, a, 0, 1, a, 1, 1, a, 1, 0], // −X side
    [b, 0, 1, b, 0, 0, b, 1, 0, b, 1, 1], // +X side
    [1, 0, a, 0, 0, a, 0, 1, a, 1, 1, a], // −Z side
    [0, 0, b, 1, 0, b, 1, 1, b, 0, 1, b], // +Z side
  ];
  const quad = (corners: number[], us: number[], vs: number[], both: boolean): void => {
    const pts: number[] = [];
    for (let c = 0; c < 4; c++) place(corners[c * 3]!, corners[c * 3 + 1]!, corners[c * 3 + 2]!, pts);
    const orders = both ? [[0, 1, 2, 3], [1, 0, 3, 2]] : [[0, 1, 2, 3]];
    for (const order of orders) {
      buf.reserve();
      const q = buf.quads++;
      buf.light(q, light);
      for (let c = 0; c < 4; c++) {
        const src = order[c]!;
        const p = q * 12 + c * 3;
        buf.pos[p] = pts[src * 3]!;
        buf.pos[p + 1] = pts[src * 3 + 1]!;
        buf.pos[p + 2] = pts[src * 3 + 2]!;
        buf.uv[q * 8 + c * 2] = us[src]!;
        buf.uv[q * 8 + c * 2 + 1] = vs[src]!;
        buf.col[p] = FULL_BYTE;
        buf.col[p + 1] = FULL_BYTE;
        buf.col[p + 2] = FULL_BYTE;
      }
    }
  };
  for (const pl of planes) quad(pl, [u0, u1, u1, u0], [v0, v0, v1, v1], true);
  // Top cap at 10/16 showing the lit tip (tile pixels 7–8, rows 6–7).
  const t = 10 / 16;
  quad(
    [a, t, b, b, t, b, b, t, a, a, t, a],
    [u0 + 7 * du, u0 + 9 * du, u0 + 9 * du, u0 + 7 * du],
    [v1 - 8 * dv, v1 - 8 * dv, v1 - 6 * dv, v1 - 6 * dv],
    false,
  );
}

/** Face on the other side of the cell: +X ↔ −X, +Y ↔ −Y, +Z ↔ −Z. */
const OPPOSITE_FACE = [1, 0, 3, 2, 5, 4];

function partialHeight(shape: number): number {
  return shape === SHAPE_SLAB ? 0.5 : shape === SHAPE_LAYER ? 0.125 : 1;
}

/**
 * Should the face of block `id` (shape `shape`) pointing at neighbour `nb`
 * through face `face` be drawn?
 */
export function faceVisible(id: number, shape: number, nb: number, face: number): boolean {
  if (nb === B.AIR) return true;
  const height = partialHeight(shape);
  // A slab's or snow layer's top sits inside the cell and never touches the block above.
  if (height < 1 && face === 2) return true;
  if (OCCLUDES[nb]) return false;
  if (nb === id && CULL_SAME[id]) return false;
  const nbHeight = partialHeight(SHAPE[nb]!);
  if (nbHeight < 1) {
    if (face === 2) return false; // the neighbour's bottom covers our top face
    // Side by side: hidden behind a partial neighbour at least as tall.
    if (height < 1 && face !== 3 && nbHeight >= height) return false;
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
  const tints = pad.tints;
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
        const tintMode = TINT_MODE[id]!;
        if (tintMode === TINT_NONE) setTint(0xffffff);
        else if (tintMode === TINT_FIXED) setTint(TINT_COLOR[id]!);
        else if (tints) {
          const o = ((z << 4) | x) * 9 + (tintMode - 1) * 3;
          tintR = tints[o]!;
          tintG = tints[o + 1]!;
          tintB = tints[o + 2]!;
        } else setTint(DEFAULT_TINTS[tintMode]!);

        if (shape === SHAPE_CROSS) {
          emitCross(buf, x, y, z, FACE_TILES[id * 6 + 2]!, light[i]!);
          continue;
        }
        if (shape === SHAPE_TORCH) {
          emitTorch(buf, x, y, z, FACE_TILES[id * 6 + 2]!, value >> 8, light[i]!);
          continue;
        }
        if (shape === SHAPE_CACTUS) {
          for (let f = 0; f < 6; f++) {
            const ni = i + PAD_OFFSETS[f]!;
            const nb = blocks[ni]! & 0xff;
            const side = f !== 2 && f !== 3;
            // Inset sides are always visible; ends touch the next block.
            if (!side && (OCCLUDES[nb] || nb === id)) continue;
            emitBoxFace(buf, f, x, y, z, CACTUS_BOX, FACE_TILES[id * 6 + f]!, FACE_BYTES[f]!, side ? light[i]! : light[ni]!);
          }
          continue;
        }

        const fullBright = FULL_BRIGHT[id] === 1;
        const liquid = pad.fluidLevels && IS_LIQUID[id] === 1;
        const top = liquid
          ? fluidHeight(value, blocks[i + PAD_LAYER]! & 0xff)
          : shape === SHAPE_SLAB
            ? 0.5
            : shape === SHAPE_LAYER
              ? 0.125
              : 1;
        const axis = HAS_AXIS[id] ? (value >> 8) % 3 : 0;
        const snowy = id === B.GRASS && isSnow(blocks[i + PAD_LAYER]! & 0xff);
        const front = HAS_FACING[id] ? FACING_FACES[(value >> 8) & 3]! : -1;
        for (let f = 0; f < 6; f++) {
          const ni = i + PAD_OFFSETS[f]!;
          const nb = blocks[ni]! & 0xff;
          if (OCCLUDES[nb] && !(top < 1 && f === 2)) continue;
          if (liquid && nb === id && f !== 2 && f !== 3) {
            // Beside a lower surface of the same fluid, show the step between them.
            const nbTop = fluidHeight(blocks[ni]!, blocks[ni + PAD_LAYER]! & 0xff);
            if (nbTop < top) {
              const lh = fullBright ? (light[ni]! & 0xf0) | 15 : light[ni]!;
              emitBoxFace(buf, f, x, y, z, [0, nbTop, 0, 1, top, 1], FACE_TILES[id * 6 + f]!, fullBright ? FULL_BYTE : FACE_BYTES[f]!, lh);
            }
            continue;
          }
          if (!faceVisible(id, shape, nb, f)) continue;
          const lightHere = fullBright ? (light[ni]! & 0xf0) | 15 : light[ni]!;
          let tile = FACE_TILES[id * 6 + f]!;
          let turn = 0;
          if (axis !== 0) {
            tile = FACE_TILES[id * 6 + (AXIS_END[axis * 6 + f] ? 2 : 0)]!;
            turn = AXIS_ROTATE[axis * 6 + f]!;
          } else if (snowy && f !== 2 && f !== 3) {
            tile = T.GRASS_SIDE_SNOW;
          } else if (id === B.BED) {
            const state = value >> 8;
            if (f === 2) {
              // The top runs from foot to head whichever way the bed faces.
              tile = state & BED_HEAD ? T.BED_HEAD_TOP : T.BED_FOOT_TOP;
              turn = state & 3; // one quarter turn per facing step
            } else if (f !== 3) {
              tile = f === front ? T.BED_FOOT_END : f === OPPOSITE_FACE[front] ? T.BED_HEAD_END : T.BED_SIDE;
            }
          } else if (front >= 0 && f !== 2 && f !== 3) {
            tile = f === front ? frontTile(id, value >> 8) : FACE_TILES[id * 6]!;
          }
          if (pad.smooth && top === 1 && !fullBright && !liquid) {
            emitSmoothFace(buf, f, x, y, z, tile, FACE_BYTES[f]!, ni, blocks, light, turn);
          } else {
            emitFace(buf, f, x, y, z, tile, fullBright ? FULL_BYTE : FACE_BYTES[f]!, lightHere, top, turn);
          }
        }
      }
    }
  }

  return [buffers[0]!.finish(), buffers[1]!.finish(), buffers[2]!.finish()];
}

function isSnow(id: number): boolean {
  return id === B.SNOW_LAYER || id === B.SNOW_BLOCK;
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
