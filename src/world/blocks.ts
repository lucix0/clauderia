/**
 * Block and texture-tile registry. Pure data: no three.js, no DOM.
 *
 * Face order used everywhere: 0 +X (east), 1 -X (west), 2 +Y (top),
 * 3 -Y (bottom), 4 +Z (south), 5 -Z (north).
 */

/** Texture tile ids (index into the 16×16-tile atlas). */
export const T = {
  STONE: 0,
  GRASS_TOP: 1,
  GRASS_SIDE: 2,
  DIRT: 3,
  COBBLE: 4,
  PLANKS: 5,
  LOG_SIDE: 6,
  LOG_TOP: 7,
  LEAVES: 8,
  GLASS: 9,
  SAND: 10,
  GRAVEL: 11,
  BEDROCK: 12,
  WATER: 13,
  LAVA: 14,
  COAL_ORE: 15,
  IRON_ORE: 16,
  GOLD_ORE: 17,
  IRON_TOP: 18,
  IRON_SIDE: 19,
  IRON_BOTTOM: 20,
  GOLD_TOP: 21,
  GOLD_SIDE: 22,
  GOLD_BOTTOM: 23,
  BRICKS: 24,
  MOSSY: 25,
  OBSIDIAN: 26,
  SPONGE: 27,
  BOOKSHELF: 28,
  TNT_SIDE: 29,
  TNT_TOP: 30,
  TNT_BOTTOM: 31,
  SLAB_SIDE: 32,
  SLAB_TOP: 33,
  DANDELION: 34,
  ROSE: 35,
  RED_MUSHROOM: 36,
  BROWN_MUSHROOM: 37,
  SAPLING: 38,
  WOOL_FIRST: 39, // 16 consecutive wool tiles
  TORCH: 55,
} as const;

export const TILE_COUNT = T.TORCH + 1;
export const ATLAS_TILES_PER_ROW = 16;

/** Block ids. Stored as bytes in the world array. */
export const B = {
  AIR: 0,
  STONE: 1,
  GRASS: 2,
  DIRT: 3,
  COBBLESTONE: 4,
  PLANKS: 5,
  SAPLING: 6,
  BEDROCK: 7,
  WATER: 8,
  LAVA: 9,
  SAND: 10,
  GRAVEL: 11,
  GOLD_ORE: 12,
  IRON_ORE: 13,
  COAL_ORE: 14,
  LOG: 15,
  LEAVES: 16,
  SPONGE: 17,
  GLASS: 18,
  WOOL_FIRST: 19, // 19..34
  DANDELION: 35,
  ROSE: 36,
  BROWN_MUSHROOM: 37,
  RED_MUSHROOM: 38,
  GOLD_BLOCK: 39,
  IRON_BLOCK: 40,
  DOUBLE_SLAB: 41,
  SLAB: 42,
  BRICKS: 43,
  TNT: 44,
  BOOKSHELF: 45,
  MOSSY_COBBLESTONE: 46,
  OBSIDIAN: 47,
  TORCH: 48,
} as const;

export const BLOCK_COUNT = 49;

/**
 * Stored block values are 16-bit: the low byte is the block id, the high byte
 * a per-block state (fluid level, orientation…). Lookup tables use the id.
 */
export const ID_MASK = 0xff;

export function idOf(value: number): number {
  return value & ID_MASK;
}

export function stateOf(value: number): number {
  return value >> 8;
}

export function withState(id: number, state: number): number {
  return (id & ID_MASK) | ((state & 0xff) << 8);
}

export type Shape = 'none' | 'cube' | 'cross' | 'slab' | 'torch';
export type RenderPass = 'opaque' | 'cutout' | 'translucent';

export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_SLAB = 3;
export const SHAPE_TORCH = 4;

export const PASS_OPAQUE = 0;
export const PASS_CUTOUT = 1;
export const PASS_TRANSLUCENT = 2;
export const PASS_COUNT = 3;

/** Tiles per face: [+X, -X, +Y, -Y, +Z, -Z]. */
export type FaceTiles = readonly [number, number, number, number, number, number];

