/**
 * Classic block behaviours, run on a fixed tick (20 per second):
 * - sand and gravel fall;
 * - water and lava spread without limit (lava slower), with a cap on
 *   updates per tick so floods can't stall the game;
 * - sponges clear water within 2 blocks and keep it out;
 * - saplings grow into trees;
 * - grass spreads onto lit dirt and dies when covered.
 *
 * Pure: works on a World through setBlock and its change listener.
 */
import { Rng } from '../util/prng';
import { B, BLOCKS_LIGHT, IS_LIQUID, IS_SOLID } from './blocks';
import type { Chunk } from './chunk';
import { posFromKey, posKey } from './coords';
import { growTree, type TreeTarget } from './trees';
import type { World } from './world';

export const TICKS_PER_SECOND = 20;
/** Scheduled updates processed per tick at most; the rest wait a tick. */
export const MAX_UPDATES_PER_TICK = 400;
export const WATER_DELAY = 5;
export const LAVA_DELAY = 30;
export const FALL_DELAY = 2;
export const SPONGE_RADIUS = 2;
/** Chunks (Chebyshev distance from the player) that receive random ticks. */
export const RANDOM_TICK_RADIUS = 8;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, 1, 0],
];
/** Liquids flow down and sideways, never up. */
const FLOW_DIRS = NEIGHBOURS.slice(0, 5);

export class Ticker {
  tick = 0;
  /** Updates processed during the last tick (for the debug overlay). */
  lastUpdates = 0;
  private readonly buckets = new Map<number, number[]>();
  private readonly due = new Map<number, number>();
  private readonly sponges = new Set<number>();
  private readonly rng: Rng;
  private readonly listener = (x: number, y: number, z: number, oldValue: number, newValue: number): void =>
    this.onChange(x, y, z, oldValue, newValue);
  private readonly trees: TreeTarget;
  private chunkList: Chunk[] = [];
  private focusX = 0;
  private focusZ = 0;

  constructor(private readonly world: World) {
    this.rng = new Rng(world.seed ^ 0x7ac3);
    for (const chunk of world.chunks.values()) {
      const b = chunk.blocks;
      for (let i = 0; i < b.length; i++) {
        if ((b[i]! & 0xff) === B.SPONGE) this.sponges.add(posKey(chunk.cx * 16 + (i & 15), i >> 8, chunk.cz * 16 + ((i >> 4) & 15)));
      }
    }
    world.addListener(this.listener);
    this.trees = {
      height: world.height,
      inside: (x, z) => world.inColumnBounds(x, z) && world.isLoaded(x, z),
      get: (x, y, z) => world.getId(x, y, z),
      set: (x, y, z, id) => void world.setBlock(x, y, z, id),
    };
  }

  /** Where the player is: random ticks happen around here. */
  setFocus(x: number, z: number): void {
    this.focusX = Math.floor(x);
    this.focusZ = Math.floor(z);
  }

  /** Stop listening to the world. */
  dispose(): void {
    this.world.removeListener(this.listener);
  }

  /** Number of cells waiting for an update. */
  get pending(): number {
    return this.due.size;
  }

  /** Schedule an update for cell (x, y, z) in `delay` ticks. */
  schedule(x: number, y: number, z: number, delay: number): void {
    if (!this.world.inBounds(x, y, z)) return;
    this.scheduleIndex(posKey(x, y, z), delay);
  }

  /** Advance one tick. */
  step(): void {
    this.tick++;
    const tick = this.tick;
    const list = this.buckets.get(tick);
    this.buckets.delete(tick);
    let processed = 0;
    if (list) {
      for (let k = 0; k < list.length; k++) {
        const i = list[k]!;
        if (this.due.get(i) !== tick) continue; // rescheduled or already done
        if (processed >= MAX_UPDATES_PER_TICK) {
          // Over budget: everything left waits for the next tick.
          const next = this.bucket(tick + 1);
          for (let r = k; r < list.length; r++) {
            const j = list[r]!;
            if (this.due.get(j) === tick) {
              this.due.set(j, tick + 1);
              next.push(j);
            }
          }
          break;
        }
        this.due.delete(i);
        this.update(i);
        processed++;
      }
    }
    this.lastUpdates = processed;
    this.randomTicks();
  }

  // ---- Scheduling ----

  private bucket(tick: number): number[] {
    let b = this.buckets.get(tick);
    if (!b) {
      b = [];
      this.buckets.set(tick, b);
    }
    return b;
  }

  private scheduleIndex(i: number, delay: number): void {
    const t = this.tick + Math.max(1, Math.floor(delay));
    const existing = this.due.get(i);
    if (existing !== undefined && existing <= t) return;
    this.due.set(i, t);
    this.bucket(t).push(i);
  }

