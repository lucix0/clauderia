import { createPadded, fillPadded } from '../src/render/padded';
import { meshSection, type ChunkMeshData } from '../src/render/mesher';
import { worldNeighbourhood } from '../src/render/neighbourhood';
import { World } from '../src/world/world';

/** A Classic world of the given size, filled by `fill(x, y, z)` (default air). */
export function classicWorld(
  sx: number,
  sy: number,
  sz: number,
  fill: (x: number, y: number, z: number) => number = () => 0,
  seed = 0,
): World {
  const level = new Uint8Array(sx * sy * sz);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) level[(y * sz + z) * sx + x] = fill(x, y, z);
  return World.fromClassicLevel(level, sx, sy, sz, seed);
}

/** Mesh one section of a world through the same path the renderer uses. */
export function meshAt(world: World, cx: number, sy: number, cz: number): ChunkMeshData {
  const chunk = world.getChunk(cx, cz);
  if (!chunk) throw new Error('No such chunk');
  const pad = createPadded();
  fillPadded(pad, worldNeighbourhood(world, chunk), sy);
  return meshSection(pad);
}
