import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../src/config';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';

describe('world indexing', () => {
  it('uses a flat y-major layout', () => {
    const w = new World(16, 8, 12, 0);
    expect(w.blocks.length).toBe(16 * 8 * 12);
    expect(w.index(0, 0, 0)).toBe(0);
    expect(w.index(1, 0, 0)).toBe(1);
    expect(w.index(0, 0, 1)).toBe(16);
    expect(w.index(0, 1, 0)).toBe(16 * 12);
    expect(w.index(15, 7, 11)).toBe(16 * 8 * 12 - 1);
  });

  it('round-trips blocks through setBlock / get', () => {
    const w = new World(16, 8, 12, 0);
    expect(w.setBlock(3, 4, 5, B.STONE)).toBe(true);
    expect(w.get(3, 4, 5)).toBe(B.STONE);
    expect(w.blocks[w.index(3, 4, 5)]).toBe(B.STONE);
    expect(w.setBlock(3, 4, 5, B.STONE)).toBe(false); // no change
  });

  it('treats out-of-bounds as air and ignores writes there', () => {
    const w = new World(8, 8, 8, 0);
    expect(w.get(-1, 0, 0)).toBe(B.AIR);
    expect(w.get(0, 8, 0)).toBe(B.AIR);
    expect(w.setBlock(8, 0, 0, B.STONE)).toBe(false);
    expect(w.inBounds(7, 7, 7)).toBe(true);
    expect(w.inBounds(7, 8, 7)).toBe(false);
  });

  it('describes the edge ocean outside the map', () => {
    const w = new World(8, 64, 8, 0);
    expect(w.getVirtual(-1, 0, 0)).toBe(B.BEDROCK);
    expect(w.getVirtual(-1, w.seaLevel - 1, 0)).toBe(B.WATER);
    expect(w.getVirtual(-1, w.seaLevel, 0)).toBe(B.AIR);
    expect(w.getVirtual(0, -1, 0)).toBe(B.BEDROCK);
  });
});

describe('setBlock side effects', () => {
  it('keeps the light height map current', () => {
    const w = new World(8, 16, 8, 0);
    expect(w.heightMap.get(2, 2)).toBe(-1);
    w.setBlock(2, 5, 2, B.STONE);
    expect(w.heightMap.get(2, 2)).toBe(5);
    w.setBlock(2, 9, 2, B.GLASS); // glass lets light through
    expect(w.heightMap.get(2, 2)).toBe(5);
    w.setBlock(2, 9, 2, B.LEAVES);
    expect(w.heightMap.get(2, 2)).toBe(9);
    w.setBlock(2, 9, 2, B.AIR);
    expect(w.heightMap.get(2, 2)).toBe(5);
    expect(w.isLit(2, 6, 2)).toBe(true);
    expect(w.isLit(2, 4, 2)).toBe(false);
  });

  it('dirties the neighbour chunk when editing on a chunk border', () => {
    const w = new World(CHUNK_SIZE * 2, CHUNK_SIZE, CHUNK_SIZE, 0);
    w.dirty.clear();
    w.setBlock(CHUNK_SIZE - 1, 5, 5, B.STONE);
    // Height changed too, but every affected column sits in the two chunks.
    expect([...w.dirty].sort()).toEqual([w.chunkIndex(0, 0, 0), w.chunkIndex(1, 0, 0)]);
    w.dirty.clear();
    w.setBlock(5, 5, 5, B.GLASS); // interior, no light change
    expect([...w.dirty]).toEqual([w.chunkIndex(0, 0, 0)]);
  });

  it('dirties chunks spanned by a light change in neighbour columns', () => {
    const w = new World(CHUNK_SIZE, CHUNK_SIZE * 2, CHUNK_SIZE, 0);
    w.setBlock(4, 2, 4, B.STONE);
    w.dirty.clear();
    w.setBlock(4, CHUNK_SIZE + 10, 4, B.STONE); // shadow now spans both vertical chunks
    expect([...w.dirty].sort()).toEqual([w.chunkIndex(0, 0, 0), w.chunkIndex(0, 1, 0)]);
  });

  it('merges a slab placed on a slab into a double slab', () => {
    const w = new World(8, 8, 8, 0);
    w.setBlock(1, 1, 1, B.SLAB);
    w.setBlock(1, 2, 1, B.SLAB);
    expect(w.get(1, 1, 1)).toBe(B.DOUBLE_SLAB);
    expect(w.get(1, 2, 1)).toBe(B.AIR);
  });

  it('pops plants off when their support is removed', () => {
    const w = new World(8, 8, 8, 0);
    w.setBlock(3, 1, 3, B.GRASS);
    w.setBlock(3, 2, 3, B.ROSE);
    w.setBlock(3, 1, 3, B.AIR);
    expect(w.get(3, 2, 3)).toBe(B.AIR);
    w.setBlock(4, 1, 4, B.DIRT);
    w.setBlock(4, 2, 4, B.SAPLING);
    w.setBlock(4, 1, 4, B.STONE); // still a support
    expect(w.get(4, 2, 4)).toBe(B.SAPLING);
  });

  it('notifies listeners of each change', () => {
    const w = new World(8, 8, 8, 0);
    const seen: number[][] = [];
    w.addListener((x, y, z, o, n) => seen.push([x, y, z, o, n]));
    w.setBlock(1, 2, 3, B.DIRT);
    w.setBlock(1, 2, 3, B.DIRT);
    expect(seen).toEqual([[1, 2, 3, B.AIR, B.DIRT]]);
  });
});
