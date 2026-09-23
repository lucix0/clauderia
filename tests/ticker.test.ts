import { describe, expect, it } from 'vitest';
import { B } from '../src/world/blocks';
import { MAX_UPDATES_PER_TICK, Ticker } from '../src/world/ticker';
import type { World } from '../src/world/world';
import { classicWorld, lightWorld } from './helpers';

/** 32×32×32 world with a stone floor at y = 4 (top surface at y = 5). */
function setup(): { w: World; t: Ticker } {
  const w = classicWorld(32, 32, 32, (_x, y) => (y <= 4 ? B.STONE : B.AIR), 7);
  lightWorld(w);
  return { w, t: new Ticker(w) };
}

function run(t: Ticker, ticks: number): void {
  for (let i = 0; i < ticks; i++) t.step();
}

function count(w: World, id: number): number {
  let n = 0;
  for (const c of w.chunks.values()) for (const b of c.blocks) if ((b & 0xff) === id) n++;
  return n;
}

describe('falling blocks', () => {
  it('drops sand and gravel onto the ground', () => {
    const { w, t } = setup();
    w.setBlock(10, 15, 10, B.SAND);
    w.setBlock(12, 9, 12, B.GRAVEL);
    run(t, 40);
    expect(w.get(10, 5, 10)).toBe(B.SAND);
    expect(w.get(10, 15, 10)).toBe(B.AIR);
    expect(w.get(12, 5, 12)).toBe(B.GRAVEL);
  });

  it('makes a sand column fall when its support is removed', () => {
    const { w, t } = setup();
    w.setBlock(8, 5, 8, B.STONE);
    for (let y = 6; y < 9; y++) w.setBlock(8, y, 8, B.SAND);
    run(t, 5);
    expect(w.get(8, 8, 8)).toBe(B.SAND); // supported: nothing moves
    w.setBlock(8, 5, 8, B.AIR);
    run(t, 40);
    expect([w.get(8, 5, 8), w.get(8, 6, 8), w.get(8, 7, 8), w.get(8, 8, 8)]).toEqual([B.SAND, B.SAND, B.SAND, B.AIR]);
  });
});

describe('liquids', () => {
  it('spreads water without limit across the floor, but not upward', () => {
    const { w, t } = setup();
    w.setBlock(16, 5, 16, B.WATER);
    run(t, 400);
    expect(w.get(0, 5, 0)).toBe(B.WATER);
    expect(w.get(31, 5, 31)).toBe(B.WATER);
    expect(w.get(16, 6, 16)).toBe(B.AIR);
  });

  it('flows down into holes', () => {
    const { w, t } = setup();
    w.setBlock(5, 4, 5, B.AIR);
    w.setBlock(5, 3, 5, B.AIR);
    w.setBlock(6, 5, 5, B.WATER);
    run(t, 60);
    expect(w.get(5, 3, 5)).toBe(B.WATER);
  });

  it('spreads lava more slowly than water', () => {
    const a = setup();
    const b = setup();
    a.w.setBlock(16, 5, 16, B.WATER);
    b.w.setBlock(16, 5, 16, B.LAVA);
    run(a.t, 100);
    run(b.t, 100);
    expect(count(b.w, B.LAVA)).toBeGreaterThan(1);
    expect(count(b.w, B.LAVA)).toBeLessThan(count(a.w, B.WATER) / 4);
  });

  it('caps the number of updates per tick', () => {
    const w = classicWorld(128, 16, 128, (_x, y) => (y === 0 ? B.STONE : B.AIR), 1);
    lightWorld(w);
    const t = new Ticker(w);
    for (let z = 0; z < 128; z += 4) for (let x = 0; x < 128; x += 4) w.setBlock(x, 1, z, B.WATER);
    let peak = 0;
    let ticks = 0;
    while (t.pending > 0 && ticks < 5000) {
      t.step();
      ticks++;
      peak = Math.max(peak, t.lastUpdates);
    }
    expect(peak).toBe(MAX_UPDATES_PER_TICK);
    // The backlog drains and the flood still completes.
    expect(t.pending).toBe(0);
    expect(count(w, B.WATER)).toBe(128 * 128);
  });

  it('hardens into stone where water meets lava', () => {
    const { w, t } = setup();
    w.setBlock(10, 5, 10, B.LAVA);
    w.setBlock(12, 5, 10, B.WATER);
    run(t, 40);
    expect(w.get(11, 5, 10)).toBe(B.STONE);
  });

  it('lets the edge ocean pour into holes dug at the map border', () => {
    const sea = 8; // outside water fills y 6..7
    const w = classicWorld(16, 16, 16, (_x, y) => (y < sea + 2 ? B.STONE : B.AIR), 3);
    expect(w.seaLevel).toBe(sea);
    lightWorld(w);
    const t = new Ticker(w);
    w.setBlock(0, sea - 1, 5, B.AIR);
    w.setBlock(1, sea - 1, 5, B.AIR);
    run(t, 30);
    expect(w.get(0, sea - 1, 5)).toBe(B.WATER);
    expect(w.get(1, sea - 1, 5)).toBe(B.WATER);
  });
});

