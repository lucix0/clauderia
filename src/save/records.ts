/**
 * Save format v2, pure part: binary chunk records and the world record shape.
 *
 * Chunk record (then gzipped):
 *   u32 magic "BTC2" · u16 version · u16 flags (bit 0: has blocks) ·
 *   i32 cx · i32 cz · [u16 × 32768 blocks, little-endian] ·
 *   u32 json length · UTF-8 JSON { blockEntities, items, mobs }
 */
import { CHUNK_VOLUME } from '../world/coords';

export const CHUNK_MAGIC = 0x32435442; // "BTC2"
export const CHUNK_RECORD_VERSION = 1;
export const WORLD_FORMAT_VERSION = 2;

/** Entity payload stored with a chunk; typed loosely so old saves stay readable. */
export interface ChunkExtras {
  blockEntities: unknown[];
  items: unknown[];
  mobs: unknown[];
}

export interface ChunkRecord {
  cx: number;
  cz: number;
  /** Present only when the blocks differ from what generation produces. */
  blocks: Uint16Array | null;
  extras: ChunkExtras;
}

export function emptyExtras(): ChunkExtras {
  return { blockEntities: [], items: [], mobs: [] };
}

export class RecordFormatError extends Error {}

export function encodeChunkRecord(rec: ChunkRecord): Uint8Array<ArrayBuffer> {
  if (rec.blocks && rec.blocks.length !== CHUNK_VOLUME) throw new Error('Chunk record has the wrong block count');
  const json = new TextEncoder().encode(JSON.stringify(rec.extras));
  const blockBytes = rec.blocks ? CHUNK_VOLUME * 2 : 0;
  const out = new Uint8Array(16 + blockBytes + 4 + json.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, CHUNK_MAGIC, true);
  view.setUint16(4, CHUNK_RECORD_VERSION, true);
  view.setUint16(6, rec.blocks ? 1 : 0, true);
  view.setInt32(8, rec.cx, true);
  view.setInt32(12, rec.cz, true);
  let o = 16;
  if (rec.blocks) {
    for (let i = 0; i < CHUNK_VOLUME; i++, o += 2) view.setUint16(o, rec.blocks[i]!, true);
  }
  view.setUint32(o, json.length, true);
  out.set(json, o + 4);
  return out;
}

export function decodeChunkRecord(bytes: Uint8Array): ChunkRecord {
  if (bytes.length < 20) throw new RecordFormatError('Chunk record is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== CHUNK_MAGIC) throw new RecordFormatError('Not a chunk record');
  const version = view.getUint16(4, true);
  if (version !== CHUNK_RECORD_VERSION) throw new RecordFormatError(`Unsupported chunk record version ${version}`);
  const flags = view.getUint16(6, true);
  const cx = view.getInt32(8, true);
  const cz = view.getInt32(12, true);
  let o = 16;
  let blocks: Uint16Array | null = null;
  if (flags & 1) {
    if (bytes.length < o + CHUNK_VOLUME * 2 + 4) throw new RecordFormatError('Chunk record is truncated');
    blocks = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < CHUNK_VOLUME; i++, o += 2) blocks[i] = view.getUint16(o, true);
  }
  if (bytes.length < o + 4) throw new RecordFormatError('Chunk record is truncated');
  const len = view.getUint32(o, true);
  o += 4;
  if (bytes.length !== o + len) throw new RecordFormatError('Chunk record size mismatch');
  let extras = emptyExtras();
  if (len > 0) {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + len)));
    extras = sanitizeExtras(parsed);
  }
  return { cx, cz, blocks, extras };
}

function sanitizeExtras(raw: unknown): ChunkExtras {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return { blockEntities: arr(r['blockEntities']), items: arr(r['items']), mobs: arr(r['mobs']) };
}

// ---- World record ----

export type GameMode = 'creative' | 'survival';
export type Difficulty = 'peaceful' | 'normal';
export type ClassicSizeName = 'small' | 'normal' | 'large';

export interface PlayerRecord {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
  hotbar: number[];
  selected: number;
  /** Survival state; absent for worlds that never ran survival. */
  vitals?: unknown;
  inventory?: unknown;
  /** Foot cell of the bed the player last used (their respawn point), if any. */
  bed?: { x: number; y: number; z: number } | null;
}

export interface WorldRecord {
  formatVersion: number;
  id: string;
  name: string;
  seed: number;
  type: 'classic' | 'infinite';
  classicSize: ClassicSizeName | null;
  gameMode: GameMode;
  difficulty: Difficulty;
  lockDaytime: boolean;
  /** Ticks into the day, 0–23999. */
  time: number;
  spawn: { x: number; y: number; z: number } | null;
  player: PlayerRecord | null;
  createdAt: number;
  lastPlayed: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vec(v: unknown): { x: number; y: number; z: number } | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const x = num(r['x'], NaN);
  const y = num(r['y'], NaN);
  const z = num(r['z'], NaN);
  return Number.isFinite(x + y + z) ? { x, y, z } : null;
}

function cell(v: unknown): { x: number; y: number; z: number } | null {
  const p = vec(v);
  return p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null;
}

/** Validate a world record read back from storage. Returns null if unusable. */
export function sanitizeWorldRecord(raw: unknown): WorldRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || r['formatVersion'] !== WORLD_FORMAT_VERSION) return null;
  const type = r['type'] === 'classic' ? 'classic' : r['type'] === 'infinite' ? 'infinite' : null;
  if (!type) return null;
  const size = r['classicSize'];
  const classicSize: ClassicSizeName | null =
    size === 'small' || size === 'normal' || size === 'large' ? size : type === 'classic' ? 'normal' : null;
  let player: PlayerRecord | null = null;
  const p = r['player'];
  if (typeof p === 'object' && p !== null) {
    const pr = p as Record<string, unknown>;
    const pos = vec(pr);
    if (pos) {
      player = {
        ...pos,
        yaw: num(pr['yaw'], 0),
        pitch: num(pr['pitch'], 0),
        flying: pr['flying'] === true,
        hotbar: Array.isArray(pr['hotbar']) ? pr['hotbar'].filter((n): n is number => typeof n === 'number') : [],
        selected: num(pr['selected'], 0),
        vitals: pr['vitals'],
        inventory: pr['inventory'],
      };
      const bed = cell(pr['bed']);
      if (bed) player.bed = bed;
    }
  }
  return {
    formatVersion: WORLD_FORMAT_VERSION,
    id: r['id'],
    name: typeof r['name'] === 'string' && r['name'].trim() ? r['name'] : 'Untitled world',
    seed: num(r['seed'], 0) >>> 0,
    type,
    classicSize,
    gameMode: r['gameMode'] === 'survival' ? 'survival' : 'creative',
    difficulty: r['difficulty'] === 'peaceful' ? 'peaceful' : 'normal',
    lockDaytime: r['lockDaytime'] === true,
    time: ((Math.floor(num(r['time'], 1000)) % 24000) + 24000) % 24000,
    spawn: vec(r['spawn']),
    player,
    createdAt: num(r['createdAt'], 0),
    lastPlayed: num(r['lastPlayed'], 0),
  };
}

/** A random, URL-safe world id. */
export function newWorldId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

export function chunkStoreKey(worldId: string, cx: number, cz: number): string {
  return `${worldId}/${cx},${cz}`;
}
