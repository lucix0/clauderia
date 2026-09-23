/**
 * Small geometry builders for entities (dropped items now, mobs later).
 * Every geometry carries the same attributes as chunk meshes (colour =
 * face shade, skyLight, blockLight, tint), so it is lit by the same shader.
 */
import * as THREE from 'three';
import { SHADE_BOTTOM, SHADE_TOP, SHADE_X, SHADE_Z } from '../config';
import { TILE_UVS } from '../render/mesher';
import {
  DEFAULT_FOLIAGE_TINT,
  DEFAULT_GRASS_TINT,
  DEFAULT_WATER_TINT,
  FACE_TILES,
  shapeHeight,
  TINT_COLOR,
  TINT_FIXED,
  TINT_MODE,
} from '../world/blocks';

/** UV rectangle: u0, v0, u1, v1. */
export type UVRect = readonly [number, number, number, number];

const FACE_SHADES = [SHADE_X, SHADE_X, SHADE_TOP, SHADE_BOTTOM, SHADE_Z, SHADE_Z];

function linear(b: number): number {
  return Math.pow(b, 2.2);
}

/** Corners per face (+X, −X, +Y, −Y, +Z, −Z), counter-clockwise from outside; uv (0,0),(1,0),(1,1),(0,1). */
const FACE_CORNERS: ReadonlyArray<readonly number[]> = [
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0],
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0],
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0],
];
const CU = [0, 1, 1, 0];
const CV = [0, 0, 1, 1];

/** Accumulates quads, then builds a BufferGeometry. */
export class ModelBuilder {
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly tint: number[] = [];

  /** One face of an axis-aligned box. */
  face(face: number, box: readonly number[], uv: UVRect, tint = 0xffffff, shade = FACE_SHADES[face]!): void {
    const c = FACE_CORNERS[face]!;
    const s = Math.round(linear(shade) * 255);
    for (let k = 0; k < 4; k++) {
      this.pos.push(c[k * 3]! ? box[3]! : box[0]!, c[k * 3 + 1]! ? box[4]! : box[1]!, c[k * 3 + 2]! ? box[5]! : box[2]!);
      this.uv.push(CU[k] ? uv[2] : uv[0], CV[k] ? uv[3] : uv[1]);
      this.col.push(s, s, s);
      this.tint.push((tint >> 16) & 255, (tint >> 8) & 255, tint & 255);
    }
  }

  /** A whole box with a UV rect per face. */
  box(box: readonly number[], uvs: (face: number) => UVRect, tint = 0xffffff): void {
    for (let f = 0; f < 6; f++) this.face(f, box, uvs(f), tint);
  }

  /** A flat, double-sided-by-material quad in the XY plane. */
  quad(x0: number, y0: number, x1: number, y1: number, uv: UVRect, tint = 0xffffff): void {
    this.face(4, [x0, y0, 0, x1, y1, 0], uv, tint, 1);
  }

  build(): THREE.BufferGeometry {
    const quads = this.pos.length / 12;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(Uint8Array.from(this.col), 3, true));
    g.setAttribute('tint', new THREE.BufferAttribute(Uint8Array.from(this.tint), 3, true));
    g.setAttribute('skyLight', new THREE.BufferAttribute(new Uint8Array(quads * 4).fill(255), 1, true));
    g.setAttribute('blockLight', new THREE.BufferAttribute(new Uint8Array(quads * 4), 1, true));
    const idx: number[] = [];
    for (let q = 0; q < quads; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    g.setIndex(idx);
    return g;
  }
}

/** Atlas UVs of a block tile. */
export function tileUV(tile: number): UVRect {
  return [TILE_UVS[tile * 4]!, TILE_UVS[tile * 4 + 1]!, TILE_UVS[tile * 4 + 2]!, TILE_UVS[tile * 4 + 3]!];
}

/** Default tint of a block (grass, leaves, water colours used outside the world). */
export function blockTint(id: number): number {
  const mode = TINT_MODE[id]!;
  if (mode === TINT_FIXED) return TINT_COLOR[id]!;
  return [0xffffff, DEFAULT_GRASS_TINT, DEFAULT_FOLIAGE_TINT, DEFAULT_WATER_TINT][mode] ?? 0xffffff;
}

/** A small cube of block `id` (centred on x/z, sitting on y = 0). */
export function blockItemGeometry(id: number, size: number): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const h = shapeHeight(id);
  const s = size / 2;
  b.box([-s, 0, -s, s, size * h, s], (f) => tileUV(FACE_TILES[id * 6 + f]!), blockTint(id));
  return b.build();
}

/** A flat sprite (centred on x, sitting on y = 0). */
export function spriteGeometry(uv: UVRect, size: number, tint = 0xffffff): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.quad(-size / 2, 0, size / 2, size, uv, tint);
  return b.build();
}

/** Set every vertex's light from a packed (sky << 4 | block) byte. */
export function setGeometryLight(g: THREE.BufferGeometry, packed: number): void {
  const sky = g.getAttribute('skyLight') as THREE.BufferAttribute;
  const block = g.getAttribute('blockLight') as THREE.BufferAttribute;
  const s = (packed >> 4) * 17;
  const k = (packed & 15) * 17;
  const sa = sky.array as Uint8Array;
  const ba = block.array as Uint8Array;
  if (sa[0] === s && ba[0] === k) return;
  sa.fill(s);
  ba.fill(k);
  sky.needsUpdate = true;
  block.needsUpdate = true;
}
