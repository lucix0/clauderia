/**
 * Seeded, deterministic Classic-style level generator. Pure: returns a flat
 * block array; reports progress through a callback.
 */
import { CombinedNoise, OctaveNoise } from '../util/noise';
import { deriveSeed, Rng } from '../util/prng';
import { B, IS_SOLID } from './blocks';
import { growTree } from './trees';

export interface GenOptions {
  sx: number;
  sy: number;
  sz: number;
  seed: number;
}

export type ProgressFn = (stage: string, fraction: number) => void;

/** Growable int stack for iterative flood fills. */
class IntStack {
  private data = new Int32Array(1 << 16);
  length = 0;

  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }

  pop(): number {
    return this.data[--this.length]!;
  }
}

class Level {
  readonly blocks: Uint8Array;
  readonly layer: number;
  readonly seaLevel: number;
  readonly heights: Int16Array;

  constructor(
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
  ) {
    this.blocks = new Uint8Array(sx * sy * sz);
    this.layer = sx * sz;
    this.seaLevel = Math.floor(sy / 2);
    this.heights = new Int16Array(sx * sz);
  }

  in(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  idx(x: number, y: number, z: number): number {
    return y * this.layer + z * this.sx + x;
  }

  get(x: number, y: number, z: number): number {
    return this.in(x, y, z) ? this.blocks[this.idx(x, y, z)]! : B.AIR;
  }

  set(x: number, y: number, z: number, id: number): void {
    if (this.in(x, y, z)) this.blocks[this.idx(x, y, z)] = id;
  }
}

/** Generate a level. Same options → identical bytes. */
export function generateLevel(opts: GenOptions, progress: ProgressFn = () => {}): Uint8Array {
  const { sx, sy, sz, seed } = opts;
  const lvl = new Level(sx, sy, sz);
  const rng = (salt: number): Rng => new Rng(deriveSeed(seed, salt));

  progress('Raising terrain', 0);
  raise(lvl, rng(1), progress);
  progress('Soiling', 0.25);
  soil(lvl, rng(2));
  progress('Carving caves', 0.35);
  carveCaves(lvl, rng(3));
  progress('Seeding ores', 0.5);
  seedOres(lvl, rng(4));
  progress('Flooding', 0.6);
  flood(lvl);
  progress('Melting lava', 0.7);
  meltLava(lvl, rng(5));
  progress('Growing', 0.75);
  grow(lvl, rng(6));
  progress('Planting', 0.85);
  plant(lvl, rng(7));
  progress('Done', 1);
  return lvl.blocks;
}

function raise(lvl: Level, rng: Rng, progress: ProgressFn): void {
  const low = new CombinedNoise(new OctaveNoise(rng, 8), new OctaveNoise(rng, 8));
  const high = new CombinedNoise(new OctaveNoise(rng, 8), new OctaveNoise(rng, 8));
  const select = new OctaveNoise(rng, 6);
  const { sx, sz, seaLevel } = lvl;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const hl = low.sample(x * 1.3, z * 1.3) / 6 - 4;
      const hh = high.sample(x * 1.3, z * 1.3) / 5 + 6;
      let h = select.sample(x, z) / 8 > 0 ? hl : Math.max(hl, hh);
      h /= 2;
      if (h < 0) h *= 0.8;
      const height = Math.round(h + seaLevel);
      lvl.heights[z * sx + x] = Math.max(2, Math.min(lvl.sy - 8, height));
    }
    if ((z & 31) === 0) progress('Raising terrain', (z / sz) * 0.25);
  }
}

function soil(lvl: Level, rng: Rng): void {
  const noise = new OctaveNoise(rng, 8);
  const { sx, sz, layer, blocks } = lvl;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const col = z * sx + x;
      const h = lvl.heights[col]!;
      const dirtDepth = Math.max(1, Math.floor(noise.sample(x, z) / 24) + 4);
      const stoneTop = h - dirtDepth;
      blocks[col] = B.BEDROCK;
      for (let y = 1; y <= h; y++) blocks[y * layer + col] = y <= stoneTop ? B.STONE : B.DIRT;
    }
  }
}

