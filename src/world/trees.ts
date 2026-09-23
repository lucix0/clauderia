import type { Rng } from '../util/prng';
import { B } from './blocks';

/** Minimal block access used by tree growth (generator array or live world). */
export interface TreeTarget {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number): void;
}

/**
 * Grow a Classic-style tree with its trunk base at (x, y, z) if there is room.
 * Returns true when the tree was placed.
 */
export function growTree(t: TreeTarget, rng: Rng, x: number, y: number, z: number): boolean {
  const height = 4 + rng.int(3);
  const top = y + height;
  if (top + 1 >= t.sy) return false;
  // Room check: trunk column plus the canopy volume must be clear.
  for (let yy = y; yy <= top; yy++) {
    const r = yy < top - 3 ? 0 : yy < top - 1 ? 2 : 1;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= t.sx || cz >= t.sz) return false;
        const id = t.get(cx, yy, cz);
        const trunkBase = yy === y && dx === 0 && dz === 0;
        if (id !== B.AIR && !(trunkBase && id === B.SAPLING)) return false;
      }
    }
  }
  // Canopy: two wide layers, then two narrow ones with trimmed corners.
  for (let yy = top - 3; yy <= top; yy++) {
    const dy = yy - top;
    const r = dy >= -1 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const corner = Math.abs(dx) === r && Math.abs(dz) === r;
        if (corner && (dy === 0 || rng.chance(0.5))) continue;
        if (t.get(x + dx, yy, z + dz) === B.AIR) t.set(x + dx, yy, z + dz, B.LEAVES);
      }
    }
  }
  for (let yy = y; yy < top; yy++) t.set(x, yy, z, B.LOG);
  return true;
}
