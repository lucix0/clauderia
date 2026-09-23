import type { Chunk } from '../world/chunk';
import type { World } from '../world/world';
import type { Neighbourhood } from './padded';

/** Neighbourhood of a chunk read straight from the world (main thread). */
export function worldNeighbourhood(world: World, chunk: Chunk): Neighbourhood {
  const around: Array<Chunk | undefined> = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) around.push(world.getChunk(chunk.cx + dx, chunk.cz + dz));
  const at = (dx: number, dz: number): Chunk | undefined => around[(dz + 1) * 3 + dx + 1];
  return {
    cx: chunk.cx,
    cz: chunk.cz,
    blocks: (dx, dz) => at(dx, dz)?.blocks ?? null,
    light: () => null,
    heights: (dx, dz) => at(dx, dz)?.heights ?? null,
    outside: (x, y, z) => world.getVirtual(x, y, z),
  };
}
