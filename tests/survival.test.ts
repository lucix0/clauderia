import { describe, expect, it } from 'vitest';
import { stack } from '../src/items/inventory';
import { I, toolId } from '../src/items/items';
import { breakTime, canHarvest, drops } from '../src/survival/mining';
import {
  eat,
  fallDamage,
  MAX_AIR,
  newVitals,
  tickVitals,
  type Surroundings,
} from '../src/survival/vitals';
import { B } from '../src/world/blocks';

const never = (): number => 0.99;
const pick = (tier: number) => stack(toolId('pickaxe', tier));
const DRY: Surroundings = { headInWater: false, inWater: false, inLava: false, headInSolid: false, touchingCactus: false };
const RULES = { peaceful: false };

describe('mining', () => {
  it('is faster with the right tool and tier', () => {
    expect(breakTime(B.STONE, null)).toBeCloseTo(7.5);
    expect(breakTime(B.STONE, pick(0))).toBeCloseTo(1.15);
    expect(breakTime(B.STONE, pick(4))).toBeLessThan(breakTime(B.STONE, pick(1)));
    expect(breakTime(B.STONE, pick(3))).toBeLessThan(breakTime(B.STONE, pick(4))); // gold is fast
    expect(breakTime(B.DIRT, null)).toBeCloseTo(0.75);
    expect(breakTime(B.DIRT, stack(toolId('shovel', 0)))).toBeLessThan(0.75);
    expect(breakTime(B.LOG, stack(toolId('axe', 1)))).toBeLessThan(breakTime(B.LOG, null));
    // The wrong tool is no better than a fist.
    expect(breakTime(B.LOG, pick(4))).toBe(breakTime(B.LOG, null));
    expect(breakTime(B.TORCH, null)).toBe(0);
    expect(breakTime(B.BEDROCK, pick(4))).toBe(Infinity);
  });

  it('gates drops by pickaxe tier', () => {
    expect(drops(B.STONE, null, never)).toEqual([]);
    expect(drops(B.STONE, pick(0), never)).toEqual([stack(B.COBBLESTONE)]);
    expect(drops(B.COAL_ORE, pick(0), never)).toEqual([stack(I.COAL)]);
    expect(canHarvest(B.IRON_ORE, pick(0))).toBe(false);
    expect(drops(B.IRON_ORE, pick(1), never)).toEqual([stack(B.IRON_ORE)]);
    expect(drops(B.GOLD_ORE, pick(1), never)).toEqual([]);
    expect(drops(B.GOLD_ORE, pick(2), never)).toEqual([stack(B.GOLD_ORE)]);
    expect(drops(B.DIAMOND_ORE, pick(3), never)).toEqual([]); // gold pickaxe: wood level
    expect(drops(B.DIAMOND_ORE, pick(2), never)).toEqual([stack(I.DIAMOND)]);
    // Stone takes longer by hand, and much longer without the right tier.
    expect(breakTime(B.IRON_ORE, pick(0))).toBeGreaterThan(breakTime(B.IRON_ORE, pick(1)) * 2);
  });

  it('follows the drop rules', () => {
    expect(drops(B.GRASS, null, never)).toEqual([stack(B.DIRT)]);
    expect(drops(B.GLASS, null, never)).toEqual([]);
    expect(drops(B.LEAVES, null, never)).toEqual([]);
    expect(drops(B.LEAVES, null, () => 0)).toEqual([stack(B.SAPLING), stack(I.APPLE)]);
    expect(drops(B.LOG | (1 << 8), null, never)).toEqual([stack(B.LOG)]);
    expect(drops(B.DOUBLE_SLAB, pick(0), never)).toEqual([stack(B.SLAB, 2)]);
  });
});

describe('vitals', () => {
  it('deals fall damage above three blocks', () => {
    expect(fallDamage(3)).toBe(0);
    expect(fallDamage(3.5)).toBe(1);
    expect(fallDamage(10)).toBe(7);
  });

  it('drowns after the air runs out, two points a second', () => {
    const v = newVitals();
    const under = { ...DRY, headInWater: true, inWater: true };
    for (let t = 0; t < MAX_AIR; t++) expect(tickVitals(v, under, RULES)).toEqual([]);
    expect(v.air).toBe(0);
    let taken = 0;
    for (let t = 0; t < 100; t++) for (const h of tickVitals(v, under, RULES)) taken += h.amount;
    expect(taken).toBe(10); // 5 seconds
    // Surfacing refills air.
    for (let t = 0; t < 60; t++) tickVitals(v, DRY, RULES);
    expect(v.air).toBe(MAX_AIR);
  });

  it('burns in lava and keeps burning until water', () => {
    const v = newVitals();
    const hits = tickVitals(v, { ...DRY, inLava: true }, RULES);
    expect(hits).toEqual([{ amount: 4, cause: 'lava' }]);
    expect(v.fire).toBeGreaterThan(0);
    let fire = 0;
    for (let t = 0; t < 40; t++) for (const h of tickVitals(v, DRY, RULES)) if (h.cause === 'fire') fire += h.amount;
    expect(fire).toBe(2);
    tickVitals(v, { ...DRY, inWater: true }, RULES);
    expect(v.fire).toBe(0);
  });

  it('pauses damage while invulnerable', () => {
    const v = newVitals();
    let n = 0;
    for (let t = 0; t < 20; t++) n += tickVitals(v, { ...DRY, touchingCactus: true }, RULES).length;
    expect(n).toBe(2); // once per half second
  });

  it('drains hunger through exhaustion, regenerates and starves', () => {
    const v = newVitals();
    v.saturation = 0;
    v.exhaustion = 4 * 3;
    tickVitals(v, DRY, RULES);
    expect(v.hunger).toBe(17);
    v.health = 10;
    v.hunger = 18;
    for (let t = 0; t < 80; t++) tickVitals(v, DRY, RULES);
    expect(v.health).toBe(11);
    v.hunger = 0;
    v.saturation = 0;
    v.health = 3;
    for (let t = 0; t < 80 * 5; t++) tickVitals(v, DRY, RULES);
    expect(v.health).toBe(1); // Normal: starving stops at half a heart
    eat(v, { hunger: 8, saturation: 12.8 });
    expect(v.hunger).toBe(8);
    expect(v.saturation).toBe(8);
  });

  it('keeps everyone fed on Peaceful', () => {
    const v = newVitals();
    v.hunger = 10;
    v.health = 5;
    for (let t = 0; t < 200; t++) tickVitals(v, DRY, { peaceful: true });
    expect(v.hunger).toBe(20);
    expect(v.health).toBe(15);
  });
});
