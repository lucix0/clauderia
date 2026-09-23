/**
 * Biome table for infinite worlds. Heights come mostly from continuous
 * climate fields; each biome adds its own character (offset, hill size,
 * flatness) and colours, blended across borders by the generator.
 */

export const BIOME = {
  OCEAN: 0,
  DEEP_OCEAN: 1,
  BEACH: 2,
  PLAINS: 3,
  FOREST: 4,
  TAIGA: 5,
  TUNDRA: 6,
  DESERT: 7,
  SWAMP: 8,
  MOUNTAINS: 9,
  RIVER: 10,
} as const;

export const BIOME_COUNT = 11;

export type TreeKind = 'oak' | 'birch' | 'spruce' | 'swamp';

export interface BiomeDef {
  readonly id: number;
  readonly name: string;
  /** Command name (lower case, underscores). */
  readonly key: string;
  /** Blocks added to the continental base height. */
  readonly offset: number;
  /** Hill amplitude in blocks. */
  readonly vary: number;
  /** 0–1: how strongly the terrain is pulled flat to sea level (swamps). */
  readonly flatten: number;
  readonly grass: number;
  readonly foliage: number;
  readonly water: number;
  /** Chance per tree candidate (16 per chunk) that a tree grows. */
  readonly trees: number;
  readonly treeKinds: ReadonlyArray<readonly [TreeKind, number]>;
  /** Snow on the ground, frozen water. */
  readonly cold: boolean;
}

function def(id: number, name: string, d: Omit<BiomeDef, 'id' | 'name' | 'key'>): BiomeDef {
  return { id, name, key: name.toLowerCase().replace(/ /g, '_'), ...d };
}

const NO_TREES: ReadonlyArray<readonly [TreeKind, number]> = [];

export const BIOMES: readonly BiomeDef[] = [
  def(BIOME.OCEAN, 'Ocean', {
    offset: 0, vary: 5, flatten: 0,
    grass: 0x7fb853, foliage: 0x66a63c, water: 0x3f76e4,
    trees: 0, treeKinds: NO_TREES, cold: false,
  }),
  def(BIOME.DEEP_OCEAN, 'Deep Ocean', {
    offset: -2, vary: 6, flatten: 0,
    grass: 0x7fb853, foliage: 0x66a63c, water: 0x3456c9,
    trees: 0, treeKinds: NO_TREES, cold: false,
  }),
  def(BIOME.BEACH, 'Beach', {
    offset: 0, vary: 2, flatten: 0,
    grass: 0x8fbd55, foliage: 0x77ab3f, water: 0x3f8fe4,
    trees: 0, treeKinds: NO_TREES, cold: false,
  }),
  def(BIOME.PLAINS, 'Plains', {
    offset: 1, vary: 4, flatten: 0,
    grass: 0x7dbd4f, foliage: 0x62a83b, water: 0x3f76e4,
    trees: 0.012, treeKinds: [['oak', 1]], cold: false,
  }),
  def(BIOME.FOREST, 'Forest', {
    offset: 3, vary: 9, flatten: 0,
    grass: 0x68ad45, foliage: 0x4f9a32, water: 0x3f76e4,
    trees: 0.45, treeKinds: [['oak', 0.65], ['birch', 0.35]], cold: false,
  }),
  def(BIOME.TAIGA, 'Taiga', {
    offset: 4, vary: 10, flatten: 0,
    grass: 0x6c9e62, foliage: 0x5a8a55, water: 0x3d6ee0,
    trees: 0.4, treeKinds: [['spruce', 1]], cold: false,
  }),
  def(BIOME.TUNDRA, 'Snowy Tundra', {
    offset: 1, vary: 4, flatten: 0,
    grass: 0x8fb09a, foliage: 0x7a9e86, water: 0x3d57d6,
    trees: 0.02, treeKinds: [['spruce', 1]], cold: true,
  }),
  def(BIOME.DESERT, 'Desert', {
    offset: 2, vary: 5, flatten: 0,
    grass: 0xbfb755, foliage: 0xaea44a, water: 0x32a5a0,
    trees: 0, treeKinds: NO_TREES, cold: false,
  }),
  def(BIOME.SWAMP, 'Swamp', {
    offset: -1, vary: 1.5, flatten: 0.9,
    grass: 0x5f7a3a, foliage: 0x587032, water: 0x617b64,
    trees: 0.12, treeKinds: [['swamp', 1]], cold: false,
  }),
  def(BIOME.MOUNTAINS, 'Mountains', {
    offset: 6, vary: 10, flatten: 0,
    grass: 0x7a9e6b, foliage: 0x6a9660, water: 0x3f76e4,
    trees: 0.05, treeKinds: [['spruce', 1]], cold: false,
  }),
  def(BIOME.RIVER, 'River', {
    offset: 0, vary: 2, flatten: 0,
    grass: 0x7dbd4f, foliage: 0x62a83b, water: 0x3f76e4,
    trees: 0, treeKinds: NO_TREES, cold: false,
  }),
];

/** Biome by command key or display name ("snowy_tundra", "Snowy Tundra"), or undefined. */
export function biomeByName(name: string): BiomeDef | undefined {
  const want = name.toLowerCase().replace(/[\s_-]+/g, '');
  return BIOMES.find((b) => b.key.replace(/_/g, '') === want || b.name.toLowerCase().replace(/\s+/g, '') === want);
}

export const BIOME_KEYS: readonly string[] = BIOMES.map((b) => b.key);
