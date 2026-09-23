import { describe, expect, it } from 'vitest';
import { B } from '../src/world/blocks';
import { computeChunkLight } from '../src/world/light';
import { buildLightRegion } from '../src/world/lightRegion';
import { Rng } from '../src/util/prng';
import type { World } from '../src/world/world';
import { infiniteWorld, lightWorld } from './helpers';

const sky = (w: World, x: number, y: number, z: number): number => w.lightAt(x, y, z) >> 4;
const blk = (w: World, x: number, y: number, z: number): number => w.lightAt(x, y, z) & 15;

/** Stone floor at y = 10 (surface y = 11). */
function flat(r = 1): World {
  const w = infiniteWorld(r, (_x, y) => (y <= 10 ? B.STONE : B.AIR));
  lightWorld(w);
  return w;
}

describe('flood-fill light', () => {
  it('lights open sky fully and shades under an overhang', () => {
    const w = flat();
    expect(sky(w, 5, 11, 5)).toBe(15);
    expect(sky(w, 5, 127, 5)).toBe(15);
    expect(sky(w, 5, 10, 5)).toBe(0); // inside stone
    w.setBlock(5, 13, 5, B.STONE);
    expect(sky(w, 5, 12, 5)).toBe(14); // light spreads in from the side
    expect(sky(w, 5, 11, 5)).toBe(14);
    w.setBlock(5, 13, 5, B.AIR);
    expect(sky(w, 5, 11, 5)).toBe(15);
  });

  it('dims sky light through leaves and water', () => {
    const w = infiniteWorld(1, (_x, y) => (y <= 10 ? B.STONE : y <= 13 ? B.WATER : B.AIR));
    lightWorld(w);
    expect(sky(w, 3, 13, 3)).toBe(13);
    expect(sky(w, 3, 12, 3)).toBe(11);
    expect(sky(w, 3, 11, 3)).toBe(9);
  });

  it('spreads torch light by one per block and removes it again', () => {
    const w = infiniteWorld(1, (_x, y) => (y <= 10 || y >= 20 ? B.STONE : B.AIR)); // dark cave layer
    lightWorld(w);
    expect(sky(w, 4, 15, 4)).toBe(0);
    w.setBlock(4, 12, 4, B.TORCH);
    expect(blk(w, 4, 12, 4)).toBe(14);
    expect(blk(w, 5, 12, 4)).toBe(13);
    expect(blk(w, 7, 13, 5)).toBe(14 - 3 - 1 - 1);
    w.setBlock(4, 12, 4, B.AIR);
    for (const [x, y, z] of [
      [4, 12, 4],
      [5, 12, 4],
      [9, 12, 4],
    ] as const)
      expect(blk(w, x, y, z)).toBe(0);
  });

  it('carries light across chunk borders, both computed and incremental', () => {
    const w = infiniteWorld(1, (_x, y) => (y <= 10 || y >= 20 ? B.STONE : B.AIR));
    w.setBlock(15, 12, 4, B.TORCH); // on the east edge of chunk (0, 0)
    lightWorld(w);
    expect(blk(w, 16, 12, 4)).toBe(13);
    expect(blk(w, 20, 12, 4)).toBe(9);
    expect(blk(w, 15, 12, -1)).toBe(9); // into chunk (0, -1)
    w.setBlock(15, 12, 4, B.AIR);
    expect(blk(w, 20, 12, 4)).toBe(0);
    w.setBlock(-1, 12, -1, B.TORCH); // corner of chunk (−1, −1)
    expect(blk(w, 0, 12, 0)).toBe(12);
    expect(blk(w, 3, 12, 0)).toBe(9);
  });

  it('blocks light with opaque blocks and lets it leak around walls', () => {
    const w = infiniteWorld(1, (_x, y) => (y <= 10 || y >= 20 ? B.STONE : B.AIR));
    lightWorld(w);
    for (let y = 11; y < 20; y++) for (let z = -8; z <= 8; z++) w.setBlock(6, y, z, B.STONE);
    w.setBlock(4, 12, 0, B.TORCH);
    expect(blk(w, 6, 12, 0)).toBe(0); // inside the wall
    expect(blk(w, 7, 12, 0)).toBe(0); // too far round the wall's ends
    w.setBlock(6, 12, 0, B.GLASS); // a window
    expect(blk(w, 7, 12, 0)).toBe(11);
  });

  it('keeps incremental relighting identical to a full recompute', () => {
    const rng = new Rng(77);
    const w = infiniteWorld(2, (x, y, z) => {
      if (y <= 8) return B.STONE;
      if (y <= 12 && (x * 7 + z * 13) % 5 === 0) return B.STONE;
      return B.AIR;
    });
    lightWorld(w);
    const choices = [B.AIR, B.STONE, B.GLASS, B.LEAVES, B.WATER, B.TORCH, B.LAVA, B.AIR, B.STONE];
    for (let step = 0; step < 120; step++) {
      const x = rng.int(32) - 16;
      const z = rng.int(32) - 16;
      const y = 6 + rng.int(14);
      w.setBlock(x, y, z, choices[rng.int(choices.length)]!);
    }
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        const fresh = computeChunkLight(buildLightRegion(w, cx, cz));
        const live = w.getChunk(cx, cz)!.light!;
        let mismatches = 0;
        for (let i = 0; i < fresh.length; i++) if (fresh[i] !== live[i]) mismatches++;
        expect(mismatches, `chunk ${cx},${cz}`).toBe(0);
      }
    }
  });
});
