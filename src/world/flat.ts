import { B, PICKABLE_BLOCKS } from './blocks';
import { World } from './world';

/**
 * A flat Classic test world: bedrock, stone, dirt and grass up to `ground`,
 * with a row of every block on display near the middle.
 */
export function createFlatWorld(sx: number, sy: number, sz: number, ground = 31): World {
  const level = new Uint8Array(sx * sy * sz);
  for (let y = 0; y <= ground; y++) {
    const id = y === 0 ? B.BEDROCK : y < ground - 2 ? B.STONE : y < ground ? B.DIRT : B.GRASS;
    level.fill(id, y * sx * sz, (y + 1) * sx * sz);
  }
  const cz = Math.floor(sz / 2);
  const x0 = Math.floor(sx / 2) - PICKABLE_BLOCKS.length;
  PICKABLE_BLOCKS.forEach((id, i) => {
    const x = x0 + i * 2;
    if (x < 0 || x >= sx) return;
    level[((ground + 1) * sz + cz) * sx + x] = id;
  });
  return World.fromClassicLevel(level, sx, sy, sz, 0);
}
