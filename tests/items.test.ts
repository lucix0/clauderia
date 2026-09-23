import { describe, expect, it } from 'vitest';
import {
  addStack,
  clickSlot,
  emptySlots,
  quickMove,
  slotsFromJSON,
  slotsToJSON,
  stack,
  takeResult,
  wearTool,
  type Slots,
} from '../src/items/inventory';
import { I, itemByName, itemDef, toolId } from '../src/items/items';
import { consumeGrid, matchRecipe } from '../src/items/recipes';
import { Container } from '../src/items/container';
import { B } from '../src/world/blocks';

/** A w×h grid from rows of ids (0 empty). */
function grid(rows: number[][]): Slots {
  return rows.flat().map((id) => (id ? stack(id) : null));
}

describe('recipes', () => {
  it('matches shaped recipes anywhere in the grid', () => {
    const P = B.PLANKS;
    expect(matchRecipe(grid([[P, 0, 0], [P, 0, 0], [0, 0, 0]]), 3, 3)?.out).toEqual(stack(I.STICK, 4));
    expect(matchRecipe(grid([[0, 0, 0], [0, 0, P], [0, 0, P]]), 3, 3)?.out).toEqual(stack(I.STICK, 4));
    expect(matchRecipe(grid([[0, P], [0, P]]), 2, 2)?.out.id).toBe(I.STICK);
    // A gap breaks the shape.
    expect(matchRecipe(grid([[P, 0, 0], [0, 0, 0], [P, 0, 0]]), 3, 3)).toBeNull();
  });

  it('matches mirrored shapes', () => {
    const X = B.COBBLESTONE;
    const S = I.STICK;
    const axe = toolId('axe', 1);
    expect(matchRecipe(grid([[X, X, 0], [X, S, 0], [0, S, 0]]), 3, 3)?.out.id).toBe(axe);
    expect(matchRecipe(grid([[0, X, X], [0, S, X], [0, S, 0]]), 3, 3)?.out.id).toBe(axe);
    // Upside down is not a mirror.
    expect(matchRecipe(grid([[0, S, 0], [X, S, 0], [X, X, 0]]), 3, 3)).toBeNull();
  });

  it('matches shapeless recipes in any slot', () => {
    expect(matchRecipe(grid([[0, 0], [0, B.LOG]]), 2, 2)?.out).toEqual(stack(B.PLANKS, 4));
    expect(matchRecipe(grid([[0, 0, 0], [B.BIRCH_LOG, 0, 0], [0, 0, 0]]), 3, 3)?.out.id).toBe(B.BIRCH_PLANKS);
    expect(matchRecipe(grid([[B.LOG, B.LOG], [0, 0]]), 2, 2)).toBeNull();
  });

  it('accepts any member of a tag', () => {
    const table = matchRecipe(grid([[B.PLANKS, B.SPRUCE_PLANKS], [B.BIRCH_PLANKS, B.PLANKS]]), 2, 2);
    expect(table?.out.id).toBe(B.CRAFTING_TABLE);
    expect(matchRecipe(grid([[I.CHARCOAL, 0], [I.STICK, 0]]), 2, 2)?.out).toEqual(stack(B.TORCH, 4));
    expect(matchRecipe(grid([[B.STONE, B.PLANKS], [B.PLANKS, B.PLANKS]]), 2, 2)).toBeNull();
  });

  it('needs a 3×3 grid for big shapes and makes every tool tier', () => {
    const C = B.COBBLESTONE;
    expect(matchRecipe(grid([[C, C], [C, C]]), 2, 2)).toBeNull();
    const S = I.STICK;
    for (const [mat, tier] of [[B.PLANKS, 0], [C, 1], [I.IRON_INGOT, 2], [I.GOLD_INGOT, 3], [I.DIAMOND, 4]] as const) {
      expect(matchRecipe(grid([[mat, mat, mat], [0, S, 0], [0, S, 0]]), 3, 3)?.out.id).toBe(toolId('pickaxe', tier));
    }
    expect(matchRecipe(grid([[C, C, C], [C, 0, C], [C, C, C]]), 3, 3)?.out.id).toBe(B.FURNACE);
  });

  it('consumes one of each ingredient', () => {
    const g: Slots = [stack(B.LOG, 3), null, null, null];
    consumeGrid(g);
    expect(g[0]).toEqual(stack(B.LOG, 2));
    consumeGrid(g);
    consumeGrid(g);
    expect(g[0]).toBeNull();
  });
});

