/**
 * Infinite-world generator. A pure function of (seed, cx, cz): the result
 * never depends on which chunks were generated before or in what order.
 *
 * Climate (continentalness, temperature, humidity, mountainness, rivers) is
 * sampled on a world-aligned 4-block lattice. Heights come from continuous
 * fields plus per-biome character blended over a 33-block kernel, so biome
 * borders never make cliffs. Features that cross chunk borders (trees, ore
 * veins) are seeded per chunk and drawn by every chunk they touch.
 */
import { Fbm, GradientNoise } from '../../util/noise';
import { deriveSeed, Rng } from '../../util/prng';
import { B, IS_LIQUID, IS_SOLID, REPLACEABLE, supportsPlant } from '../blocks';
import { CHUNK_HEIGHT, CHUNK_VOLUME, chunkKey, toChunk, toLocal } from '../coords';
import { BIOME, BIOMES, biomeByName, type BiomeDef, type TreeKind } from './biomes';

export const INFINITE_HEIGHT = CHUNK_HEIGHT;
export const INFINITE_SEA_LEVEL = 62;

/** Deterministic 32-bit hash of integer coordinates and a seed. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function unit(h: number): number {
  return h / 4294967296;
}

export interface GeneratedChunk {
  blocks: Uint16Array;
  /** Grass, foliage and water rgb per column (see Chunk.tints). */
  tints: Uint8Array;
  /** Biome id per column. */
  biomes: Uint8Array;
}

/** Surface data of one chunk (pure, cached). */
export interface ColumnInfo {
  /** Surface heights of an 18×18 region (one-column apron): index (z + 1) * 18 + x + 1. */
  readonly heights: Int16Array;
  /** 16×16 biome ids. */
  readonly biomes: Uint8Array;
  /** 16×16×9 tint bytes. */
  readonly tints: Uint8Array;
  /** 16×16: 1 where the ground is snowy and water freezes. */
  readonly cold: Uint8Array;
}

// ---- Lattice geometry ----

/** Lattice spacing in blocks. */
const CELL = 4;
/** Blend radius in lattice cells (16 blocks). */
const KERNEL = 4;
/** Lattice nodes spanning the 18-column region: node −1 … 5 (world x = cx·16 + n·4). */
const NB = 7;
const NB_FIRST = -1;
/** Climate nodes: region nodes plus the kernel radius on each side. */
const NC = NB + 2 * KERNEL;
const NC_FIRST = NB_FIRST - KERNEL;
const REGION = 18;

const CLIMATE_FIELDS = 6; // c, t, h, e, r, m
const PARAMS = 12; // offset, vary, flatten, 9 tint channels

const KERNEL_WEIGHTS = (() => {
  const w = new Float32Array((2 * KERNEL + 1) ** 2);
  const r2 = (KERNEL + 1) ** 2;
  for (let j = -KERNEL; j <= KERNEL; j++) {
    for (let i = -KERNEL; i <= KERNEL; i++) {
      const f = Math.max(0, 1 - (i * i + j * j) / r2);
      w[(j + KERNEL) * (2 * KERNEL + 1) + i + KERNEL] = f * f;
    }
  }
  return w;
})();

/** Biome parameters as flat numbers for blending. */
const BIOME_PARAMS = (() => {
  const p = new Float32Array(BIOMES.length * PARAMS);
  for (const b of BIOMES) {
    const o = b.id * PARAMS;
    p[o] = b.offset;
    p[o + 1] = b.vary;
    p[o + 2] = b.flatten;
    [b.grass, b.foliage, b.water].forEach((c, k) => {
      p[o + 3 + k * 3] = (c >> 16) & 255;
      p[o + 4 + k * 3] = (c >> 8) & 255;
      p[o + 5 + k * 3] = c & 255;
    });
  }
  return p;
})();

// ---- Climate thresholds ----

const OCEAN_C = -0.06;
const DEEP_C = -0.2;
/** Spread of a 3–4 octave Fbm, used to map it to a roughly uniform 0–1. */
const FBM_SD = 0.165;

function uniform(v: number): number {
  return 1 / (1 + Math.exp((-1.702 * v) / FBM_SD));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Continental base height (relative to sea level) from continentalness. */
const BASE_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, -26],
  [-0.3, -24],
  [-0.18, -16],
  [OCEAN_C, -4],
  [0, 1],
  [0.3, 7],
  [0.6, 10],
];

function baseHeight(c: number): number {
  const k = BASE_KNOTS;
  if (c <= k[0]![0]) return k[0]![1];
  for (let i = 1; i < k.length; i++) {
    const [c1, h1] = k[i]!;
    if (c <= c1) {
      const [c0, h0] = k[i - 1]!;
      return h0 + ((c - c0) / (c1 - c0)) * (h1 - h0);
    }
  }
  return k[k.length - 1]![1];
}

function mountainFactor(e: number, c: number): number {
  return smoothstep(0.7, 0.9, e) * smoothstep(-0.02, 0.1, c);
}

/** Land biome from climate (t, h uniform 0–1; m mountain factor). */
function landBiome(t: number, h: number, m: number): number {
  if (m > 0.45) return BIOME.MOUNTAINS;
  if (t < 0.16) return BIOME.TUNDRA;
  if (t < 0.34) return BIOME.TAIGA;
  if (t < 0.7) return h > 0.76 ? BIOME.SWAMP : h > 0.42 ? BIOME.FOREST : BIOME.PLAINS;
  return h < 0.55 ? BIOME.DESERT : h > 0.85 ? BIOME.FOREST : BIOME.PLAINS;
}

