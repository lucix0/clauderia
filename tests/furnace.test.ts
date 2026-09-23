import { describe, expect, it } from 'vitest';
import { stack } from '../src/items/inventory';
import { I } from '../src/items/items';
import { furnaceSlotFor, newFurnace, SMELT_TICKS, tickFurnace } from '../src/items/smelting';
import { BlockEntities } from '../src/world/blockEntities';
import { B } from '../src/world/blocks';

describe('furnace', () => {
  it('smelts one item every 10 seconds while fuel burns', () => {
    const f = newFurnace();
    f.slots[0] = stack(B.IRON_ORE, 3);
    f.slots[1] = stack(I.COAL, 1);
    let flips = 0;
    for (let t = 0; t < SMELT_TICKS; t++) if (tickFurnace(f)) flips++;
    expect(flips).toBe(1); // lit up
    expect(f.slots[2]).toEqual(stack(I.IRON_INGOT, 1));
    expect(f.slots[1]).toBeNull(); // the coal is burning
    for (let t = 0; t < SMELT_TICKS * 2; t++) tickFurnace(f);
    expect(f.slots[2]).toEqual(stack(I.IRON_INGOT, 3));
    expect(f.slots[0]).toBeNull();
  });

  it('uses fuel by burn time: one coal smelts eight items, a plank one and a half', () => {
    const f = newFurnace();
    f.slots[0] = stack(B.SAND, 20);
    f.slots[1] = stack(I.COAL, 1);
    for (let t = 0; t < SMELT_TICKS * 12; t++) tickFurnace(f);
    expect(f.slots[2]).toEqual(stack(B.GLASS, 8));
    const g = newFurnace();
    g.slots[0] = stack(B.COBBLESTONE, 5);
    g.slots[1] = stack(B.PLANKS, 1);
    for (let t = 0; t < SMELT_TICKS * 5; t++) tickFurnace(g);
    expect(g.slots[2]).toEqual(stack(B.STONE, 1));
    expect(g.progress).toBe(0); // the half-done second one cooled off
  });

  it('goes out when the output is full or the input can’t be smelted', () => {
    const f = newFurnace();
    f.slots[0] = stack(B.DIRT, 4);
    f.slots[1] = stack(I.COAL, 2);
    for (let t = 0; t < 100; t++) tickFurnace(f);
    expect(f.burn).toBe(0);
    expect(f.slots[1]).toEqual(stack(I.COAL, 2)); // no fuel wasted
    f.slots[0] = stack(I.RAW_BEEF, 1);
    f.slots[2] = stack(I.COOKED_BEEF, 64);
    for (let t = 0; t < 100; t++) tickFurnace(f);
    expect(f.burn).toBe(0);
  });

  it('leaves the bucket behind when burning lava', () => {
    const f = newFurnace();
    f.slots[0] = stack(B.LOG, 1);
    f.slots[1] = stack(I.LAVA_BUCKET, 1);
    tickFurnace(f);
    expect(f.slots[1]).toEqual(stack(I.BUCKET, 1));
    for (let t = 0; t < SMELT_TICKS; t++) tickFurnace(f);
    expect(f.slots[2]).toEqual(stack(I.CHARCOAL, 1));
  });

  it('routes shift-clicks to input or fuel', () => {
    expect(furnaceSlotFor(stack(B.GOLD_ORE))).toBe('input');
    expect(furnaceSlotFor(stack(I.COAL))).toBe('fuel');
    expect(furnaceSlotFor(stack(B.DIRT))).toBeNull();
  });
});

describe('block entities', () => {
  it('save and load with their chunk', () => {
    const be = new BlockEntities();
    be.chest(3, 70, -5)[4] = stack(I.DIAMOND, 7);
    const f = be.furnace(20, 64, 1);
    f.slots[0] = stack(B.SAND, 2);
    f.burn = 50;
    const a = be.inChunk(0, -1, true);
    const b = be.inChunk(1, 0, true);
    expect(be.size).toBe(0);
    const again = new BlockEntities();
    again.load(JSON.parse(JSON.stringify([...a, ...b])));
    expect(again.chest(3, 70, -5)[4]).toEqual(stack(I.DIAMOND, 7));
    expect(again.furnace(20, 64, 1).burn).toBe(50);
    expect(BlockEntities.contents(again.remove(20, 64, 1)!)).toEqual([stack(B.SAND, 2)]);
  });
});
