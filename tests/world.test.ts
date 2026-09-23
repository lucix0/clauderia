import { describe, expect, it } from 'vitest';
import { B, idOf, stateOf, withState } from '../src/world/blocks';
import { Chunk } from '../src/world/chunk';
import {
  chunkFromKey,
  chunkKey,
  floorDiv,
  localIndex,
  mod,
  posFromKey,
  posKey,
  toChunk,
  toLocal,
} from '../src/world/coords';
import { canPlace, placementTarget, placementValue } from '../src/world/placement';
import { World } from '../src/world/world';
import { classicWorld } from './helpers';

describe('coordinate math', () => {
  it('floors toward −∞ and keeps modulo positive', () => {
    expect(floorDiv(-1, 16)).toBe(-1);
    expect(floorDiv(-16, 16)).toBe(-1);
    expect(floorDiv(-17, 16)).toBe(-2);
    expect(floorDiv(15, 16)).toBe(0);
    expect(mod(-1, 16)).toBe(15);
    expect(mod(-16, 16)).toBe(0);
    expect(mod(-17, 16)).toBe(15);
    expect(mod(33, 16)).toBe(1);
  });

  it('splits block coordinates into chunk + local, including negatives', () => {
    for (const v of [-100001, -33, -17, -16, -15, -1, 0, 1, 15, 16, 17, 100000]) {
      expect(toChunk(v)).toBe(floorDiv(v, 16));
      expect(toLocal(v)).toBe(mod(v, 16));
      expect(toChunk(v) * 16 + toLocal(v)).toBe(v);
    }
  });

  it('packs chunk and block positions into exact, reversible keys', () => {
    const keys = new Set<number>();
    for (const [cx, cz] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
      [6250, -6250],
      [-1_000_000, 999_999],
    ] as const) {
      const k = chunkKey(cx, cz);
      expect(Number.isSafeInteger(k)).toBe(true);
      expect(chunkFromKey(k)).toEqual([cx, cz]);
      keys.add(k);
    }
    expect(keys.size).toBe(6);
    for (const p of [
      [0, 0, 0],
      [-1, 5, -1],
      [-100_000, 127, 100_000],
      [123_456, 64, -654_321],
    ] as const) {
      const k = posKey(p[0], p[1], p[2]);
      expect(Number.isSafeInteger(k)).toBe(true);
      expect(posFromKey(k)).toEqual([...p]);
    }
  });

  it('lays chunk cells out y-major so sections are contiguous', () => {
    expect(localIndex(0, 0, 0)).toBe(0);
    expect(localIndex(1, 0, 0)).toBe(1);
    expect(localIndex(0, 0, 1)).toBe(16);
    expect(localIndex(0, 1, 0)).toBe(256);
    expect(localIndex(15, 127, 15)).toBe(16 * 16 * 128 - 1);
    expect(localIndex(0, 16, 0)).toBe(4096); // section 1 starts here
  });

  it('keeps block ids and states apart in 16-bit values', () => {
    const v = withState(B.WATER, 5);
    expect(idOf(v)).toBe(B.WATER);
    expect(stateOf(v)).toBe(5);
  });
});

describe('chunked world', () => {
  it('reads and writes blocks at negative coordinates', () => {
    const w = new World({ type: 'infinite', seed: 1, height: 128, seaLevel: 62 });
    for (const [cx, cz] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ] as const)
      w.addChunk(new Chunk(cx, cz));
    expect(w.setBlock(-1, 10, -1, B.STONE)).toBe(true);
    expect(w.get(-1, 10, -1)).toBe(B.STONE);
    expect(w.getChunk(-1, -1)!.blocks[localIndex(15, 10, 15)]).toBe(B.STONE);
    expect(w.setBlock(-16, 3, 0, B.DIRT)).toBe(true);
    expect(w.getChunk(-1, 0)!.blocks[localIndex(0, 3, 0)]).toBe(B.DIRT);
    // Unloaded chunks read as air and refuse writes.
    expect(w.get(-17, 3, 0)).toBe(B.AIR);
    expect(w.setBlock(-17, 3, 0, B.DIRT)).toBe(false);
  });

  it('converts Classic levels to chunks and back without loss', () => {
    const level = new Uint8Array(32 * 64 * 48);
    for (let i = 0; i < level.length; i++) level[i] = (i * 7) % 48;
    const w = World.fromClassicLevel(level, 32, 64, 48, 5);
    expect(w.chunks.size).toBe(2 * 3);
    expect(w.bounds).toEqual({ sx: 32, sz: 48 });
    expect(w.height).toBe(64);
    expect(w.seaLevel).toBe(32);
    expect(w.toClassicLevel()).toEqual(level);
    expect(w.get(5, 7, 40)).toBe(level[(7 * 48 + 40) * 32 + 5]);
  });

  it('treats Classic out-of-bounds cells as air and ignores writes there', () => {
    const w = classicWorld(16, 64, 16);
    expect(w.get(-1, 0, 0)).toBe(B.AIR);
    expect(w.setBlock(16, 0, 0, B.STONE)).toBe(false);
    expect(w.setBlock(0, 64, 0, B.STONE)).toBe(false); // above Classic build height
    expect(w.inBounds(15, 63, 15)).toBe(true);
    expect(w.inBounds(15, 64, 15)).toBe(false);
  });

  it('describes the Classic edge ocean outside the map', () => {
    const w = classicWorld(16, 64, 16);
    expect(w.getVirtual(-1, 0, 0)).toBe(B.BEDROCK);
    expect(w.getVirtual(-1, w.seaLevel - 1, 0)).toBe(B.WATER);
    expect(w.getVirtual(-1, w.seaLevel, 0)).toBe(B.AIR);
    expect(w.getVirtual(0, -1, 0)).toBe(B.BEDROCK);
  });
});

