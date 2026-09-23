import { describe, expect, it } from 'vitest';
import { B, IS_SOLID } from '../src/world/blocks';
import { findSpawn, generateLevel } from '../src/world/generator';

const SX = 64;
const SY = 64;
const SZ = 64;

describe('level generator', () => {
  const a = generateLevel({ sx: SX, sy: SY, sz: SZ, seed: 12345 });

  it('is deterministic: same seed, identical world', () => {
    const b = generateLevel({ sx: SX, sy: SY, sz: SZ, seed: 12345 });
    expect(b).toEqual(a);
  });

  it('differs for another seed', () => {
    const c = generateLevel({ sx: SX, sy: SY, sz: SZ, seed: 54321 });
    expect(c).not.toEqual(a);
  });

  it('has a solid bedrock floor', () => {
    for (let i = 0; i < SX * SZ; i++) expect(a[i]).toBe(B.BEDROCK);
  });

  it('contains the expected materials', () => {
    const counts = new Map<number, number>();
    for (const id of a) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of [B.STONE, B.DIRT, B.GRASS, B.WATER, B.COAL_ORE]) {
      expect(counts.get(id) ?? 0, `block ${id}`).toBeGreaterThan(0);
    }
  });

  it('floods the ocean from the edges and never above sea level', () => {
    const sea = SY / 2;
    const layer = SX * SZ;
    for (let y = sea; y < SY; y++) {
      for (let i = 0; i < layer; i++) expect(a[y * layer + i]).not.toBe(B.WATER);
    }
    // Every edge cell below sea level is water or solid ground, never air.
    for (let y = 1; y < sea; y++) {
      for (let x = 0; x < SX; x++) {
        expect(a[y * layer + x]).not.toBe(B.AIR);
        expect(a[y * layer + (SZ - 1) * SX + x]).not.toBe(B.AIR);
      }
    }
  });

  it('spawns on dry land near the centre', () => {
    const s = findSpawn(a, SX, SY, SZ);
    const layer = SX * SZ;
    const at = (x: number, y: number, z: number): number => a[y * layer + z * SX + x]!;
    const x = Math.floor(s.x);
    const z = Math.floor(s.z);
    expect(s.y).toBeGreaterThanOrEqual(SY / 2);
    expect(IS_SOLID[at(x, s.y - 1, z)]).toBe(1);
    expect(at(x, s.y, z)).toBe(B.AIR);
    expect(at(x, s.y + 1, z)).toBe(B.AIR);
  });
});