export interface BlockDef {
  readonly id: number;
  readonly name: string;
  readonly tiles: FaceTiles;
  /** Collides with the player. */
  readonly solid: boolean;
  /** Counts for the light height map (casts a shadow below it). */
  readonly blocksLight: boolean;
  readonly shape: Shape;
  readonly pass: RenderPass;
  /** Faces between two blocks of this same type are culled. */
  readonly cullSame: boolean;
  readonly liquid: boolean;
  /** Always rendered at full brightness (lava). */
  readonly fullBright: boolean;
  /** Can be hit by the targeting ray. */
  readonly selectable: boolean;
  /** Needs a solid block underneath; pops off otherwise. */
  readonly plant: boolean;
  /** Light emitted (0–15). */
  readonly emit: number;
  /** How much light it takes away when passing through (0 clear … 15 opaque). */
  readonly opacity: number;
}

interface BlockSpec {
  name: string;
  tiles: number | FaceTiles;
  solid?: boolean;
  blocksLight?: boolean;
  shape?: Shape;
  pass?: RenderPass;
  cullSame?: boolean;
  liquid?: boolean;
  fullBright?: boolean;
  selectable?: boolean;
  plant?: boolean;
  emit?: number;
  opacity?: number;
}

function all(t: number): FaceTiles {
  return [t, t, t, t, t, t];
}

/** [side, top, bottom] → per-face tiles. */
function column(side: number, top: number, bottom: number): FaceTiles {
  return [side, side, top, bottom, side, side];
}

export const WOOL_NAMES: readonly string[] = [
  'Red',
  'Orange',
  'Yellow',
  'Lime',
  'Green',
  'Teal',
  'Cyan',
  'Sky',
  'Blue',
  'Indigo',
  'Violet',
  'Magenta',
  'Pink',
  'Charcoal',
  'Gray',
  'White',
];

const specs: Record<number, BlockSpec> = {
  [B.AIR]: { name: 'Air', tiles: 0, solid: false, blocksLight: false, shape: 'none', selectable: false },
  [B.STONE]: { name: 'Stone', tiles: T.STONE },
  [B.GRASS]: { name: 'Grass', tiles: column(T.GRASS_SIDE, T.GRASS_TOP, T.DIRT) },
  [B.DIRT]: { name: 'Dirt', tiles: T.DIRT },
  [B.COBBLESTONE]: { name: 'Cobblestone', tiles: T.COBBLE },
  [B.PLANKS]: { name: 'Planks', tiles: T.PLANKS },
  [B.SAPLING]: { name: 'Sapling', tiles: T.SAPLING, shape: 'cross', plant: true },
  [B.BEDROCK]: { name: 'Bedrock', tiles: T.BEDROCK },
  [B.WATER]: {
    name: 'Water',
    tiles: T.WATER,
    solid: false,
    blocksLight: true,
    pass: 'translucent',
    cullSame: true,
    liquid: true,
    selectable: false,
    opacity: 2,
  },
  [B.LAVA]: {
    name: 'Lava',
    tiles: T.LAVA,
    solid: false,
    blocksLight: true,
    liquid: true,
    fullBright: true,
    selectable: false,
    emit: 15,
  },
  [B.SAND]: { name: 'Sand', tiles: T.SAND },
  [B.GRAVEL]: { name: 'Gravel', tiles: T.GRAVEL },
  [B.GOLD_ORE]: { name: 'Gold Ore', tiles: T.GOLD_ORE },
  [B.IRON_ORE]: { name: 'Iron Ore', tiles: T.IRON_ORE },
  [B.COAL_ORE]: { name: 'Coal Ore', tiles: T.COAL_ORE },
  [B.LOG]: { name: 'Log', tiles: column(T.LOG_SIDE, T.LOG_TOP, T.LOG_TOP) },
  [B.LEAVES]: { name: 'Leaves', tiles: T.LEAVES, pass: 'cutout', cullSame: false, opacity: 1 },
  [B.SPONGE]: { name: 'Sponge', tiles: T.SPONGE },
  [B.GLASS]: { name: 'Glass', tiles: T.GLASS, blocksLight: false, pass: 'cutout', cullSame: true },
  [B.DANDELION]: { name: 'Dandelion', tiles: T.DANDELION, shape: 'cross', plant: true },
  [B.ROSE]: { name: 'Rose', tiles: T.ROSE, shape: 'cross', plant: true },
  [B.BROWN_MUSHROOM]: { name: 'Brown Mushroom', tiles: T.BROWN_MUSHROOM, shape: 'cross', plant: true },
  [B.RED_MUSHROOM]: { name: 'Red Mushroom', tiles: T.RED_MUSHROOM, shape: 'cross', plant: true },
  [B.GOLD_BLOCK]: { name: 'Gold Block', tiles: column(T.GOLD_SIDE, T.GOLD_TOP, T.GOLD_BOTTOM) },
  [B.IRON_BLOCK]: { name: 'Iron Block', tiles: column(T.IRON_SIDE, T.IRON_TOP, T.IRON_BOTTOM) },
  [B.DOUBLE_SLAB]: { name: 'Double Slab', tiles: column(T.SLAB_SIDE, T.SLAB_TOP, T.SLAB_TOP) },
  [B.SLAB]: { name: 'Slab', tiles: column(T.SLAB_SIDE, T.SLAB_TOP, T.SLAB_TOP), shape: 'slab' },
  [B.BRICKS]: { name: 'Bricks', tiles: T.BRICKS },
  [B.TNT]: { name: 'TNT', tiles: column(T.TNT_SIDE, T.TNT_TOP, T.TNT_BOTTOM) },
  [B.BOOKSHELF]: { name: 'Bookshelf', tiles: column(T.BOOKSHELF, T.PLANKS, T.PLANKS) },
  [B.MOSSY_COBBLESTONE]: { name: 'Mossy Cobblestone', tiles: T.MOSSY },
  [B.OBSIDIAN]: { name: 'Obsidian', tiles: T.OBSIDIAN },
  [B.TORCH]: {
    name: 'Torch',
    tiles: T.TORCH,
    shape: 'torch',
    solid: false,
    blocksLight: false,
    pass: 'cutout',
    emit: 14,
  },
};
for (let i = 0; i < 16; i++) {
  specs[B.WOOL_FIRST + i] = { name: `${WOOL_NAMES[i]} Wool`, tiles: T.WOOL_FIRST + i };
}