  /** How soon a cell holding `id` wants to react to a change next to it. */
  private reactionDelay(x: number, y: number, z: number, id: number): number {
    switch (id) {
      case B.WATER:
        return WATER_DELAY;
      case B.LAVA:
        return LAVA_DELAY;
      case B.SAND:
      case B.GRAVEL:
        return FALL_DELAY;
      case B.AIR:
        return this.touchesEdgeOcean(x, y, z) ? WATER_DELAY : 0;
      default:
        return 0;
    }
  }

  private onChange(x: number, y: number, z: number, oldValue: number, newValue: number): void {
    const w = this.world;
    const oldId = oldValue & 0xff;
    const newId = newValue & 0xff;
    const i = posKey(x, y, z);
    if (oldId === B.SPONGE) {
      this.sponges.delete(i);
      this.wakeWaterAround(x, y, z, SPONGE_RADIUS + 1);
    }
    if (newId === B.SPONGE) {
      this.sponges.add(i);
      this.scheduleIndex(i, 1);
    }
    // The changed cell itself may react (placed sand falls, placed water flows…).
    const selfDelay = this.reactionDelay(x, y, z, newId);
    if (selfDelay > 0) this.scheduleIndex(i, selfDelay);
    // Neighbours only care when room opened up: liquids flow into air, and
    // sand or gravel above falls into anything non-solid.
    if (!IS_SOLID[newId]) {
      const opened = newId === B.AIR;
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (!w.inBounds(nx, ny, nz)) continue;
        const nid = w.getId(nx, ny, nz);
        const wake = (opened && IS_LIQUID[nid] === 1) || (dy === 1 && (nid === B.SAND || nid === B.GRAVEL));
        if (wake) this.scheduleIndex(posKey(nx, ny, nz), this.reactionDelay(nx, ny, nz, nid));
      }
    }
    // Grass under a new light-blocking block dies after a while.
    if (BLOCKS_LIGHT[newId] && y > 0 && w.getId(x, y - 1, z) === B.GRASS) {
      this.schedule(x, y - 1, z, 40 + this.rng.int(80));
    }
    // Freshly exposed or placed dirt may turn green if grass is nearby.
    if (newId === B.DIRT) this.schedule(x, y, z, 60 + this.rng.int(140));
    if (!BLOCKS_LIGHT[newId] && y > 0 && w.getId(x, y - 1, z) === B.DIRT) {
      this.schedule(x, y - 1, z, 60 + this.rng.int(140));
    }
    if (newId === B.SAPLING) this.schedule(x, y, z, 100 + this.rng.int(300));
  }

  private wakeWaterAround(x: number, y: number, z: number, r: number): void {
    const w = this.world;
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const id = w.getId(x + dx, y + dy, z + dz);
          if (id === B.WATER) this.schedule(x + dx, y + dy, z + dz, WATER_DELAY);
          else if (id === B.AIR && this.touchesEdgeOcean(x + dx, y + dy, z + dz)) {
            this.schedule(x + dx, y + dy, z + dz, WATER_DELAY);
          }
        }
      }
    }
  }

  // ---- Rules ----

  private update(key: number): void {
    const w = this.world;
    const [x, y, z] = posFromKey(key);
    if (!w.inBounds(x, y, z)) return;
    // Nothing simulates in chunks that aren't loaded and lit yet: wait.
    if (!w.isActive(x, z)) {
      this.scheduleIndex(key, 20);
      return;
    }
    const id = w.getId(x, y, z);
    switch (id) {
      case B.SAND:
      case B.GRAVEL:
        this.fall(x, y, z, id);
        break;
      case B.WATER:
      case B.LAVA:
        this.spread(x, y, z, id);
        break;
      case B.AIR:
        if (this.touchesEdgeOcean(x, y, z) && !this.nearSponge(x, y, z)) w.setBlock(x, y, z, B.WATER);
        break;
      case B.SPONGE:
        this.absorb(x, y, z);
        break;
      case B.GRASS:
        if (this.covered(x, y, z)) w.setBlock(x, y, z, B.DIRT);
        else this.spreadGrass(x, y, z);
        break;
      case B.DIRT:
        if (this.exposed(x, y, z) && this.grassNearby(x, y, z)) w.setBlock(x, y, z, B.GRASS);
        break;
      case B.SAPLING:
        if (!this.growSapling(x, y, z)) this.schedule(x, y, z, 200 + this.rng.int(400));
        break;
    }
  }

  private fall(x: number, y: number, z: number, id: number): void {
    if (y === 0) return;
    const below = this.world.getId(x, y - 1, z);
    if (IS_SOLID[below]) return;
    this.world.setBlock(x, y - 1, z, id);
    this.world.setBlock(x, y, z, B.AIR);
  }

  private spread(x: number, y: number, z: number, liquid: number): void {
    const w = this.world;
    const other = liquid === B.WATER ? B.LAVA : B.WATER;
    for (const [dx, dy, dz] of FLOW_DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!w.inBounds(nx, ny, nz) || w.getId(nx, ny, nz) !== B.AIR) continue;
      if (liquid === B.WATER && this.nearSponge(nx, ny, nz)) continue;
      // Where water and lava would meet, the flow hardens into stone.
      w.setBlock(nx, ny, nz, this.touches(nx, ny, nz, other) ? B.STONE : liquid);
    }
  }

  private absorb(x: number, y: number, z: number): void {
    const r = SPONGE_RADIUS;
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (this.world.getId(x + dx, y + dy, z + dz) === B.WATER) this.world.setBlock(x + dx, y + dy, z + dz, B.AIR);
        }
      }
    }
  }

  private growSapling(x: number, y: number, z: number): boolean {
    const w = this.world;
    const soil = w.getId(x, y - 1, z);
    if (soil !== B.GRASS && soil !== B.DIRT) return false;
    if (!w.isLit(x, y, z)) return false;
    return growTree(this.trees, this.rng, x, y, z);
  }

  /** Grass is covered when the block right above it blocks light. */
  private covered(x: number, y: number, z: number): boolean {
    return BLOCKS_LIGHT[this.world.getId(x, y + 1, z)] === 1 || IS_LIQUID[this.world.getId(x, y + 1, z)] === 1;
  }

  /** Dirt can turn to grass when nothing covers it and sunlight reaches it. */
  private exposed(x: number, y: number, z: number): boolean {
    return !this.covered(x, y, z) && this.world.isLit(x, y + 1, z);
  }

  private spreadGrass(x: number, y: number, z: number): void {
    const tx = x + this.rng.int(3) - 1;
    const ty = y + this.rng.int(5) - 3;
    const tz = z + this.rng.int(3) - 1;
    if (this.world.getId(tx, ty, tz) === B.DIRT && this.exposed(tx, ty, tz)) this.world.setBlock(tx, ty, tz, B.GRASS);
  }

  private grassNearby(x: number, y: number, z: number): boolean {
    for (let dy = -1; dy <= 3; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (this.world.getId(x + dx, y + dy, z + dz) === B.GRASS) return true;
        }
      }
    }
    return false;
  }

  /**
   * Random column ticks: sample surface columns so grass creeps across lit
   * dirt and saplings grow even without anything nearby changing.
   */
  private randomTicks(): void {
    const w = this.world;
    if (this.tick % 20 === 1 || this.chunkList.length === 0) {
      // Only chunks near the player take random ticks.
      const fx = this.focusX >> 4;
      const fz = this.focusZ >> 4;
      this.chunkList = [];
      for (const c of w.chunks.values()) {
        if (Math.max(Math.abs(c.cx - fx), Math.abs(c.cz - fz)) <= RANDOM_TICK_RADIUS) this.chunkList.push(c);
      }
    }
    const list = this.chunkList;
    if (list.length === 0) return;
    // About one sample per 64 columns per tick.
    const samples = Math.min(list.length * 4, 1024);
    for (let s = 0; s < samples; s++) {
      const chunk = list[this.rng.int(list.length)]!;
      if (!chunk.lit || w.chunks.get(chunk.key) !== chunk) continue;
      const col = this.rng.int(256);
      const y = chunk.heights[col]!;
      if (y < 0) continue;
      const x = chunk.cx * 16 + (col & 15);
      const z = chunk.cz * 16 + (col >> 4);
      if (!w.inColumnBounds(x, z)) continue;
      const top = w.getId(x, y, z);
      if (top === B.GRASS) this.spreadGrass(x, y, z);
      if (w.getId(x, y + 1, z) === B.SAPLING && this.rng.chance(0.1)) this.growSapling(x, y + 1, z);
    }
  }

  // ---- Queries ----

  private touches(x: number, y: number, z: number, id: number): boolean {
    for (const [dx, dy, dz] of NEIGHBOURS) if (this.world.getId(x + dx, y + dy, z + dz) === id) return true;
    return false;
  }

  /** A Classic map-border cell level with the ocean outside the map. */
  private touchesEdgeOcean(x: number, y: number, z: number): boolean {
    const w = this.world;
    const b = w.bounds;
    if (!b || y < w.edgeFloor || y >= w.seaLevel) return false;
    return x === 0 || z === 0 || x === b.sx - 1 || z === b.sz - 1;
  }

  private nearSponge(x: number, y: number, z: number): boolean {
    if (this.sponges.size === 0) return false;
    const w = this.world;
    const r = SPONGE_RADIUS;
    if (this.sponges.size > 64) {
      for (let dy = -r; dy <= r; dy++)
        for (let dz = -r; dz <= r; dz++)
          for (let dx = -r; dx <= r; dx++) if (w.getId(x + dx, y + dy, z + dz) === B.SPONGE) return true;
      return false;
    }
    for (const key of this.sponges) {
      const [sx, sy, sz] = posFromKey(key);
      if (Math.abs(sx - x) <= r && Math.abs(sy - y) <= r && Math.abs(sz - z) <= r) return true;
    }
    return false;
  }
}
