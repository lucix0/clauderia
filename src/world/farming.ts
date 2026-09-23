/**
 * Farming rules: tilling soil, planting seeds, crops growing, farmland
 * drying out. Pure world edits, shared by the game and the ticker.
 */
import { B, FARMLAND_WET, idOf, IS_SOLID, WHEAT_RIPE } from './blocks';
import type { World } from './world';

/** Water this close (horizontally, at the soil's level or one above) keeps farmland moist. */
export const WATER_REACH = 4;
/** Crops need at least this much light (sky or block) to grow. */
export const CROP_MIN_LIGHT = 9;

/** Can a hoe turn this cell into farmland (grass or dirt with nothing on top)? */
export function canTill(world: World, x: number, y: number, z: number): boolean {
  const id = world.getId(x, y, z);
  return (id === B.GRASS || id === B.DIRT) && world.getId(x, y + 1, z) === B.AIR;
}

export function till(world: World, x: number, y: number, z: number): boolean {
  if (!canTill(world, x, y, z)) return false;
  return world.setBlock(x, y, z, B.FARMLAND | (moist(world, x, y, z) ? FARMLAND_WET << 8 : 0));
}

/** Is there water near enough to farmland at (x, y, z)? */
export function moist(world: World, x: number, y: number, z: number): boolean {
  const r = WATER_REACH;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) if (world.getId(x + dx, y + dy, z + dz) === B.WATER) return true;
    }
  }
  return false;
}

/** Sow seeds on the farmland at (x, y, z). */
export function plantSeeds(world: World, x: number, y: number, z: number): boolean {
  if (world.getId(x, y, z) !== B.FARMLAND || world.getId(x, y + 1, z) !== B.AIR) return false;
  return world.setBlock(x, y + 1, z, B.WHEAT);
}

/**
 * One growth chance for the crop at (x, y, z): it needs light, and grows
 * every time on moist soil but only half the time on dry. Returns whether it grew.
 */
export function growCrop(world: World, x: number, y: number, z: number, rand: () => number): boolean {
  const value = world.get(x, y, z);
  if (idOf(value) !== B.WHEAT) return false;
  const age = value >> 8;
  if (age >= WHEAT_RIPE) return false;
  const light = world.lightAt(x, y, z);
  if (Math.max(light >> 4, light & 15) < CROP_MIN_LIGHT) return false;
  const soil = world.get(x, y - 1, z);
  const wet = idOf(soil) === B.FARMLAND && ((soil >> 8) & FARMLAND_WET) !== 0;
  if (!wet && rand() < 0.5) return false;
  return world.setBlock(x, y, z, B.WHEAT | ((age + 1) << 8));
}

/** Bone meal: push a crop two to four stages on at once. */
export function fertilize(world: World, x: number, y: number, z: number, rand: () => number): boolean {
  const value = world.get(x, y, z);
  if (idOf(value) !== B.WHEAT || value >> 8 >= WHEAT_RIPE) return false;
  const age = Math.min(WHEAT_RIPE, (value >> 8) + 2 + Math.floor(rand() * 3));
  return world.setBlock(x, y, z, B.WHEAT | (age << 8));
}

/**
 * Farmland reacts to its surroundings: covered by a solid block it turns
 * back to dirt, near water it's moist, away from water it dries. With
 * `decay`, dry farmland with nothing planted may also revert to dirt.
 */
export function updateFarmland(world: World, x: number, y: number, z: number, rand: () => number, decay: boolean): void {
  const value = world.get(x, y, z);
  if (idOf(value) !== B.FARMLAND) return;
  const above = world.getId(x, y + 1, z);
  if (IS_SOLID[above]) {
    world.setBlock(x, y, z, B.DIRT);
    return;
  }
  const wasWet = ((value >> 8) & FARMLAND_WET) !== 0;
  if (moist(world, x, y, z)) {
    if (!wasWet) world.setBlock(x, y, z, B.FARMLAND | (FARMLAND_WET << 8));
  } else if (wasWet) {
    world.setBlock(x, y, z, B.FARMLAND);
  } else if (decay && above !== B.WHEAT && rand() < 0.05) {
    world.setBlock(x, y, z, B.DIRT);
  }
}
