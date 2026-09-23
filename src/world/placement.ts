/**
 * Pure break / place / pick rules shared by the player controller and tests.
 */
import {
  B,
  BED_HEAD,
  BED_HEAD_STEP,
  collisionHeight,
  DOOR_OPEN,
  DOOR_UPPER,
  HAS_AXIS,
  idOf,
  IS_LIQUID,
  IS_SOLID,
  REPLACEABLE,
  restsOn,
  supportsPlant,
  TORCH_ATTACH,
} from './blocks';
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
  const value = world.get(x, y, z);
  if (!world.setBlock(x, y, z, B.AIR)) return false;
  // Beds and doors come apart as a whole.
  const id = idOf(value);
  if (id === B.BED || id === B.DOOR) {
    const other = id === B.BED ? bedPartner({ x, y, z }, value) : { x, y: (value >> 8) & DOOR_UPPER ? y - 1 : y + 1, z };
    if (idOf(world.get(other.x, other.y, other.z)) === id) world.setBlock(other.x, other.y, other.z, B.AIR);
  }
  return true;
}

/**
 * Place a door with its lower half at `cell` (facing turns it toward the
 * player). Needs two free cells, solid ground, and room clear of the player.
 */
export function placeDoor(world: World, cell: Cell, facing: number, overlapsPlayer: (cell: Cell, height: number) => boolean): Cell | null {
  const upper = { x: cell.x, y: cell.y + 1, z: cell.z };
  for (const c of [cell, upper]) {
    if (!world.inBounds(c.x, c.y, c.z) || !isReplaceable(world.getId(c.x, c.y, c.z))) return null;
    if (overlapsPlayer(c, 1)) return null;
  }
  if (!supportsPlant(world.getId(cell.x, cell.y - 1, cell.z))) return null;
  const lower = B.DOOR | ((facing & 3) << 8);
  if (!world.setBlock(cell.x, cell.y, cell.z, lower)) return null;
  world.setBlock(upper.x, upper.y, upper.z, lower | (DOOR_UPPER << 8));
  return cell;
}

/** Open a closed door or close an open one (both halves). Returns the new open state, or null. */
export function toggleDoor(world: World, cell: Cell): boolean | null {
  const value = world.get(cell.x, cell.y, cell.z);
  if (idOf(value) !== B.DOOR) return null;
  const lowerY = (value >> 8) & DOOR_UPPER ? cell.y - 1 : cell.y;
  const lower = world.get(cell.x, lowerY, cell.z);
  if (idOf(lower) !== B.DOOR) return null;
  const open = ((lower >> 8) & DOOR_OPEN) === 0;
  const flip = (v: number): number => (open ? v | (DOOR_OPEN << 8) : v & ~(DOOR_OPEN << 8));
  world.setBlock(cell.x, lowerY, cell.z, flip(lower));
  const upper = world.get(cell.x, lowerY + 1, cell.z);
  if (idOf(upper) === B.DOOR) world.setBlock(cell.x, lowerY + 1, cell.z, flip(upper));
  return open;
}

/** The other half of the bed whose half at `cell` has value `value`. */
export function bedPartner(cell: Cell, value: number): Cell {
  const state = value >> 8;
  const [dx, dz] = BED_HEAD_STEP[state & 3]!;
  const sign = state & BED_HEAD ? -1 : 1;
  return { x: cell.x + dx * sign, y: cell.y, z: cell.z + dz * sign };
}

/** The foot half of the bed with a half at `cell`. */
export function bedFoot(cell: Cell, value: number): Cell {
  return (value >> 8) & BED_HEAD ? bedPartner(cell, value) : cell;
}

/**
 * Place a bed with its foot at `foot`, stretching away from the player
 * (`facing` turns the foot end toward them). Both cells must be free and
 * on solid ground. Returns the foot cell, or null.
 */
export function placeBed(world: World, foot: Cell, facing: number, overlapsPlayer: (cell: Cell, height: number) => boolean): Cell | null {
  const footValue = B.BED | ((facing & 3) << 8);
  const head = bedPartner(foot, footValue);
  for (const c of [foot, head]) {
    if (!world.inBounds(c.x, c.y, c.z) || !isReplaceable(world.getId(c.x, c.y, c.z))) return null;
    if (!IS_SOLID[world.getId(c.x, c.y - 1, c.z)]) return null;
    if (overlapsPlayer(c, collisionHeight(B.BED))) return null;
  }
  if (!world.setBlock(foot.x, foot.y, foot.z, footValue)) return null;
  if (!world.setBlock(head.x, head.y, head.z, footValue | (BED_HEAD << 8))) {
    world.setBlock(foot.x, foot.y, foot.z, B.AIR);
    return null;
  }
  return foot;
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
  // Placed leaves are marked persistent so they never decay.
  if (id === B.LEAVES || id === B.SPRUCE_LEAVES || id === B.BIRCH_LEAVES) return id | (1 << 8);
  if (id !== B.TORCH && id !== B.LADDER) return id;
  if (normal[1] === 1) return id === B.TORCH ? B.TORCH : null; // torches stand on the floor; ladders need a wall
  if (normal[1] === -1) return null; // nothing hangs from ceilings
  const state = TORCH_ATTACH.findIndex(([dx, dz], i) => i > 0 && dx === normal[0] && dz === normal[2]);
  return state > 0 ? id | (state << 8) : null;
}

/** Is the block a torch (or ladder) in this cell would hang from / stand on still there? */
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
  const attached = id === B.TORCH || id === B.LADDER;
  if (attached ? !torchSupported(world, cell, value) : !restsOn(value, world.getId(x, y - 1, z))) return false;
  if (merging) return !overlapsPlayer(cell, 1);
  if (id === B.SLAB && world.getId(x, y - 1, z) === B.SLAB) {
    // Lands on the slab below and turns it into a double slab.
    return !overlapsPlayer({ x, y: y - 1, z }, 1);
  }
  // Fences collide through shapes.ts rather than a height; keep them out of the player too.
  const h = id === B.FENCE ? 1 : collisionHeight(id);
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
