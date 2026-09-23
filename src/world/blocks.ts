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
  SANDSTONE_TOP: 56,
  SANDSTONE_SIDE: 57,
  SANDSTONE_BOTTOM: 58,
  SNOW: 59,
  ICE: 60,
  CACTUS_SIDE: 61,
  CACTUS_TOP: 62,
  CACTUS_BOTTOM: 63,
  DEAD_BUSH: 64,
  TALL_GRASS: 65,
  CLAY: 66,
  SPRUCE_LOG: 67,
  SPRUCE_LOG_TOP: 68,
  SPRUCE_LEAVES: 69,
  SPRUCE_PLANKS: 70,
  BIRCH_LOG: 71,
  BIRCH_LOG_TOP: 72,
  BIRCH_LEAVES: 73,
  BIRCH_PLANKS: 74,
  DIAMOND_ORE: 75,
  DIAMOND_BLOCK: 76,
  GRASS_SIDE_SNOW: 77,
  CRAFTING_TOP: 78,
  CRAFTING_SIDE: 79,
  CRAFTING_FRONT: 80,
  FURNACE_FRONT: 81,
  FURNACE_FRONT_LIT: 82,
  FURNACE_SIDE: 83,
  FURNACE_TOP: 84,
  CHEST_FRONT: 85,
  CHEST_SIDE: 86,
  CHEST_TOP: 87,
  /** Ten mining crack stages (transparent overlays). */
  CRACK_FIRST: 88,
  BED_HEAD_TOP: 98,
  BED_FOOT_TOP: 99,
  BED_SIDE: 100,
  BED_HEAD_END: 101,
  BED_FOOT_END: 102,
  /** Eight wheat growth stages. */
  WHEAT_FIRST: 103,
  FARMLAND_DRY: 111,
  FARMLAND_WET: 112,
} as const;

export const CRACK_STAGES = 10;
export const WHEAT_STAGES = 8;
export const TILE_COUNT = T.FARMLAND_WET + 1;
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
  SANDSTONE: 49,
  SNOW_BLOCK: 50,
  SNOW_LAYER: 51,
  ICE: 52,
  CACTUS: 53,
  DEAD_BUSH: 54,
  TALL_GRASS: 55,
  CLAY: 56,
  SPRUCE_LOG: 57,
  SPRUCE_LEAVES: 58,
  SPRUCE_PLANKS: 59,
  BIRCH_LOG: 60,
  BIRCH_LEAVES: 61,
  BIRCH_PLANKS: 62,
  DIAMOND_ORE: 63,
  DIAMOND_BLOCK: 64,
  CRAFTING_TABLE: 65,
  FURNACE: 66,
  CHEST: 67,
  BED: 68,
  FARMLAND: 69,
  WHEAT: 70,
} as const;

export const BLOCK_COUNT = 71;

/**
 * Light-only id for a lit furnace (emits light; never stored in the world).
 * 255 is taken by "unloaded" in light regions.
 */
export const LIT_FURNACE_LIGHT_ID = 254;

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

export type Shape = 'none' | 'cube' | 'cross' | 'slab' | 'torch' | 'layer' | 'cactus';
/**
 * How a block's colour follows the biome: none, the column's grass /
 * foliage / water colour, or a fixed colour (0xRRGGBB).
 */
export type Tint = 'none' | 'grass' | 'foliage' | 'water' | number;
export type RenderPass = 'opaque' | 'cutout' | 'translucent';

export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_SLAB = 3;
export const SHAPE_TORCH = 4;
/** Thin layer on the floor (snow): drawn like a 2/16-tall slab. */
export const SHAPE_LAYER = 5;
/** Cube whose sides are inset by 1/16 (cactus). */
export const SHAPE_CACTUS = 6;

export const TINT_NONE = 0;
export const TINT_GRASS = 1;
export const TINT_FOLIAGE = 2;
export const TINT_WATER = 3;
export const TINT_FIXED = 4;

