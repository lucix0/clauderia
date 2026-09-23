/**
 * Voxel DDA raycast (Amanatides & Woo). Pure: works on any `get(x, y, z)`.
 * Cells whose block has a partial shape (slab, plant) are refined with a
 * ray/box test against the block's bounds.
 */
import { blockBounds, SELECTABLE } from '../world/blocks';

export interface RayHit {
  x: number;
  y: number;
  z: number;
  /** Face index hit: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. */
  face: number;
  /** Outward normal of the hit face. */
  nx: number;
  ny: number;
  nz: number;
  id: number;
  /** Distance along the ray. */
  t: number;
}

export interface BlockSource {
  get(x: number, y: number, z: number): number;
  inBounds(x: number, y: number, z: number): boolean;
}

const NORMALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Face entered when crossing a boundary along `axis` moving in `step` direction. */
function entryFace(axis: number, step: number): number {
  // Moving +X enters through the cell's -X face, and so on.
  return axis * 2 + (step > 0 ? 1 : 0);
}

/** Ray vs box slab test; returns [tEnter, face] or null. */
function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: readonly number[],
): [number, number] | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  let face = -1;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let axis = 0; axis < 3; axis++) {
    const lo = b[axis]!;
    const hi = b[axis + 3]!;
    const oa = o[axis]!;
    const da = d[axis]!;
    if (Math.abs(da) < 1e-12) {
      if (oa < lo || oa > hi) return null;
      continue;
    }
    let t1 = (lo - oa) / da;
    let t2 = (hi - oa) / da;
    let enterFace = axis * 2 + 1; // entering through the low side → -axis face
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      enterFace = axis * 2; // entering through the high side → +axis face
    }
    if (t1 > tMin) {
      tMin = t1;
      face = enterFace;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 0 || face < 0) return null;
  return [Math.max(0, tMin), face];
}

/**
 * Cast from `origin` along the unit vector `dir` up to `maxDist`. Returns the
 * first selectable block, or null. Cells outside the map are skipped.
 */
export function raycast(
  world: BlockSource,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  selectable: (id: number) => boolean = (id) => SELECTABLE[id] === 1,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) * tDeltaX : stepX < 0 ? (ox - x) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) * tDeltaY : stepY < 0 ? (oy - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) * tDeltaZ : stepZ < 0 ? (oz - z) * tDeltaZ : Infinity;

  let t = 0;
  let face = -1;
  while (t <= maxDist) {
    if (world.inBounds(x, y, z)) {
      const id = world.get(x, y, z);
      if (id !== 0 && selectable(id)) {
        const b = blockBounds(id);
        const full = b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1 && b[4] === 1 && b[5] === 1;
        if (full && face >= 0) {
          const n = NORMALS[face]!;
          return { x, y, z, face, nx: n[0], ny: n[1], nz: n[2], id, t };
        }
        const box = [x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]];
        const hit = rayBox(ox, oy, oz, dx, dy, dz, box);
        if (hit && hit[0] <= maxDist) {
          const n = NORMALS[hit[1]]!;
          return { x, y, z, face: hit[1], nx: n[0], ny: n[1], nz: n[2], id, t: hit[0] };
        }
      }
    }
    // Step to the next cell.
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      face = entryFace(0, stepX);
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      face = entryFace(1, stepY);
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      face = entryFace(2, stepZ);
    }
  }
  return null;
}
