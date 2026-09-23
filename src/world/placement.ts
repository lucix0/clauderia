/**
 * Pure break / place / pick rules shared by the player controller and tests.
 */
import { B, collisionHeight, HAS_AXIS, IS_LIQUID, REPLACEABLE, restsOn, supportsPlant, TORCH_ATTACH } from './blocks';
import type { World } from './world';

export interface Cell {
  x: number;
  y: number;
  z: number;
}

/** Everything but air can be broken, except the bottom bedrock layer. */
export function canBreak(world: World, x: number, y: number, z: number): boolean {
  if (!world.inBounds(x, y, z)) return false;
  const id = world.get(x, y, z);
  if (id === B.AIR) return false;
  if (id === B.BEDROCK && y === 0) return false;
  return true;
}

export function breakBlock(world: World, x: number, y: number, z: number): boolean {
  if (!canBreak(world, x, y, z)) return false;
  return world.setBlock(x, y, z, B.AIR);
}

/** Cells that can be overwritten by placing a block (air, liquids, tall grass, snow layers). */
export function isReplaceable(id: number): boolean {
  return id === B.AIR || IS_LIQUID[id] === 1 || REPLACEABLE[id] === 1;
}

/**
 * Where a block placed against (hitX, hitY, hitZ) through `face` normal would
 * go. Placing a slab on the top face of a slab merges it in place.
 */
export function placementTarget(
  world: World,
  hit: Cell,
  normal: readonly [number, number, number],
  id: number,
): Cell {
  if (id === B.SLAB && normal[1] === 1 && world.get(hit.x, hit.y, hit.z) === B.SLAB) {
    return { x: hit.x, y: hit.y, z: hit.z };
  }
  // Clicking tall grass or a snow layer replaces it rather than building beside it.
  if (REPLACEABLE[world.getId(hit.x, hit.y, hit.z)] && id !== world.getId(hit.x, hit.y, hit.z)) {
    return { x: hit.x, y: hit.y, z: hit.z };
  }
  return { x: hit.x + normal[0], y: hit.y + normal[1], z: hit.z + normal[2] };
}

/**
 * The full block value to place for `id` clicked against a face with outward
 * `normal` (torches pick floor / wall attachment, logs lie along the clicked
 * axis). Null when it can't attach.
 */
export function placementValue(id: number, normal: readonly [number, number, number]): number | null {
  if (HAS_AXIS[id]) return normal[0] !== 0 ? id | (1 << 8) : normal[2] !== 0 ? id | (2 << 8) : id;
  if (id !== B.TORCH) return id;
  if (normal[1] === 1) return B.TORCH; // standing on the floor
  if (normal[1] === -1) return null; // no ceiling torches
  const state = TORCH_ATTACH.findIndex(([dx, dz], i) => i > 0 && dx === normal[0] && dz === normal[2]);
  return state > 0 ? B.TORCH | (state << 8) : null;
}

/** Is the block a torch in this cell would hang from / stand on still there? */
export function torchSupported(world: World, cell: Cell, value: number): boolean {
  const state = value >> 8;
  const [dx, dz] = TORCH_ATTACH[state] ?? [0, 0];
  if (state === 0) return supportsPlant(world.getId(cell.x, cell.y - 1, cell.z));
  return supportsPlant(world.getId(cell.x - dx, cell.y, cell.z - dz));
}

/**
 * Check whether `id` may go at `cell`. `overlapsPlayer(cell, height)` reports
 * whether a solid box of that height in the cell would intersect the player.
 */
export function canPlace(
  world: World,
  cell: Cell,
  id: number,
  overlapsPlayer: (cell: Cell, height: number) => boolean,
): boolean {
  const { x, y, z } = cell;
  const value = id;
  id = id & 0xff;
  if (!world.inBounds(x, y, z) || id === B.AIR) return false;
  const current = world.getId(x, y, z);
  const merging = id === B.SLAB && current === B.SLAB;
  if (!merging && !isReplaceable(current)) return false;
  if (id === B.TORCH ? !torchSupported(world, cell, value) : !restsOn(value, world.getId(x, y - 1, z))) return false;
  if (merging) return !overlapsPlayer(cell, 1);
  if (id === B.SLAB && world.getId(x, y - 1, z) === B.SLAB) {
    // Lands on the slab below and turns it into a double slab.
    return !overlapsPlayer({ x, y: y - 1, z }, 1);
  }
  const h = collisionHeight(id);
  if (h > 0 && overlapsPlayer(cell, h)) return false;
  return true;
}

/** Place a block, returning the cell that changed (or null). */
export function placeBlock(
  world: World,
  cell: Cell,
  id: number,
  overlapsPlayer: (cell: Cell, height: number) => boolean,
): Cell | null {
  if (!canPlace(world, cell, id, overlapsPlayer)) return null;
  if (id === B.SLAB && world.getId(cell.x, cell.y, cell.z) === B.SLAB) {
    return world.setBlock(cell.x, cell.y, cell.z, B.DOUBLE_SLAB) ? cell : null;
  }
  const below = world.getId(cell.x, cell.y - 1, cell.z);
  if (!world.setBlock(cell.x, cell.y, cell.z, id)) return null;
  // setBlock merges a slab dropped onto a slab into the cell below.
  if (id === B.SLAB && below === B.SLAB) return { x: cell.x, y: cell.y - 1, z: cell.z };
  return cell;
}