/** Tints used where a column has no biome colours (Classic worlds, icons). */
export const DEFAULT_GRASS_TINT = 0x77bf4c;
export const DEFAULT_FOLIAGE_TINT = 0x5aa83b;
export const DEFAULT_WATER_TINT = 0x4379e8;

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
  readonly tint: Tint;
  /** Placing a block into this cell just replaces it (tall grass, snow layer). */
  readonly replaceable: boolean;
  /** Logs: the block state holds an axis (0 Y, 1 X, 2 Z). */
  readonly axis: boolean;
  /** Furnaces and chests: state bits 0–1 face the front toward the player. */
  readonly facing: boolean;
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
  tint?: Tint;
  replaceable?: boolean;
  axis?: boolean;
  facing?: boolean;
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
  [B.GRASS]: { name: 'Grass', tiles: column(T.GRASS_SIDE, T.GRASS_TOP, T.DIRT), tint: 'grass' },
  [B.DIRT]: { name: 'Dirt', tiles: T.DIRT },
  [B.COBBLESTONE]: { name: 'Cobblestone', tiles: T.COBBLE },
  [B.PLANKS]: { name: 'Oak Planks', tiles: T.PLANKS },
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
    tint: 'water',
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
  [B.LOG]: { name: 'Oak Log', tiles: column(T.LOG_SIDE, T.LOG_TOP, T.LOG_TOP), axis: true },
  [B.LEAVES]: { name: 'Oak Leaves', tiles: T.LEAVES, pass: 'cutout', cullSame: false, opacity: 1, tint: 'foliage' },
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
  [B.SANDSTONE]: { name: 'Sandstone', tiles: column(T.SANDSTONE_SIDE, T.SANDSTONE_TOP, T.SANDSTONE_BOTTOM) },
  [B.SNOW_BLOCK]: { name: 'Snow Block', tiles: T.SNOW },
  [B.SNOW_LAYER]: {
    name: 'Snow',
    tiles: T.SNOW,
    shape: 'layer',
    solid: false,
    blocksLight: false,
    cullSame: true,
    replaceable: true,
  },
  [B.ICE]: { name: 'Ice', tiles: T.ICE, pass: 'translucent', cullSame: true, blocksLight: true, opacity: 2 },
  [B.CACTUS]: {
    name: 'Cactus',
    tiles: column(T.CACTUS_SIDE, T.CACTUS_TOP, T.CACTUS_BOTTOM),
    shape: 'cactus',
    pass: 'cutout',
    cullSame: true,
    opacity: 0,
    blocksLight: false,
  },
  [B.DEAD_BUSH]: { name: 'Dead Bush', tiles: T.DEAD_BUSH, shape: 'cross', plant: true, replaceable: true },
  [B.TALL_GRASS]: { name: 'Tall Grass', tiles: T.TALL_GRASS, shape: 'cross', plant: true, replaceable: true, tint: 'grass' },
  [B.CLAY]: { name: 'Clay', tiles: T.CLAY },
  [B.SPRUCE_LOG]: { name: 'Spruce Log', tiles: column(T.SPRUCE_LOG, T.SPRUCE_LOG_TOP, T.SPRUCE_LOG_TOP), axis: true },
  [B.SPRUCE_LEAVES]: { name: 'Spruce Leaves', tiles: T.SPRUCE_LEAVES, pass: 'cutout', opacity: 1, tint: 0x5f8f5f },
  [B.SPRUCE_PLANKS]: { name: 'Spruce Planks', tiles: T.SPRUCE_PLANKS },
  [B.BIRCH_LOG]: { name: 'Birch Log', tiles: column(T.BIRCH_LOG, T.BIRCH_LOG_TOP, T.BIRCH_LOG_TOP), axis: true },
  [B.BIRCH_LEAVES]: { name: 'Birch Leaves', tiles: T.BIRCH_LEAVES, pass: 'cutout', opacity: 1, tint: 0x80a755 },
  [B.BIRCH_PLANKS]: { name: 'Birch Planks', tiles: T.BIRCH_PLANKS },
  [B.DIAMOND_ORE]: { name: 'Diamond Ore', tiles: T.DIAMOND_ORE },
  [B.DIAMOND_BLOCK]: { name: 'Diamond Block', tiles: T.DIAMOND_BLOCK },
  [B.CRAFTING_TABLE]: {
    name: 'Crafting Table',
    tiles: [T.CRAFTING_SIDE, T.CRAFTING_SIDE, T.CRAFTING_TOP, T.PLANKS, T.CRAFTING_FRONT, T.CRAFTING_FRONT],
  },
  // Front tile on +Z: state 0 faces south, and icons show the front.
  [B.FURNACE]: {
    name: 'Furnace',
    tiles: [T.FURNACE_SIDE, T.FURNACE_SIDE, T.FURNACE_TOP, T.FURNACE_TOP, T.FURNACE_FRONT, T.FURNACE_SIDE],
    facing: true,
  },
  [B.CHEST]: {
    name: 'Chest',
    tiles: [T.CHEST_SIDE, T.CHEST_SIDE, T.CHEST_TOP, T.CHEST_TOP, T.CHEST_FRONT, T.CHEST_SIDE],
    facing: true,
  },
  // Two cells long: the state holds the facing (the foot end faces it) and a head bit.
  [B.BED]: {
    name: 'Bed',
    tiles: [T.BED_SIDE, T.BED_SIDE, T.BED_FOOT_TOP, T.PLANKS, T.BED_FOOT_END, T.BED_HEAD_END],
    shape: 'slab',
    facing: true,
  },
  // State bit 0: moist (water within 4 blocks).
  [B.FARMLAND]: { name: 'Farmland', tiles: column(T.DIRT, T.FARMLAND_DRY, T.DIRT) },
  // State: growth stage 0–7.
  [B.WHEAT]: { name: 'Wheat Crops', tiles: T.WHEAT_FIRST, shape: 'cross', plant: true },
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
    tint: s.tint ?? 'none',
    replaceable: s.replaceable ?? false,
    axis: s.axis ?? false,
    facing: s.facing ?? false,
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
  layer: SHAPE_LAYER,
  cactus: SHAPE_CACTUS,
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
/** Tint mode per id (TINT_*); fixed tints keep their colour in TINT_COLOR. */
export const TINT_MODE = new Uint8Array(256);
export const TINT_COLOR = new Uint32Array(256);
export const REPLACEABLE = new Uint8Array(256);
export const HAS_AXIS = new Uint8Array(256);
export const HAS_FACING = new Uint8Array(256);

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
  if (typeof def.tint === 'number') {
    TINT_MODE[id] = TINT_FIXED;
    TINT_COLOR[id] = def.tint;
  } else {
    TINT_MODE[id] = { none: TINT_NONE, grass: TINT_GRASS, foliage: TINT_FOLIAGE, water: TINT_WATER }[def.tint];
  }
  REPLACEABLE[id] = def.replaceable ? 1 : 0;
  HAS_AXIS[id] = def.axis ? 1 : 0;
  HAS_FACING[id] = def.facing ? 1 : 0;
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

