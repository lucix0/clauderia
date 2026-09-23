/**
 * Pure break / place / pick rules shared by the player controller and tests.
 */
import { B, collisionHeight, IS_LIQUID, IS_PLANT, supportsPlant } from './blocks';
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

/** Cells that can be overwritten by placing a block. */
export function isReplaceable(id: number): boolean {
  return id === B.AIR || IS_LIQUID[id] === 1;
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
  return { x: hit.x + normal[0], y: hit.y + normal[1], z: hit.z + normal[2] };
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
  if (!world.inBounds(x, y, z) || id === B.AIR) return false;
  const current = world.get(x, y, z);
  const merging = id === B.SLAB && current === B.SLAB;
  if (!merging && !isReplaceable(current)) return false;
  if (IS_PLANT[id] && !supportsPlant(world.get(x, y - 1, z))) return false;
  if (merging) return !overlapsPlayer(cell, 1);
  if (id === B.SLAB && world.get(x, y - 1, z) === B.SLAB) {
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
  if (id === B.SLAB && world.get(cell.x, cell.y, cell.z) === B.SLAB) {
    return world.setBlock(cell.x, cell.y, cell.z, B.DOUBLE_SLAB) ? cell : null;
  }
  const below = world.get(cell.x, cell.y - 1, cell.z);
  if (!world.setBlock(cell.x, cell.y, cell.z, id)) return null;
  // setBlock merges a slab dropped onto a slab into the cell below.
  if (id === B.SLAB && below === B.SLAB) return { x: cell.x, y: cell.y - 1, z: cell.z };
  return cell;
}
