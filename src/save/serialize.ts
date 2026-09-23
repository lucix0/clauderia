/**
 * Pure binary (de)serialisation of a save: world blocks + size + seed,
 * player position / orientation / spawn, and the hotbar. Little-endian.
 */
import { BLOCK_COUNT } from '../world/blocks';

export const SAVE_MAGIC = 0x544b4c42; // "BLKT"
export const SAVE_VERSION = 1;

export interface SaveData {
  world: { sx: number; sy: number; sz: number; seed: number; blocks: Uint8Array };
  player: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    flying: boolean;
    spawnX: number;
    spawnY: number;
    spawnZ: number;
  };
  hotbar: number[];
  selected: number;
}

const HEADER_BYTES = 4 + 2 + 2 * 3 + 4 + 4 * 8 + 1 + 1 + 1;

export function serializeSave(data: SaveData): Uint8Array<ArrayBuffer> {
  const { world, player, hotbar } = data;
  const volume = world.sx * world.sy * world.sz;
  if (world.blocks.length !== volume) throw new Error('Block array does not match world size');
  if (hotbar.length > 255) throw new Error('Hotbar too long');
  const size = HEADER_BYTES + hotbar.length + 4 + volume;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, SAVE_MAGIC, true);
  o += 4;
  view.setUint16(o, SAVE_VERSION, true);
  o += 2;
  for (const n of [world.sx, world.sy, world.sz]) {
    view.setUint16(o, n, true);
    o += 2;
  }
  view.setUint32(o, world.seed >>> 0, true);
  o += 4;
  for (const f of [player.x, player.y, player.z, player.yaw, player.pitch, player.spawnX, player.spawnY, player.spawnZ]) {
    view.setFloat32(o, f, true);
    o += 4;
  }
  view.setUint8(o++, player.flying ? 1 : 0);
  view.setUint8(o++, data.selected);
  view.setUint8(o++, hotbar.length);
  for (const id of hotbar) view.setUint8(o++, id);
  view.setUint32(o, volume, true);
  o += 4;
  out.set(world.blocks, o);
  return out;
}

export class SaveFormatError extends Error {}

export function deserializeSave(bytes: Uint8Array): SaveData {
  if (bytes.length < HEADER_BYTES + 4) throw new SaveFormatError('Save file is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  if (view.getUint32(o, true) !== SAVE_MAGIC) throw new SaveFormatError('Not a Blocktide save');
  o += 4;
  const version = view.getUint16(o, true);
  o += 2;
  if (version !== SAVE_VERSION) throw new SaveFormatError(`Unsupported save version ${version}`);
  const sx = view.getUint16(o, true);
  const sy = view.getUint16(o + 2, true);
  const sz = view.getUint16(o + 4, true);
  o += 6;
  const seed = view.getUint32(o, true);
  o += 4;
  const f: number[] = [];
  for (let i = 0; i < 8; i++) {
    f.push(view.getFloat32(o, true));
    o += 4;
  }
  const flying = view.getUint8(o++) === 1;
  const selected = view.getUint8(o++);
  const hotbarLen = view.getUint8(o++);
  if (bytes.length < o + hotbarLen + 4) throw new SaveFormatError('Save file is truncated');
  const hotbar: number[] = [];
  for (let i = 0; i < hotbarLen; i++) hotbar.push(view.getUint8(o++));
  const volume = view.getUint32(o, true);
  o += 4;
  if (sx === 0 || sy === 0 || sz === 0 || volume !== sx * sy * sz) throw new SaveFormatError('Bad world size');
  if (bytes.length !== o + volume) throw new SaveFormatError('Save file size mismatch');
  const blocks = bytes.slice(o, o + volume);
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]! >= BLOCK_COUNT) throw new SaveFormatError(`Unknown block id ${blocks[i]}`);
  }
  if (f.some((n) => !Number.isFinite(n))) throw new SaveFormatError('Bad player data');
  return {
    world: { sx, sy, sz, seed, blocks },
    player: {
      x: f[0]!,
      y: f[1]!,
      z: f[2]!,
      yaw: f[3]!,
      pitch: f[4]!,
      spawnX: f[5]!,
      spawnY: f[6]!,
      spawnZ: f[7]!,
      flying,
    },
    hotbar,
    selected,
  };
}
