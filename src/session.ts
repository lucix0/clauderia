import { DEBUG_SEED } from './config';
import { loadChunk, loadChunks, packChunks, saveBatch } from './save/db';
import {
  chunkStoreKey,
  emptyExtras,
  type ChunkExtras,
  newWorldId,
  WORLD_FORMAT_VERSION,
  type ChunkRecord,
  type ClassicSizeName,
  type Difficulty,
  type GameMode,
  type PlayerRecord,
  type WorldRecord,
} from './save/records';
import type { Chunk } from './world/chunk';
import { INFINITE_HEIGHT, INFINITE_SEA_LEVEL, infiniteGenerator } from './world/gen/infinite';
import { generateAsync } from './world/generate';
import { findSpawn } from './world/generator';
import { WORLD_SIZES } from './world/sizes';
import { Ticker } from './world/ticker';
import { World } from './world/world';

export type Progress = (stage: string, fraction: number) => void;

export interface NewWorldSpec {
  name: string;
  seed: number;
  type: 'classic' | 'infinite';
  classicSize: ClassicSizeName;
  gameMode: GameMode;
  difficulty: Difficulty;
}

/**
 * A loaded world together with its metadata record, block behaviours and
 * persistence. Debug sessions are never written to storage.
 */
export class WorldSession {
  readonly ticker: Ticker;
  private running: Promise<boolean> | null = null;
  /** Records of unloaded chunks not yet written (read back before the DB). */
  private readonly pendingWrites = new Map<string, ChunkRecord>();
  private flushTimer = 0;
  /** Ticks into the day (0–23999). */
  time: number;
  /** Stop the day cycle for this world. */
  lockDaytime: boolean;
  private queued: Promise<boolean> | null = null;
  private nextPlayer: PlayerRecord | null = null;
  /**
   * Entities and block entities stored with a chunk (set by the game);
   * `remove` takes them out of the live world (the chunk is unloading).
   */
  extrasFor: (chunk: Chunk, remove: boolean) => ChunkExtras = () => emptyExtras();
  /** Records read while opening a Classic world, for their entities. */
  initialRecords: ChunkRecord[] = [];

  private constructor(
    readonly world: World,
    public record: WorldRecord,
    readonly persistent: boolean,
  ) {
    this.ticker = new Ticker(world);
    this.time = record.time;
    this.lockDaytime = record.lockDaytime;
  }

  /** Advance the clock by one tick (20 per second) unless daytime is locked. */
  tickTime(): void {
    if (!this.lockDaytime) this.time = (this.time + 1) % 24000;
  }

  /** Build the record for a brand-new world. */
  static newRecord(spec: NewWorldSpec): WorldRecord {
    const now = Date.now();
    return {
      formatVersion: WORLD_FORMAT_VERSION,
      id: newWorldId(),
      name: spec.name,
      seed: spec.seed >>> 0,
      type: spec.type,
      classicSize: spec.type === 'classic' ? spec.classicSize : null,
      gameMode: spec.gameMode,
      difficulty: spec.difficulty,
      lockDaytime: false,
      time: 1000,
      spawn: null,
      player: null,
      createdAt: now,
      lastPlayed: now,
    };
  }

  /** Generate (or regenerate) a Classic world and apply stored changes. */
  static async openClassic(record: WorldRecord, persistent: boolean, progress: Progress): Promise<WorldSession> {
    const size = WORLD_SIZES[record.classicSize ?? 'normal'];
    const level = await generateAsync({ sx: size.sx, sy: size.sy, sz: size.sz, seed: record.seed }, (stage, f) =>
      progress(stage, f * 0.7),
    );
    if (!record.spawn) record.spawn = findSpawn(level, size.sx, size.sy, size.sz);
    const world = World.fromClassicLevel(level, size.sx, size.sy, size.sz, record.seed);
    let records: ChunkRecord[] = [];
    if (persistent) {
      progress('Reading saved chunks', 0.72);
      records = await loadChunks(record.id);
      applyRecords(world, records);
    }
    const session = new WorldSession(world, record, persistent);
    session.initialRecords = records;
    return session;
  }

  /**
   * Open an Infinite world. Chunks stream in later; a new world's spawn
   * column is picked now and its height (y = −1) once the ground loads.
   */
  static openInfinite(record: WorldRecord, persistent: boolean): WorldSession {
    const world = new World({ type: 'infinite', seed: record.seed, height: INFINITE_HEIGHT, seaLevel: INFINITE_SEA_LEVEL });
    if (!record.spawn) {
      const col = infiniteGenerator(record.seed).findSpawnColumn();
      record.spawn = { x: col.x + 0.5, y: -1, z: col.z + 0.5 };
    }
    return new WorldSession(world, record, persistent);
  }

  static async open(record: WorldRecord, persistent: boolean, progress: Progress): Promise<WorldSession> {
    return record.type === 'classic'
      ? WorldSession.openClassic(record, persistent, progress)
      : WorldSession.openInfinite(record, persistent);
  }

  /** A throwaway session for ?debug (fixed seed, never saved). */
  static async openDebug(type: 'classic' | 'infinite', size: ClassicSizeName, progress: Progress): Promise<WorldSession> {
    const record = WorldSession.newRecord({
      name: 'Debug',
      seed: DEBUG_SEED,
      type,
      classicSize: size,
      gameMode: 'creative',
      difficulty: 'normal',
    });
    // Stable screenshots: noon, clock stopped (`/time set` still works).
    record.time = 6000;
    record.lockDaytime = true;
    return WorldSession.open(record, false, progress);
  }

