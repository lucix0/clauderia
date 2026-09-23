import { describe, expect, it } from 'vitest';
import { faceVisible } from '../src/render/mesher';
import { B, PASS_CUTOUT, PASS_OPAQUE, PASS_TRANSLUCENT, SHAPE_CUBE } from '../src/world/blocks';
import type { World } from '../src/world/world';
import { buildMeshInput, fillPaddedFromInput } from '../src/render/meshInput';
import { meshSection } from '../src/render/mesher';
import { createPadded } from '../src/render/padded';
import { classicWorld, lightWorld, meshAt } from './helpers';

function quads(world: World, cx = 0, sy = 0, cz = 0): number[] {
  return meshAt(world, cx, sy, cz).map((p) => p?.quads ?? 0);
}

function worldWith(cells: Array<[number, number, number, number]>): World {
  const w = classicWorld(32, 32, 32);
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
    const m = meshAt(w, 0, 0, 0)[PASS_OPAQUE]!;
    expect(m.positions.length).toBe(10 * 4 * 3);
  });

  it('culls across chunk and section borders exactly like inside a chunk', () => {
    // Two cubes straddling the x = 16 chunk border, then the y = 16 section border.
    const across = worldWith([
      [15, 10, 5, B.STONE],
      [16, 10, 5, B.STONE],
    ]);
    expect(quads(across, 0, 0, 0)[PASS_OPAQUE]! + quads(across, 1, 0, 0)[PASS_OPAQUE]!).toBe(10);
    const stacked = worldWith([
      [5, 15, 5, B.STONE],
      [5, 16, 5, B.STONE],
    ]);
    expect(quads(stacked, 0, 0, 0)[PASS_OPAQUE]! + quads(stacked, 0, 1, 0)[PASS_OPAQUE]!).toBe(10);
  });

  it('emits chunk-local positions', () => {
    const w = worldWith([[20, 18, 21, B.STONE]]);
    const m = meshAt(w, 1, 1, 1)[PASS_OPAQUE]!;
    const xs = [];
    const ys = [];
    const zs = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      xs.push(m.positions[i]!);
      ys.push(m.positions[i + 1]!);
      zs.push(m.positions[i + 2]!);
    }
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([4, 5]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([18, 19]);
    expect([Math.min(...zs), Math.max(...zs)]).toEqual([5, 6]);
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

  it('produces nothing for an empty section', () => {
    expect(quads(worldWith([]), 0, 1, 0)).toEqual([0, 0, 0]);
  });

  it('stores face shade in colours and light in its own attributes', () => {
    const lone = worldWith([[10, 10, 10, B.STONE]]);
    lightWorld(lone);
    const lit = meshAt(lone, 0, 0, 0)[PASS_OPAQUE]!;
    const covered = worldWith([
      [10, 10, 10, B.STONE],
      [10, 20, 10, B.STONE],
    ]);
    lightWorld(covered);
    const shadowed = meshAt(covered, 0, 0, 0)[PASS_OPAQUE]!;
    // Faces are emitted +X, −X, +Y …: the top face is quad 2.
    expect(lit.colors[2 * 12]).toBe(255);
    expect(lit.colors[0]!).toBeLessThan(255); // sides are shaded
    expect(lit.sky[2 * 4]).toBe(15 * 17);
    expect(shadowed.sky[2 * 4]).toBe(14 * 17); // lit from the side only
    expect(shadowed.colors[2 * 12]).toBe(255); // colour ignores light now
    expect(lit.block[2 * 4]).toBe(0);
  });

  it('keeps lava fully bright', () => {
    const w = worldWith([[10, 10, 10, B.LAVA], [10, 20, 10, B.STONE]]);
    lightWorld(w);
    const m = meshAt(w, 0, 0, 0)[PASS_OPAQUE]!;
    expect(Math.min(...m.block.slice(0, 6 * 4))).toBe(255);
  });

  it('lights torch faces from the torch cell', () => {
    const w = worldWith([[10, 9, 10, B.STONE], [10, 10, 10, B.TORCH]]);
    lightWorld(w);
    const m = meshAt(w, 0, 0, 0)[PASS_CUTOUT]!;
    expect(m.quads).toBe(9); // four double-sided planes + a top cap
    expect(m.block[0]).toBe(14 * 17);
  });

  it('shows the map edge against the Classic edge ocean', () => {
    // A stone block on the map edge below sea level: its outward face looks
    // into the edge ocean (water) and stays; the one below edgeFloor faces bedrock.
    const w = classicWorld(16, 64, 16);
    w.setBlock(0, w.seaLevel - 1, 5, B.STONE);
    w.setBlock(0, 5, 5, B.STONE);
    const m = meshAt(w, 0, 1, 0)[PASS_OPAQUE]!;
    expect(m.quads).toBe(6);
    expect(meshAt(w, 0, 0, 0)[PASS_OPAQUE]!.quads).toBe(5);
  });

  it('tints grass by the column colour and leaves stone white', () => {
    const w = worldWith([[10, 10, 10, B.GRASS], [12, 10, 10, B.STONE]]);
    const chunk = w.getChunk(0, 0)!;
    chunk.tints = new Uint8Array(256 * 9);
    const k = ((10 << 4) | 10) * 9;
    chunk.tints.set([10, 20, 30], k);
    const m = meshAt(w, 0, 0, 0)[PASS_OPAQUE]!;
    const tintOf = (quad: number): number[] => Array.from(m.tints.slice(quad * 12, quad * 12 + 3));
    const seen = new Set<string>();
    for (let q = 0; q < m.quads; q++) seen.add(tintOf(q).join(','));
    expect(seen).toEqual(new Set(['10,20,30', '255,255,255']));
  });

  it('draws a snow layer as a thin slab that keeps the grass side snowy', () => {
    const w = worldWith([[10, 10, 10, B.GRASS], [10, 11, 10, B.SNOW_LAYER]]);
    const m = meshAt(w, 0, 0, 0)[PASS_OPAQUE]!;
    // Grass: 4 sides + bottom (top hidden under the snow); snow: 4 sides + top (bottom rests on grass).
    expect(m.quads).toBe(10);
    let top = 0;
    for (let i = 1; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i]!);
    expect(top).toBeCloseTo(11.125);
    expect(faceVisible(B.SNOW_LAYER, 5, B.STONE, 2)).toBe(true);
  });

  it('turns logs lying on their side', () => {
    const upright = meshAt(worldWith([[10, 10, 10, B.LOG]]), 0, 0, 0)[PASS_OPAQUE]!;
    const sideways = meshAt(worldWith([[10, 10, 10, B.LOG | (1 << 8)]]), 0, 0, 0)[PASS_OPAQUE]!;
    expect(sideways.quads).toBe(6);
    expect(Array.from(sideways.uvs)).not.toEqual(Array.from(upright.uvs));
  });

  it('insets cactus sides and stacks cacti without inner faces', () => {
    const w = worldWith([[10, 9, 10, B.SAND], [10, 10, 10, B.CACTUS], [10, 11, 10, B.CACTUS]]);
    const m = meshAt(w, 0, 0, 0)[PASS_CUTOUT]!;
    expect(m.quads).toBe(4 + 4 + 1); // two rings of sides + the top cap
    let minX = 99;
    for (let i = 0; i < m.positions.length; i += 3) minX = Math.min(minX, m.positions[i]!);
    expect(minX).toBeCloseTo(10 + 1 / 16);
  });

  it('shades corners next to walls with smooth lighting (ambient occlusion)', () => {
    const w = worldWith([[10, 9, 10, B.STONE], [10, 10, 11, B.STONE], [11, 10, 10, B.STONE], [11, 10, 11, B.STONE]]);
    lightWorld(w);
    const chunk = w.getChunk(0, 0)!;
    const pad = createPadded();
    fillPaddedFromInput(pad, buildMeshInput(w, chunk, 1, (c) => c.light, true), 0);
    const m = meshSection(pad)[PASS_OPAQUE]!;
    // The top face of the floor block: its corner under the three walls is darkest.
    let top = -1;
    for (let q = 0; q < m.quads; q++) {
      const ys = [1, 4, 7, 10].map((k) => m.positions[q * 12 + k]!);
      const xs = [0, 3, 6, 9].map((k) => m.positions[q * 12 + k]!);
      if (ys.every((y) => y === 10) && xs.every((x) => x >= 10 && x <= 11)) top = q;
    }
    expect(top).toBeGreaterThanOrEqual(0);
    const shades = [0, 1, 2, 3].map((k) => m.colors[top * 12 + k * 3]!);
    expect(Math.min(...shades)).toBeLessThan(Math.max(...shades));
    const flat = meshAt(w, 0, 0, 0)[PASS_OPAQUE]!;
    expect(new Set(Array.from(flat.colors.slice(0, 12))).size).toBe(1); // flat lighting: one shade per face
  });
});
