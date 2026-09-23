import type { ChunkRenderer } from '../render/chunks';
import type { ChunkMeshData } from '../render/mesher';
import { buildMeshInput } from '../render/meshInput';
import type { ChunkRecord } from '../save/records';
import { Chunk } from '../world/chunk';
import { chunkKey, toChunk } from '../world/coords';
import { buildLightRegion } from '../world/lightRegion';
import type { World } from '../world/world';
import type { WorkerPool } from '../workers/pool';

export interface StreamerHooks {
  /** Stored record for a chunk about to be generated (infinite worlds). */
  loadRecord(cx: number, cz: number): Promise<ChunkRecord | null>;
  /** A freshly added chunk (apply saved entities etc.). */
  added?(chunk: Chunk, record: ChunkRecord | null): void;
  /** Chunks leaving memory; modified ones must be persisted. */
  unloaded(chunks: Chunk[]): void;
}

interface ColumnState {
  readonly cx: number;
  readonly cz: number;
  readonly key: number;
  genPending: boolean;
  lightPending: boolean;
  meshPending: boolean;
  meshed: boolean;
}

interface Upload {
  chunk: Chunk;
  sig: number;
  sections: Array<ChunkMeshData | null>;
}

/** Extra chunk rings: generate R+2, light R+1, mesh R, unload beyond R+3. */
const GEN_MARGIN = 2;
const UNLOAD_MARGIN = 3;

/**
 * Keeps the chunks around the camera generated and meshed. Work runs in the
 * worker pool, nearest and in-view first; the main thread only adds chunk
 * data and uploads finished meshes within a per-frame budget.
 */
export class Streamer {
  radius = 8;
  /** Mesh jobs finished and uploaded (stats). */
  uploads = 0;
  lastMeshMs = 0;
  lastLightMs = 0;
  private readonly states = new Map<number, ColumnState>();
  /** Finished meshes waiting for upload, newest per column. */
  private readonly uploadsQueue = new Map<number, Upload>();
  private centerX = 0;
  private centerZ = 0;
  private viewX = 0;
  private viewZ = -1;
  private disposed = false;

  constructor(
    private readonly world: World,
    private readonly pool: WorkerPool,
    private readonly renderer: ChunkRenderer,
    private readonly hooks: StreamerHooks,
  ) {}

  get queued(): number {
    return this.pool.queued + this.uploadsQueue.size;
  }

  get loadedColumns(): number {
    return this.world.chunks.size;
  }

  /** Is this column's terrain loaded, lit and safe to simulate in? */
  isActive(x: number, z: number): boolean {
    const c = this.world.chunkAt(x, z);
    return c !== undefined && c.lit;
  }

