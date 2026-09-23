import { B, BLOCKS_LIGHT, idOf, restsOn, supportsPlant, TORCH_ATTACH } from './blocks';
import { borderSeeds, relight, spread, type LightStore } from './light';
import { Chunk } from './chunk';
import {
  CHUNK_HEIGHT,
  CHUNK_SIZE,
  SECTION_SIZE,
  chunkKey,
  localIndex,
  toChunk,
  toLocal,
} from './coords';

export type WorldType = 'classic' | 'infinite';

/** Called after every successful block change. Values are full 16-bit block values. */
export type BlockListener = (x: number, y: number, z: number, oldValue: number, newValue: number) => void;

export interface WorldOptions {
  type: WorldType;
  seed: number;
  /** Build height (Classic 64, Infinite 128). */
  height: number;
  seaLevel: number;
  /** Classic worlds only: size of the map in blocks. */
  bounds?: { sx: number; sz: number } | null;
}

/**
 * Voxel world stored as 16×16×128 chunk columns in a map. Every block change
 * goes through `setBlock`.
 */
export class World {
  readonly type: WorldType;
  readonly seed: number;
  readonly height: number;
  /** Water fills cells with y < seaLevel; the surface sits at y = seaLevel. */
  readonly seaLevel: number;
  /** Classic: outside the map, cells with y < edgeFloor are bedrock. */
  readonly edgeFloor: number;
  readonly bounds: { sx: number; sz: number } | null;
  readonly chunks = new Map<number, Chunk>();
  /** Chunks with at least one stale section mesh. Consumed by the renderer. */
  readonly dirtyChunks = new Set<Chunk>();
  /** Number of block changes (stats). */
  changeCount = 0;
  private readonly listeners: BlockListener[] = [];
  private loads = 0;
  /** Live light across chunk borders (used by incremental relighting). */
  readonly lightStore: LightStore = {
    id: (x, y, z) => {
      const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
      if (!c) return this.inColumnBounds(x, z) ? 255 : this.getVirtual(x, y, z) & 0xff;
      return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)]! & 0xff;
    },
    get: (x, y, z) => {
      const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
      if (!c || !c.light) return -1;
      return c.light[(y << 8) | ((z & 15) << 4) | (x & 15)]!;
    },
    set: (x, y, z, packed) => {
      const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
      if (!c || !c.light) return;
      c.light[(y << 8) | ((z & 15) << 4) | (x & 15)] = packed;
      this.markCellDirty(x, y, z);
    },
  };

  constructor(opts: WorldOptions) {
    this.type = opts.type;
    this.seed = opts.seed >>> 0;
    this.height = Math.min(CHUNK_HEIGHT, opts.height);
    this.seaLevel = opts.seaLevel;
    this.edgeFloor = this.seaLevel - 2;
    this.bounds = opts.bounds ?? null;
  }

  /**
   * Build a Classic world from a flat level array indexed
   * `(y * sz + z) * sx + x` (the finite generator's layout).
   */
  static fromClassicLevel(blocks: Uint8Array, sx: number, sy: number, sz: number, seed: number): World {
    if (blocks.length !== sx * sy * sz) throw new Error('Level array does not match its size');
    if (sx % CHUNK_SIZE || sz % CHUNK_SIZE) throw new Error('Classic sizes must be multiples of 16');
    const world = new World({ type: 'classic', seed, height: sy, seaLevel: Math.floor(sy / 2), bounds: { sx, sz } });
    for (let cz = 0; cz < sz / CHUNK_SIZE; cz++) {
      for (let cx = 0; cx < sx / CHUNK_SIZE; cx++) {
        const chunk = new Chunk(cx, cz);
        const out = chunk.blocks;
        for (let y = 0; y < sy; y++) {
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const src = (y * sz + cz * CHUNK_SIZE + lz) * sx + cx * CHUNK_SIZE;
            const dst = localIndex(0, y, lz);
            for (let lx = 0; lx < CHUNK_SIZE; lx++) out[dst + lx] = blocks[src + lx]!;
          }
        }
        world.addChunk(chunk);
      }
    }
    return world;
  }

  /** Flatten a Classic world back to the finite generator's layout. */
  toClassicLevel(): Uint8Array {
    const b = this.bounds;
    if (!b) throw new Error('Only Classic worlds have a flat level');
    const sy = this.height;
    const out = new Uint8Array(b.sx * sy * b.sz);
    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < b.sz; z++) {
        for (let x = 0; x < b.sx; x++) out[(y * b.sz + z) * b.sx + x] = idOf(this.get(x, y, z));
      }
    }
    return out;
  }

  // ---- Chunks ----

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  chunkAt(x: number, z: number): Chunk | undefined {
    return this.chunks.get(chunkKey(toChunk(x), toChunk(z)));
  }

  /** Add a generated (or loaded) chunk. Meshing is up to the streamer. */
  addChunk(chunk: Chunk): void {
    this.chunks.set(chunk.key, chunk);
    chunk.loadId = ++this.loads;
    chunk.updateNonEmpty();
    this.recomputeHeights(chunk);
  }

  removeChunk(chunk: Chunk): void {
    this.chunks.delete(chunk.key);
    this.dirtyChunks.delete(chunk);
  }

  /** Is (x, z) inside the playable area (Classic bounds; always for Infinite)? */
  inColumnBounds(x: number, z: number): boolean {
    const b = this.bounds;
    return !b || (x >= 0 && z >= 0 && x < b.sx && z < b.sz);
  }

  /** Inside the build volume of a loaded chunk. */
  inBounds(x: number, y: number, z: number): boolean {
    return y >= 0 && y < this.height && this.inColumnBounds(x, z) && this.chunkAt(x, z) !== undefined;
  }

  isLoaded(x: number, z: number): boolean {
    return this.chunkAt(x, z) !== undefined;
  }

  /** Loaded and lit: simulation may run here. */
  isActive(x: number, z: number): boolean {
    const c = this.chunkAt(x, z);
    return c !== undefined && c.lit;
  }

  // ---- Blocks ----

  /** Block value (id | state << 8); air when unloaded or out of range. */
  get(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return B.AIR;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)]! : B.AIR;
  }

  /** Block id at a cell. */
  getId(x: number, y: number, z: number): number {
    return this.get(x, y, z) & 0xff;
  }

  /**
   * Block value including the virtual surroundings: bedrock below the world;
   * for Classic, the edge ocean (bedrock below edgeFloor, water to sea level)
   * outside the map.
   */
  getVirtual(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= CHUNK_HEIGHT) return B.AIR;
    if (!this.inColumnBounds(x, z)) {
      if (y < this.edgeFloor) return B.BEDROCK;
      if (y < this.seaLevel) return B.WATER;
      return B.AIR;
    }
    return this.get(x, y, z);
  }

  /** Under open sky: full sky light (or, before lighting, nothing light-blocking above). */
  isLit(x: number, y: number, z: number): boolean {
    if (y >= CHUNK_HEIGHT) return true;
    const c = this.chunkAt(x, z);
    if (!c) return true;
    const col = ((z & 15) << 4) | (x & 15);
    if (c.light) return y < 0 ? false : c.light[(y << 8) | col]! >> 4 === 15;
    return y > c.heights[col]!;
  }

  /** Packed light at a cell (sky << 4 | block); full sky outside lit chunks. */
  lightAt(x: number, y: number, z: number): number {
    if (y >= CHUNK_HEIGHT) return 0xf0;
    if (y < 0) return 0;
    const c = this.chunkAt(x, z);
    if (!c || !c.light) return 0xf0;
    return c.light[(y << 8) | ((z & 15) << 4) | (x & 15)]!;
  }

  /** Install freshly computed light and reconcile it with lit neighbours. */
  setChunkLight(chunk: Chunk, light: Uint8Array): void {
    chunk.light = light;
    const store = this.lightStore;
    const pairs: Array<[Chunk, Chunk, boolean]> = [];
    const east = this.getChunk(chunk.cx + 1, chunk.cz);
    const west = this.getChunk(chunk.cx - 1, chunk.cz);
    const south = this.getChunk(chunk.cx, chunk.cz + 1);
    const north = this.getChunk(chunk.cx, chunk.cz - 1);
    if (east?.light) pairs.push([chunk, east, true]);
    if (west?.light) pairs.push([west, chunk, true]);
    if (south?.light) pairs.push([chunk, south, false]);
    if (north?.light) pairs.push([north, chunk, false]);
    for (const isSky of [true, false]) {
      for (const [a, b, alongX] of pairs) {
        spread(store, borderSeeds(a.blocks, a.light!, b.blocks, b.light!, a.cx, a.cz, alongX, isSky), isSky);
      }
    }
  }

  addListener(listener: BlockListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: BlockListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /**
   * The single entry point for block changes. Updates light heights, marks
   * affected sections dirty and applies neighbour effects:
   * - a slab placed on a slab merges into a double slab;
   * - plants, torches, snow layers and cacti pop off when the block under
   *   (or behind) them stops supporting them.
   * Returns true when anything changed.
   */
  setBlock(x: number, y: number, z: number, value: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const chunk = this.chunkAt(x, z)!;
    const lx = toLocal(x);
    const lz = toLocal(z);
    const i = localIndex(lx, y, lz);
    const old = chunk.blocks[i]!;
    if (old === value) return false;

    const id = idOf(value);
    if (id === B.SLAB && y > 0 && idOf(chunk.blocks[i - 256]!) === B.SLAB) {
      return this.setBlock(x, y - 1, z, B.DOUBLE_SLAB);
    }

    chunk.blocks[i] = value;
    chunk.modified = true;
    chunk.version++;
    if (id !== B.AIR) chunk.nonEmpty |= 1 << (y >> 4);
    this.changeCount++;
    this.markCellDirty(x, y, z);

    const col = (lz << 4) | lx;
    const oldH = chunk.heights[col]!;
    this.updateHeight(chunk, col, y, id);
    const newH = chunk.heights[col]!;
    if (chunk.light) relight(this.lightStore, x, y, z);
    else if (oldH !== newH) this.markLightDirty(x, z, oldH, newH);

    for (const listener of this.listeners) listener(x, y, z, old, value);

    // Things resting on this block pop off when their support goes away.
    if (y + 1 < this.height) {
      const above = chunk.blocks[i + 256]!;
      if (above !== B.AIR && !restsOn(above, id)) this.setBlock(x, y + 1, z, B.AIR);
    }
    if (!supportsPlant(id)) {
      for (let s = 1; s < TORCH_ATTACH.length; s++) {
        const [dx, dz] = TORCH_ATTACH[s]!;
        const v = this.get(x + dx, y, z + dz);
        if (idOf(v) === B.TORCH && v >> 8 === s) this.setBlock(x + dx, y, z + dz, B.AIR);
      }
    }
    return true;
  }

  /** Biome id of a loaded infinite-world column, or -1. */
  biomeAt(x: number, z: number): number {
    const chunk = this.chunkAt(x, z);
    if (!chunk?.biomes) return -1;
    return chunk.biomes[(toLocal(z) << 4) | toLocal(x)]!;
  }

  // ---- Classic column shadows ----

  recomputeHeights(chunk: Chunk): void {
    const b = chunk.blocks;
    for (let col = 0; col < 256; col++) {
      let h = -1;
      for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
        if (BLOCKS_LIGHT[b[(y << 8) | col]! & 0xff]) {
          h = y;
          break;
        }
      }
      chunk.heights[col] = h;
    }
  }

  private updateHeight(chunk: Chunk, col: number, y: number, id: number): void {
    const old = chunk.heights[col]!;
    if (BLOCKS_LIGHT[id]) {
      if (y > old) chunk.heights[col] = y;
    } else if (y === old) {
      let h = -1;
      for (let yy = y - 1; yy >= 0; yy--) {
        if (BLOCKS_LIGHT[chunk.blocks[(yy << 8) | col]! & 0xff]) {
          h = yy;
          break;
        }
      }
      chunk.heights[col] = h;
    }
  }

  // ---- Dirty tracking ----

  markSectionDirty(cx: number, sy: number, cz: number): void {
    if (sy < 0 || sy * SECTION_SIZE >= CHUNK_HEIGHT) return;
    const c = this.getChunk(cx, cz);
    if (!c) return;
    c.dirtySections |= 1 << sy;
    this.dirtyChunks.add(c);
  }

  /** Dirty the cell's section plus any section sharing the touched faces. */
  markCellDirty(x: number, y: number, z: number): void {
    const cx = toChunk(x);
    const cz = toChunk(z);
    const sy = y >> 4;
    this.markSectionDirty(cx, sy, cz);
    const lx = toLocal(x);
    const lz = toLocal(z);
    const ly = y & 15;
    if (lx === 0) this.markSectionDirty(cx - 1, sy, cz);
    else if (lx === 15) this.markSectionDirty(cx + 1, sy, cz);
    if (lz === 0) this.markSectionDirty(cx, sy, cz - 1);
    else if (lz === 15) this.markSectionDirty(cx, sy, cz + 1);
    if (ly === 0) this.markSectionDirty(cx, sy - 1, cz);
    else if (ly === 15) this.markSectionDirty(cx, sy + 1, cz);
  }

  /**
   * A column's light height moved from `oldH` to `newH`: faces looking into
   * cells between them changed brightness. Dirty the sections spanning that
   * range in this column and its four neighbours.
   */
  private markLightDirty(x: number, z: number, oldH: number, newH: number): void {
    const lo = Math.max(0, Math.min(oldH, newH));
    const hi = Math.min(CHUNK_HEIGHT - 1, Math.max(oldH, newH) + 1);
    const cols: ReadonlyArray<readonly [number, number]> = [
      [x, z],
      [x + 1, z],
      [x - 1, z],
      [x, z + 1],
      [x, z - 1],
    ];
    for (const [px, pz] of cols) {
      for (let sy = lo >> 4; sy <= hi >> 4; sy++) this.markSectionDirty(toChunk(px), sy, toChunk(pz));
    }
  }
}