function nodeBiome(c: number, t: number, h: number, m: number): number {
  if (c < DEEP_C) return BIOME.DEEP_OCEAN;
  if (c < OCEAN_C) return BIOME.OCEAN;
  return landBiome(t, h, m);
}

// ---- River shape ----

const RIVER_CHANNEL = 0.012;
const RIVER_VALLEY = 0.06;

// ---- Mountain surface ----

const STONE_LINE = INFINITE_SEA_LEVEL + 26;
const SNOW_LINE = INFINITE_SEA_LEVEL + 34;
const PEAK_LINE = INFINITE_SEA_LEVEL + 46;

// ---- Caves ----

const CAVE_NODES_Y = CHUNK_HEIGHT / CELL + 1;
const LAVA_LEVEL = 10;

// ---- Ore veins: block, veins per chunk, min size, extra size, min y, max y ----

const VEINS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [B.DIRT, 4, 10, 10, 30, 110],
  [B.GRAVEL, 4, 10, 10, 5, 100],
  [B.COAL_ORE, 16, 6, 9, 5, 110],
  [B.IRON_ORE, 10, 4, 5, 5, 64],
  [B.GOLD_ORE, 2, 4, 4, 5, 32],
  [B.DIAMOND_ORE, 1, 3, 4, 5, 16],
];
/** Veins never reach further than this from where they start. */
const VEIN_REACH = 7;

const TREE_CANDIDATES = 16;
const SALT_TREES = 0x7ee5;
const SALT_ORES = 0x04e5;
const SALT_DECO = 0xdec0;

/** Noise fields shared by every chunk of one seed (cheap to build, cache per seed). */
export class InfiniteGenerator {
  readonly seaLevel = INFINITE_SEA_LEVEL;
  private readonly continent: Fbm;
  private readonly temperature: Fbm;
  private readonly humidity: Fbm;
  private readonly erosion: Fbm;
  private readonly river: Fbm;
  private readonly hills: Fbm;
  private readonly detail: Fbm;
  private readonly ridges: Fbm;
  private readonly jitter: GradientNoise;
  private readonly floor: Fbm;
  private readonly clay: Fbm;
  private readonly tunnelA: GradientNoise;
  private readonly tunnelB: GradientNoise;
  private readonly cavern: GradientNoise;
  private readonly infos = new Map<number, ColumnInfo>();
  /** Climate of 4×4 lattice nodes per chunk-sized block, shared by neighbouring chunks. */
  private readonly nodeBlocks = new Map<number, Float32Array>();
  private readonly veins = new Map<number, Int32Array>();
  private readonly climateBuf = new Float32Array(NC * NC * CLIMATE_FIELDS);
  private readonly nodeBiomes = new Uint8Array(NC * NC);
  private readonly blended = new Float32Array(NB * NB * PARAMS);

  constructor(readonly seed: number) {
    const rng = (salt: number): Rng => new Rng(deriveSeed(seed, salt));
    this.continent = new Fbm(rng(201), 4, 1100);
    this.temperature = new Fbm(rng(202), 3, 800);
    this.humidity = new Fbm(rng(203), 3, 650);
    this.erosion = new Fbm(rng(204), 3, 600);
    this.river = new Fbm(rng(205), 3, 650);
    this.hills = new Fbm(rng(206), 4, 110);
    this.detail = new Fbm(rng(207), 2, 22);
    this.ridges = new Fbm(rng(208), 4, 200);
    this.jitter = new GradientNoise(rng(209));
    this.floor = new Fbm(rng(210), 2, 24);
    this.clay = new Fbm(rng(211), 2, 18);
    this.tunnelA = new GradientNoise(rng(104));
    this.tunnelB = new GradientNoise(rng(105));
    this.cavern = new GradientNoise(rng(106));
  }

  // ---- Climate ----

  /** Climate at a world position into out[o..o+5]: c, t, h, e, r, m. */
  private climate(x: number, z: number, out: Float32Array, o: number): void {
    const c = this.continent.sample(x, z) + 0.1;
    const e = uniform(this.erosion.sample(x, z));
    out[o] = c;
    out[o + 1] = uniform(this.temperature.sample(x, z));
    out[o + 2] = uniform(this.humidity.sample(x, z));
    out[o + 3] = e;
    out[o + 4] = this.river.sample(x, z);
    out[o + 5] = mountainFactor(e, c);
  }

  /** Surface data for a chunk (heights with apron, biomes, tints). Cached. */
  columns(cx: number, cz: number): ColumnInfo {
    const key = chunkKey(cx, cz);
    const hit = this.infos.get(key);
    if (hit) {
      // Refresh LRU position.
      this.infos.delete(key);
      this.infos.set(key, hit);
      return hit;
    }
    const info = this.computeColumns(cx, cz);
    this.infos.set(key, info);
    if (this.infos.size > 1024) this.infos.delete(this.infos.keys().next().value!);
    return info;
  }

