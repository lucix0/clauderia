import { describe, expect, it } from 'vitest';
import { paintAllTiles, paintTile } from '../src/render/tiles';
import { T, TILE_COUNT } from '../src/world/blocks';

describe('procedural tiles', () => {
  it('paints every tile deterministically', () => {
    const tiles = paintAllTiles();
    expect(tiles).toHaveLength(TILE_COUNT);
    for (const t of tiles) expect(t.length).toBe(16 * 16 * 4);
    expect(paintTile(T.STONE)).toEqual(tiles[T.STONE]);
  });

  it('gives cutout tiles transparent pixels and keeps opaque tiles solid', () => {
    const alphaOf = (t: Uint8ClampedArray): number[] => Array.from({ length: 256 }, (_, i) => t[i * 4 + 3]!);
    expect(alphaOf(paintTile(T.LEAVES)).some((a) => a === 0)).toBe(true);
    expect(alphaOf(paintTile(T.GLASS)).some((a) => a === 0)).toBe(true);
    expect(alphaOf(paintTile(T.STONE)).every((a) => a === 255)).toBe(true);
    const water = alphaOf(paintTile(T.WATER));
    expect(water.every((a) => a > 0 && a < 255)).toBe(true);
  });
});
