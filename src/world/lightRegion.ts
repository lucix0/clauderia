import { lightId } from './blocks';
import { CHUNK_HEIGHT } from './coords';
import { REGION, REGION_LAYER, REGION_VOLUME } from './light';
import type { World } from './world';

/**
 * Ids of the 3×3 chunks around (cx, cz) as one 48×48×128 array for
 * `computeChunkLight`. Missing neighbours (the Classic edge) use the
 * world's virtual surroundings.
 */
export function buildLightRegion(world: World, cx: number, cz: number): Uint8Array {
  const out = new Uint8Array(REGION_VOLUME);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.getChunk(cx + dx, cz + dz);
      const ox = (dx + 1) * 16;
      const oz = (dz + 1) * 16;
      if (c) {
        const b = c.blocks;
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          for (let lz = 0; lz < 16; lz++) {
            let i = (y << 8) | (lz << 4);
            let o = (y * REGION + oz + lz) * REGION + ox;
            for (let lx = 0; lx < 16; lx++, i++, o++) out[o] = lightId(b[i]!);
          }
        }
      } else {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const wx = (cx + dx) * 16 + lx;
            const wz = (cz + dz) * 16 + lz;
            for (let y = 0, o = (oz + lz) * REGION + ox + lx; y < CHUNK_HEIGHT; y++, o += REGION_LAYER) {
              out[o] = lightId(world.getVirtual(wx, y, wz));
            }
          }
        }
      }
    }
  }
  return out;
}