  /** Climate (+ node biome) of the 4×4 lattice nodes whose block is (bx, bz). */
  private nodeBlock(bx: number, bz: number): Float32Array {
    const key = chunkKey(bx, bz);
    let block = this.nodeBlocks.get(key);
    if (block) return block;
    block = new Float32Array(16 * (CLIMATE_FIELDS + 1));
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const o = (j * 4 + i) * (CLIMATE_FIELDS + 1);
        this.climate((bx * 4 + i) * CELL, (bz * 4 + j) * CELL, block, o);
        block[o + CLIMATE_FIELDS] = nodeBiome(block[o]!, block[o + 1]!, block[o + 2]!, block[o + 5]!);
      }
    }
    this.nodeBlocks.set(key, block);
    if (this.nodeBlocks.size > 4096) this.nodeBlocks.delete(this.nodeBlocks.keys().next().value!);
    return block;
  }

  private computeColumns(cx: number, cz: number): ColumnInfo {
    const clim = this.climateBuf;
    const nodes = this.nodeBiomes;
    const ox = cx * 16;
    const oz = cz * 16;
    for (let j = 0; j < NC; j++) {
      const nz = cz * 4 + NC_FIRST + j;
      for (let i = 0; i < NC; i++) {
        const nx = cx * 4 + NC_FIRST + i;
        const block = this.nodeBlock(nx >> 2, nz >> 2);
        const src = ((nz & 3) * 4 + (nx & 3)) * (CLIMATE_FIELDS + 1);
        const n = j * NC + i;
        for (let f = 0; f < CLIMATE_FIELDS; f++) clim[n * CLIMATE_FIELDS + f] = block[src + f]!;
        nodes[n] = block[src + CLIMATE_FIELDS]!;
      }
    }
    // Blend biome parameters over the kernel for each region node.
    const blended = this.blended;
    blended.fill(0);
    const kw = 2 * KERNEL + 1;
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NB; i++) {
        const dst = (j * NB + i) * PARAMS;
        let total = 0;
        for (let kj = 0; kj < kw; kj++) {
          for (let ki = 0; ki < kw; ki++) {
            const w = KERNEL_WEIGHTS[kj * kw + ki]!;
            if (w === 0) continue;
            const b = nodes[(j + kj) * NC + i + ki]!;
            const src = b * PARAMS;
            for (let p = 0; p < PARAMS; p++) blended[dst + p] += BIOME_PARAMS[src + p]! * w;
            total += w;
          }
        }
        for (let p = 0; p < PARAMS; p++) blended[dst + p] /= total;
      }
    }

    const heights = new Int16Array(REGION * REGION);
    const biomes = new Uint8Array(256);
    const tints = new Uint8Array(256 * 9);
    const cold = new Uint8Array(256);
    const cl = new Float32Array(CLIMATE_FIELDS);
    const pr = new Float32Array(PARAMS);
    for (let rz = 0; rz < REGION; rz++) {
      const lz = rz - 1;
      const gz = Math.floor(lz / CELL);
      const tz = (lz - gz * CELL) / CELL;
      for (let rx = 0; rx < REGION; rx++) {
        const lx = rx - 1;
        const gx = Math.floor(lx / CELL);
        const tx = (lx - gx * CELL) / CELL;
        // Bilinear climate from the four surrounding nodes.
        const ci = gx - NC_FIRST;
        const cj = gz - NC_FIRST;
        for (let f = 0; f < CLIMATE_FIELDS; f++) {
          const a = clim[(cj * NC + ci) * CLIMATE_FIELDS + f]!;
          const b = clim[(cj * NC + ci + 1) * CLIMATE_FIELDS + f]!;
          const c = clim[((cj + 1) * NC + ci) * CLIMATE_FIELDS + f]!;
          const d = clim[((cj + 1) * NC + ci + 1) * CLIMATE_FIELDS + f]!;
          cl[f] = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
        }
        const bi = gx - NB_FIRST;
        const bj = gz - NB_FIRST;
        for (let p = 0; p < PARAMS; p++) {
          const a = blended[(bj * NB + bi) * PARAMS + p]!;
          const b = blended[(bj * NB + bi + 1) * PARAMS + p]!;
          const c = blended[((bj + 1) * NB + bi) * PARAMS + p]!;
          const d = blended[((bj + 1) * NB + bi + 1) * PARAMS + p]!;
          pr[p] = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
        }
        const x = ox + lx;
        const z = oz + lz;
        const col = this.column(x, z, cl, pr);
        heights[rz * REGION + rx] = col.h;
        if (lx < 0 || lz < 0 || lx > 15 || lz > 15) continue;
        const k = (lz << 4) | lx;
        const t = cl[1]! + this.jitter.sample3(x / 5, z / 5, 3.3) * 0.02;
        const hum = cl[2]! + this.jitter.sample3(x / 5, z / 5, 7.7) * 0.02;
        const biome = this.classify(col.h, cl[0]!, t, hum, cl[5]!, col.channel);
        biomes[k] = biome;
        cold[k] =
          biome === BIOME.TUNDRA ||
          (t < 0.16 && (biome === BIOME.RIVER || biome === BIOME.OCEAN || biome === BIOME.BEACH)) ||
          (biome === BIOME.MOUNTAINS && col.h >= SNOW_LINE)
            ? 1
            : 0;
        for (let q = 0; q < 9; q++) tints[k * 9 + q] = Math.round(pr[3 + q]!);
      }
    }
    return { heights, biomes, tints, cold };
  }

  /** Surface height of one column from interpolated climate `cl` and blended params `pr`. */
  private column(x: number, z: number, cl: Float32Array, pr: Float32Array): { h: number; channel: number } {
    const sea = this.seaLevel;
    const c = cl[0]!;
    const m = cl[5]!;
    const hill = this.hills.sample(x, z);
    const detail = this.detail.sample(x, z);
    let h = sea + baseHeight(c) + pr[0]! + pr[1]! * hill * 2 + detail * 2;
    if (m > 0) {
      const r = Math.max(0, Math.min(1, (this.ridges.ridged(x, z) - 0.35) / 0.6));
      h += m * (12 + 50 * r * Math.sqrt(r) + detail * 4);
    }
    const flatten = pr[2]!;
    if (flatten > 0) h += (sea - 2 + detail * 3.5 - h) * flatten;
    // Rivers: a valley that eases the land down, then a channel below sea level.
    const land = smoothstep(OCEAN_C - 0.1, OCEAN_C + 0.04, c) * (1 - smoothstep(0.3, 0.7, m));
    let channel = 0;
    if (land > 0) {
      const rv = Math.abs(cl[4]!);
      if (rv < RIVER_VALLEY) {
        const valley = (1 - smoothstep(RIVER_CHANNEL, RIVER_VALLEY, rv)) * land;
        const bank = sea + 1 + (rv / RIVER_VALLEY) * 4;
        if (h > bank) h += (bank - h) * valley;
        channel = (1 - smoothstep(RIVER_CHANNEL * 0.4, RIVER_CHANNEL, rv)) * land;
        const bed = sea - 3;
        if (h > bed) h += (bed - h) * channel;
      }
    }
    if (h > 108) h = 108 + (h - 108) * 0.45;
    return { h: Math.max(6, Math.min(INFINITE_HEIGHT - 8, Math.round(h))), channel };
  }

  private classify(h: number, c: number, t: number, hum: number, m: number, channel: number): number {
    const sea = this.seaLevel;
    if (channel > 0.5 && h < sea) return BIOME.RIVER;
    if (c < OCEAN_C + 0.02 && h < sea - 1) return c < DEEP_C ? BIOME.DEEP_OCEAN : BIOME.OCEAN;
    const land = landBiome(t, hum, m);
    if (c < 0.02 && h >= sea - 1 && h <= sea + 1 && land !== BIOME.SWAMP && land !== BIOME.MOUNTAINS) return BIOME.BEACH;
    return land;
  }

  // ---- Public queries ----

  /** Terrain surface height (y of the top terrain block) at a column. */
  heightAt(x: number, z: number): number {
    const info = this.columns(toChunk(x), toChunk(z));
    return info.heights[(toLocal(z) + 1) * REGION + toLocal(x) + 1]!;
  }

  biomeAt(x: number, z: number): BiomeDef {
    const info = this.columns(toChunk(x), toChunk(z));
    return BIOMES[info.biomes[(toLocal(z) << 4) | toLocal(x)]!]!;
  }

  // ---- Caves ----

  /** Cave density at a lattice node (> 0 is hollow). */
  private caveNode(x: number, y: number, z: number): number {
    const a = this.tunnelA.sample3(x / 48, y / 32, z / 48);
    const b = this.tunnelB.sample3(x / 48, y / 32, z / 48);
    // Tunnels where two noise fields are both near zero ("spaghetti").
    const tunnel = 0.085 - Math.hypot(a, b);
    // Rare larger caverns from low-frequency noise, flattened vertically.
    const cav = this.cavern.sample3(x / 90, y / 36, z / 90) - 0.42;
    // Float32 so caveAt() and the chunk grid agree exactly.
    return Math.fround(Math.max(tunnel, cav * 0.6));
  }

  private caveGrid(cx: number, cz: number): Float32Array {
    const grid = new Float32Array(5 * CAVE_NODES_Y * 5);
    for (let gy = 0; gy < CAVE_NODES_Y; gy++) {
      for (let gz = 0; gz < 5; gz++) {
        for (let gx = 0; gx < 5; gx++) {
          grid[(gy * 5 + gz) * 5 + gx] = this.caveNode(cx * 16 + gx * CELL, gy * CELL, cz * 16 + gz * CELL);
        }
      }
    }
    return grid;
  }

  /** Cave density at any cell, identical to what the chunk's grid gives. */
  caveAt(x: number, y: number, z: number): number {
    const x0 = Math.floor(x / CELL) * CELL;
    const y0 = Math.floor(y / CELL) * CELL;
    const z0 = Math.floor(z / CELL) * CELL;
    const tx = (x - x0) / CELL;
    const ty = (y - y0) / CELL;
    const tz = (z - z0) / CELL;
    const n = (i: number, j: number, k: number): number => this.caveNode(x0 + i * CELL, y0 + j * CELL, z0 + k * CELL);
    const c00 = n(0, 0, 0) + (n(1, 0, 0) - n(0, 0, 0)) * tx;
    const c10 = n(0, 1, 0) + (n(1, 1, 0) - n(0, 1, 0)) * tx;
    const c01 = n(0, 0, 1) + (n(1, 0, 1) - n(0, 0, 1)) * tx;
    const c11 = n(0, 1, 1) + (n(1, 1, 1) - n(0, 1, 1)) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  /** Is this surface cell cut away by a cave entrance? */
  private carvesSurface(cave: number, h: number): boolean {
    return cave > 0.05 && h >= this.seaLevel + 3;
  }

  // ---- Generation ----

  generate(cx: number, cz: number): GeneratedChunk {
    const blocks = new Uint16Array(CHUNK_VOLUME);
    const info = this.columns(cx, cz);
    const grid = this.caveGrid(cx, cz);
    const hollow = hollowCells(grid);
    const sea = this.seaLevel;
    const seed = this.seed;
    const H = info.heights;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const k = (lz << 4) | lx;
        const x = cx * 16 + lx;
        const z = cz * 16 + lz;
        const r = (lz + 1) * REGION + lx + 1;
        const h = H[r]!;
        const biome = info.biomes[k]!;
        const cold = info.cold[k] === 1;
        const steep = Math.max(Math.abs(H[r + 1]! - H[r - 1]!), Math.abs(H[r + REGION]! - H[r - REGION]!)) >= 5;
        const soil = 3 + (hash3(seed, x, 7, z) & 1);
        const [top, filler, deep] = this.surface(biome, h, x, z, steep);
        const gx = lx >> 2;
        const tx = (lx & 3) / 4;
        const gz = lz >> 2;
        const tz = (lz & 3) / 4;
        const lid = h < sea ? 6 : 1;
        // Everything above the ground and the sea stays air (the array starts zeroed).
        const last = Math.max(h, sea - 1);
        for (let y = 0; y <= last; y++) {
          let id: number = B.AIR;
          if (y === 0 || (y < 4 && hash3(seed, x, y, z) % 4 < 4 - y)) {
            id = B.BEDROCK;
          } else if (y <= h) {
            const depth = h - y;
            if (depth === 0) id = top;
            else if (depth <= soil) id = filler;
            else if (depth <= soil + deep.depth) id = deep.id;
            else id = B.STONE;
            if (y > 4 && hollow[((y >> 2) * 4 + gz) * 4 + gx]) {
              const v = trilinear(grid, gx, y >> 2, gz, tx, (y & 3) / 4, tz);
              if (v > 0 && (y <= h - lid || (lid === 1 && this.carvesSurface(v, h)))) {
                id = y <= LAVA_LEVEL ? B.LAVA : B.AIR;
              }
            }
          } else if (y < sea) {
            id = cold && y === sea - 1 ? B.ICE : B.WATER;
          }
          blocks[(y << 8) | k] = id;
        }
      }
    }
    this.placeOres(blocks, cx, cz);
    this.placeTrees(blocks, cx, cz);
    this.decorate(blocks, cx, cz, info);
    return { blocks, tints: info.tints.slice(), biomes: info.biomes.slice() };
  }

  /** Top block, filler (under the top) and deeper layer for a column. */
  private surface(
    biome: number,
    h: number,
    x: number,
    z: number,
    steep: boolean,
  ): [number, number, { id: number; depth: number }] {
    const sea = this.seaLevel;
    const none = { id: B.STONE, depth: 0 };
    switch (biome) {
      case BIOME.DESERT:
        return [B.SAND, B.SAND, { id: B.SANDSTONE, depth: 4 }];
      case BIOME.BEACH:
        return [B.SAND, B.SAND, { id: B.SANDSTONE, depth: 2 }];
      case BIOME.OCEAN:
      case BIOME.DEEP_OCEAN:
      case BIOME.RIVER: {
        const f = this.floor.sample(x, z);
        if (this.clay.sample(x, z) > 0.2 && biome !== BIOME.DEEP_OCEAN) return [B.CLAY, B.CLAY, none];
        const sandy = biome === BIOME.DEEP_OCEAN ? f > 0.12 : f > -0.1;
        return sandy ? [B.SAND, B.SAND, none] : [B.GRAVEL, B.GRAVEL, none];
      }
      case BIOME.MOUNTAINS: {
        const line = STONE_LINE + ((hash3(this.seed, x, 11, z) & 7) - 4);
        if (h >= PEAK_LINE) return [B.SNOW_BLOCK, B.STONE, none];
        if (h >= line || steep) return [B.STONE, B.STONE, none];
        break;
      }
      case BIOME.SWAMP:
        if (h < sea) return this.clay.sample(x, z) > 0.1 ? [B.CLAY, B.DIRT, none] : [B.DIRT, B.DIRT, none];
        break;
    }
    if (h < sea - 1) {
      // Lake beds in land biomes.
      return h >= sea - 3 ? [B.SAND, B.SAND, none] : [B.DIRT, B.DIRT, none];
    }
    if (h < sea + 1 && biome !== BIOME.TUNDRA && biome !== BIOME.SWAMP) return [B.SAND, B.SAND, none];
    return [B.GRASS, B.DIRT, none];
  }

  private placeOres(blocks: Uint16Array, cx: number, cz: number): void {
    const x0 = cx * 16;
    const z0 = cz * 16;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cells = this.veinCells(cx + dx, cz + dz);
        for (let i = 0; i < cells.length; i += 4) {
          const lx = cells[i]! - x0;
          const lz = cells[i + 2]! - z0;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          const k = (cells[i + 1]! << 8) | (lz << 4) | lx;
          if (blocks[k] === B.STONE) blocks[k] = cells[i + 3]!;
        }
      }
    }
  }

  /** Cells (x, y, z, id) of the ore veins that start in a chunk. Cached. */
  private veinCells(cx: number, cz: number): Int32Array {
    const key = chunkKey(cx, cz);
    const hit = this.veins.get(key);
    if (hit) return hit;
    const out: number[] = [];
    const add = (x: number, y: number, z: number, id: number): void => {
      if (y >= 1 && y < INFINITE_HEIGHT) out.push(x, y, z, id);
    };
    const rng = new Rng(hash3(this.seed ^ SALT_ORES, cx, 0, cz));
    for (const [id, veins, size, extra, minY, maxY] of VEINS) {
      for (let v = 0; v < veins; v++) {
        const sx = cx * 16 + rng.int(16);
        const sy = minY + rng.int(maxY - minY);
        const sz = cz * 16 + rng.int(16);
        const n = size + rng.int(extra + 1);
        let x = sx;
        let y = sy;
        let z = sz;
        for (let i = 0; i < n; i++) {
          const step = rng.nextU32();
          add(x, y, z, id);
          // Thicken the vein with one extra neighbour now and then.
          const thick = step % 6;
          if (thick < 3) add(x + (thick === 0 ? 1 : 0), y + (thick === 1 ? 1 : 0), z + (thick === 2 ? 1 : 0), id);
          const axis = (step >>> 8) % 3;
          const dir = (step >>> 16) & 1 ? 1 : -1;
          if (axis === 0) x = clampTo(x + dir, sx);
          else if (axis === 1) y = clampTo(y + dir, sy);
          else z = clampTo(z + dir, sz);
        }
      }
    }
    const cells = Int32Array.from(out);
    this.veins.set(key, cells);
    if (this.veins.size > 1024) this.veins.delete(this.veins.keys().next().value!);
    return cells;
  }

  private placeTrees(blocks: Uint16Array, cx: number, cz: number): void {
    const sea = this.seaLevel;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ncx = cx + dx;
        const ncz = cz + dz;
        const info = this.columns(ncx, ncz);
        const rng = new Rng(hash3(this.seed ^ SALT_TREES, ncx, 0, ncz));
        for (let k = 0; k < TREE_CANDIDATES; k++) {
          // Always draw the same numbers, whatever happens to the candidate.
          const lx = rng.int(16);
          const lz = rng.int(16);
          const roll = rng.next();
          const kindRoll = rng.next();
          const shape = rng.nextU32();
          const biome = BIOMES[info.biomes[(lz << 4) | lx]!]!;
          if (roll >= biome.trees) continue;
          const h = info.heights[(lz + 1) * REGION + lx + 1]!;
          const x = ncx * 16 + lx;
          const z = ncz * 16 + lz;
          const swamp = biome.id === BIOME.SWAMP;
          if (h < (swamp ? sea - 2 : sea)) continue;
          if (biome.id === BIOME.MOUNTAINS && h >= STONE_LINE - 4) continue;
          if (h + 12 >= INFINITE_HEIGHT) continue;
          // No trees over cave entrances.
          if (this.carvesSurface(this.caveAt(x, h, z), h)) continue;
          const kind = pickKind(biome.treeKinds, kindRoll);
          if (kind) growTree(blocks, cx, cz, kind, x, h + 1, z, new Rng(shape));
        }
      }
    }
  }

  /** Plants, cacti and snow; only ever touches this chunk. */
  private decorate(blocks: Uint16Array, cx: number, cz: number, info: ColumnInfo): void {
    const H = info.heights;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const k = (lz << 4) | lx;
        const x = cx * 16 + lx;
        const z = cz * 16 + lz;
        const h = H[(lz + 1) * REGION + lx + 1]!;
        const biome = info.biomes[k]!;
        const roll = unit(hash3(this.seed ^ SALT_DECO, x, 0, z));
        const topId = blocks[(h << 8) | k]!;
        const aboveFree = h + 1 < INFINITE_HEIGHT && blocks[((h + 1) << 8) | k] === B.AIR;
        if (aboveFree && topId === B.GRASS) {
          const plant = grassPlant(biome, roll, unit(hash3(this.seed ^ SALT_DECO, x, 1, z)));
          if (plant) blocks[((h + 1) << 8) | k] = plant;
        } else if (aboveFree && topId === B.SAND && biome === BIOME.DESERT) {
          if (roll < 0.006) {
            const tall = 1 + (hash3(this.seed ^ SALT_DECO, x, 2, z) % 3);
            for (let i = 1; i <= tall; i++) {
              const y = h + i;
              // Cacti need air all around; neighbours come from the height apron.
              if (y >= INFINITE_HEIGHT || !this.cactusRoom(blocks, H, lx, y, lz)) break;
              blocks[(y << 8) | k] = B.CACTUS;
            }
          } else if (roll < 0.018) {
            blocks[((h + 1) << 8) | k] = B.DEAD_BUSH;
          }
        }
        if (info.cold[k]) this.snowColumn(blocks, k);
      }
    }
  }

  private cactusRoom(blocks: Uint16Array, H: Int16Array, lx: number, y: number, lz: number): boolean {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = lx + dx;
      const nz = lz + dz;
      if (nx < 0 || nx > 15 || nz < 0 || nz > 15) {
        if (H[(nz + 1) * REGION + nx + 1]! >= y) return false;
      } else if (blocks[(y << 8) | (nz << 4) | nx] !== B.AIR) {
        return false;
      }
    }
    return true;
  }

  /** Snow layer on the highest block of a cold column (ground or leaves). */
  private snowColumn(blocks: Uint16Array, k: number): void {
    let y = INFINITE_HEIGHT - 1;
    while (y > 0 && blocks[(y << 8) | k] === B.AIR) y--;
    const id = blocks[(y << 8) | k]! & 0xff;
    if (REPLACEABLE[id]) {
      blocks[(y << 8) | k] = B.SNOW_LAYER;
    } else if (y + 1 < INFINITE_HEIGHT && (supportsPlant(id) || isLeaves(id))) {
      blocks[((y + 1) << 8) | k] = B.SNOW_LAYER;
    }
  }

  // ---- Spawn and search ----

  /**
   * A dry-land column near the origin for the world spawn (x, z): solid
   * ground with open air above (not under a tree or over a cave mouth).
   */
  findSpawnColumn(): { x: number; z: number } {
    const chunks = new Map<number, Uint16Array>();
    for (let r = 0; r <= 64; r++) {
      const candidates: Array<{ x: number; z: number; h: number; d: number }> = [];
      for (let cz = -r; cz <= r; cz++) {
        for (let cx = -r; cx <= r; cx++) {
          if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
          const info = this.columns(cx, cz);
          for (let k = 0; k < 256; k += 17) {
            const lx = k & 15;
            const lz = k >> 4;
            const h = info.heights[(lz + 1) * REGION + lx + 1]!;
            if (!goodSpawn(info.biomes[k]!, h, this.seaLevel)) continue;
            const x = cx * 16 + lx;
            const z = cz * 16 + lz;
            candidates.push({ x, z, h, d: x * x + z * z });
          }
        }
      }
      candidates.sort((a, b) => a.d - b.d);
      for (const c of candidates.slice(0, 24)) {
        const key = chunkKey(toChunk(c.x), toChunk(c.z));
        let blocks = chunks.get(key);
        if (!blocks) {
          blocks = this.generate(toChunk(c.x), toChunk(c.z)).blocks;
          chunks.set(key, blocks);
        }
        const k = (toLocal(c.z) << 4) | toLocal(c.x);
        const ground = blocks[(c.h << 8) | k]! & 0xff;
        const clear = (y: number): boolean => y >= INFINITE_HEIGHT || !blocksSpawn(blocks![(y << 8) | k]! & 0xff);
        if (supportsPlant(ground) && clear(c.h + 1) && clear(c.h + 2) && clear(c.h + 3)) return { x: c.x, z: c.z };
      }
    }
    return { x: 0, z: 0 };
  }

  /**
   * A column well inside the nearest patch of a biome (by key or name) to
   * (x, z), within `radius` blocks. A cheap climate estimate on a 32-block
   * grid picks candidate chunks; the exact chunk data confirms them.
   */
  locateBiome(name: string, fromX: number, fromZ: number, radius = 6000): { x: number; z: number } | null {
    const target = biomeByName(name);
    if (!target) return null;
    const step = 32;
    const cl = new Float32Array(CLIMATE_FIELDS);
    const checked = new Set<number>();
    const rings = Math.ceil(radius / step);
    // Narrow biomes only need a few columns in a chunk to count as found.
    const need = target.id === BIOME.RIVER ? 12 : target.id === BIOME.BEACH ? 24 : 96;
    let checks = 0;
    for (let r = 0; r <= rings; r++) {
      let best: { x: number; z: number; d: number } | null = null;
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const x = Math.floor(fromX) + i * step;
          const z = Math.floor(fromZ) + j * step;
          this.climate(x, z, cl, 0);
          if (!this.maybeBiome(target.id, cl)) continue;
          const reach = target.id === BIOME.RIVER || target.id === BIOME.BEACH ? 1 : 0;
          for (let dz = -reach; dz <= reach; dz++) {
            for (let dx = -reach; dx <= reach; dx++) {
              const ccx = toChunk(x) + dx;
              const ccz = toChunk(z) + dz;
              const key = chunkKey(ccx, ccz);
              if (checked.has(key) || checks > 4000) continue;
              checked.add(key);
              checks++;
              const spot = this.patchCentre(ccx, ccz, target.id, need);
              if (!spot) continue;
              const d = (spot.x - fromX) ** 2 + (spot.z - fromZ) ** 2;
              if (!best || d < best.d) best = { ...spot, d };
            }
          }
        }
      }
      if (best) return { x: best.x, z: best.z };
    }
    return null;
  }

  /** The biome column closest to the middle of its columns in a chunk, if it has enough. */
  private patchCentre(cx: number, cz: number, biome: number, need: number): { x: number; z: number } | null {
    const info = this.columns(cx, cz);
    // Land biomes count only dry columns, so a find is never a sandy shoreline.
    const land = biome !== BIOME.OCEAN && biome !== BIOME.DEEP_OCEAN && biome !== BIOME.RIVER && biome !== BIOME.BEACH;
    const counts = (k: number): boolean =>
      info.biomes[k] === biome && (!land || info.heights[((k >> 4) + 1) * REGION + (k & 15) + 1]! > this.seaLevel);
    let n = 0;
    let sx = 0;
    let sz = 0;
    for (let k = 0; k < 256; k++) {
      if (!counts(k)) continue;
      n++;
      sx += k & 15;
      sz += k >> 4;
    }
    if (n < need) return null;
    const mx = sx / n;
    const mz = sz / n;
    let bestK = -1;
    let bestD = Infinity;
    for (let k = 0; k < 256; k++) {
      if (!counts(k)) continue;
      const d = ((k & 15) - mx) ** 2 + ((k >> 4) - mz) ** 2;
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }
    return { x: cx * 16 + (bestK & 15), z: cz * 16 + (bestK >> 4) };
  }

  /** Could this climate produce `biome` nearby? (A loose prefilter.) */
  private maybeBiome(biome: number, cl: Float32Array): boolean {
    const [c, t, h, , r, m] = cl as unknown as [number, number, number, number, number, number];
    switch (biome) {
      case BIOME.OCEAN:
        return c < OCEAN_C + 0.02 && c > DEEP_C - 0.04;
      case BIOME.DEEP_OCEAN:
        return c < DEEP_C + 0.02;
      case BIOME.BEACH:
        return c > OCEAN_C - 0.06 && c < 0.08 && m < 0.45;
      case BIOME.RIVER:
        return c > OCEAN_C - 0.05 && Math.abs(r) < RIVER_VALLEY && m < 0.5;
      default:
        return c > OCEAN_C - 0.02 && landBiome(t, h, m) === biome;
    }
  }
}

