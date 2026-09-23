/**
 * Survival mining: how long a block takes to break with what's in hand,
 * whether it drops anything, and what. Pure.
 */
import type { ItemStack } from '../items/inventory';
import { I, itemDef, type ToolKind } from '../items/items';
import { B, idOf, IS_LIQUID } from '../world/blocks';

interface Hardness {
  /** Seconds-ish scale (Minecraft-like); 0 breaks instantly, < 0 never. */
  readonly hardness: number;
  /** Tool that mines it faster. */
  readonly tool: ToolKind | null;
  /** Minimum pickaxe level to get a drop (−1: anything works, even a fist). */
  readonly level: number;
}

const H = (hardness: number, tool: ToolKind | null = null, level = -1): Hardness => ({ hardness, tool, level });

const TABLE = new Map<number, Hardness>([
  [B.STONE, H(1.5, 'pickaxe', 0)],
  [B.COBBLESTONE, H(2, 'pickaxe', 0)],
  [B.MOSSY_COBBLESTONE, H(2, 'pickaxe', 0)],
  [B.SANDSTONE, H(0.8, 'pickaxe', 0)],
  [B.BRICKS, H(2, 'pickaxe', 0)],
  [B.OBSIDIAN, H(50, 'pickaxe', 3)],
  [B.COAL_ORE, H(3, 'pickaxe', 0)],
  [B.IRON_ORE, H(3, 'pickaxe', 1)],
  [B.GOLD_ORE, H(3, 'pickaxe', 2)],
  [B.DIAMOND_ORE, H(3, 'pickaxe', 2)],
  [B.IRON_BLOCK, H(5, 'pickaxe', 1)],
  [B.GOLD_BLOCK, H(3, 'pickaxe', 2)],
  [B.DIAMOND_BLOCK, H(5, 'pickaxe', 2)],
  [B.SLAB, H(2, 'pickaxe', 0)],
  [B.DOUBLE_SLAB, H(2, 'pickaxe', 0)],
  [B.FURNACE, H(3.5, 'pickaxe', 0)],
  [B.ICE, H(0.5, 'pickaxe')],
  [B.BEDROCK, H(-1)],
  [B.DIRT, H(0.5, 'shovel')],
  [B.GRASS, H(0.6, 'shovel')],
  [B.SAND, H(0.5, 'shovel')],
  [B.GRAVEL, H(0.6, 'shovel')],
  [B.CLAY, H(0.6, 'shovel')],
  [B.SNOW_BLOCK, H(0.2, 'shovel')],
  [B.SNOW_LAYER, H(0.1, 'shovel')],
  [B.LOG, H(2, 'axe')],
  [B.SPRUCE_LOG, H(2, 'axe')],
  [B.BIRCH_LOG, H(2, 'axe')],
  [B.PLANKS, H(2, 'axe')],
  [B.SPRUCE_PLANKS, H(2, 'axe')],
  [B.BIRCH_PLANKS, H(2, 'axe')],
  [B.CRAFTING_TABLE, H(2.5, 'axe')],
  [B.CHEST, H(2.5, 'axe')],
  [B.BOOKSHELF, H(1.5, 'axe')],
  [B.LEAVES, H(0.2)],
  [B.SPRUCE_LEAVES, H(0.2)],
  [B.BIRCH_LEAVES, H(0.2)],
  [B.GLASS, H(0.3)],
  [B.SPONGE, H(0.6)],
  [B.CACTUS, H(0.4)],
  [B.TNT, H(0)],
]);
for (let i = 0; i < 16; i++) TABLE.set(B.WOOL_FIRST + i, H(0.8));

function hardnessOf(id: number): Hardness {
  if (IS_LIQUID[id]) return H(-1);
  // Plants, torches and anything unlisted break instantly.
  return TABLE.get(id) ?? H(0);
}

export function isUnbreakable(id: number): boolean {
  return hardnessOf(id).hardness < 0;
}

function toolOf(held: ItemStack | null): { kind: ToolKind; level: number; speed: number } | null {
  const t = held ? itemDef(held.id)?.tool : null;
  return t ? { kind: t.kind, level: t.level, speed: t.speed } : null;
}

/** Does breaking the block with `held` give its drops? */
export function canHarvest(id: number, held: ItemStack | null): boolean {
  const h = hardnessOf(id);
  if (h.level < 0) return true;
  const t = toolOf(held);
  return t !== null && t.kind === 'pickaxe' && t.level >= h.level;
}

/** Seconds to break block `id` holding `held` (Infinity if unbreakable, 0 if instant). */
export function breakTime(id: number, held: ItemStack | null): number {
  const h = hardnessOf(id);
  if (h.hardness < 0) return Infinity;
  if (h.hardness === 0) return 0;
  const t = toolOf(held);
  let speed = t && t.kind === h.tool ? t.speed : 1;
  // Swords cut through leaves and cobweb-like blocks a bit faster.
  if (t?.kind === 'sword' && h.tool === null) speed = 1.5;
  const perTick = speed / h.hardness / (canHarvest(id, held) ? 30 : 100);
  return Math.ceil(1 / perTick) / 20;
}

/** Does the tool in hand count as the right one (it wears by 1, others by 2)? */
export function toolWear(id: number, held: ItemStack | null): number {
  const t = toolOf(held);
  if (!t || hardnessOf(id).hardness === 0) return 0;
  return t.kind === 'sword' ? 2 : 1;
}

/**
 * What breaking block value `value` with `held` drops. `rand` gives
 * numbers in [0, 1) for chance drops (saplings, apples).
 */
export function drops(value: number, held: ItemStack | null, rand: () => number): ItemStack[] {
  const id = idOf(value);
  if (!canHarvest(id, held)) return [];
  const one = (item: number, count = 1): ItemStack[] => [{ id: item, count, damage: 0 }];
  switch (id) {
    case B.AIR:
    case B.GLASS:
    case B.ICE:
    case B.TALL_GRASS:
    case B.DEAD_BUSH:
    case B.SNOW_LAYER:
    case B.BEDROCK:
    case B.WATER:
    case B.LAVA:
      return [];
    case B.STONE:
      return one(B.COBBLESTONE);
    case B.GRASS:
      return one(B.DIRT);
    case B.COAL_ORE:
      return one(I.COAL);
    case B.DIAMOND_ORE:
      return one(I.DIAMOND);
    case B.DOUBLE_SLAB:
      return one(B.SLAB, 2);
    case B.SNOW_BLOCK:
      return toolOf(held)?.kind === 'shovel' ? one(B.SNOW_BLOCK) : [];
    case B.LEAVES:
    case B.SPRUCE_LEAVES:
    case B.BIRCH_LEAVES: {
      const out: ItemStack[] = [];
      if (rand() < 0.05) out.push({ id: B.SAPLING, count: 1, damage: 0 });
      if (id === B.LEAVES && rand() < 0.02) out.push({ id: I.APPLE, count: 1, damage: 0 });
      return out;
    }
    case B.BOOKSHELF:
      return one(B.PLANKS, 3);
    case B.GRAVEL:
      return rand() < 0.1 ? one(I.FLINT) : one(B.GRAVEL);
    default:
      return one(id);
  }
}
