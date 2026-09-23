/**
 * Mesh input for one chunk column: its blocks and light plus a one-cell
 * apron from the 8 neighbours, as flat transferable arrays (18×18×128).
 * Built on the main thread, meshed in a worker (or on the main thread for
 * edits) through the same code path.
 */
import { B } from '../world/blocks';
import type { Chunk } from '../world/chunk';
import { CHUNK_HEIGHT } from '../world/coords';
import type { World } from '../world/world';
import { PAD, type PaddedSection } from './padded';

export const COL = 18;
export const COL_LAYER = COL * COL;
export const COL_VOLUME = COL_LAYER * CHUNK_HEIGHT;

export interface MeshInput {
  cx: number;
  cz: number;
  /** Sections to mesh (bitmask). */
  sections: number;
  blocks: Uint16Array;
  /** Sky light in the high nibble, block light in the low one. */
  light: Uint8Array;
}

/** Full light array of a chunk (sky << 4 | block per cell), or null for full sky. */
export type LightReader = (chunk: Chunk) => Uint8Array | null;

const shadowCache = new WeakMap<Chunk, { version: number; light: Uint8Array }>();

/** Classic column shadows as a light array: sky 15 above the light height, else 0. */
export const columnShadowLight: LightReader = (chunk) => {
  const cached = shadowCache.get(chunk);
  if (cached && cached.version === chunk.version) return cached.light;
  const light = cached?.light ?? new Uint8Array(CHUNK_HEIGHT * 256);
  const h = chunk.heights;
  for (let col = 0; col < 256; col++) {
    const top = h[col]!;
    for (let y = 0; y < CHUNK_HEIGHT; y++) light[(y << 8) | col] = y > top ? 0xf0 : 0;
  }
  shadowCache.set(chunk, { version: chunk.version, light });
  return light;
};

export function colIndex(x: number, y: number, z: number): number {
  return (y * COL + (z + 1)) * COL + (x + 1);
}

/** Gather a column and its apron from the world. */
export function buildMeshInput(world: World, chunk: Chunk, sections: number, light: LightReader): MeshInput {
  const blocks = new Uint16Array(COL_VOLUME);
  const lightOut = new Uint8Array(COL_VOLUME);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const src = world.getChunk(chunk.cx + dx, chunk.cz + dz);
      // Local ranges of this neighbour inside the padded box.
      const x0 = dx < 0 ? 15 : 0;
      const x1 = dx > 0 ? 0 : 15;
      const z0 = dz < 0 ? 15 : 0;
      const z1 = dz > 0 ? 0 : 15;
      const ox = dx * 16 + 1; // padded x = lx + ox
      const oz = dz * 16 + 1;
      if (src) {
        const sb = src.blocks;
        const sl = light(src);
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          for (let lz = z0; lz <= z1; lz++) {
            let i = (y << 8) | (lz << 4) | x0;
            let o = (y * COL + lz + oz) * COL + x0 + ox;
            for (let lx = x0; lx <= x1; lx++, i++, o++) {
              blocks[o] = sb[i]!;
              lightOut[o] = sl ? sl[i]! : 0xf0;
            }
          }
        }
      } else {
        for (let lz = z0; lz <= z1; lz++) {
          for (let lx = x0; lx <= x1; lx++) {
            const wx = (chunk.cx + dx) * 16 + lx;
            const wz = (chunk.cz + dz) * 16 + lz;
            let o = (lz + oz) * COL + lx + ox;
            for (let y = 0; y < CHUNK_HEIGHT; y++, o += COL_LAYER) {
              blocks[o] = world.getVirtual(wx, y, wz);
              lightOut[o] = 0xf0;
            }
          }
        }
      }
    }
  }
  return { cx: chunk.cx, cz: chunk.cz, sections, blocks, light: lightOut };
}

/** Copy section `sy` (with its one-cell border) out of a mesh input. */
export function fillPaddedFromInput(out: PaddedSection, input: MeshInput, sy: number): void {
  out.sy = sy;
  out.cx = input.cx;
  out.cz = input.cz;
  const y0 = sy * 16 - 1;
  for (let py = 0; py < PAD; py++) {
    const y = y0 + py;
    const dst = py * COL_LAYER; // PAD === COL, so layers line up
    if (y < 0) {
      out.blocks.fill(B.BEDROCK, dst, dst + COL_LAYER);
      out.light.fill(0, dst, dst + COL_LAYER);
    } else if (y >= CHUNK_HEIGHT) {
      out.blocks.fill(B.AIR, dst, dst + COL_LAYER);
      out.light.fill(0xf0, dst, dst + COL_LAYER);
    } else {
      out.blocks.set(input.blocks.subarray(y * COL_LAYER, (y + 1) * COL_LAYER), dst);
      out.light.set(input.light.subarray(y * COL_LAYER, (y + 1) * COL_LAYER), dst);
    }
  }
}