function clampTo(v: number, origin: number): number {
  return Math.max(origin - VEIN_REACH, Math.min(origin + VEIN_REACH, v));
}

function goodSpawn(biome: number, h: number, sea: number): boolean {
  if (biome === BIOME.OCEAN || biome === BIOME.DEEP_OCEAN || biome === BIOME.RIVER || biome === BIOME.SWAMP) return false;
  return h >= sea + 2 && h < sea + 24;
}

function blocksSpawn(id: number): boolean {
  return (IS_SOLID[id] === 1 && id !== B.SNOW_LAYER) || isLeaves(id) || IS_LIQUID[id] === 1;
}

function pickKind(kinds: BiomeDef['treeKinds'], roll: number): TreeKind | null {
  let acc = 0;
  for (const [kind, w] of kinds) {
    acc += w;
    if (roll < acc) return kind;
  }
  return kinds.length ? kinds[kinds.length - 1]![0] : null;
}

function grassPlant(biome: number, roll: number, roll2: number): number {
  const flower = roll2 < 0.5 ? B.DANDELION : B.ROSE;
  switch (biome) {
    case BIOME.PLAINS:
      return roll < 0.2 ? B.TALL_GRASS : roll < 0.235 ? flower : 0;
    case BIOME.FOREST:
      return roll < 0.1 ? B.TALL_GRASS : roll < 0.11 ? flower : roll < 0.115 ? B.BROWN_MUSHROOM : 0;
    case BIOME.TAIGA:
      return roll < 0.1 ? B.TALL_GRASS : roll < 0.106 ? B.BROWN_MUSHROOM : 0;
    case BIOME.SWAMP:
      return roll < 0.12 ? B.TALL_GRASS : roll < 0.13 ? (roll2 < 0.5 ? B.RED_MUSHROOM : B.BROWN_MUSHROOM) : 0;
    case BIOME.MOUNTAINS:
    case BIOME.BEACH:
      return roll < 0.06 ? B.TALL_GRASS : 0;
    default:
      return 0;
  }
}