describe('setBlock side effects', () => {
  it('keeps the column light heights current', () => {
    const w = classicWorld(16, 32, 16);
    expect(w.isLit(2, 0, 2)).toBe(true);
    w.setBlock(2, 5, 2, B.STONE);
    expect(w.isLit(2, 6, 2)).toBe(true);
    expect(w.isLit(2, 4, 2)).toBe(false);
    w.setBlock(2, 9, 2, B.GLASS); // glass lets light through
    expect(w.isLit(2, 6, 2)).toBe(true);
    w.setBlock(2, 9, 2, B.LEAVES);
    expect(w.isLit(2, 6, 2)).toBe(false);
    w.setBlock(2, 9, 2, B.AIR);
    expect(w.isLit(2, 6, 2)).toBe(true);
  });

  it('dirties the neighbour chunk section when editing on a chunk border', () => {
    const w = classicWorld(32, 32, 16);
    const a = w.getChunk(0, 0)!;
    const b = w.getChunk(1, 0)!;
    for (const c of [a, b]) c.dirtySections = 0;
    w.dirtyChunks.clear();
    w.setBlock(15, 5, 5, B.GLASS); // light-transparent: only the face neighbours matter
    expect(a.dirtySections).toBe(1);
    expect(b.dirtySections).toBe(1);
    a.dirtySections = 0;
    b.dirtySections = 0;
    w.setBlock(5, 15, 5, B.GLASS); // top of section 0 → section 1 too
    expect(a.dirtySections).toBe(0b11);
    expect(b.dirtySections).toBe(0);
  });

  it('dirties sections spanned by a light change in neighbour columns', () => {
    const w = classicWorld(32, 64, 16);
    w.setBlock(15, 2, 4, B.STONE);
    const a = w.getChunk(0, 0)!;
    const b = w.getChunk(1, 0)!;
    a.dirtySections = 0;
    b.dirtySections = 0;
    w.setBlock(15, 40, 4, B.STONE); // shadow now spans sections 0..2
    expect(a.dirtySections).toBe(0b111);
    expect(b.dirtySections).toBe(0b111); // the column at x = 16 looks into it
  });

  it('merges a slab placed on a slab into a double slab', () => {
    const w = classicWorld(16, 16, 16);
    w.setBlock(1, 1, 1, B.SLAB);
    w.setBlock(1, 2, 1, B.SLAB);
    expect(w.get(1, 1, 1)).toBe(B.DOUBLE_SLAB);
    expect(w.get(1, 2, 1)).toBe(B.AIR);
  });

  it('pops plants off when their support is removed', () => {
    const w = classicWorld(16, 16, 16);
    w.setBlock(3, 1, 3, B.GRASS);
    w.setBlock(3, 2, 3, B.ROSE);
    w.setBlock(3, 1, 3, B.AIR);
    expect(w.get(3, 2, 3)).toBe(B.AIR);
    w.setBlock(4, 1, 4, B.DIRT);
    w.setBlock(4, 2, 4, B.SAPLING);
    w.setBlock(4, 1, 4, B.STONE); // still a support
    expect(w.get(4, 2, 4)).toBe(B.SAPLING);
  });

  it('pops snow layers and cacti off with their support', () => {
    const w = classicWorld(16, 16, 16);
    w.setBlock(3, 1, 3, B.GRASS);
    w.setBlock(3, 2, 3, B.SNOW_LAYER);
    w.setBlock(3, 1, 3, B.AIR);
    expect(w.get(3, 2, 3)).toBe(B.AIR);
    w.setBlock(5, 1, 5, B.SAND);
    w.setBlock(5, 2, 5, B.CACTUS);
    w.setBlock(5, 3, 5, B.CACTUS);
    w.setBlock(5, 1, 5, B.DIRT); // cacti only grow on sand
    expect(w.get(5, 2, 5)).toBe(B.AIR);
    expect(w.get(5, 3, 5)).toBe(B.AIR);
  });

  it('places logs along the clicked axis and replaces tall grass', () => {
    expect(placementValue(B.LOG, [0, 1, 0])).toBe(B.LOG);
    expect(stateOf(placementValue(B.SPRUCE_LOG, [1, 0, 0])!)).toBe(1);
    expect(stateOf(placementValue(B.BIRCH_LOG, [0, 0, -1])!)).toBe(2);
    const w = classicWorld(16, 16, 16);
    w.setBlock(3, 1, 3, B.GRASS);
    w.setBlock(3, 2, 3, B.TALL_GRASS);
    const cell = placementTarget(w, { x: 3, y: 2, z: 3 }, [0, 1, 0], B.STONE);
    expect(cell).toEqual({ x: 3, y: 2, z: 3 });
    expect(canPlace(w, cell, B.STONE, () => false)).toBe(true);
    expect(canPlace(w, { x: 3, y: 2, z: 3 }, B.CACTUS, () => false)).toBe(false); // not on grass
  });

  it('notifies listeners and marks the chunk modified', () => {
    const w = classicWorld(16, 16, 16);
    const seen: number[][] = [];
    w.addListener((x, y, z, o, n) => seen.push([x, y, z, o, n]));
    const chunk = w.getChunk(0, 0)!;
    expect(chunk.modified).toBe(false);
    w.setBlock(1, 2, 3, B.DIRT);
    w.setBlock(1, 2, 3, B.DIRT);
    expect(seen).toEqual([[1, 2, 3, B.AIR, B.DIRT]]);
    expect(chunk.modified).toBe(true);
    expect(chunk.version).toBe(1);
  });
});