/** Fill an ellipsoid, replacing only the listed block ids. */
function fillBlob(
  lvl: Level,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  id: number,
  replace: (current: number) => boolean,
): void {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    if (y < 1 || y >= lvl.sy) continue;
    for (let z = Math.floor(cz - radius); z <= Math.ceil(cz + radius); z++) {
      if (z < 0 || z >= lvl.sz) continue;
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (x < 0 || x >= lvl.sx) continue;
        const dx = x + 0.5 - cx;
        const dy = (y + 0.5 - cy) * 1.25;
        const dz = z + 0.5 - cz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        const i = lvl.idx(x, y, z);
        if (replace(lvl.blocks[i]!)) lvl.blocks[i] = id;
      }
    }
  }
}

/** Worm-style tunnels: a wandering walk that carves spheres along its path. */
function worm(
  lvl: Level,
  rng: Rng,
  length: number,
  radiusFor: (t: number, y: number) => number,
  start: [number, number, number],
  id: number,
  replace: (current: number) => boolean,
): void {
  let [x, y, z] = start;
  let theta = rng.next() * Math.PI * 2;
  let dTheta = 0;
  let phi = rng.next() * Math.PI * 2;
  let dPhi = 0;
  for (let l = 0; l < length; l++) {
    x += Math.sin(theta) * Math.cos(phi);
    z += Math.cos(theta) * Math.cos(phi);
    y += Math.sin(phi);
    theta += dTheta * 0.2;
    dTheta = dTheta * 0.9 + rng.next() - rng.next();
    phi = phi / 2 + dPhi / 4;
    dPhi = dPhi * 0.75 + rng.next() - rng.next();
    if (rng.next() < 0.25) continue;
    const r = radiusFor(l / length, y);
    if (r < 0.6) continue;
    fillBlob(
      lvl,
      x + (rng.next() * 4 - 2) * 0.2,
      y + (rng.next() * 4 - 2) * 0.2,
      z + (rng.next() * 4 - 2) * 0.2,
      r,
      id,
      replace,
    );
  }
}

function carveCaves(lvl: Level, rng: Rng): void {
  const { sx, sy, sz } = lvl;
  const count = Math.floor((sx * sy * sz) / 8192);
  const carvable = (id: number): boolean => id === B.STONE || id === B.DIRT;
  for (let i = 0; i < count; i++) {
    const start: [number, number, number] = [rng.next() * sx, rng.next() * sy * 0.8, rng.next() * sz];
    const length = Math.floor(rng.next() * rng.next() * 200);
    const size = rng.next() * rng.next();
    worm(
      lvl,
      rng,
      length,
      (t, y) => {
        const depth = (sy - y) / sy;
        return (1.2 + (depth * 3.5 + 1) * size) * Math.sin(t * Math.PI);
      },
      start,
      B.AIR,
      carvable,
    );
  }
}

function seedOres(lvl: Level, rng: Rng): void {
  const { sx, sy, sz, seaLevel } = lvl;
  const volume = sx * sy * sz;
  const ores: Array<{ id: number; per: number; maxY: number; size: number }> = [
    { id: B.COAL_ORE, per: 5000, maxY: sy - 8, size: 1.4 },
    { id: B.IRON_ORE, per: 11000, maxY: Math.floor(seaLevel * 0.8), size: 1.25 },
    { id: B.GOLD_ORE, per: 26000, maxY: Math.floor(seaLevel * 0.45), size: 1.15 },
  ];
  const onlyStone = (id: number): boolean => id === B.STONE;
  for (const ore of ores) {
    const count = Math.floor(volume / ore.per);
    for (let i = 0; i < count; i++) {
      const start: [number, number, number] = [rng.next() * sx, 1 + rng.next() * (ore.maxY - 1), rng.next() * sz];
      const length = 4 + Math.floor(rng.next() * 12);
      const size = ore.size * (0.7 + rng.next() * 0.5);
      worm(lvl, rng, length, (t) => size * (0.6 + 0.4 * Math.sin(t * Math.PI)), start, ore.id, onlyStone);
    }
  }
}

/**
 * Iterative flood fill of `id` into air cells from the seeds, never above
 * `maxY`. Returns the number of cells filled.
 */