  get spawn(): { x: number; y: number; z: number } {
    return this.record.spawn ?? { x: 0.5, y: this.world.seaLevel + 1, z: 0.5 };
  }

  /** Spawn height still unknown (waiting for its chunk to load). */
  get spawnPending(): boolean {
    return this.spawn.y < 0;
  }

  setSpawn(x: number, y: number, z: number): void {
    this.record = { ...this.record, spawn: { x, y, z } };
  }

  // ---- Streaming persistence (Infinite) ----

  /** Stored record of a chunk that is about to be generated. */
  async loadRecord(cx: number, cz: number): Promise<ChunkRecord | null> {
    const pending = this.pendingWrites.get(chunkStoreKey(this.record.id, cx, cz));
    if (pending) return pending;
    if (!this.persistent) return null;
    return loadChunk(this.record.id, cx, cz);
  }

  /** Chunks left memory: keep changed ones (and their entities) until they are written. */
  chunksUnloaded(chunks: readonly Chunk[]): void {
    let queued = false;
    for (const c of chunks) {
      const extras = this.extrasFor(c, true);
      if (!this.persistent) continue;
      const has = hasExtras(extras);
      if (!c.modified && !has && !c.storedExtras) continue;
      this.pendingWrites.set(chunkStoreKey(this.record.id, c.cx, c.cz), {
        cx: c.cx,
        cz: c.cz,
        blocks: c.modified ? c.blocks.slice() : null,
        extras,
      });
      queued = true;
    }
    if (queued && !this.flushTimer) {
      this.flushTimer = window.setTimeout(() => {
        this.flushTimer = 0;
        void this.flushPending();
      }, 1500);
    }
  }

  /** Write unloaded-chunk records in one transaction. */
  async flushPending(): Promise<void> {
    if (this.pendingWrites.size === 0) return;
    const batch = [...this.pendingWrites.entries()];
    try {
      await saveBatch(null, await packChunks(this.record.id, batch.map(([, r]) => r)));
      for (const [key, rec] of batch) if (this.pendingWrites.get(key) === rec) this.pendingWrites.delete(key);
    } catch (err) {
      console.warn('Could not write unloaded chunks:', err);
    }
  }

  /** Changed chunks (and chunks holding entities) that need writing. */
  unsavedChunks(): ChunkRecord[] {
    const out: ChunkRecord[] = [];
    for (const c of this.world.chunks.values()) {
      const extras = this.extrasFor(c, false);
      const has = hasExtras(extras);
      if (!(c.modified && c.version !== c.savedVersion) && !has && !c.storedExtras) continue;
      out.push({ cx: c.cx, cz: c.cz, blocks: c.modified ? c.blocks.slice() : null, extras });
    }
    return out;
  }

  /**
   * Write the world record and every changed chunk in one transaction.
   * A request made while a save is running queues exactly one follow-up
   * save (with the newest player state), so no change is ever skipped.
   */
  save(player: PlayerRecord): Promise<boolean> {
    if (!this.persistent) return Promise.resolve(false);
    this.nextPlayer = player;
    if (this.queued) return this.queued;
    const previous = this.running ?? Promise.resolve(true);
    const job = previous
      .catch(() => false)
      .then(() => {
        this.queued = null;
        const run = this.writeNow(this.nextPlayer ?? player);
        this.running = run;
        return run.finally(() => {
          if (this.running === run) this.running = null;
        });
      });
    this.queued = job;
    return job;
  }

  private async writeNow(player: PlayerRecord): Promise<boolean> {
    const versions = new Map<number, number>();
    for (const c of this.world.chunks.values()) versions.set(c.key, c.version);
    const pending = [...this.pendingWrites.entries()];
    // Pending records first: a newer copy of a reloaded chunk overwrites them.
    const chunks = [...pending.map(([, r]) => r), ...this.unsavedChunks()];
    this.record = {
      ...this.record,
      player,
      time: Math.floor(this.time),
      lockDaytime: this.lockDaytime,
      lastPlayed: Date.now(),
    };
    await saveBatch(this.record, await packChunks(this.record.id, chunks));
    for (const [key, rec] of pending) if (this.pendingWrites.get(key) === rec) this.pendingWrites.delete(key);
    for (const rec of chunks) {
      const c = this.world.getChunk(rec.cx, rec.cz);
      if (c) c.storedExtras = hasExtras(rec.extras);
    }
    for (const c of this.world.chunks.values()) {
      const v = versions.get(c.key);
      if (v !== undefined) c.savedVersion = v;
    }
    return true;
  }

  dispose(): void {
    this.ticker.dispose();
    if (this.flushTimer) window.clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    void this.flushPending();
  }
}

function hasExtras(e: ChunkExtras): boolean {
  return e.items.length > 0 || e.blockEntities.length > 0 || e.mobs.length > 0;
}

/** Overwrite generated chunks with stored ones. */
export function applyRecords(world: World, records: readonly ChunkRecord[]): void {
  for (const rec of records) {
    const chunk = world.getChunk(rec.cx, rec.cz);
    if (!chunk) continue;
    chunk.storedExtras = hasExtras(rec.extras);
    if (!rec.blocks) continue;
    chunk.blocks.set(rec.blocks);
    chunk.modified = true;
    world.addChunk(chunk);
  }
}
