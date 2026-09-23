import { describe, expect, it } from 'vitest';
import { stack, type Slots } from '../src/items/inventory';
import { itemDef } from '../src/items/items';
import { matchRecipe } from '../src/items/recipes';
import { TILE_UVS } from '../src/render/mesher';
import { sanitizeWorldRecord, WORLD_FORMAT_VERSION } from '../src/save/records';
import { drops } from '../src/survival/mining';
import { canSleepAt, monstersNear } from '../src/survival/sleep';
import { B, BED_HEAD, PASS_OPAQUE, T } from '../src/world/blocks';
import { bedFoot, bedPartner, breakBlock, placeBed } from '../src/world/placement';
import { classicWorld, meshAt } from './helpers';

/** Stone floor below y = 10. */
function floor() {
  return classicWorld(32, 32, 32, (_x, y) => (y < 10 ? B.STONE : B.AIR));
}

const free = (): boolean => false;

describe('beds', () => {
  it('are placed two cells long, the head away from the player', () => {
    // Facing 0: the foot end faces +Z (toward the player), so the head is at −Z.
    const w = floor();
    expect(placeBed(w, { x: 5, y: 10, z: 5 }, 0, free)).toEqual({ x: 5, y: 10, z: 5 });
    expect(w.get(5, 10, 5)).toBe(B.BED);
    expect(w.get(5, 10, 4)).toBe(B.BED | (BED_HEAD << 8));
    // Facing 1 (front toward −X): the head is at +X.
    expect(placeBed(w, { x: 10, y: 10, z: 10 }, 1, free)).not.toBeNull();
    expect(w.get(11, 10, 10)).toBe(B.BED | ((1 | BED_HEAD) << 8));
    expect(bedPartner({ x: 11, y: 10, z: 10 }, w.get(11, 10, 10))).toEqual({ x: 10, y: 10, z: 10 });
    expect(bedFoot({ x: 11, y: 10, z: 10 }, w.get(11, 10, 10))).toEqual({ x: 10, y: 10, z: 10 });
  });

  it('need two free cells on solid ground, clear of the player', () => {
    const w = floor();
    w.setBlock(5, 10, 4, B.STONE);
    expect(placeBed(w, { x: 5, y: 10, z: 5 }, 0, free)).toBeNull(); // head cell taken
    expect(w.get(5, 10, 5)).toBe(B.AIR);
    expect(placeBed(w, { x: 20, y: 14, z: 20 }, 0, free)).toBeNull(); // floating
    expect(placeBed(w, { x: 20, y: 10, z: 20 }, 0, (c) => c.z === 19)).toBeNull(); // player in the way
    expect(placeBed(w, { x: 20, y: 10, z: 20 }, 2, free)).not.toBeNull();
  });

  it('break as a whole and drop one bed', () => {
    const w = floor();
    placeBed(w, { x: 5, y: 10, z: 5 }, 0, free);
    const head = w.get(5, 10, 4);
    expect(breakBlock(w, 5, 10, 4)).toBe(true);
    expect(w.get(5, 10, 5)).toBe(B.AIR);
    expect(drops(head, null, () => 0.5)).toEqual([stack(B.BED)]);
    placeBed(w, { x: 8, y: 10, z: 8 }, 3, free);
    expect(breakBlock(w, 8, 10, 8)).toBe(true);
    expect(w.get(7, 10, 8)).toBe(B.AIR);
  });

  it('are crafted from wool over planks and stack to one', () => {
    const W = B.WOOL_FIRST + 14;
    const grid: Slots = [W, W + 1, W, B.PLANKS, B.BIRCH_PLANKS, B.PLANKS, 0, 0, 0].map((id) => (id ? stack(id) : null));
    expect(matchRecipe(grid, 3, 3)?.out).toEqual(stack(B.BED));
    expect(itemDef(B.BED)?.maxStack).toBe(1);
  });

  it('draw the pillow at the head end whichever way they face', () => {
    for (const facing of [0, 1, 2, 3]) {
      const w = floor();
      placeBed(w, { x: 5, y: 10, z: 5 }, facing, free);
      const head = bedPartner({ x: 5, y: 10, z: 5 }, w.get(5, 10, 5));
      const m = meshAt(w, 0, 0, 0)[PASS_OPAQUE]!;
      // Find the head cell's top quad: all four corners at y = 10.5 inside its cell.
      let found = false;
      for (let q = 0; q < m.quads; q++) {
        const corners = [0, 1, 2, 3].map((c) => ({
          x: m.positions[q * 12 + c * 3]!,
          y: m.positions[q * 12 + c * 3 + 1]!,
          z: m.positions[q * 12 + c * 3 + 2]!,
          u: m.uvs[q * 8 + c * 2]!,
          v: m.uvs[q * 8 + c * 2 + 1]!,
        }));
        if (!corners.every((c) => c.y === 10.5 && c.x >= head.x && c.x <= head.x + 1 && c.z >= head.z && c.z <= head.z + 1)) continue;
        found = true;
        const vTop = TILE_UVS[T.BED_HEAD_TOP * 4 + 3]!;
        expect(corners.some((c) => c.v === vTop)).toBe(true); // it's the pillow tile
        // The image's top edge (v = vTop) lies along the far end, away from the foot.
        const [dx, dz] = [head.x - 5, head.z - 5];
        for (const c of corners) {
          const far = (dx > 0 && c.x === head.x + 1) || (dx < 0 && c.x === head.x) || (dz > 0 && c.z === head.z + 1) || (dz < 0 && c.z === head.z);
          expect(c.v === vTop).toBe(far);
        }
      }
      expect(found).toBe(true);
      // 2 tops, 4 long sides, 2 ends; the faces between the halves are hidden, and
      // the bed covers two floor tops.
      expect(m.quads - meshAt(floor(), 0, 0, 0)[PASS_OPAQUE]!.quads).toBe(8 - 2);
    }
  });

  it('can be slept in at night with no monsters around', () => {
    expect(canSleepAt(6000)).toBe(false);
    expect(canSleepAt(12000)).toBe(false);
    expect(canSleepAt(13000)).toBe(true);
    expect(canSleepAt(18000)).toBe(true);
    expect(canSleepAt(23600)).toBe(false);
    const zombie = { def: { hostile: true }, body: { x: 3, y: 10, z: 0 }, removed: false, dying: -1 };
    const pig = { def: { hostile: false }, body: { x: 1, y: 10, z: 0 }, removed: false, dying: -1 };
    expect(monstersNear([pig], 0, 10, 0)).toBe(false);
    expect(monstersNear([pig, zombie], 0, 10, 0)).toBe(true);
    expect(monstersNear([{ ...zombie, body: { x: 20, y: 10, z: 0 } }], 0, 10, 0)).toBe(false);
    expect(monstersNear([{ ...zombie, dying: 0.2 }], 0, 10, 0)).toBe(false);
  });

  it('keep the respawn point in the saved player', () => {
    const base = {
      formatVersion: WORLD_FORMAT_VERSION,
      id: 'w',
      type: 'infinite',
      player: { x: 1, y: 70, z: 2, bed: { x: 4.2, y: 64, z: -3.5 } },
    };
    expect(sanitizeWorldRecord(base)?.player?.bed).toEqual({ x: 4, y: 64, z: -4 });
    expect(sanitizeWorldRecord({ ...base, player: { x: 1, y: 70, z: 2 } })?.player?.bed).toBeUndefined();
  });
});