LIGHT_EMIT[LIT_FURNACE_LIGHT_ID] = 13;
LIGHT_OPACITY[LIT_FURNACE_LIGHT_ID] = 15;

/** Facing state (0–3) → the face (+X 0, −X 1, +Z 4, −Z 5) the front is on. */
export const FACING_FACES: readonly number[] = [4, 1, 5, 0];
/** Furnace state bit: burning. */
export const FURNACE_LIT = 4;

/** Front-face tile for a facing block's state (lit furnaces glow). */
export function frontTile(id: number, state: number): number {
  if (id === B.FURNACE) return state & FURNACE_LIT ? T.FURNACE_FRONT_LIT : T.FURNACE_FRONT;
  return FACE_TILES[id * 6 + 4]!;
}

/** Farmland state bit: moist. */
export const FARMLAND_WET = 1;
/** Last wheat growth stage (ripe). */
export const WHEAT_RIPE = WHEAT_STAGES - 1;

/** Tile for blocks whose look depends on their state (crop stages, moist farmland). */
export function stateTile(id: number, state: number, tile: number): number {
  if (id === B.WHEAT) return T.WHEAT_FIRST + Math.min(state, WHEAT_RIPE);
  if (id === B.FARMLAND && tile === T.FARMLAND_DRY && state & FARMLAND_WET) return T.FARMLAND_WET;
  return tile;
}

