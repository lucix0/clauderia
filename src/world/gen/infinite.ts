/**
 * Infinite-world generator. A pure function of (seed, cx, cz): the result
 * never depends on which chunks were generated before or in what order.
 */
import { GradientNoise, OctaveNoise } from '../../util/noise';
import { deriveSeed, Rng } from '../../util/prng';
import { B } from '../blocks';
import { CHUNK_HEIGHT, CHUNK_VOLUME } from '../coords';

export const INFINITE_HEIGHT = CHUNK_HEIGHT;
export const INFINITE_SEA_LEVEL = 62;

/** Deterministic 32-bit hash of integer coordinates and a seed. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface GeneratedChunk {
  blocks: Uint16Array;
}

/** Noise fields shared by every chunk of one seed (cheap to build, cache per seed). */
export class InfiniteGenerator {
  readonly seaLevel = INFINITE_SEA_LEVEL;
  private readonly continental: OctaveNoise;
  private readonly hills: OctaveNoise;
  private readonly detail: GradientNoise;
  private readonly tunnelA: GradientNoise;
  private readonly tunnelB: GradientNoise;
  private readonly cavern: GradientNoise;
  private readonly soil: GradientNoise;

  constructor(readonly seed: number) {
    const rng = (salt: number): Rng => new Rng(deriveSeed(seed, salt));
    this.continental = new OctaveNoise(rng(101), 5);
    this.hills = new OctaveNoise(rng(102), 4);
    this.detail = new GradientNoise(rng(103));
    this.tunnelA = new GradientNoise(rng(104));
    this.tunnelB = new GradientNoise(rng(105));
    this.cavern = new GradientNoise(rng(106));
    this.soil = new GradientNoise(rng(107));
  }

  /** Terrain surface height (y of the top solid block) at a column. */
  heightAt(x: number, z: number): number {
    // OctaveNoise sums octaves with doubling amplitude; normalise to ~[-1, 1].
    const c = this.continental.sample(x / 12, z / 12) / 31;
    const h = this.hills.sample(x / 6, z / 6) / 15;
    const d = this.detail.sample(x / 24, z / 24);
    let height = this.seaLevel + 2 + c * 22 + Math.max(0, c) * h * 26 + d * 3;
    height = Math.max(8, Math.min(INFINITE_HEIGHT - 12, height));
    return Math.round(height);
  }

  /** Cave carving density: true where the cell is hollow. */
  private carvedGrid(cx: number, cz: number): Float32Array {
    // Sample noise every 4 blocks and interpolate: 5 × 33 × 5 lattice.
    const grid = new Float32Array(5 * 33 * 5);
    for (let gy = 0; gy < 33; gy++) {
      for (let gz = 0; gz < 5; gz++) {
        for (let gx = 0; gx < 5; gx++) {
          const x = cx * 16 + gx * 4;
          const y = gy * 4;
          const z = cz * 16 + gz * 4;
          const a = this.tunnelA.sample3(x / 48, y / 32, z / 48);
          const b = this.tunnelB.sample3(x / 48, y / 32, z / 48);
          // Tunnels where two noise fields are both near zero ("spaghetti").
          const tunnel = 0.085 - Math.hypot(a, b);
          // Rare larger caverns from low-frequency noise, flattened vertically.
          const cav = this.cavern.sample3(x / 90, y / 36, z / 90) - 0.42;
          grid[(gy * 5 + gz) * 5 + gx] = Math.max(tunnel, cav * 0.6);
        }
      }
    }
    return grid;
  }

  generate(cx: number, cz: number): GeneratedChunk {
    const blocks = new Uint16Array(CHUNK_VOLUME);
    const heights = new Int16Array(256);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) heights[(lz << 4) | lx] = this.heightAt(cx * 16 + lx, cz * 16 + lz);
    }
    const grid = this.carvedGrid(cx, cz);
    const sea = this.seaLevel;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const col = (lz << 4) | lx;
        const x = cx * 16 + lx;
        const z = cz * 16 + lz;
        const h = heights[col]!;
        const soilDepth = 3 + Math.floor((this.soil.sample(x / 8, z / 8) + 1) * 1.5);
        const beach = h <= sea + 1 && h >= sea - 3;
        const under = h < sea;
        const gx = lx >> 2;
        const tx = (lx & 3) / 4;
        const gz = lz >> 2;
        const tz = (lz & 3) / 4;
        for (let y = 0; y < INFINITE_HEIGHT; y++) {
          let id: number = B.AIR;
          if (y === 0 || (y < 4 && hash3(this.seed, x, y, z) % 4 < 4 - y)) {
            id = B.BEDROCK;
          } else if (y <= h) {
            if (y === h) id = under ? (beach ? B.SAND : B.GRAVEL) : beach ? B.SAND : B.GRASS;
            else if (y > h - soilDepth) id = beach || under ? B.SAND : B.DIRT;
            else id = B.STONE;
            // Carve caves, but keep a lid under water so the sea stays put.
            const lid = under ? 6 : 1;
            if (y > 4 && y < h - lid + 1 && id !== B.BEDROCK) {
              const gy = y >> 2;
              const ty = (y & 3) / 4;
              const v = trilinear(grid, gx, gy, gz, tx, ty, tz);
              if (v > 0) id = y < 11 ? B.LAVA : B.AIR;
            }
          } else if (y < sea) {
            id = B.WATER;
          }
          blocks[(y << 8) | col] = id;
        }
      }
    }
    return { blocks };
  }

  /** A dry-land column near the origin for the world spawn (x, z). */
  findSpawnColumn(): { x: number; z: number } {
    for (let r = 0; r < 4096; r += 8) {
      const steps = Math.max(1, Math.floor((2 * Math.PI * r) / 8));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r);
        const z = Math.round(Math.sin(a) * r);
        const h = this.heightAt(x, z);
        if (h >= this.seaLevel + 2 && h < this.seaLevel + 30) return { x, z };
      }
    }
    return { x: 0, z: 0 };
  }
}

function trilinear(g: Float32Array, gx: number, gy: number, gz: number, tx: number, ty: number, tz: number): number {
  const at = (x: number, y: number, z: number): number => g[(y * 5 + z) * 5 + x]!;
  const c00 = at(gx, gy, gz) + (at(gx + 1, gy, gz) - at(gx, gy, gz)) * tx;
  const c10 = at(gx, gy + 1, gz) + (at(gx + 1, gy + 1, gz) - at(gx, gy + 1, gz)) * tx;
  const c01 = at(gx, gy, gz + 1) + (at(gx + 1, gy, gz + 1) - at(gx, gy, gz + 1)) * tx;
  const c11 = at(gx, gy + 1, gz + 1) + (at(gx + 1, gy + 1, gz + 1) - at(gx, gy + 1, gz + 1)) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

const cache = new Map<number, InfiniteGenerator>();

/** Shared generator per seed. */
export function infiniteGenerator(seed: number): InfiniteGenerator {
  let g = cache.get(seed);
  if (!g) {
    g = new InfiniteGenerator(seed);
    cache.set(seed, g);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return g;
}
