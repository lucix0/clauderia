/**
 * Furnace recipes and the furnace's per-tick logic (pure). A furnace burns
 * one fuel item at a time and smelts one input every 10 seconds while lit.
 */
import { B } from '../world/blocks';
import { canMerge, emptySlots, type ItemStack, type Slots } from './inventory';
import { I, itemDef, maxStack } from './items';

/** Ticks to smelt one item (10 s). */
export const SMELT_TICKS = 200;

export const SMELTING: ReadonlyMap<number, number> = new Map([
  [B.IRON_ORE, I.IRON_INGOT],
  [B.GOLD_ORE, I.GOLD_INGOT],
  [B.DIAMOND_ORE, I.DIAMOND],
  [B.COAL_ORE, I.COAL],
  [B.SAND, B.GLASS],
  [B.COBBLESTONE, B.STONE],
  [B.CLAY, B.BRICKS],
  [B.LOG, I.CHARCOAL],
  [B.SPRUCE_LOG, I.CHARCOAL],
  [B.BIRCH_LOG, I.CHARCOAL],
  [I.RAW_PORK, I.COOKED_PORK],
  [I.RAW_BEEF, I.COOKED_BEEF],
]);

export function smeltResult(id: number): number | null {
  return SMELTING.get(id) ?? null;
}

export function fuelTicks(id: number): number {
  return itemDef(id)?.fuel ?? 0;
}

export interface FurnaceState {
  /** Slots: 0 input, 1 fuel, 2 output. */
  readonly slots: Slots;
  /** Ticks of burn left from the current fuel item. */
  burn: number;
  /** Burn time of the current fuel item (for the flame gauge). */
  burnMax: number;
  /** Ticks into smelting the current item. */
  progress: number;
}

export function newFurnace(): FurnaceState {
  return { slots: emptySlots(3), burn: 0, burnMax: 0, progress: 0 };
}

/** Can the input be smelted into what's in (or room in) the output slot? */
function canSmelt(f: FurnaceState): boolean {
  const input = f.slots[0];
  if (!input) return false;
  const out = smeltResult(input.id);
  if (out === null) return false;
  const cur = f.slots[2];
  if (!cur) return true;
  return canMerge(cur, { id: out, count: 1, damage: 0 }) && cur.count < maxStack(out);
}

/**
 * One furnace tick. Returns true when the lit state flipped (the block's
 * look and light change).
 */
export function tickFurnace(f: FurnaceState): boolean {
  const wasLit = f.burn > 0;
  if (f.burn > 0) f.burn--;
  const smeltable = canSmelt(f);
  if (f.burn === 0 && smeltable) {
    const fuel = f.slots[1];
    const ticks = fuel ? fuelTicks(fuel.id) : 0;
    if (fuel && ticks > 0) {
      f.burn = f.burnMax = ticks;
      if (fuel.id === I.LAVA_BUCKET) {
        f.slots[1] = { id: I.BUCKET, count: 1, damage: 0 };
      } else {
        fuel.count--;
        if (fuel.count <= 0) f.slots[1] = null;
      }
    }
  }
  if (f.burn > 0 && smeltable) {
    f.progress++;
    if (f.progress >= SMELT_TICKS) {
      f.progress = 0;
      const input = f.slots[0]!;
      const out = smeltResult(input.id)!;
      input.count--;
      if (input.count <= 0) f.slots[0] = null;
      const cur = f.slots[2];
      if (cur) cur.count++;
      else f.slots[2] = { id: out, count: 1, damage: 0 };
    }
  } else if (!smeltable) {
    f.progress = 0;
  } else {
    // Out of fuel: the half-cooked item cools down.
    f.progress = Math.max(0, f.progress - 2);
  }
  return wasLit !== f.burn > 0;
}

/** Where shift-click sends an item into a furnace (null: nowhere). */
export function furnaceSlotFor(s: ItemStack): 'input' | 'fuel' | null {
  if (smeltResult(s.id) !== null) return 'input';
  if (fuelTicks(s.id) > 0) return 'fuel';
  return null;
}