function floodFill(lvl: Level, seeds: IntStack, id: number, maxY: number): number {
  const { sx, sz, layer, blocks } = lvl;
  let filled = 0;
  while (seeds.length > 0) {
    const i = seeds.pop();
    const y = Math.floor(i / layer);
    const rem = i - y * layer;
    const z = Math.floor(rem / sx);
    const x = rem - z * sx;
    const tryPush = (j: number): void => {
      if (blocks[j] === B.AIR) {
        blocks[j] = id;
        filled++;
        seeds.push(j);
      }
    };
    if (x > 0) tryPush(i - 1);
    if (x < sx - 1) tryPush(i + 1);
    if (z > 0) tryPush(i - sx);
    if (z < sz - 1) tryPush(i + sx);
    if (y > 1) tryPush(i - layer);
    if (y < maxY) tryPush(i + layer);
  }
  return filled;
}

/** Ocean floods inward from the map edges below sea level; enclosed caves stay dry. */
function flood(lvl: Level): void {
  const { sx, sz, seaLevel, blocks } = lvl;
  const seeds = new IntStack();
  const maxY = seaLevel - 1;
  const seed = (x: number, y: number, z: number): void => {
    const i = lvl.idx(x, y, z);
    if (blocks[i] === B.AIR) {
      blocks[i] = B.WATER;
      seeds.push(i);
    }
  };
  for (let y = 1; y <= maxY; y++) {
    for (let x = 0; x < sx; x++) {
      seed(x, y, 0);
      seed(x, y, sz - 1);
    }
    for (let z = 0; z < sz; z++) {
      seed(0, y, z);
      seed(sx - 1, y, z);
    }
  }
  floodFill(lvl, seeds, B.WATER, maxY);
}

/** Lava pools in air pockets near the bottom of the map. */
function meltLava(lvl: Level, rng: Rng): void {
  const { sx, sy, sz, seaLevel } = lvl;
  const count = Math.floor((sx * sy * sz) / 20000);
  const seeds = new IntStack();
  for (let i = 0; i < count; i++) {
    const x = rng.int(sx);
    const z = rng.int(sz);
    const y = 1 + Math.floor((seaLevel - 12) * rng.next() * rng.next());
    const idx = lvl.idx(x, y, z);
    if (lvl.blocks[idx] !== B.AIR) continue;
    lvl.blocks[idx] = B.LAVA;
    seeds.push(idx);
    floodFill(lvl, seeds, B.LAVA, y);
  }
}

/** Beaches, gravel shores and grass on exposed dirt. */
function grow(lvl: Level, rng: Rng): void {
  const sandNoise = new OctaveNoise(rng, 8);
  const gravelNoise = new OctaveNoise(rng, 8);
  const { sx, sz, seaLevel } = lvl;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const y = topSolid(lvl, x, z);
      if (y < 1) continue;
      const above = lvl.get(x, y + 1, z);
      const top = lvl.get(x, y, z);
      if (top !== B.DIRT && top !== B.GRASS) continue;
      const sandy = sandNoise.sample(x, z) > 8;
      const gravelly = gravelNoise.sample(x, z) > 12;
      if (above === B.WATER && gravelly) {
        lvl.set(x, y, z, B.GRAVEL);
      } else if (above === B.WATER && y >= seaLevel - 4) {
        lvl.set(x, y, z, sandy ? B.SAND : B.DIRT);
      } else if (above === B.AIR && y <= seaLevel + 1 && y >= seaLevel - 2 && (sandy || y <= seaLevel - 1)) {
        lvl.set(x, y, z, B.SAND);
        if (lvl.get(x, y - 1, z) === B.DIRT) lvl.set(x, y - 1, z, B.SAND);
      } else if (above === B.AIR) {
        lvl.set(x, y, z, B.GRASS);
      }
    }
  }
}

/** Highest block that is neither air nor liquid. */
function topSolid(lvl: Level, x: number, z: number): number {
  for (let y = lvl.sy - 1; y >= 0; y--) {
    const id = lvl.get(x, y, z);
    if (id !== B.AIR && id !== B.WATER && id !== B.LAVA) return y;
  }
  return -1;
}