function build(id: number, s: BlockSpec): BlockDef {
  const shape = s.shape ?? 'cube';
  const isCross = shape === 'cross';
  const blocksLight = s.blocksLight ?? !isCross;
  return {
    id,
    name: s.name,
    tiles: typeof s.tiles === 'number' ? all(s.tiles) : s.tiles,
    solid: s.solid ?? !isCross,
    blocksLight: s.blocksLight ?? !isCross,
    shape,
    pass: s.pass ?? (isCross ? 'cutout' : 'opaque'),
    cullSame: s.cullSame ?? false,
    liquid: s.liquid ?? false,
    fullBright: s.fullBright ?? false,
    selectable: s.selectable ?? true,
    plant: s.plant ?? false,
    emit: s.emit ?? 0,
    opacity: s.opacity ?? (blocksLight ? 15 : 0),
  };
}

export const BLOCKS: readonly BlockDef[] = Array.from({ length: BLOCK_COUNT }, (_, id) => {
  const spec = specs[id];
  if (!spec) throw new Error(`Block id ${id} has no definition`);
  return build(id, spec);
});

// ---- Flat lookup tables for hot loops (mesher, physics, raycast) ----

const SHAPE_CODES: Record<Shape, number> = {
  none: SHAPE_NONE,
  cube: SHAPE_CUBE,
  cross: SHAPE_CROSS,
  slab: SHAPE_SLAB,
  torch: SHAPE_TORCH,
};
const PASS_CODES: Record<RenderPass, number> = {
  opaque: PASS_OPAQUE,
  cutout: PASS_CUTOUT,
  translucent: PASS_TRANSLUCENT,
};

export const IS_SOLID = new Uint8Array(256);
export const BLOCKS_LIGHT = new Uint8Array(256);
export const SHAPE = new Uint8Array(256);
export const PASS = new Uint8Array(256);
export const CULL_SAME = new Uint8Array(256);
export const IS_LIQUID = new Uint8Array(256);
export const FULL_BRIGHT = new Uint8Array(256);
export const SELECTABLE = new Uint8Array(256);
export const IS_PLANT = new Uint8Array(256);
/** Full opaque cube: hides every neighbouring face that touches it. */
export const OCCLUDES = new Uint8Array(256);
/** Tile per face, 6 entries per block id. */
export const FACE_TILES = new Uint8Array(256 * 6);
/** Light emitted by each block id (0–15). */
export const LIGHT_EMIT = new Uint8Array(256);
/** Light opacity of each block id (0 clear … 15 opaque). Unknown ids are opaque. */
export const LIGHT_OPACITY = new Uint8Array(256).fill(15);