describe('sponges', () => {
  it('clears water within 2 blocks and keeps it out until removed', () => {
    const w = classicWorld(32, 32, 32, (_x, y) => (y <= 4 ? B.STONE : y < 8 ? B.WATER : B.AIR), 7);
    lightWorld(w);
    const t = new Ticker(w);
    w.setBlock(16, 6, 16, B.SPONGE);
    run(t, 100);
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          expect(w.get(16 + dx, 6 + dy, 16 + dz)).toBe(B.AIR);
        }
    expect(w.get(19, 6, 16)).toBe(B.WATER);
    w.setBlock(16, 6, 16, B.AIR);
    run(t, 100);
    expect(w.get(16, 6, 16)).toBe(B.WATER);
    expect(w.get(15, 5, 15)).toBe(B.WATER);
  });
});

describe('simulation gating', () => {
  it('does nothing in chunks that are not lit yet', () => {
    const w = classicWorld(32, 32, 32, (_x, y) => (y <= 4 ? B.STONE : B.AIR), 7);
    const t = new Ticker(w);
    w.setBlock(10, 15, 10, B.SAND);
    run(t, 40);
    expect(w.get(10, 15, 10)).toBe(B.SAND); // still hanging: not loaded yet
    lightWorld(w);
    run(t, 80);
    expect(w.get(10, 5, 10)).toBe(B.SAND);
  });
});

describe('plants and grass', () => {
  it('grows a sapling into a tree', () => {
    const { w, t } = setup();
    w.setBlock(16, 4, 16, B.GRASS);
    w.setBlock(16, 5, 16, B.SAPLING);
    run(t, 20 * 60);
    expect(w.get(16, 5, 16)).toBe(B.LOG);
    expect(count(w, B.LEAVES)).toBeGreaterThan(10);
  });

  it('kills grass that gets covered', () => {
    const { w, t } = setup();
    w.setBlock(10, 4, 10, B.GRASS);
    w.setBlock(10, 5, 10, B.STONE);
    run(t, 200);
    expect(w.get(10, 4, 10)).toBe(B.DIRT);
  });

  it('spreads grass onto lit dirt but not onto covered dirt', () => {
    const { w, t } = setup();
    w.setBlock(10, 4, 10, B.GRASS);
    w.setBlock(11, 4, 10, B.DIRT);
    w.setBlock(9, 4, 10, B.DIRT);
    w.setBlock(9, 5, 10, B.STONE);
    run(t, 20 * 30);
    expect(w.get(11, 4, 10)).toBe(B.GRASS);
    expect(w.get(9, 4, 10)).toBe(B.DIRT);
  });
});
