import { describe, expect, it } from 'vitest';
import { STEP_DT } from '../src/config';
import { stack, type Slots } from '../src/items/inventory';
import { I } from '../src/items/items';
import { matchRecipe } from '../src/items/recipes';
import { createBody, stepBody, type Body, type MoveInput } from '../src/player/physics';
import { collisionWorld } from '../src/player/player';
import { raycast } from '../src/player/raycast';
import { B, DOOR_OPEN, DOOR_UPPER, iconTile, PASS_CUTOUT, PASS_OPAQUE, T } from '../src/world/blocks';
import { breakBlock, canPlace, placeDoor, placementValue, toggleDoor } from '../src/world/placement';
import { selectionBox } from '../src/world/shapes';
import type { World } from '../src/world/world';
import { classicWorld, meshAt } from './helpers';

/** Stone floor at y = 4 (stand at y = 5). */
function floor(): World {
  return classicWorld(32, 32, 32, (_x, y) => (y === 4 ? B.STONE : B.AIR));
}

const free = (): boolean => false;
const walkNorth: MoveInput = { forward: 1, strafe: 0, jump: false, down: false, yaw: 0 };

function run(world: World, body: Body, input: MoveInput, seconds: number): void {
  const cw = collisionWorld(world);
  for (let t = 0; t < seconds; t += STEP_DT) stepBody(cw, body, input, STEP_DT);
}

function grid(rows: number[][]): Slots {
  return rows.flat().map((id) => (id ? stack(id) : null));
}

describe('doors', () => {
  it('are placed two tall on solid ground and open and close as one', () => {
    const w = floor();
    expect(placeDoor(w, { x: 10, y: 5, z: 10 }, 0, free)).not.toBeNull();
    expect(w.get(10, 5, 10)).toBe(B.DOOR);
    expect(w.get(10, 6, 10)).toBe(B.DOOR | (DOOR_UPPER << 8));
    expect(placeDoor(w, { x: 12, y: 8, z: 10 }, 0, free)).toBeNull(); // nothing underneath
    expect(toggleDoor(w, { x: 10, y: 6, z: 10 })).toBe(true); // clicking the top half opens both
    expect(w.get(10, 5, 10) >> 8).toBe(DOOR_OPEN);
    expect(w.get(10, 6, 10) >> 8).toBe(DOOR_OPEN | DOOR_UPPER);
    expect(toggleDoor(w, { x: 10, y: 5, z: 10 })).toBe(false);
    expect(w.get(10, 6, 10) >> 8).toBe(DOOR_UPPER);
  });

  it('block the way shut and let the player through open', () => {
    const w = floor();
    placeDoor(w, { x: 10, y: 5, z: 10 }, 0, free);
    const body = createBody(10.5, 5, 12.5);
    run(w, body, walkNorth, 2);
    // Closed: the panel lies along the far (north) side of the cell.
    expect(body.z).toBeCloseTo(10 + 3 / 16 + 0.3, 3);
    toggleDoor(w, { x: 10, y: 5, z: 10 });
    run(w, body, walkNorth, 2);
    expect(body.z).toBeLessThan(9);
  });

  it('come apart as a whole, and fall when their floor goes', () => {
    const w = floor();
    placeDoor(w, { x: 10, y: 5, z: 10 }, 1, free);
    breakBlock(w, 10, 6, 10);
    expect(w.get(10, 5, 10)).toBe(B.AIR);
    placeDoor(w, { x: 12, y: 5, z: 10 }, 1, free);
    w.setBlock(12, 4, 10, B.AIR);
    expect(w.get(12, 5, 10)).toBe(B.AIR);
    expect(w.get(12, 6, 10)).toBe(B.AIR);
  });

  it('are targeted on the panel only', () => {
    const w = floor();
    placeDoor(w, { x: 10, y: 5, z: 10 }, 0, free);
    // Open, the panel swings to the west side: a ray down the east half misses it.
    toggleDoor(w, { x: 10, y: 5, z: 10 });
    const miss = raycast(w, 10.8, 5.5, 13, 0, 0, -1, 10);
    expect(miss?.id).not.toBe(B.DOOR);
    const hit = raycast(w, 10.1, 5.5, 13, 0, 0, -1, 10);
    expect(hit?.id).toBe(B.DOOR);
    expect(selectionBox(w, 10, 5, 10, w.get(10, 5, 10))).toEqual([0, 0, 0, 3 / 16, 1, 1]);
  });
});

