import { describe, expect, it } from 'vitest';
import { gunzip, gzip } from '../src/save/compress';
import { migrateV1 } from '../src/save/migrate';
import {
  chunkStoreKey,
  decodeChunkRecord,
  encodeChunkRecord,
  RecordFormatError,
  sanitizeWorldRecord,
  WORLD_FORMAT_VERSION,
  type WorldRecord,
} from '../src/save/records';
import { deserializeSave, serializeSave, type SaveData } from '../src/save/serialize';
import { applyRecords } from '../src/session';
import { B, withState } from '../src/world/blocks';
import { CHUNK_VOLUME, localIndex } from '../src/world/coords';
import { generateLevel } from '../src/world/generator';
import { World } from '../src/world/world';

describe('save v2 chunk records', () => {
  it('round-trips blocks, states and extras through gzip', async () => {
    const blocks = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < blocks.length; i += 97) blocks[i] = withState(B.WATER, i % 8);
    blocks[localIndex(3, 70, 9)] = B.GOLD_BLOCK;
    const extras = { blockEntities: [{ kind: 'chest', slots: [] }], items: [{ id: 3, count: 2 }], mobs: [] };
    const packed = await gzip(encodeChunkRecord({ cx: -7, cz: 12345, blocks, extras }));
    expect(packed.length).toBeLessThan(CHUNK_VOLUME / 4);
    const back = decodeChunkRecord(await gunzip(packed));
    expect(back.cx).toBe(-7);
    expect(back.cz).toBe(12345);
    expect(back.blocks).toEqual(blocks);
    expect(back.extras).toEqual(extras);
  });

  it('stores entity-only records without blocks', () => {
    const rec = decodeChunkRecord(
      encodeChunkRecord({ cx: 1, cz: -1, blocks: null, extras: { blockEntities: [], items: [], mobs: [{ kind: 'pig' }] } }),
    );
    expect(rec.blocks).toBeNull();
    expect(rec.extras.mobs).toEqual([{ kind: 'pig' }]);
  });

  it('rejects garbage', () => {
    expect(() => decodeChunkRecord(new Uint8Array(8))).toThrow(RecordFormatError);
    const good = encodeChunkRecord({ cx: 0, cz: 0, blocks: null, extras: { blockEntities: [], items: [], mobs: [] } });
    const bad = good.slice();
    bad[0] = 0;
    expect(() => decodeChunkRecord(bad)).toThrow(/Not a chunk record/);
    expect(() => decodeChunkRecord(good.slice(0, good.length - 1))).toThrow(RecordFormatError);
  });

  it('keys chunk records by world and chunk', () => {
    expect(chunkStoreKey('abc', -3, 4)).toBe('abc/-3,4');
  });
});

describe('world records', () => {
  const base: WorldRecord = {
    formatVersion: WORLD_FORMAT_VERSION,
    id: 'w1',
    name: 'Test',
    seed: 42,
    type: 'infinite',
    classicSize: null,
    gameMode: 'survival',
    difficulty: 'peaceful',
    lockDaytime: true,
    time: 13000,
    spawn: { x: 1, y: 70, z: -3 },
    player: { x: 1, y: 70, z: -3, yaw: 1, pitch: 0, flying: false, hotbar: [1, 2], selected: 1 },
    createdAt: 1,
    lastPlayed: 2,
  };

  it('keeps valid records intact (structured-clone round trip)', () => {
    expect(sanitizeWorldRecord(structuredClone(base))).toEqual({ ...base, player: { ...base.player, vitals: undefined, inventory: undefined } });
  });

  it('repairs or rejects bad fields', () => {
    expect(sanitizeWorldRecord(null)).toBeNull();
    expect(sanitizeWorldRecord({ ...base, formatVersion: 1 })).toBeNull();
    expect(sanitizeWorldRecord({ ...base, type: 'flat' })).toBeNull();
    const fixed = sanitizeWorldRecord({ ...base, name: '  ', time: -1, gameMode: 'hardcore', player: { x: 'a' } })!;
    expect(fixed.name).toBe('Untitled world');
    expect(fixed.time).toBe(23999);
    expect(fixed.gameMode).toBe('creative');
    expect(fixed.player).toBeNull();
  });
});

describe('v1 migration', () => {
  const fresh = generateLevel({ sx: 128, sy: 64, sz: 128, seed: 99 });
  const regenerate = (): Uint8Array => fresh.slice();

  function v1Save(): SaveData {
    const blocks = fresh.slice();
    // The player built a pillar in chunk (2, 3) and dug a hole in chunk (7, 0).
    for (let y = 40; y < 50; y++) blocks[(y * 128 + 3 * 16 + 5) * 128 + 2 * 16 + 5] = B.BRICKS;
    blocks[(20 * 128 + 4) * 128 + 7 * 16 + 1] = B.AIR;
    return {
      world: { sx: 128, sy: 64, sz: 128, seed: 99, blocks },
      player: { x: 10, y: 40, z: 11, yaw: 1, pitch: -0.5, flying: true, spawnX: 64.5, spawnY: 33, spawnZ: 64.5 },
      hotbar: [1, 4, 43, 3, 5, 15, 16, 18, 42],
      selected: 2,
    };
  }

  it('turns the v1 save into a Classic world storing only changed chunks', () => {
    const data = deserializeSave(serializeSave(v1Save()));
    const m = migrateV1(data, 'migrated', 1000, regenerate);
    expect(m.world.type).toBe('classic');
    expect(m.world.classicSize).toBe('small');
    expect(m.world.seed).toBe(99);
    expect(m.world.player).toMatchObject({ x: 10, y: 40, z: 11, flying: true, selected: 2 });
    expect(m.world.spawn).toEqual({ x: 64.5, y: 33, z: 64.5 });
    expect(m.chunks.map((c) => [c.cx, c.cz]).sort()).toEqual([
      [2, 3],
      [7, 0],
    ]);

    // Regenerate + apply the stored chunks: identical to the v1 blocks.
    const world = World.fromClassicLevel(regenerate(), 128, 64, 128, 99);
    applyRecords(world, m.chunks);
    expect(world.toClassicLevel()).toEqual(data.world.blocks);
    expect(sanitizeWorldRecord(structuredClone(m.world))).not.toBeNull();
  });

  it('refuses sizes the Classic generator never made', () => {
    const data = v1Save();
    data.world = { sx: 32, sy: 64, sz: 32, seed: 1, blocks: new Uint8Array(32 * 64 * 32) };
    expect(() => migrateV1(data, 'x', 0, regenerate)).toThrow(/Can't migrate/);
  });
});
