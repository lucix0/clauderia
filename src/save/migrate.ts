/**
 * v1 → v2 migration (pure): the single v1 save becomes a Classic world.
 * Chunks that differ from a fresh regeneration are stored as chunk records.
 */
import { CHUNK_SIZE, CHUNK_VOLUME, localIndex } from '../world/coords';
import { generateLevel } from '../world/generator';
import {
  emptyExtras,
  WORLD_FORMAT_VERSION,
  type ChunkRecord,
  type ClassicSizeName,
  type WorldRecord,
} from './records';
import type { SaveData } from './serialize';

const SIZE_BY_WIDTH: Record<number, ClassicSizeName> = { 128: 'small', 256: 'normal', 512: 'large' };

export function classicSizeFor(sx: number, sy: number, sz: number): ClassicSizeName | null {
  if (sx !== sz || sy !== 64) return null;
  return SIZE_BY_WIDTH[sx] ?? null;
}

export interface Migrated {
  world: WorldRecord;
  chunks: ChunkRecord[];
}

/**
 * Convert a decoded v1 save. `regenerate` defaults to the Classic generator
 * and is injectable for tests.
 */
export function migrateV1(
  data: SaveData,
  id: string,
  now: number,
  regenerate: (sx: number, sy: number, sz: number, seed: number) => Uint8Array = (sx, sy, sz, seed) =>
    generateLevel({ sx, sy, sz, seed }),
): Migrated {
  const { sx, sy, sz, seed, blocks } = data.world;
  const size = classicSizeFor(sx, sy, sz);
  if (!size) throw new Error(`Can't migrate a ${sx}×${sy}×${sz} world`);
  const fresh = regenerate(sx, sy, sz, seed);
  const chunks: ChunkRecord[] = [];
  for (let cz = 0; cz < sz / CHUNK_SIZE; cz++) {
    for (let cx = 0; cx < sx / CHUNK_SIZE; cx++) {
      let differs = false;
      const out = new Uint16Array(CHUNK_VOLUME);
      for (let y = 0; y < sy; y++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          const src = (y * sz + cz * CHUNK_SIZE + lz) * sx + cx * CHUNK_SIZE;
          const dst = localIndex(0, y, lz);
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const v = blocks[src + lx]!;
            out[dst + lx] = v;
            if (v !== fresh[src + lx]) differs = true;
          }
        }
      }
      if (differs) chunks.push({ cx, cz, blocks: out, extras: emptyExtras() });
    }
  }
  const p = data.player;
  const world: WorldRecord = {
    formatVersion: WORLD_FORMAT_VERSION,
    id,
    name: 'My first world',
    seed,
    type: 'classic',
    classicSize: size,
    gameMode: 'creative',
    difficulty: 'normal',
    lockDaytime: true,
    time: 6000,
    spawn: { x: p.spawnX, y: p.spawnY, z: p.spawnZ },
    player: {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      flying: p.flying,
      hotbar: [...data.hotbar],
      selected: data.selected,
    },
    createdAt: now,
    lastPlayed: now,
  };
  return { world, chunks };
}
