import { describe, expect, it } from 'vitest';
import { stack, type Slots } from '../src/items/inventory';
import { I, itemByName, toolId } from '../src/items/items';
import { matchRecipe } from '../src/items/recipes';
import { drops } from '../src/survival/mining';
import { B, FARMLAND_WET, stateTile, T, WHEAT_RIPE } from '../src/world/blocks';
import { fertilize, growCrop, moist, plantSeeds, till, updateFarmland } from '../src/world/farming';
import { Ticker } from '../src/world/ticker';
import { classicWorld, lightWorld } from './helpers';

/** Grass floor with its top at y = 9 (air from y = 10), lit. */
function field() {
  const w = classicWorld(32, 32, 32, (_x, y) => (y < 9 ? B.DIRT : y === 9 ? B.GRASS : B.AIR));
  lightWorld(w);
  return w;
}

const always = (): number => 0;
const never = (): number => 0.99;

function grid(rows: number[][]): Slots {
  return rows.flat().map((id) => (id ? stack(id) : null));
}

describe('farming', () => {
  it('hoes till grass and dirt with room above into farmland', () => {
    const w = field();
    expect(till(w, 5, 9, 5)).toBe(true);
    expect(w.get(5, 9, 5)).toBe(B.FARMLAND); // dry: no water nearby
    w.setBlock(6, 10, 6, B.STONE);
    expect(till(w, 6, 9, 6)).toBe(false);
    expect(till(w, 7, 8, 7)).toBe(false); // buried dirt
    // Water within four blocks makes it moist.
    w.setBlock(12, 9, 5, B.WATER);
    expect(moist(w, 9, 9, 5)).toBe(true);
    expect(moist(w, 7, 9, 5)).toBe(false);
    expect(till(w, 9, 9, 5)).toBe(true);
    expect(w.get(9, 9, 5)).toBe(B.FARMLAND | (FARMLAND_WET << 8));
  });

  it('seeds grow into wheat through eight stages, faster on moist soil', () => {
    const w = field();
    till(w, 5, 9, 5);
    expect(plantSeeds(w, 5, 9, 5)).toBe(true);
    expect(w.get(5, 10, 5)).toBe(B.WHEAT);
    expect(plantSeeds(w, 6, 9, 6)).toBe(false); // not farmland
    // Dry soil: only half the growth chances succeed.
    expect(growCrop(w, 5, 10, 5, never)).toBe(true);
    expect(growCrop(w, 5, 10, 5, always)).toBe(false);
    expect(w.get(5, 10, 5) >> 8).toBe(1);
    w.setBlock(5, 9, 5, B.FARMLAND | (FARMLAND_WET << 8));
    for (let i = 0; i < 10; i++) growCrop(w, 5, 10, 5, always);
    expect(w.get(5, 10, 5) >> 8).toBe(WHEAT_RIPE);
    expect(growCrop(w, 5, 10, 5, always)).toBe(false);
  });

  it('crops need light', () => {
    const w = field();
    till(w, 5, 9, 5);
    plantSeeds(w, 5, 9, 5);
    // A roof high above shades it to darkness.
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) w.setBlock(x, 14, z, B.STONE);
    lightWorld(w);
    expect(growCrop(w, 5, 10, 5, never)).toBe(false);
    w.setBlock(5, 10, 6, B.TORCH);
    lightWorld(w);
    expect(growCrop(w, 5, 10, 5, never)).toBe(true);
  });

  it('bone meal pushes a crop several stages', () => {
    const w = field();
    till(w, 5, 9, 5);
    plantSeeds(w, 5, 9, 5);
    expect(fertilize(w, 5, 10, 5, always)).toBe(true);
    expect(w.get(5, 10, 5) >> 8).toBe(2);
    fertilize(w, 5, 10, 5, never);
    fertilize(w, 5, 10, 5, never);
    expect(w.get(5, 10, 5) >> 8).toBe(WHEAT_RIPE);
    expect(fertilize(w, 5, 10, 5, never)).toBe(false);
  });

  it('farmland dries, reverts to dirt when bare or covered, and drops its crop', () => {
    const w = field();
    w.setBlock(5, 9, 5, B.FARMLAND | (FARMLAND_WET << 8));
    updateFarmland(w, 5, 9, 5, always, true);
    expect(w.get(5, 9, 5)).toBe(B.FARMLAND); // dried out first
    updateFarmland(w, 5, 9, 5, always, false);
    expect(w.get(5, 9, 5)).toBe(B.FARMLAND); // no decay without the flag
    updateFarmland(w, 5, 9, 5, always, true);
    expect(w.get(5, 9, 5)).toBe(B.DIRT);
    // Planted farmland doesn't decay.
    till(w, 7, 9, 7);
    plantSeeds(w, 7, 9, 7);
    updateFarmland(w, 7, 9, 7, always, true);
    expect(w.get(7, 9, 7)).toBe(B.FARMLAND);
    // Soil gone: the crop pops off.
    w.setBlock(7, 9, 7, B.DIRT);
    expect(w.get(7, 10, 7)).toBe(B.AIR);
    // Covered by a solid block: back to dirt.
    till(w, 9, 9, 9);
    w.setBlock(9, 10, 9, B.PLANKS);
    updateFarmland(w, 9, 9, 9, never, false);
    expect(w.get(9, 9, 9)).toBe(B.DIRT);
  });

  it('the ticker grows planted wheat to ripeness on its own', () => {
    const w = field();
    w.setBlock(10, 9, 10, B.WATER);
    till(w, 11, 9, 10);
    plantSeeds(w, 11, 9, 10);
    const t = new Ticker(w);
    // A new crop is scheduled when planted; the ticker only sees changes from now on.
    w.setBlock(11, 10, 10, B.AIR);
    w.setBlock(11, 10, 10, B.WHEAT);
    t.setFocus(11, 10);
    for (let i = 0; i < 8 * 900; i++) t.step();
    expect(w.get(11, 10, 10) >> 8).toBe(WHEAT_RIPE);
    expect(w.get(11, 9, 10)).toBe(B.FARMLAND | (FARMLAND_WET << 8));
    t.dispose();
  });

  it('drops seeds from grass and grain from ripe wheat', () => {
    expect(drops(B.TALL_GRASS, null, () => 0.1)).toEqual([stack(I.WHEAT_SEEDS)]);
    expect(drops(B.TALL_GRASS, null, () => 0.5)).toEqual([]);
    expect(drops(B.WHEAT | (3 << 8), null, () => 0.5)).toEqual([stack(I.WHEAT_SEEDS)]);
    expect(drops(B.WHEAT | (WHEAT_RIPE << 8), null, () => 0.5)).toEqual([stack(I.WHEAT), stack(I.WHEAT_SEEDS, 2)]);
    expect(drops(B.FARMLAND, null, () => 0.5)).toEqual([stack(B.DIRT)]);
  });

  it('hoes and bread are crafted, and seeds have a short name', () => {
    const P = B.PLANKS;
    const S = I.STICK;
    expect(matchRecipe(grid([[P, P, 0], [0, S, 0], [0, S, 0]]), 3, 3)?.out).toEqual(stack(toolId('hoe', 0)));
    expect(matchRecipe(grid([[0, 0, 0], [I.WHEAT, I.WHEAT, I.WHEAT], [0, 0, 0]]), 3, 3)?.out).toEqual(stack(I.BREAD));
    expect(itemByName('seeds')).toBe(I.WHEAT_SEEDS);
    expect(itemByName('diamond_hoe')).toBe(toolId('hoe', 4));
  });

  it('shows each growth stage and moist soil with its own tile', () => {
    expect(stateTile(B.WHEAT, 0, T.WHEAT_FIRST)).toBe(T.WHEAT_FIRST);
    expect(stateTile(B.WHEAT, 5, T.WHEAT_FIRST)).toBe(T.WHEAT_FIRST + 5);
    expect(stateTile(B.FARMLAND, FARMLAND_WET, T.FARMLAND_DRY)).toBe(T.FARMLAND_WET);
    expect(stateTile(B.FARMLAND, FARMLAND_WET, T.DIRT)).toBe(T.DIRT); // sides stay dirt
  });
});
