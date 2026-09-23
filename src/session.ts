import { DEBUG_SEED } from './config';
import { loadChunks, packChunks, saveBatch } from './save/db';
import {
  emptyExtras,
  newWorldId,
  WORLD_FORMAT_VERSION,
  type ChunkRecord,
  type ClassicSizeName,
  type Difficulty,
  type GameMode,
  type PlayerRecord,
  type WorldRecord,
} from './save/records';
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
  private queued: Promise<boolean> | null = null;
  private nextPlayer: PlayerRecord | null = null;

  private constructor(
    readonly world: World,
    public record: WorldRecord,
    readonly persistent: boolean,
  ) {
    this.ticker = new Ticker(world);
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
    if (persistent) {
      progress('Reading saved chunks', 0.72);
      applyRecords(world, await loadChunks(record.id));
    }
    return new WorldSession(world, record, persistent);
  }

  /** A throwaway session for ?debug (fixed seed, never saved). */
  static async openDebug(size: ClassicSizeName, progress: Progress): Promise<WorldSession> {
    const record = WorldSession.newRecord({
      name: 'Debug',
      seed: DEBUG_SEED,
      type: 'classic',
      classicSize: size,
      gameMode: 'creative',
      difficulty: 'normal',
    });
    return WorldSession.openClassic(record, false, progress);
  }

  get spawn(): { x: number; y: number; z: number } {
    return this.record.spawn ?? { x: 0.5, y: this.world.seaLevel + 1, z: 0.5 };
  }

  /** Changed chunks that still need writing. */
  unsavedChunks(): ChunkRecord[] {
    const out: ChunkRecord[] = [];
    for (const c of this.world.chunks.values()) {
      if (c.modified && c.version !== c.savedVersion) out.push({ cx: c.cx, cz: c.cz, blocks: c.blocks.slice(), extras: emptyExtras() });
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
    const chunks = this.unsavedChunks();
    this.record = { ...this.record, player, lastPlayed: Date.now() };
    await saveBatch(this.record, await packChunks(this.record.id, chunks));
    for (const c of this.world.chunks.values()) {
      const v = versions.get(c.key);
      if (v !== undefined) c.savedVersion = v;
    }
    return true;
  }

  dispose(): void {
    this.ticker.dispose();
  }
}

/** Overwrite generated chunks with stored ones. */
export function applyRecords(world: World, records: readonly ChunkRecord[]): void {
  for (const rec of records) {
    const chunk = world.getChunk(rec.cx, rec.cz);
    if (!chunk || !rec.blocks) continue;
    chunk.blocks.set(rec.blocks);
    chunk.modified = true;
    world.addChunk(chunk);
  }
}
