import { describe, expect, it } from 'vitest';
import { gunzip, gzip } from '../src/save/compress';
import { deserializeSave, SaveFormatError, serializeSave, type SaveData } from '../src/save/serialize';
import { sanitizeSettings } from '../src/ui/settings';
import { B, DEFAULT_HOTBAR } from '../src/world/blocks';
import { generateLevel } from '../src/world/generator';

function sample(): SaveData {
  const sx = 32;
  const sy = 64;
  const sz = 48;
  return {
    world: { sx, sy, sz, seed: 0xdeadbeef, blocks: generateLevel({ sx, sy, sz, seed: 99 }) },
    player: { x: 12.25, y: 40.5, z: 7.75, yaw: 1.5, pitch: -0.25, flying: true, spawnX: 16.5, spawnY: 33, spawnZ: 24.5 },
    hotbar: [...DEFAULT_HOTBAR.slice(0, 8), B.GOLD_BLOCK],
    selected: 4,
  };
}

describe('save round-trip', () => {
  it('restores world, player and hotbar exactly', () => {
    const data = sample();
    const back = deserializeSave(serializeSave(data));
    expect(back.world.sx).toBe(32);
    expect(back.world.sy).toBe(64);
    expect(back.world.sz).toBe(48);
    expect(back.world.seed).toBe(0xdeadbeef);
    expect(back.world.blocks).toEqual(data.world.blocks);
    expect(back.player).toEqual(data.player);
    expect(back.hotbar).toEqual(data.hotbar);
    expect(back.selected).toBe(4);
  });

  it('survives gzip compression', async () => {
    const data = sample();
    const raw = serializeSave(data);
    const packed = await gzip(raw);
    expect(packed.length).toBeLessThan(raw.length / 4);
    const back = deserializeSave(await gunzip(packed));
    expect(back.world.blocks).toEqual(data.world.blocks);
    expect(back.player.x).toBe(12.25);
  });

  it('rejects corrupt or foreign data', () => {
    const raw = serializeSave(sample());
    expect(() => deserializeSave(new Uint8Array(10))).toThrow(SaveFormatError);
    const wrongMagic = raw.slice();
    wrongMagic[0] = 0;
    expect(() => deserializeSave(wrongMagic)).toThrow(/Not a Blocktide save/);
    expect(() => deserializeSave(raw.slice(0, raw.length - 1))).toThrow(SaveFormatError);
    const badBlock = raw.slice();
    badBlock[badBlock.length - 1] = 250;
    expect(() => deserializeSave(badBlock)).toThrow(/Unknown block id/);
  });
});

describe('settings', () => {
  it('fills defaults and clamps bad values', () => {
    expect(sanitizeSettings(null)).toEqual({ sensitivity: 1, fov: 70, renderDistance: 3, invertY: false });
    const s = sanitizeSettings({ sensitivity: 99, fov: 'wide', renderDistance: -3, invertY: true });
    expect(s).toEqual({ sensitivity: 4, fov: 70, renderDistance: 0, invertY: true });
  });
});