  /** Fraction of the columns within `r` of (cx, cz) that are meshed. */
  meshedFraction(cx: number, cz: number, r: number): number {
    let total = 0;
    let done = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (!this.wanted(cx + dx, cz + dz)) continue;
        total++;
        if (this.states.get(chunkKey(cx + dx, cz + dz))?.meshed) done++;
      }
    }
    return total === 0 ? 1 : done / total;
  }

  /** Update the camera used for priorities. */
  setView(x: number, z: number, dirX: number, dirZ: number): void {
    this.centerX = x;
    this.centerZ = z;
    const len = Math.hypot(dirX, dirZ) || 1;
    this.viewX = dirX / len;
    this.viewZ = dirZ / len;
  }

  /** Queue generation / meshing, unload far chunks, dispatch work. */
  update(): void {
    if (this.disposed) return;
    const R = this.radius;
    const ccx = toChunk(Math.floor(this.centerX));
    const ccz = toChunk(Math.floor(this.centerZ));
    const genR = R + GEN_MARGIN;
    const infinite = this.world.type === 'infinite';

    for (let dz = -genR; dz <= genR; dz++) {
      for (let dx = -genR; dx <= genR; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        if (!this.wanted(cx, cz)) continue;
        const key = chunkKey(cx, cz);
        let st = this.states.get(key);
        if (!st) {
          st = { cx, cz, key, genPending: false, lightPending: false, meshPending: false, meshed: false };
          this.states.set(key, st);
        }
        const chunk = this.world.chunks.get(key);
        if (!chunk) {
          if (infinite && !st.genPending) this.requestGenerate(st);
          continue;
        }
        const lightR = R + 1;
        if (!chunk.lit) {
          if (!st.lightPending && Math.abs(dx) <= lightR && Math.abs(dz) <= lightR && this.neighboursGenerated(cx, cz)) {
            this.requestLight(st, chunk);
          }
          continue;
        }
        if (!st.meshed && !st.meshPending && dx * dx + dz * dz <= (R + 0.5) * (R + 0.5) && this.neighboursReady(cx, cz)) {
          this.requestMesh(st, chunk);
        }
      }
    }

    // Unload (or for Classic, just un-mesh) far columns.
    const unloadR = R + UNLOAD_MARGIN;
    const gone: Chunk[] = [];
    for (const st of [...this.states.values()]) {
      const far = Math.max(Math.abs(st.cx - ccx), Math.abs(st.cz - ccz)) > unloadR;
      if (!far) continue;
      const chunk = this.world.chunks.get(st.key);
      if (chunk) {
        this.renderer.dropColumn(chunk);
        if (infinite) {
          this.world.removeChunk(chunk);
          gone.push(chunk);
        }
      }
      this.pool.cancel(jobKey('gen', st.key));
      this.pool.cancel(jobKey('light', st.key));
      this.pool.cancel(jobKey('mesh', st.key));
      this.states.delete(st.key);
    }
    if (gone.length) this.hooks.unloaded(gone);
    this.pool.dispatch();
  }

  /** Upload finished meshes until the budget is spent (at least one). */
  upload(budgetMs: number): number {
    const start = performance.now();
    let n = 0;
    for (const [key, up] of this.uploadsQueue) {
      this.uploadsQueue.delete(key);
      const st = this.states.get(key);
      if (!st || this.world.chunks.get(key) !== up.chunk) continue;
      st.meshPending = false;
      if (this.signature(up.chunk) !== up.sig) {
        // Stale: something changed while meshing; ask again.
        st.meshed = false;
        continue;
      }
      this.renderer.applyColumn(up.chunk, up.sections);
      st.meshed = true;
      this.uploads++;
      n++;
      if (performance.now() - start >= budgetMs) break;
    }
    return n;
  }

  /** Rebuild every column's mesh (e.g. a rendering setting changed). */
  invalidateAll(): void {
    for (const st of this.states.values()) st.meshed = false;
  }

  /** Forget a column's mesh so it is rebuilt by the pool (e.g. after relighting). */
  invalidate(cx: number, cz: number): void {
    const st = this.states.get(chunkKey(cx, cz));
    if (st) st.meshed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.pool.retain(() => false);
    this.states.clear();
    this.uploadsQueue.clear();
  }

  // ---- internals ----

  /** Within the world (Classic bounds) at all? */
  private wanted(cx: number, cz: number): boolean {
    const b = this.world.bounds;
    return !b || (cx >= 0 && cz >= 0 && cx * 16 < b.sx && cz * 16 < b.sz);
  }

  private neighboursGenerated(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.wanted(cx + dx, cz + dz)) continue;
        if (!this.world.getChunk(cx + dx, cz + dz)) return false;
      }
    }
    return true;
  }

  private neighboursReady(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.wanted(cx + dx, cz + dz)) continue; // Classic edge: virtual ocean
        const c = this.world.getChunk(cx + dx, cz + dz);
        if (!c || !c.lit) return false;
      }
    }
    return true;
  }

  /** Changes whenever any block in the 3×3 neighbourhood changes. */
  private signature(chunk: Chunk): number {
    let sig = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
        if (c) sig += c.version + c.loadId * 7919;
      }
    }
    return sig;
  }

  private priority(cx: number, cz: number, bias: number): number {
    const dx = (cx + 0.5) * 16 - this.centerX;
    const dz = (cz + 0.5) * 16 - this.centerZ;
    const d = Math.hypot(dx, dz) / 16;
    // Columns in front of the camera come first.
    const facing = d < 1.5 ? 1 : (dx * this.viewX + dz * this.viewZ) / (d * 16);
    const inView = facing > 0.45 ? 0.55 : 1;
    return d * inView + bias;
  }

  private requestGenerate(st: ColumnState): void {
    st.genPending = true;
    const seed = this.world.seed;
    const recordPromise = this.hooks.loadRecord(st.cx, st.cz).catch(() => null);
    this.pool.submit({
      key: jobKey('gen', st.key),
      request: { kind: 'generate', seed, cx: st.cx, cz: st.cz },
      priority: () => this.priority(st.cx, st.cz, 0.25),
      onDone: (result) => {
        if (result.kind !== 'generate') return;
        void recordPromise.then((record) => {
          st.genPending = false;
          if (this.disposed || this.states.get(st.key) !== st || this.world.chunks.has(st.key)) return;
          const chunk = new Chunk(st.cx, st.cz, result.blocks);
          chunk.tints = result.tints;
          chunk.biomes = result.biomes;
          if (record?.blocks) {
            chunk.blocks.set(record.blocks);
            chunk.modified = true;
          }
          if (record) {
            const e = record.extras;
            chunk.storedExtras = e.items.length > 0 || e.blockEntities.length > 0 || e.mobs.length > 0;
          }
          this.world.addChunk(chunk);
          this.hooks.added?.(chunk, record);
        });
      },
      onError: (error) => {
        st.genPending = false;
        console.warn('Chunk generation failed:', error);
      },
    });
  }

  private requestLight(st: ColumnState, chunk: Chunk): void {
    st.lightPending = true;
    let sig = 0;
    this.pool.submit({
      key: jobKey('light', st.key),
      request: () => {
        if (this.world.chunks.get(st.key) !== chunk) {
          st.lightPending = false;
          return null;
        }
        sig = this.signature(chunk);
        return { kind: 'light', cx: st.cx, cz: st.cz, ids: buildLightRegion(this.world, st.cx, st.cz) };
      },
      priority: () => this.priority(st.cx, st.cz, 0.1),
      onDone: (result) => {
        st.lightPending = false;
        if (result.kind !== 'light' || this.disposed) return;
        this.lastLightMs = result.ms;
        if (this.world.chunks.get(st.key) !== chunk || chunk.lit) return;
        // Computed from blocks that changed since: ask again.
        if (this.signature(chunk) !== sig) return;
        this.world.setChunkLight(chunk, result.light);
      },
      onError: (error) => {
        st.lightPending = false;
        console.warn('Chunk lighting failed:', error);
      },
    });
  }

  private requestMesh(st: ColumnState, chunk: Chunk): void {
    st.meshPending = true;
    let sig = 0;
    this.pool.submit({
      key: jobKey('mesh', st.key),
      request: () => {
        if (this.world.chunks.get(st.key) !== chunk) {
          st.meshPending = false;
          return null;
        }
        sig = this.signature(chunk);
        chunk.dirtySections = 0;
        this.world.dirtyChunks.delete(chunk);
        return { kind: 'mesh', input: buildMeshInput(this.world, chunk, chunk.nonEmpty, this.renderer.lightReader, this.renderer.smooth) };
      },
      priority: () => this.priority(st.cx, st.cz, 0),
      onDone: (result) => {
        // Stays pending until the upload is applied, so it isn't re-requested.
        if (result.kind !== 'mesh') {
          st.meshPending = false;
          return;
        }
        this.lastMeshMs = result.ms;
        this.uploadsQueue.set(st.key, { chunk, sig, sections: result.sections });
      },
      onError: (error) => {
        st.meshPending = false;
        console.warn('Chunk meshing failed:', error);
      },
    });
  }
}

function jobKey(kind: string, key: number): string {
  return `${kind}:${key}`;
}
