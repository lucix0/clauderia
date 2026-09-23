/**
 * Geometry of the shaped blocks (doors, ladders, fences): boxes inside the
 * cell, [minX, minY, minZ, maxX, maxY, maxZ] in 0–1 cell units, built from
 * the block's state and, for fences, its neighbours. Shared by the mesher,
 * the physics and the targeting ray. Pure.
 */
import {
  B,
  BED_HEAD_STEP,
  blockBounds,
  DOOR_OPEN,
  idOf,
  OCCLUDES,
  SHAPE,
  SHAPE_DOOR,
  SHAPE_FENCE,
  SHAPE_LADDER,
  TORCH_ATTACH,
} from './blocks';

export type Box6 = readonly [number, number, number, number, number, number];

const PX = 1 / 16;
const DOOR_THICKNESS = 3 * PX;
/** Ladders are drawn thin but collide a little thicker, so pushing into one climbs it. */
const LADDER_DRAWN = PX;
const LADDER_THICKNESS = 3 * PX;
/** Fences are taller than a jump. */
export const FENCE_HEIGHT = 1.5;

/** A slab of thickness `t` against the cell side in direction (dx, dz), height `h`. */
export function sideBox(dx: number, dz: number, t: number, h = 1): Box6 {
  if (dx > 0) return [1 - t, 0, 0, 1, h, 1];
  if (dx < 0) return [0, 0, 0, t, h, 1];
  if (dz > 0) return [0, 0, 1 - t, 1, h, 1];
  return [0, 0, 0, 1, h, t];
}

/**
 * A door half. Closed, it stands against the cell side away from where the
 * player stood to place it; open, it swings against the side on their left.
 */
export function doorBox(state: number): Box6 {
  const [ax, az] = BED_HEAD_STEP[state & 3]!;
  if (state & DOOR_OPEN) return sideBox(az, -ax, DOOR_THICKNESS);
  return sideBox(ax, az, DOOR_THICKNESS);
}

/** A ladder against its wall (state as wall torches: it leans away toward TORCH_ATTACH[state]). */
export function ladderBox(state: number, thickness = LADDER_THICKNESS): Box6 {
  const [dx, dz] = TORCH_ATTACH[state] ?? [0, 1];
  return sideBox(-dx, -dz, thickness);
}

export function ladderDrawBox(state: number): Box6 {
  return ladderBox(state, LADDER_DRAWN);
}

/** Fence connection bits: +X 1, −X 2, +Z 4, −Z 8. */
export const FENCE_PX = 1;
export const FENCE_NX = 2;
export const FENCE_PZ = 4;
export const FENCE_NZ = 8;

function joins(id: number): boolean {
  return id === B.FENCE || OCCLUDES[id] === 1;
}

/** Which sides a fence joins, from its four neighbours' ids. */
export function fenceMask(px: number, nx: number, pz: number, nz: number): number {
  return (joins(px) ? FENCE_PX : 0) | (joins(nx) ? FENCE_NX : 0) | (joins(pz) ? FENCE_PZ : 0) | (joins(nz) ? FENCE_NZ : 0);
}

const POST_MIN = 6 * PX;
const POST_MAX = 10 * PX;
const BAR_MIN = 7 * PX;
const BAR_MAX = 9 * PX;

/** Boxes from the post to the cell edge on each joined side, between heights y0 and y1, `w0`–`w1` wide. */
function arms(mask: number, y0: number, y1: number, w0: number, w1: number, out: Box6[]): void {
  if (mask & FENCE_PX) out.push([POST_MAX, y0, w0, 1, y1, w1]);
  if (mask & FENCE_NX) out.push([0, y0, w0, POST_MIN, y1, w1]);
  if (mask & FENCE_PZ) out.push([w0, y0, POST_MAX, w1, y1, 1]);
  if (mask & FENCE_NZ) out.push([w0, y0, 0, w1, y1, POST_MIN]);
}

/** What a fence looks like: a post and two rails toward each joined side. */
export function fenceDrawBoxes(mask: number): Box6[] {
  const out: Box6[] = [[POST_MIN, 0, POST_MIN, POST_MAX, 1, POST_MAX]];
  arms(mask, 6 * PX, 9 * PX, BAR_MIN, BAR_MAX, out);
  arms(mask, 12 * PX, 15 * PX, BAR_MIN, BAR_MAX, out);
  return out;
}

/** What a fence stops: the post and its arms, taller than a jump. */
export function fenceCollisionBoxes(mask: number): Box6[] {
  const out: Box6[] = [[POST_MIN, 0, POST_MIN, POST_MAX, FENCE_HEIGHT, POST_MAX]];
  arms(mask, 0, FENCE_HEIGHT, POST_MIN, POST_MAX, out);
  return out;
}

/** Reads the world around a cell. */
export interface ShapeSource {
  get(x: number, y: number, z: number): number;
}

function fenceMaskAt(world: ShapeSource, x: number, y: number, z: number): number {
  return fenceMask(
    idOf(world.get(x + 1, y, z)),
    idOf(world.get(x - 1, y, z)),
    idOf(world.get(x, y, z + 1)),
    idOf(world.get(x, y, z - 1)),
  );
}

/** Is this a block whose shape comes from this module? */
export function isShaped(id: number): boolean {
  const s = SHAPE[id];
  return s === SHAPE_DOOR || s === SHAPE_LADDER || s === SHAPE_FENCE;
}

/** Collision boxes of the shaped block `value` at (x, y, z); null for any other block. */
export function collisionBoxes(world: ShapeSource, x: number, y: number, z: number, value: number): Box6[] | null {
  const id = idOf(value);
  if (id === B.DOOR) return [doorBox(value >> 8)];
  if (id === B.LADDER) return [ladderBox(value >> 8)];
  if (id === B.FENCE) return fenceCollisionBoxes(fenceMaskAt(world, x, y, z));
  return null;
}

/** The box the targeting ray tests and the outline draws. */
export function selectionBox(world: ShapeSource, x: number, y: number, z: number, value: number): Box6 {
  const id = idOf(value);
  if (id === B.DOOR) return doorBox(value >> 8);
  if (id === B.LADDER) return ladderBox(value >> 8);
  if (id === B.FENCE) {
    const mask = fenceMaskAt(world, x, y, z);
    return [
      mask & FENCE_NX ? 0 : POST_MIN,
      0,
      mask & FENCE_NZ ? 0 : POST_MIN,
      mask & FENCE_PX ? 1 : POST_MAX,
      1,
      mask & FENCE_PZ ? 1 : POST_MAX,
    ];
  }
  return blockBounds(id);
}