describe('inventory', () => {
  it('fills matching stacks before empty slots and caps at 64', () => {
    const s = emptySlots(4);
    s[2] = stack(B.DIRT, 60);
    expect(addStack(s, stack(B.DIRT, 10))).toBe(0);
    expect(s[2]!.count).toBe(64);
    expect(s[0]).toEqual(stack(B.DIRT, 6));
    expect(addStack(s, stack(B.DIRT, 64 * 3))).toBe(6 + 0 * 1 + 0); // 58 + 64 + 64 fit, 6 left
  });

  it('keeps tools unstackable', () => {
    const s = emptySlots(3);
    const pick = toolId('pickaxe', 2);
    expect(addStack(s, stack(pick, 1))).toBe(0);
    expect(addStack(s, stack(pick, 1))).toBe(0);
    expect(s.filter(Boolean).length).toBe(2);
    expect(itemDef(pick)!.maxStack).toBe(1);
  });

  it('left click picks up, puts down, merges and swaps', () => {
    const s: Slots = [stack(B.STONE, 10), stack(B.DIRT, 5), stack(B.STONE, 60)];
    let cursor = clickSlot(s, 0, null, 'left');
    expect(cursor).toEqual(stack(B.STONE, 10));
    expect(s[0]).toBeNull();
    cursor = clickSlot(s, 2, cursor, 'left'); // merge up to 64
    expect(s[2]!.count).toBe(64);
    expect(cursor).toEqual(stack(B.STONE, 6));
    cursor = clickSlot(s, 1, cursor, 'left'); // swap
    expect(s[1]).toEqual(stack(B.STONE, 6));
    expect(cursor).toEqual(stack(B.DIRT, 5));
    cursor = clickSlot(s, 0, cursor, 'left');
    expect(cursor).toBeNull();
    expect(s[0]).toEqual(stack(B.DIRT, 5));
  });

  it('right click takes half or places one', () => {
    const s: Slots = [stack(B.SAND, 7), null];
    let cursor = clickSlot(s, 0, null, 'right');
    expect(cursor).toEqual(stack(B.SAND, 4));
    expect(s[0]).toEqual(stack(B.SAND, 3));
    cursor = clickSlot(s, 1, cursor, 'right');
    cursor = clickSlot(s, 1, cursor, 'right');
    expect(s[1]).toEqual(stack(B.SAND, 2));
    expect(cursor).toEqual(stack(B.SAND, 2));
    cursor = clickSlot(s, 0, cursor, 'right');
    expect(s[0]!.count).toBe(4);
  });

  it('only accepts allowed items and takes results whole', () => {
    const s: Slots = [null];
    const cursor = clickSlot(s, 0, stack(B.DIRT, 3), 'left', () => false);
    expect(cursor).toEqual(stack(B.DIRT, 3));
    expect(s[0]).toBeNull();
    expect(takeResult(stack(I.STICK, 62), stack(I.STICK, 4)).taken).toBe(false);
    expect(takeResult(stack(I.STICK, 60), stack(I.STICK, 4)).cursor).toEqual(stack(I.STICK, 64));
  });

  it('shift-click moves a stack between sections', () => {
    const hotbar: Slots = [stack(B.GLASS, 20), null];
    const main: Slots = [stack(B.GLASS, 50), null];
    quickMove(hotbar, 0, main, [0, 1]);
    expect(hotbar[0]).toBeNull();
    expect(main).toEqual([stack(B.GLASS, 64), stack(B.GLASS, 6)]);
  });

  it('wears tools out', () => {
    const s: Slots = [stack(toolId('pickaxe', 3), 1)];
    for (let i = 0; i < 31; i++) expect(wearTool(s, 0)).toBe(false);
    expect(wearTool(s, 0)).toBe(true);
    expect(s[0]).toBeNull();
  });

  it('round-trips through JSON and drops junk', () => {
    const s: Slots = [stack(I.DIAMOND, 3), null, stack(toolId('sword', 4), 1, 17)];
    expect(slotsFromJSON(JSON.parse(JSON.stringify(slotsToJSON(s))), 3)).toEqual(s);
    expect(slotsFromJSON([[99999, 1, 0], 'x', [B.DIRT, 500, 0]], 3)).toEqual([null, null, stack(B.DIRT, 64)]);
  });

  it('resolves item names for commands', () => {
    expect(itemByName('iron_ingot')).toBe(I.IRON_INGOT);
    expect(itemByName('Diamond Pickaxe')).toBe(toolId('pickaxe', 4));
    expect(itemByName('stone')).toBe(B.STONE);
    expect(itemByName('nope')).toBeNull();
  });
});

describe('crafting container', () => {
  it('crafts from the 2×2 grid and gives leftovers back on close', () => {
    const inv = emptySlots(36);
    inv[0] = stack(B.LOG, 3);
    const c = new Container(inv, 2);
    c.click('hotbar', 0, 'left', false); // pick up the logs
    c.click('grid', 3, 'right', false); // put one in the bottom-right corner
    expect(c.result[0]).toEqual(stack(B.PLANKS, 4));
    c.click('result', 0, 'left', false);
    expect(c.cursor).toEqual(stack(B.LOG, 2)); // still holding the logs: can't take
    c.click('hotbar', 0, 'left', false); // put the logs back down
    c.click('result', 0, 'left', false);
    expect(c.cursor).toEqual(stack(B.PLANKS, 4));
    expect(c.grid[3]).toBeNull();
    expect(c.result[0]).toBeNull();
    // Leave planks in the grid and close: they return to the inventory.
    c.click('grid', 0, 'left', false);
    expect(c.close()).toEqual([]);
    expect(inv[0]).toEqual(stack(B.LOG, 2));
    expect(inv[1]).toEqual(stack(B.PLANKS, 4));
  });

  it('shift-clicks the result as many times as the ingredients allow', () => {
    const inv = emptySlots(36);
    const c = new Container(inv, 3);
    c.grid[4] = stack(B.PLANKS, 5);
    c.grid[7] = stack(B.PLANKS, 3);
    c.refresh();
    c.click('result', 0, 'left', true);
    expect(inv[0]).toEqual(stack(I.STICK, 12));
    expect(c.grid[4]).toEqual(stack(B.PLANKS, 2));
    expect(c.grid[7]).toBeNull();
  });

  it('moves stacks between hotbar and main with shift', () => {
    const inv = emptySlots(36);
    inv[2] = stack(B.SAND, 10);
    const c = new Container(inv, 2);
    c.click('hotbar', 2, 'left', true);
    expect(inv[2]).toBeNull();
    expect(inv[9]).toEqual(stack(B.SAND, 10));
    expect(c.dropFrom('main', 0, false)).toEqual(stack(B.SAND, 1));
    expect(inv[9]!.count).toBe(9);
  });
});
