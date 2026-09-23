/**
 * Item registry. Block items share the block's id (< 256); everything else
 * (materials, food, tools, buckets) has an id from 256 up. Pure data.
 */
import { B, BLOCKS, BLOCK_COUNT, isValidBlock } from '../world/blocks';

export const ITEM_FIRST = 256;

export const I = {
  STICK: 256,
  COAL: 257,
  CHARCOAL: 258,
  IRON_INGOT: 259,
  GOLD_INGOT: 260,
  DIAMOND: 261,
  APPLE: 262,
  RAW_PORK: 263,
  COOKED_PORK: 264,
  RAW_BEEF: 265,
  COOKED_BEEF: 266,
  BONE: 267,
  BONE_MEAL: 268,
  STRING: 269,
  BUCKET: 270,
  WATER_BUCKET: 271,
  LAVA_BUCKET: 272,
  FLINT: 273,
  ARROW: 274,
  BOW: 275,
} as const;

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword';
export const TOOL_KINDS: readonly ToolKind[] = ['pickaxe', 'axe', 'shovel', 'sword'];

export interface Tier {
  readonly key: string;
  readonly name: string;
  /** Harvest level: which ores it can mine (wood/gold 0, stone 1, iron 2, diamond 3). */
  readonly level: number;
  /** Mining speed multiplier on the right blocks. */
  readonly speed: number;
  readonly durability: number;
  /** Extra attack damage. */
  readonly damage: number;
}

export const TIERS: readonly Tier[] = [
  { key: 'wooden', name: 'Wooden', level: 0, speed: 2, durability: 59, damage: 0 },
  { key: 'stone', name: 'Stone', level: 1, speed: 4, durability: 131, damage: 1 },
  { key: 'iron', name: 'Iron', level: 2, speed: 6, durability: 250, damage: 2 },
  { key: 'golden', name: 'Golden', level: 0, speed: 12, durability: 32, damage: 0 },
  { key: 'diamond', name: 'Diamond', level: 3, speed: 8, durability: 1561, damage: 3 },
];

export const TOOL_FIRST = 280;

export function toolId(kind: ToolKind, tier: number): number {
  return TOOL_FIRST + TOOL_KINDS.indexOf(kind) * TIERS.length + tier;
}

export interface ToolInfo {
  readonly kind: ToolKind;
  readonly tier: number;
  readonly level: number;
  readonly speed: number;
  readonly durability: number;
}

export interface FoodInfo {
  readonly hunger: number;
  readonly saturation: number;
}

export interface ItemDef {
  readonly id: number;
  /** Command name: lower case with underscores. */
  readonly key: string;
  readonly name: string;
  readonly maxStack: number;
  readonly tool: ToolInfo | null;
  /** Damage dealt when hitting with it (a fist does 1). */
  readonly attack: number;
  /** Uses before it breaks (tools, bow); 0 for items that don't wear. */
  readonly durability: number;
  readonly food: FoodInfo | null;
  /** Furnace burn time in ticks (0: not a fuel). */
  readonly fuel: number;
  /** Is it a block that can be placed? */
  readonly block: boolean;
}

function keyOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const defs = new Map<number, ItemDef>();

function add(d: Partial<ItemDef> & { id: number; name: string }): void {
  defs.set(d.id, {
    key: keyOf(d.name),
    maxStack: 64,
    tool: null,
    attack: 1,
    durability: 0,
    food: null,
    fuel: 0,
    block: false,
    ...d,
  });
}

// Block items.
const BLOCK_FUEL: Record<number, number> = {
  [B.LOG]: 300,
  [B.SPRUCE_LOG]: 300,
  [B.BIRCH_LOG]: 300,
  [B.PLANKS]: 300,
  [B.SPRUCE_PLANKS]: 300,
  [B.BIRCH_PLANKS]: 300,
  [B.CRAFTING_TABLE]: 300,
  [B.CHEST]: 300,
  [B.BOOKSHELF]: 300,
  [B.SAPLING]: 100,
};
for (let id = 1; id < BLOCK_COUNT; id++) {
  if (!isValidBlock(id)) continue;
  add({ id, name: BLOCKS[id]!.name, block: true, fuel: BLOCK_FUEL[id] ?? 0 });
}