// ---- Trees ----

const LOG_OF: Record<TreeKind, number> = { oak: B.LOG, birch: B.BIRCH_LOG, spruce: B.SPRUCE_LOG, swamp: B.LOG };
const LEAVES_OF: Record<TreeKind, number> = {
  oak: B.LEAVES,
  birch: B.BIRCH_LEAVES,
  spruce: B.SPRUCE_LEAVES,
  swamp: B.LEAVES,
};

/**
 * Write the parts of a tree rooted at (x, y, z) that fall inside chunk
 * (cx, cz). Logs push through leaves, water and plants; leaves only fill air.
 */
function growTree(blocks: Uint16Array, cx: number, cz: number, kind: TreeKind, x: number, y: number, z: number, rng: Rng): void {
  const log = LOG_OF[kind];
  const leaves = LEAVES_OF[kind];
  const put = (px: number, py: number, pz: number, value: number, isLog: boolean): void => {
    const lx = px - cx * 16;
    const lz = pz - cz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || py < 1 || py >= INFINITE_HEIGHT) return;
    const i = (py << 8) | (lz << 4) | lx;
    const cur = blocks[i]! & 0xff;
    const free = cur === B.AIR || REPLACEABLE[cur] === 1;
    if (isLog ? free || cur === B.WATER || isLeaves(cur) : free) blocks[i] = value;
  };
  const leaf = (px: number, py: number, pz: number): void => put(px, py, pz, leaves, false);
  // Soil under the trunk.
  {
    const lx = x - cx * 16;
    const lz = z - cz * 16;
    if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16) {
      const i = ((y - 1) << 8) | (lz << 4) | lx;
      if (blocks[i] === B.GRASS) blocks[i] = B.DIRT;
    }
  }

  if (kind === 'spruce') {
    const height = 6 + rng.int(4);
    const top = y + height;
    const radii = [0, 1, 1, 2, 1, 2, 3, 2, 3, 2, 3];
    for (let py = top; py >= y + 2; py--) {
      const r = radii[Math.min(radii.length - 1, top - py)]!;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > r + (r >= 2 ? 1 : 0)) continue;
          leaf(x + dx, py, z + dz);
        }
      }
    }
    leaf(x, top + 1, z);
    for (let py = y; py < top; py++) put(x, py, z, log, true);
    return;
  }

  const height = kind === 'birch' ? 5 + rng.int(3) : kind === 'swamp' ? 4 + rng.int(2) : 4 + rng.int(3);
  const top = y + height; // first cell above the trunk
  for (let py = top - 3; py <= top; py++) {
    const layer = py - (top - 3); // 0..3 bottom to top
    const r = kind === 'swamp' ? (layer < 2 ? 3 : layer === 2 ? 2 : 1) : layer < 2 ? 2 : 1;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const corner = Math.abs(dx) === r && Math.abs(dz) === r;
        // Always draw the corner roll so every tree uses the same count.
        const keep = rng.chance(0.5);
        if (corner && (layer === 3 || r === 3 || !keep)) continue;
        if (layer === 3 && r === 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
        leaf(x + dx, py, z + dz);
      }
    }
  }
  for (let py = y; py < top; py++) put(x, py, z, log, true);
}

function isLeaves(id: number): boolean {
  return id === B.LEAVES || id === B.SPRUCE_LEAVES || id === B.BIRCH_LEAVES;
}

/** Per 4³ lattice cell: can any point inside be hollow (some corner > 0)? */
function hollowCells(g: Float32Array): Uint8Array {
  const out = new Uint8Array(4 * (CAVE_NODES_Y - 1) * 4);
  for (let gy = 0; gy < CAVE_NODES_Y - 1; gy++) {
    for (let gz = 0; gz < 4; gz++) {
      for (let gx = 0; gx < 4; gx++) {
        let any = 0;
        for (let k = 0; k < 8 && !any; k++) {
          if (g[((gy + (k >> 2)) * 5 + gz + ((k >> 1) & 1)) * 5 + gx + (k & 1)]! > 0) any = 1;
        }
        out[(gy * 4 + gz) * 4 + gx] = any;
      }
    }
  }
  return out;
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