function plant(lvl: Level, rng: Rng): void {
  const { sx, sz, sy } = lvl;
  const area = sx * sz;
  const target = {
    sx,
    sy,
    sz,
    get: (x: number, y: number, z: number) => lvl.get(x, y, z),
    set: (x: number, y: number, z: number, id: number) => lvl.set(x, y, z, id),
  };

  // Flower patches.
  for (let p = 0; p < Math.floor(area / 3000); p++) {
    const flower = rng.chance(0.5) ? B.DANDELION : B.ROSE;
    const px = rng.int(sx);
    const pz = rng.int(sz);
    for (let k = 0; k < 10; k++) {
      let x = px;
      let z = pz;
      for (let s = 0; s < 5; s++) {
        x += rng.int(6) - rng.int(6);
        z += rng.int(6) - rng.int(6);
      }
      if (x < 0 || z < 0 || x >= sx || z >= sz) continue;
      const y = topSolid(lvl, x, z);
      if (lvl.get(x, y, z) === B.GRASS && lvl.get(x, y + 1, z) === B.AIR) lvl.set(x, y + 1, z, flower);
    }
  }

  // Mushrooms: dark cave floors, plus the odd shady patch on the surface.
  const volume = area * sy;
  for (let p = 0; p < Math.floor(volume / 2000); p++) {
    const shroom = rng.chance(0.5) ? B.BROWN_MUSHROOM : B.RED_MUSHROOM;
    const x = rng.int(sx);
    const y = 1 + rng.int(sy - 2);
    const z = rng.int(sz);
    if (lvl.get(x, y, z) !== B.AIR) continue;
    const below = lvl.get(x, y - 1, z);
    if (below !== B.STONE && below !== B.GRAVEL && below !== B.DIRT) continue;
    if (y > topSolid(lvl, x, z)) continue; // must be under cover
    lvl.set(x, y, z, shroom);
  }
  for (let p = 0; p < Math.floor(area / 9000); p++) {
    const shroom = rng.chance(0.5) ? B.BROWN_MUSHROOM : B.RED_MUSHROOM;
    const px = rng.int(sx);
    const pz = rng.int(sz);
    for (let k = 0; k < 6; k++) {
      const x = px + rng.int(5) - rng.int(5);
      const z = pz + rng.int(5) - rng.int(5);
      if (x < 0 || z < 0 || x >= sx || z >= sz) continue;
      const y = topSolid(lvl, x, z);
      if (lvl.get(x, y, z) === B.GRASS && lvl.get(x, y + 1, z) === B.AIR) lvl.set(x, y + 1, z, shroom);
    }
  }

  // Tree clusters.
  for (let p = 0; p < Math.floor(area / 4000); p++) {
    const px = rng.int(sx);
    const pz = rng.int(sz);
    for (let k = 0; k < 20; k++) {
      let x = px;
      let z = pz;
      for (let s = 0; s < 20; s++) {
        x += rng.int(6) - rng.int(6);
        z += rng.int(6) - rng.int(6);
        if (x < 0 || z < 0 || x >= sx || z >= sz) break;
        if (!rng.chance(0.25)) continue;
        const y = topSolid(lvl, x, z);
        if (lvl.get(x, y, z) !== B.GRASS) continue;
        if (growTree(target, rng, x, y + 1, z)) lvl.set(x, y, z, B.DIRT);
      }
    }
  }
}

/** Find a dry spawn cell near the centre: returns feet position. */
export function findSpawn(
  blocks: Uint8Array,
  sx: number,
  sy: number,
  sz: number,
): { x: number; y: number; z: number } {
  const layer = sx * sz;
  const at = (x: number, y: number, z: number): number => blocks[y * layer + z * sx + x]!;
  const seaLevel = Math.floor(sy / 2);
  const cx = Math.floor(sx / 2);
  const cz = Math.floor(sz / 2);
  const maxR = Math.max(sx, sz) / 2;
  for (let r = 0; r < maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx;
        const z = cz + dz;
        if (x < 1 || z < 1 || x >= sx - 1 || z >= sz - 1) continue;
        for (let y = sy - 3; y >= seaLevel; y--) {
          const id = at(x, y, z);
          if (id === B.AIR) continue;
          if (!IS_SOLID[id] || id === B.LEAVES) break;
          if (at(x, y + 1, z) === B.AIR && at(x, y + 2, z) === B.AIR) return { x: x + 0.5, y: y + 1, z: z + 0.5 };
          break;
        }
      }
    }
  }
  // Nothing dry: stand on top of whatever is at the centre.
  for (let y = sy - 2; y >= 0; y--) {
    if (at(cx, y, cz) !== B.AIR) return { x: cx + 0.5, y: y + 1, z: cz + 0.5 };
  }
  return { x: cx + 0.5, y: seaLevel + 1, z: cz + 0.5 };
}