add({ id: I.STICK, name: 'Stick', fuel: 100 });
add({ id: I.COAL, name: 'Coal', fuel: 1600 });
add({ id: I.CHARCOAL, name: 'Charcoal', fuel: 1600 });
add({ id: I.IRON_INGOT, name: 'Iron Ingot' });
add({ id: I.GOLD_INGOT, name: 'Gold Ingot' });
add({ id: I.DIAMOND, name: 'Diamond' });
add({ id: I.APPLE, name: 'Apple', food: { hunger: 4, saturation: 2.4 } });
add({ id: I.RAW_PORK, name: 'Raw Porkchop', food: { hunger: 3, saturation: 1.8 } });
add({ id: I.COOKED_PORK, name: 'Cooked Porkchop', food: { hunger: 8, saturation: 12.8 } });
add({ id: I.RAW_BEEF, name: 'Raw Beef', food: { hunger: 3, saturation: 1.8 } });
add({ id: I.COOKED_BEEF, name: 'Steak', food: { hunger: 8, saturation: 12.8 } });
add({ id: I.BONE, name: 'Bone' });
add({ id: I.BONE_MEAL, name: 'Bone Meal' });
add({ id: I.STRING, name: 'String' });
add({ id: I.BUCKET, name: 'Bucket', maxStack: 16 });
add({ id: I.WATER_BUCKET, name: 'Water Bucket', maxStack: 1 });
add({ id: I.LAVA_BUCKET, name: 'Lava Bucket', maxStack: 1, fuel: 20000 });
add({ id: I.FLINT, name: 'Flint' });
add({ id: I.ARROW, name: 'Arrow' });
add({ id: I.BOW, name: 'Bow', maxStack: 1, durability: 384, fuel: 300 });

const BASE_ATTACK: Record<ToolKind, number> = { pickaxe: 2, axe: 3, shovel: 1.5, sword: 4 };
TOOL_KINDS.forEach((kind) => {
  TIERS.forEach((tier, t) => {
    const name = `${tier.name} ${kind === 'pickaxe' ? 'Pickaxe' : kind === 'axe' ? 'Axe' : kind === 'shovel' ? 'Shovel' : 'Sword'}`;
    add({
      id: toolId(kind, t),
      name,
      maxStack: 1,
      tool: { kind, tier: t, level: tier.level, speed: tier.speed, durability: tier.durability },
      durability: tier.durability,
      attack: BASE_ATTACK[kind] + tier.damage,
      fuel: t === 0 ? 200 : 0,
    });
  });
});

export function itemDef(id: number): ItemDef | undefined {
  return defs.get(id);
}

export function isValidItem(id: number): boolean {
  return defs.has(id);
}

export function itemName(id: number): string {
  return defs.get(id)?.name ?? `Unknown (${id})`;
}

export function maxStack(id: number): number {
  return defs.get(id)?.maxStack ?? 64;
}

/** Every item (blocks first), for the creative inventory and /give. */
export const ALL_ITEMS: readonly ItemDef[] = [...defs.values()];

/** Item id from a command name ("iron_ingot", "Iron Ingot", "stone") or number. */
export function itemByName(token: string): number | null {
  if (/^\d+$/.test(token)) return defs.has(Number(token)) ? Number(token) : null;
  const want = keyOf(token.replace(/^minecraft:/, ''));
  for (const d of defs.values()) if (d.key === want) return d.id;
  // A few friendly aliases.
  const alias: Record<string, number> = {
    wood: B.LOG,
    log: B.LOG,
    oak_log: B.LOG,
    planks: B.PLANKS,
    oak_planks: B.PLANKS,
    leaves: B.LEAVES,
    oak_leaves: B.LEAVES,
    porkchop: I.RAW_PORK,
    beef: I.RAW_BEEF,
    cooked_beef: I.COOKED_BEEF,
    steak: I.COOKED_BEEF,
    gold_pickaxe: toolId('pickaxe', 3),
    wood_pickaxe: toolId('pickaxe', 0),
  };
  return alias[want] ?? null;
}