for (const def of BLOCKS) {
  const id = def.id;
  IS_SOLID[id] = def.solid ? 1 : 0;
  BLOCKS_LIGHT[id] = def.blocksLight ? 1 : 0;
  SHAPE[id] = SHAPE_CODES[def.shape];
  PASS[id] = PASS_CODES[def.pass];
  CULL_SAME[id] = def.cullSame ? 1 : 0;
  IS_LIQUID[id] = def.liquid ? 1 : 0;
  FULL_BRIGHT[id] = def.fullBright ? 1 : 0;
  SELECTABLE[id] = def.selectable ? 1 : 0;
  IS_PLANT[id] = def.plant ? 1 : 0;
  OCCLUDES[id] = def.shape === 'cube' && def.pass === 'opaque' ? 1 : 0;
  LIGHT_EMIT[id] = def.emit;
  LIGHT_OPACITY[id] = def.opacity;
  for (let f = 0; f < 6; f++) FACE_TILES[id * 6 + f] = def.tiles[f]!;
}

export function blockName(id: number): string {
  return BLOCKS[id]?.name ?? `Unknown (${id})`;
}

export function isValidBlock(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < BLOCK_COUNT;
}

/** Height of the collision box of a solid block (0 when not solid). */
export function collisionHeight(id: number): number {
  if (!IS_SOLID[id]) return 0;
  return SHAPE[id] === SHAPE_SLAB ? 0.5 : 1;
}

/** Can a plant (or a torch) sit on / hang from this block? */
export function supportsPlant(id: number): boolean {
  return IS_SOLID[id] === 1 && SHAPE[id] === SHAPE_CUBE;
}

/**
 * Torch attachment states: 0 stands on the floor; 1–4 hang on a wall and
 * lean away from it toward +X, −X, +Z, −Z (the wall is on the other side).
 */
export const TORCH_ATTACH: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Selection / hit box of a block inside its cell: [minX, minY, minZ, maxX, maxY, maxZ]. */
export function blockBounds(id: number): readonly [number, number, number, number, number, number] {
  const shape = SHAPE[id];
  if (shape === SHAPE_SLAB) return SLAB_BOUNDS;
  if (shape === SHAPE_CROSS) return CROSS_BOUNDS;
  if (shape === SHAPE_TORCH) return TORCH_BOUNDS;
  return CUBE_BOUNDS;
}
const CUBE_BOUNDS = [0, 0, 0, 1, 1, 1] as const;
const SLAB_BOUNDS = [0, 0, 0, 1, 0.5, 1] as const;
const CROSS_BOUNDS = [0.2, 0, 0.2, 0.8, 0.8, 0.8] as const;
const TORCH_BOUNDS = [0.4, 0, 0.4, 0.6, 0.65, 0.6] as const;

/** Every block a player can pick from the block picker (everything except air). */
export const PICKABLE_BLOCKS: readonly number[] = [
  B.STONE,
  B.COBBLESTONE,
  B.BRICKS,
  B.DIRT,
  B.PLANKS,
  B.LOG,
  B.LEAVES,
  B.GLASS,
  B.SLAB,
  B.MOSSY_COBBLESTONE,
  B.SAPLING,
  B.DANDELION,
  B.ROSE,
  B.BROWN_MUSHROOM,
  B.RED_MUSHROOM,
  B.SAND,
  B.GRAVEL,
  B.SPONGE,
  ...Array.from({ length: 16 }, (_, i) => B.WOOL_FIRST + i),
  B.COAL_ORE,
  B.IRON_ORE,
  B.GOLD_ORE,
  B.IRON_BLOCK,
  B.GOLD_BLOCK,
  B.BOOKSHELF,
  B.TNT,
  B.OBSIDIAN,
  B.TORCH,
  B.DOUBLE_SLAB,
  B.GRASS,
  B.BEDROCK,
  B.WATER,
  B.LAVA,
];

export const DEFAULT_HOTBAR: readonly number[] = [
  B.STONE,
  B.COBBLESTONE,
  B.BRICKS,
  B.DIRT,
  B.PLANKS,
  B.LOG,
  B.LEAVES,
  B.GLASS,
  B.SLAB,
];
