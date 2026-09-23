import { describe, expect, it } from 'vitest';
import { raycast } from '../src/player/raycast';
import { B } from '../src/world/blocks';
import type { World } from '../src/world/world';
import { classicWorld } from './helpers';

function world(): World {
  const w = classicWorld(16, 16, 16);
  w.setBlock(8, 5, 8, B.STONE);
  return w;
}

describe('voxel DDA raycast', () => {
  it('hits a block from above on its top face', () => {
    const hit = raycast(world(), 8.5, 9.5, 8.5, 0, -1, 0, 10);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([8, 5, 8]);
    expect(hit!.face).toBe(2); // +Y
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([0, 1, 0]);
    expect(hit!.t).toBeCloseTo(3.5);
    expect(hit!.id).toBe(B.STONE);
  });

  it('reports the side face that was entered', () => {
    const fromWest = raycast(world(), 5.5, 5.5, 8.5, 1, 0, 0, 10)!;
    expect(fromWest.face).toBe(1); // -X
    expect([fromWest.nx, fromWest.ny, fromWest.nz]).toEqual([-1, 0, 0]);
    const fromNorth = raycast(world(), 8.5, 5.5, 3.2, 0, 0, 1, 10)!;
    expect(fromNorth.face).toBe(5); // -Z
    const d = Math.SQRT1_2;
    const diagonal = raycast(world(), 10.5, 5.5, 10.5, -d, 0, -d, 10)!;
    expect([diagonal.x, diagonal.y, diagonal.z]).toEqual([8, 5, 8]);
  });

  it('respects the reach limit', () => {
    expect(raycast(world(), 8.5, 15.5, 8.5, 0, -1, 0, 5)).toBeNull();
    expect(raycast(world(), 8.5, 11.5, 8.5, 0, -1, 0, 5.5)).not.toBeNull();
  });

  it('passes through liquids and air but stops on plants', () => {
    const w = world();
    w.setBlock(8, 6, 8, B.WATER);
    expect(raycast(w, 8.5, 9.5, 8.5, 0, -1, 0, 10)!.y).toBe(5);
    w.setBlock(8, 6, 8, B.ROSE);
    const hit = raycast(w, 8.5, 9.5, 8.5, 0, -1, 0, 10)!;
    expect(hit.id).toBe(B.ROSE);
    expect(hit.face).toBe(2);
    expect(hit.t).toBeCloseTo(9.5 - 6.8);
  });

  it('hits the top of a slab at half height and misses above it', () => {
    const w = classicWorld(16, 16, 16);
    w.setBlock(4, 4, 4, B.SLAB);
    const down = raycast(w, 4.5, 8, 4.5, 0, -1, 0, 10)!;
    expect(down.face).toBe(2);
    expect(down.t).toBeCloseTo(3.5);
    // A horizontal ray through the empty upper half misses.
    expect(raycast(w, 1.5, 4.75, 4.5, 1, 0, 0, 10)).toBeNull();
    const low = raycast(w, 1.5, 4.25, 4.5, 1, 0, 0, 10)!;
    expect(low.face).toBe(1);
  });
});
