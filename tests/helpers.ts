import { buildMeshInput, columnShadowLight, fillPaddedFromInput } from '../src/render/meshInput';
import { meshSection, type ChunkMeshData } from '../src/render/mesher';
import { createPadded } from '../src/render/padded';
import { Chunk } from '../src/world/chunk';
import { computeChunkLight } from '../src/world/light';
import { buildLightRegion } from '../src/world/lightRegion';
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
  const reader = (c: Chunk): Uint8Array | null => c.light ?? columnShadowLight(c);
  fillPaddedFromInput(pad, buildMeshInput(world, chunk, 1 << sy, reader), sy);
  return meshSection(pad);
}

/** Compute flood-fill light for every chunk of a world (as the workers would). */
export function lightWorld(world: World): void {
  for (const c of world.chunks.values()) c.light = null;
  for (const c of world.chunks.values()) {
    world.setChunkLight(c, computeChunkLight(buildLightRegion(world, c.cx, c.cz)));
  }
}

/** An Infinite-type world with chunks cx, cz ∈ [−r, r] filled by `fill`. */
export function infiniteWorld(r: number, fill: (x: number, y: number, z: number) => number): World {
  const w = new World({ type: 'infinite', seed: 1, height: 128, seaLevel: 62 });
  for (let cz = -r; cz <= r; cz++) {
    for (let cx = -r; cx <= r; cx++) {
      const c = new Chunk(cx, cz);
      for (let y = 0; y < 128; y++)
        for (let lz = 0; lz < 16; lz++)
          for (let lx = 0; lx < 16; lx++) c.blocks[(y << 8) | (lz << 4) | lx] = fill(cx * 16 + lx, y, cz * 16 + lz);
      w.addChunk(c);
    }
  }
  return w;
}
