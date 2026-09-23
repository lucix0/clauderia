/**
 * Crafting recipes as data, and the matcher. Shaped recipes match anywhere
 * in the grid and mirrored; shapeless ones match any arrangement. An
 * ingredient is an item id or a tag such as "#planks".
 */
import { B } from '../world/blocks';
import type { ItemStack, Slots } from './inventory';
import { I, TIERS, toolId, type ToolKind } from './items';

export type Ingredient = number | `#${string}`;

export interface ShapedRecipe {
  readonly kind: 'shaped';
  readonly pattern: readonly string[];
  readonly key: Readonly<Record<string, Ingredient>>;
  readonly out: ItemStack;
}

export interface ShapelessRecipe {
  readonly kind: 'shapeless';
  readonly ingredients: readonly Ingredient[];
  readonly out: ItemStack;
}

export type Recipe = ShapedRecipe | ShapelessRecipe;

export const TAGS: Readonly<Record<string, readonly number[]>> = {
  planks: [B.PLANKS, B.SPRUCE_PLANKS, B.BIRCH_PLANKS],
  logs: [B.LOG, B.SPRUCE_LOG, B.BIRCH_LOG],
  coals: [I.COAL, I.CHARCOAL],
};

export function ingredientMatches(ing: Ingredient, id: number): boolean {
  if (typeof ing === 'number') return ing === id;
  return TAGS[ing.slice(1)]?.includes(id) ?? false;
}

function out(id: number, count = 1): ItemStack {
  return { id, count, damage: 0 };
}

function shaped(pattern: string[], key: Record<string, Ingredient>, result: ItemStack): ShapedRecipe {
  return { kind: 'shaped', pattern, key, out: result };
}

function shapeless(ingredients: Ingredient[], result: ItemStack): ShapelessRecipe {
  return { kind: 'shapeless', ingredients, out: result };
}

const TOOL_PATTERNS: Record<ToolKind, string[]> = {
  pickaxe: ['XXX', ' S ', ' S '],
  axe: ['XX', 'XS', ' S'],
  shovel: ['X', 'S', 'S'],
  sword: ['X', 'X', 'S'],
};
const TIER_MATERIAL: Ingredient[] = ['#planks', B.COBBLESTONE, I.IRON_INGOT, I.GOLD_INGOT, I.DIAMOND];

function storage(block: number, item: number): Recipe[] {
  return [shaped(['XXX', 'XXX', 'XXX'], { X: item }, out(block)), shapeless([block], out(item, 9))];
}

export const RECIPES: readonly Recipe[] = [
  shapeless([B.LOG], out(B.PLANKS, 4)),
  shapeless([B.SPRUCE_LOG], out(B.SPRUCE_PLANKS, 4)),
  shapeless([B.BIRCH_LOG], out(B.BIRCH_PLANKS, 4)),
  shaped(['X', 'X'], { X: '#planks' }, out(I.STICK, 4)),
  shaped(['XX', 'XX'], { X: '#planks' }, out(B.CRAFTING_TABLE)),
  shaped(['C', 'S'], { C: '#coals', S: I.STICK }, out(B.TORCH, 4)),
  shaped(['XXX', 'X X', 'XXX'], { X: B.COBBLESTONE }, out(B.FURNACE)),
  shaped(['XXX', 'X X', 'XXX'], { X: '#planks' }, out(B.CHEST)),
  shaped(['X X', ' X '], { X: I.IRON_INGOT }, out(I.BUCKET)),
  ...storage(B.IRON_BLOCK, I.IRON_INGOT),
  ...storage(B.GOLD_BLOCK, I.GOLD_INGOT),
  ...storage(B.DIAMOND_BLOCK, I.DIAMOND),
  shaped(['XX', 'XX'], { X: I.STRING }, out(B.WOOL_FIRST + 15)), // white wool
  shapeless([I.BONE], out(I.BONE_MEAL, 3)),
  shaped(['XX', 'XX'], { X: B.SAND }, out(B.SANDSTONE)),
  shaped(['XXX'], { X: B.STONE }, out(B.SLAB, 6)),
  shaped(['XX', 'XX'], { X: B.SNOW_LAYER }, out(B.SNOW_BLOCK)),
  // No birds here, so arrows are fletched with nothing but a flint head.
  shaped(['F', 'S'], { F: I.FLINT, S: I.STICK }, out(I.ARROW, 4)),
  shaped([' SX', 'S X', ' SX'], { S: I.STICK, X: I.STRING }, out(I.BOW)),
  ...(Object.keys(TOOL_PATTERNS) as ToolKind[]).flatMap((kind) =>
    TIERS.map((_, t) => shaped(TOOL_PATTERNS[kind], { X: TIER_MATERIAL[t]!, S: I.STICK }, out(toolId(kind, t)))),
  ),
];

/** Grid cells as ids (0 = empty), row-major w×h. */
function ids(grid: Slots): number[] {
  return grid.map((s) => (s && s.count > 0 ? s.id : 0));
}

function matchShaped(r: ShapedRecipe, cells: number[], w: number, h: number): boolean {
  // Bounding box of the filled cells.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!cells[y * w + x]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return false;
  const pw = Math.max(...r.pattern.map((row) => row.length));
  const ph = r.pattern.length;
  if (x1 - x0 + 1 !== pw || y1 - y0 + 1 !== ph) return false;
  const test = (mirror: boolean): boolean => {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const ch = r.pattern[y]![mirror ? pw - 1 - x : x] ?? ' ';
        const id = cells[(y0 + y) * w + x0 + x]!;
        if (ch === ' ') {
          if (id) return false;
        } else if (!id || !ingredientMatches(r.key[ch]!, id)) {
          return false;
        }
      }
    }
    return true;
  };
  return test(false) || test(true);
}

function matchShapeless(r: ShapelessRecipe, cells: number[]): boolean {
  const items = cells.filter((id) => id !== 0);
  if (items.length !== r.ingredients.length) return false;
  // Assign every item to a distinct ingredient (tags can overlap: backtrack).
  const used = new Array<boolean>(r.ingredients.length).fill(false);
  const assign = (k: number): boolean => {
    if (k === items.length) return true;
    for (let j = 0; j < r.ingredients.length; j++) {
      if (used[j] || !ingredientMatches(r.ingredients[j]!, items[k]!)) continue;
      used[j] = true;
      if (assign(k + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return assign(0);
}

/** The recipe a w×h crafting grid makes, or null. */
export function matchRecipe(grid: Slots, w: number, h: number, recipes: readonly Recipe[] = RECIPES): Recipe | null {
  const cells = ids(grid);
  for (const r of recipes) {
    if (r.kind === 'shaped' ? matchShaped(r, cells, w, h) : matchShapeless(r, cells)) return r;
  }
  return null;
}

/** Use up one of every ingredient in the grid (after taking the result). */
export function consumeGrid(grid: Slots): void {
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i];
    if (!s) continue;
    s.count--;
    if (s.count <= 0) grid[i] = null;
  }
}
