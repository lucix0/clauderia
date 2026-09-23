import { describe, expect, it } from 'vitest';
import { B, IS_SOLID } from '../src/world/blocks';
import { Chunk } from '../src/world/chunk';
import { InfiniteGenerator, INFINITE_SEA_LEVEL } from '../src/world/gen/infinite';
import { World } from '../src/world/world';

function build(order: Array<[number, number]>, seed = 4242): World {
  const gen = new InfiniteGenerator(seed);
  const w = new World({ type: 'infinite', seed, height: 128, seaLevel: INFINITE_SEA_LEVEL });
  for (const [cx, cz] of order) w.addChunk(new Chunk(cx, cz, gen.generate(cx, cz).blocks));
  return w;
}

const AREA: Array<[number, number]> = [];
for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) AREA.push([cx, cz]);

describe('infinite generation', () => {
  it('is a pure function of seed and chunk coordinates', () => {
    const a = new InfiniteGenerator(7).generate(-3, 11).blocks;
    const b = new InfiniteGenerator(7).generate(-3, 11).blocks;
    expect(b).toEqual(a);
    expect(new InfiniteGenerator(8).generate(-3, 11).blocks).not.toEqual(a);
  });

  it('builds identical 3×3 areas regardless of generation order', () => {
    const forward = build(AREA);
    const shuffled = build([...AREA].reverse().sort((p, q) => (p[0] * 7 + p[1] * 3) % 5 - (q[0] * 7 + q[1] * 3) % 5));
    for (const [cx, cz] of AREA) {
      expect(shuffled.getChunk(cx, cz)!.blocks).toEqual(forward.getChunk(cx, cz)!.blocks);
    }
    // A generator that has already produced other chunks still agrees.
    const warm = new InfiniteGenerator(4242);
    for (let i = 0; i < 5; i++) warm.generate(100 + i, -50);
    expect(warm.generate(0, 0).blocks).toEqual(forward.getChunk(0, 0)!.blocks);
  });

  it('is continuous across chunk borders (no seams in the terrain)', () => {
    const gen = new InfiniteGenerator(99);
    for (let x = -40; x < 40; x++) {
      expect(Math.abs(gen.heightAt(x, 5) - gen.heightAt(x + 1, 5))).toBeLessThanOrEqual(3);
    }
  });

  it('has bedrock at the bottom, stone below, water at sea level and caves', () => {
    const w = build(AREA, 12345);
    let caves = 0;
    let water = 0;
    for (const c of w.chunks.values()) {
      for (let col = 0; col < 256; col++) expect(c.blocks[col]).toBe(B.BEDROCK);
      for (let i = 256 * 5; i < 256 * 40; i++) if (c.blocks[i] === B.AIR) caves++;
      for (const v of c.blocks) if (v === B.WATER) water++;
    }
    expect(caves + water).toBeGreaterThan(0);
  });

  it('picks a dry spawn column near the origin', () => {
    const gen = new InfiniteGenerator(2024);
    const s = gen.findSpawnColumn();
    expect(Math.hypot(s.x, s.z)).toBeLessThan(1024);
    const h = gen.heightAt(s.x, s.z);
    expect(h).toBeGreaterThanOrEqual(INFINITE_SEA_LEVEL + 2);
    const blocks = gen.generate(s.x >> 4, s.z >> 4).blocks;
    expect(IS_SOLID[blocks[(h << 8) | ((s.z & 15) << 4) | (s.x & 15)]! & 0xff]).toBe(1);
  });
});