describe('fences', () => {
  it('join their neighbours and cannot be jumped', () => {
    const w = floor();
    for (let x = 6; x <= 14; x++) w.setBlock(x, 5, 10, B.FENCE);
    const body = createBody(10.5, 5, 12.5);
    run(w, body, { ...walkNorth, jump: true }, 3);
    expect(body.z).toBeGreaterThan(10.5);
    // A lone post is only a post: walking past its side works.
    const lone = floor();
    lone.setBlock(10, 5, 10, B.FENCE);
    const b2 = createBody(10.5 + 0.55, 5, 12.5);
    run(lone, b2, walkNorth, 3);
    expect(b2.z).toBeLessThan(9);
  });

  it('draw rails only toward what they join', () => {
    const one = floor();
    one.setBlock(10, 5, 10, B.FENCE);
    const two = floor();
    two.setBlock(10, 5, 10, B.FENCE);
    two.setBlock(11, 5, 10, B.FENCE);
    const base = meshAt(floor(), 0, 0, 0)[PASS_OPAQUE]!.quads;
    const q1 = meshAt(one, 0, 0, 0)[PASS_OPAQUE]!.quads - base;
    const q2 = meshAt(two, 0, 0, 0)[PASS_OPAQUE]!.quads - base;
    // A lone post: 5 faces (its bottom sits on stone). Two joined posts add two rails each.
    expect(q1).toBe(5);
    expect(q2).toBe(2 * 5 + 2 * 2 * 6);
  });

  it('can’t be placed inside the player', () => {
    const w = floor();
    expect(canPlace(w, { x: 10, y: 5, z: 10 }, B.FENCE, (c) => c.x === 10 && c.z === 10)).toBe(false);
  });
});

describe('ladders', () => {
  /** A stone wall along z = 9 with ladders on its south face at x = 10. */
  function wall(height: number): World {
    const w = floor();
    for (let y = 5; y < 5 + height; y++) {
      for (let x = 8; x <= 12; x++) w.setBlock(x, y, 9, B.STONE);
      w.setBlock(10, y, 10, placementValue(B.LADDER, [0, 0, 1])!);
    }
    return w;
  }

  it('hang on walls only', () => {
    expect(placementValue(B.LADDER, [0, 1, 0])).toBeNull();
    expect(placementValue(B.LADDER, [0, 0, 1])).toBe(B.LADDER | (3 << 8));
    const w = wall(3);
    w.setBlock(10, 6, 9, B.AIR);
    expect(w.get(10, 6, 10)).toBe(B.AIR); // lost its wall
    expect(w.getId(10, 5, 10)).toBe(B.LADDER);
  });

  it('are climbed by walking into them, held by sneaking, and slid down slowly', () => {
    const w = wall(10);
    const body = createBody(10.5, 5, 10.6);
    run(w, body, walkNorth, 2);
    expect(body.climbing).toBe(true);
    expect(body.y).toBeGreaterThan(8);
    const held = body.y;
    run(w, body, { ...walkNorth, forward: 0, sneak: true }, 1);
    expect(body.y).toBeCloseTo(held, 5);
    let fastest = 0;
    const cw = collisionWorld(w);
    for (let t = 0; t < 1; t += STEP_DT) {
      stepBody(cw, body, { ...walkNorth, forward: 0 }, STEP_DT);
      fastest = Math.min(fastest, body.vy);
    }
    expect(body.y).toBeLessThan(held);
    expect(fastest).toBeGreaterThanOrEqual(-2.5);
  });
});

describe('shaped block items', () => {
  it('are crafted from planks and sticks and shown flat', () => {
    const P = B.PLANKS;
    const S = I.STICK;
    expect(matchRecipe(grid([[P, P], [P, P], [P, P]].map((r) => [...r, 0])), 3, 3)?.out).toEqual(stack(B.DOOR, 3));
    expect(matchRecipe(grid([[S, 0, S], [S, S, S], [S, 0, S]]), 3, 3)?.out).toEqual(stack(B.LADDER, 3));
    expect(matchRecipe(grid([[P, S, P], [P, S, P], [0, 0, 0]]), 3, 3)?.out).toEqual(stack(B.FENCE, 3));
    expect(iconTile(B.DOOR)).toBe(T.DOOR_ITEM);
    expect(iconTile(B.STONE)).toBe(-1);
  });

  it('draws doors in the cut-out pass (the window is see-through)', () => {
    const w = floor();
    placeDoor(w, { x: 10, y: 5, z: 10 }, 0, free);
    expect(meshAt(w, 0, 0, 0)[PASS_CUTOUT]!.quads).toBe(2 * 6 - 1); // the bottom sits on stone
  });
});
