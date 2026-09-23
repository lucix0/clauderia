import { CHUNK_SHIFT, CHUNK_SIZE } from '../config';
import { B, IS_PLANT, supportsPlant } from './blocks';
import { HeightMap } from './heightmap';

export type BlockListener = (x: number, y: number, z: number, oldId: number, newId: number) => void;

/**
 * Fixed-size voxel world stored as a flat Uint8Array, indexed
 * `(y * sz + z) * sx + x`. Every block change goes through `setBlock`.
 */
export class World {
  readonly blocks: Uint8Array;
  readonly heightMap: HeightMap;
  /** Water fills cells with y < seaLevel; the surface sits at y = seaLevel. */
  readonly seaLevel: number;
  /** Outside the map, cells with y < edgeFloor are bedrock. */
  readonly edgeFloor: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunksZ: number;
  /** Chunk indices whose meshes are stale. Consumed by the renderer. */
  readonly dirty = new Set<number>();
  /** Number of setBlock calls that changed something (for stats). */
  changeCount = 0;
  private readonly listeners: BlockListener[] = [];

  constructor(
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
    readonly seed: number,
    blocks?: Uint8Array,
  ) {
    const volume = sx * sy * sz;
    if (blocks && blocks.length !== volume) {
      throw new Error(`Block array has ${blocks.length} entries, expected ${volume}`);
    }
    this.blocks = blocks ?? new Uint8Array(volume);
    this.seaLevel = Math.floor(sy / 2);
    this.edgeFloor = this.seaLevel - 2;
    this.chunksX = Math.ceil(sx / CHUNK_SIZE);
    this.chunksY = Math.ceil(sy / CHUNK_SIZE);
    this.chunksZ = Math.ceil(sz / CHUNK_SIZE);
    this.heightMap = new HeightMap(sx, sy, sz);
    this.heightMap.recomputeAll(this.blocks);
  }

  get volume(): number {
    return this.blocks.length;
  }

  get chunkCount(): number {
    return this.chunksX * this.chunksY * this.chunksZ;
  }

  index(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  /** Block id at a cell; air outside the map. */
  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return B.AIR;
    return this.blocks[(y * this.sz + z) * this.sx + x]!;
  }

  /**
   * Block id including the virtual surroundings: bedrock below the map and
   * under the edge ocean, water up to sea level outside the map, air above.
   */
  getVirtual(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= this.sy) return B.AIR;
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) {
      if (y < this.edgeFloor) return B.BEDROCK;
      if (y < this.seaLevel) return B.WATER;
      return B.AIR;
    }
    return this.blocks[(y * this.sz + z) * this.sx + x]!;
  }

  isLit(x: number, y: number, z: number): boolean {
    return this.heightMap.isLit(x, y, z);
  }

  addListener(listener: BlockListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: BlockListener): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /**
   * The single entry point for block changes. Updates the light height map,
   * marks affected chunks dirty and applies neighbour effects:
   * - a slab placed on a slab merges into a double slab;
   * - plants pop off when the block under them stops supporting them.
   * Returns true when anything changed.
   */
  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    const old = this.blocks[i]!;
    if (old === id) return false;

    if (id === B.SLAB && y > 0 && this.blocks[i - this.sx * this.sz] === B.SLAB) {
      return this.setBlock(x, y - 1, z, B.DOUBLE_SLAB);
    }

    this.blocks[i] = id;
    this.changeCount++;
    this.markCellDirty(x, y, z);

    const oldH = this.heightMap.update(this.blocks, x, y, z, id);
    const newH = this.heightMap.get(x, z);
    if (oldH !== newH) this.markLightDirty(x, z, oldH, newH);

    for (const listener of this.listeners) listener(x, y, z, old, id);

    // Plants pop off when their support goes away.
    if (y + 1 < this.sy && !supportsPlant(id)) {
      const above = this.blocks[i + this.sx * this.sz]!;
      if (IS_PLANT[above]) this.setBlock(x, y + 1, z, B.AIR);
    }
    return true;
  }

  chunkIndex(cx: number, cy: number, cz: number): number {
    return (cy * this.chunksZ + cz) * this.chunksX + cx;
  }

  markChunkDirty(cx: number, cy: number, cz: number): void {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.chunksX || cy >= this.chunksY || cz >= this.chunksZ) return;
    this.dirty.add(this.chunkIndex(cx, cy, cz));
  }

  markAllDirty(): void {
    for (let i = 0; i < this.chunkCount; i++) this.dirty.add(i);
  }

  /** Dirty the cell's chunk plus any chunk that shares the touched faces. */
  markCellDirty(x: number, y: number, z: number): void {
    const cx = x >> CHUNK_SHIFT;
    const cy = y >> CHUNK_SHIFT;
    const cz = z >> CHUNK_SHIFT;
    this.markChunkDirty(cx, cy, cz);
    const m = CHUNK_SIZE - 1;
    const lx = x & m;
    const ly = y & m;
    const lz = z & m;
    if (lx === 0) this.markChunkDirty(cx - 1, cy, cz);
    else if (lx === m) this.markChunkDirty(cx + 1, cy, cz);
    if (ly === 0) this.markChunkDirty(cx, cy - 1, cz);
    else if (ly === m) this.markChunkDirty(cx, cy + 1, cz);
    if (lz === 0) this.markChunkDirty(cx, cy, cz - 1);
    else if (lz === m) this.markChunkDirty(cx, cy, cz + 1);
  }

  /**
   * A column's light height moved from `oldH` to `newH`: every face that looks
   * into a cell between them changed brightness. Dirty the chunks spanning that
   * range in this column and its four neighbours.
   */
  private markLightDirty(x: number, z: number, oldH: number, newH: number): void {
    const lo = Math.max(0, Math.min(oldH, newH));
    const hi = Math.min(this.sy - 1, Math.max(oldH, newH) + 1);
    const cyLo = lo >> CHUNK_SHIFT;
    const cyHi = hi >> CHUNK_SHIFT;
    const cols: ReadonlyArray<readonly [number, number]> = [
      [x, z],
      [x + 1, z],
      [x - 1, z],
      [x, z + 1],
      [x, z - 1],
    ];
    for (const [cx0, cz0] of cols) {
      if (cx0 < 0 || cz0 < 0 || cx0 >= this.sx || cz0 >= this.sz) continue;
      for (let cy = cyLo; cy <= cyHi; cy++) this.markChunkDirty(cx0 >> CHUNK_SHIFT, cy, cz0 >> CHUNK_SHIFT);
    }
  }
}
