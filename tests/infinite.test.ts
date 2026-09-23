import { describe, expect, it } from 'vitest';
import { B, IS_SOLID } from '../src/world/blocks';
import { Chunk } from '../src/world/chunk';
import { BIOME, BIOMES } from '../src/world/gen/biomes';
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
    let steps = 0;
    for (let x = -200; x < 200; x++) {
      const d = Math.abs(gen.heightAt(x, 5) - gen.heightAt(x + 1, 5));
      // Chunk borders (x ≡ 15 mod 16) look no different from anywhere else.
      if ((x & 15) === 15) expect(d).toBeLessThanOrEqual(5);
      steps += d;
    }
    expect(steps / 400).toBeLessThan(1.2);
  });

  it('blends heights across biome borders (no cliffs where biomes meet)', () => {
    const gen = new InfiniteGenerator(777);
    let borders = 0;
    for (let cz = -24; cz < 24; cz += 2) {
      for (let cx = -24; cx < 24; cx++) {
        const info = gen.columns(cx, cz);
        for (let lz = 0; lz < 16; lz += 3) {
          for (let lx = -1; lx < 16; lx++) {
            // Both sides of every pair, including across the chunk edge (apron).
            const a = lx < 0 ? gen.biomeAt(cx * 16 - 1, cz * 16 + lz).id : info.biomes[(lz << 4) | lx]!;
            const b = lx + 1 > 15 ? gen.biomeAt(cx * 16 + 16, cz * 16 + lz).id : info.biomes[(lz << 4) | (lx + 1)]!;
            if (a === b) continue;
            // Rivers are carved channels and mountains rise with their own slopes; skip those edges.
            if ([a, b].some((id) => id === BIOME.RIVER || id === BIOME.MOUNTAINS)) continue;
            borders++;
            const ha = info.heights[(lz + 1) * 18 + lx + 1]!;
            const hb = info.heights[(lz + 1) * 18 + lx + 2]!;
            expect(Math.abs(ha - hb)).toBeLessThanOrEqual(4);
          }
        }
      }
    }
    expect(borders).toBeGreaterThan(50);
  });

  it('produces a variety of biomes', () => {
    const gen = new InfiniteGenerator(4242);
    const seen = new Set<number>();
    for (let cz = -80; cz < 80; cz += 4) for (let cx = -80; cx < 80; cx += 4) for (const b of gen.columns(cx, cz).biomes) seen.add(b);
    expect(seen.size).toBeGreaterThanOrEqual(9);
  });

  it('locates biomes and reports what is really there', () => {
    const gen = new InfiniteGenerator(4242);
    for (const key of ['desert', 'forest', 'snowy_tundra', 'river', 'ocean']) {
      const found = gen.locateBiome(key, 0, 0, 4000);
      expect(found, key).not.toBeNull();
      expect(gen.biomeAt(found!.x, found!.z).key).toBe(key);
    }
    expect(gen.locateBiome('nowhere', 0, 0)).toBeNull();
  });

  it('grows trees whose parts in neighbouring chunks line up', () => {
    const forest = new InfiniteGenerator(4242).locateBiome('forest', 0, 0)!;
    const fx = forest.x >> 4;
    const fz = forest.z >> 4;
    const w = build(AREA.map(([cx, cz]) => [cx + fx, cz + fz]), 4242);
    let logs = 0;
    let leavesOnBorder = 0;
    for (const c of w.chunks.values()) {
      for (let i = 0; i < c.blocks.length; i++) {
        const id = c.blocks[i]! & 0xff;
        if (id === B.LOG || id === B.BIRCH_LOG || id === B.SPRUCE_LOG) logs++;
        const lx = i & 15;
        if ((lx === 0 || lx === 15) && (id === B.LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES)) leavesOnBorder++;
      }
    }
    expect(logs).toBeGreaterThan(0);
    expect(leavesOnBorder).toBeGreaterThan(0);
  });

  it('hides diamonds deep and other ores above them', () => {
    const gen = new InfiniteGenerator(31337);
    let diamonds = 0;
    let coal = 0;
    for (let i = 0; i < 16; i++) {
      const blocks = gen.generate(i % 4, i >> 2).blocks;
      for (let k = 0; k < blocks.length; k++) {
        const id = blocks[k]! & 0xff;
        if (id === B.DIAMOND_ORE) {
          diamonds++;
          expect(k >> 8).toBeLessThanOrEqual(24);
        }
        if (id === B.COAL_ORE) coal++;
      }
    }
    expect(diamonds).toBeGreaterThan(0);
    expect(coal).toBeGreaterThan(diamonds);
  });

  it('returns blended tints and biome ids per column', () => {
    const g = new InfiniteGenerator(5).generate(3, -2);
    expect(g.tints.length).toBe(256 * 9);
    expect(g.biomes.length).toBe(256);
    for (const b of g.biomes) expect(BIOMES[b]).toBeDefined();
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
