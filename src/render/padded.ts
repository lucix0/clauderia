/**
 * Padded 18×18×18 view of one 16³ section plus a one-cell apron from its
 * neighbours, built from the 3×3 chunk neighbourhood. Pure: the same builder
 * runs on the main thread (edits) and in mesh workers.
 */
import { B } from '../world/blocks';
import { CHUNK_HEIGHT } from '../world/coords';

export const PAD = 18;
export const PAD_VOLUME = PAD * PAD * PAD;

/** Index into padded arrays for local coords in −1..16. */
export function padIndex(x: number, y: number, z: number): number {
  return ((y + 1) * PAD + (z + 1)) * PAD + (x + 1);
}

/** Block and light source for the 3×3 neighbourhood around a column. */
export interface Neighbourhood {
  /** Chunk blocks by offset (dx, dz ∈ −1..1), or null when missing. */
  blocks(dx: number, dz: number): Uint16Array | null;
  /**
   * Light per cell: sky in the high nibble, block light in the low one.
   * Null when missing (treated as full sky light).
   */
  light(dx: number, dz: number): Uint8Array | null;
  /**
   * Classic column shadows: highest light-blocking y per column. Used when
   * there is no light array (cells at or below it read as sky 0).
   */
  heights?(dx: number, dz: number): Int16Array | null;
  /** Value used for cells of a missing neighbour (Classic edge ocean etc.). */
  outside(wx: number, y: number, wz: number): number;
  /** Chunk coordinates of the centre column. */
  readonly cx: number;
  readonly cz: number;
}

export interface PaddedSection {
  readonly blocks: Uint16Array;
  readonly light: Uint8Array;
  /** Section index (0–7) and column. */
  sy: number;
  cx: number;
  cz: number;
}

export function createPadded(): PaddedSection {
  return { blocks: new Uint16Array(PAD_VOLUME), light: new Uint8Array(PAD_VOLUME), sy: 0, cx: 0, cz: 0 };
}

/** Fill `out` for section `sy` of the centre column. */
export function fillPadded(out: PaddedSection, n: Neighbourhood, sy: number): void {
  out.sy = sy;
  out.cx = n.cx;
  out.cz = n.cz;
  const y0 = sy * 16;
  const ob = out.blocks;
  const ol = out.light;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const blocks = n.blocks(dx, dz);
      const light = n.light(dx, dz);
      const heights = light ? null : (n.heights?.(dx, dz) ?? null);
      // Local x/z ranges of this neighbour that fall inside the padded box.
      const xs = dx < 0 ? 15 : 0;
      const xe = dx > 0 ? 0 : 15;
      const zs = dz < 0 ? 15 : 0;
      const ze = dz > 0 ? 0 : 15;
      const ox = dx * 16;
      const oz = dz * 16;
      for (let py = -1; py <= 16; py++) {
        const y = y0 + py;
        for (let lz = zs; lz <= ze; lz++) {
          for (let lx = xs; lx <= xe; lx++) {
            const pi = padIndex(lx + ox, py, lz + oz);
            if (y < 0) {
              ob[pi] = B.BEDROCK;
              ol[pi] = 0;
            } else if (y >= CHUNK_HEIGHT) {
              ob[pi] = B.AIR;
              ol[pi] = 0xf0;
            } else if (blocks) {
              const i = (y << 8) | (lz << 4) | lx;
              ob[pi] = blocks[i]!;
              ol[pi] = light ? light[i]! : heights && y <= heights[(lz << 4) | lx]! ? 0 : 0xf0;
            } else {
              ob[pi] = n.outside((n.cx + dx) * 16 + lx, y, (n.cz + dz) * 16 + lz);
              ol[pi] = 0xf0;
            }
          }
        }
      }
    }
  }
}
