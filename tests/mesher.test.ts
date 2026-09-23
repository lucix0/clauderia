import { describe, expect, it } from 'vitest';
import { faceVisible, meshChunk } from '../src/render/mesher';
import { B, PASS_CUTOUT, PASS_OPAQUE, PASS_TRANSLUCENT, SHAPE_CUBE } from '../src/world/blocks';
import { World } from '../src/world/world';

function quads(world: World): number[] {
  const m = meshChunk(world, 0, 0, 0);
  return m.map((p) => p?.quads ?? 0);
}

function worldWith(cells: Array<[number, number, number, number]>): World {
  const w = new World(32, 32, 32, 0);
  for (const [x, y, z, id] of cells) w.setBlock(x, y, z, id);
  return w;
}

describe('mesher culling', () => {
  it('emits 6 faces for a lone cube', () => {
    expect(quads(worldWith([[10, 10, 10, B.STONE]]))[PASS_OPAQUE]).toBe(6);
  });

  it('emits 10 faces for two adjacent cubes', () => {
    const w = worldWith([
      [10, 10, 10, B.STONE],
      [11, 10, 10, B.DIRT],
    ]);
    expect(quads(w)[PASS_OPAQUE]).toBe(10);
    const m = meshChunk(w, 0, 0, 0)[PASS_OPAQUE]!;
    expect(m.positions.length).toBe(10 * 4 * 3);
    expect(m.indices.length).toBe(10 * 6);
  });

  it('culls faces between two blocks of the same transparent type', () => {
    expect(quads(worldWith([[10, 10, 10, B.GLASS], [10, 11, 10, B.GLASS]]))[PASS_CUTOUT]).toBe(10);
    expect(quads(worldWith([[10, 10, 10, B.WATER], [10, 10, 11, B.WATER]]))[PASS_TRANSLUCENT]).toBe(10);
  });

  it('keeps faces between different transparent blocks and against non-occluders', () => {
    const q = quads(worldWith([[10, 10, 10, B.GLASS], [11, 10, 10, B.STONE]]));
    expect(q[PASS_OPAQUE]).toBe(6); // stone still shows through the glass
    expect(q[PASS_CUTOUT]).toBe(5); // glass face against stone is hidden
  });

  it('hides a cube top under a slab but keeps the slab top', () => {
    const q = quads(worldWith([[10, 10, 10, B.STONE], [10, 11, 10, B.SLAB]]));
    expect(q[PASS_OPAQUE]).toBe(10);
    expect(faceVisible(B.SLAB, 3, B.STONE, 2)).toBe(true);
    expect(faceVisible(B.STONE, SHAPE_CUBE, B.SLAB, 2)).toBe(false);
  });

  it('draws plants as two double-sided diagonal quads', () => {
    const q = quads(worldWith([[10, 9, 10, B.GRASS], [10, 10, 10, B.ROSE]]));
    expect(q[PASS_CUTOUT]).toBe(4);
  });

  it('bakes directional shade and shadows into vertex colours', () => {
    const lit = meshChunk(worldWith([[10, 10, 10, B.STONE]]), 0, 0, 0)[PASS_OPAQUE]!;
    const shadowed = meshChunk(
      worldWith([
        [10, 10, 10, B.STONE],
        [10, 20, 10, B.STONE],
      ]),
      0,
      0,
      0,
    )[PASS_OPAQUE]!;
    // The top face is the 3rd face emitted (+X, -X, +Y ...).
    const topLit = lit.colors[2 * 12]!;
    const topShadow = shadowed.colors[2 * 12]!;
    expect(topLit).toBe(255);
    expect(topShadow).toBeLessThan(topLit);
    const sideLit = lit.colors[0]!;
    expect(sideLit).toBeLessThan(topLit);
  });

  it('keeps lava fully bright', () => {
    const m = meshChunk(worldWith([[10, 10, 10, B.LAVA], [10, 20, 10, B.STONE]]), 0, 0, 0)[PASS_OPAQUE]!;
    const lavaColours = m.colors.slice(0, 6 * 12);
    expect(Math.min(...lavaColours)).toBe(255);
  });
});