/** Bed state bit: this cell is the head (pillow) half. */
export const BED_HEAD = 4;

/** Facing state → the (dx, dz) step from a bed's foot to its head (away from the front). */
export const BED_HEAD_STEP: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Facing state that turns a block's front toward a player with view yaw `yaw`. */
export function facingToward(yaw: number): number {
  const k = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return (4 - k) % 4;
}

/** The id light code sees for a stored value (a burning furnace emits light). */
export function lightId(value: number): number {
  const id = value & ID_MASK;
  return id === B.FURNACE && (value >> 8) & FURNACE_LIT ? LIT_FURNACE_LIGHT_ID : id;
}

/** Visual height of partial-height shapes (slab 0.5, snow layer 2/16), else 1. */
export function shapeHeight(id: number): number {
  const shape = SHAPE[id];
  return shape === SHAPE_SLAB ? 0.5 : shape === SHAPE_LAYER ? 0.125 : 1;
}

/** Can a plant (or a torch) sit on / hang from this block? */
export function supportsPlant(id: number): boolean {
  return IS_SOLID[id] === 1 && SHAPE[id] === SHAPE_CUBE;
}

function isLeafId(id: number): boolean {
  return id === B.LEAVES || id === B.SPRUCE_LEAVES || id === B.BIRCH_LEAVES;
}

/**
 * Can block value `value` rest on block id `below`? Plants, floor torches,
 * snow layers and cacti need the right block underneath; everything else
 * doesn't care.
 */
export function restsOn(value: number, below: number): boolean {
  const id = value & ID_MASK;
  if (id === B.WHEAT) return below === B.FARMLAND;
  if (IS_PLANT[id] || (id === B.TORCH && value >> 8 === 0)) return supportsPlant(below);
  if (id === B.SNOW_LAYER) return supportsPlant(below) || isLeafId(below);
  if (id === B.CACTUS) return below === B.SAND || below === B.CACTUS;
  return true;
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
  if (shape === SHAPE_LAYER) return LAYER_BOUNDS;
  return CUBE_BOUNDS;
}
const CUBE_BOUNDS = [0, 0, 0, 1, 1, 1] as const;
const SLAB_BOUNDS = [0, 0, 0, 1, 0.5, 1] as const;
const CROSS_BOUNDS = [0.2, 0, 0.2, 0.8, 0.8, 0.8] as const;
const TORCH_BOUNDS = [0.4, 0, 0.4, 0.6, 0.65, 0.6] as const;
const LAYER_BOUNDS = [0, 0, 0, 1, 0.125, 1] as const;

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
  B.SANDSTONE,
  B.SNOW_BLOCK,
  B.SNOW_LAYER,
  B.ICE,
  B.CACTUS,
  B.DEAD_BUSH,
  B.TALL_GRASS,
  B.CLAY,
  B.SPRUCE_LOG,
  B.SPRUCE_LEAVES,
  B.SPRUCE_PLANKS,
  B.BIRCH_LOG,
  B.BIRCH_LEAVES,
  B.BIRCH_PLANKS,
  B.DIAMOND_ORE,
  B.DIAMOND_BLOCK,
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
