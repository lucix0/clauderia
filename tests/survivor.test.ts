import { describe, expect, it } from 'vitest';
import { ItemEntities } from '../src/entities/items';
import { stack } from '../src/items/inventory';
import { I, toolId } from '../src/items/items';
import { createBody, stepBody, type CollisionWorld } from '../src/player/physics';
import { Survivor } from '../src/survival/survivor';
import { B, collisionHeight } from '../src/world/blocks';
import { classicWorld, lightWorld } from './helpers';

function flatWorld() {
  const w = classicWorld(32, 32, 32, (_x, y) => (y < 10 ? B.STONE : y === 10 ? B.GRASS : 0));
  lightWorld(w);
  return w;
}

function collision(w: ReturnType<typeof flatWorld>): CollisionWorld & { active(): boolean } {
  return {
    solidHeight: (x, y, z) => (w.inBounds(x, y, z) ? collisionHeight(w.getId(x, y, z)) : y < 0 ? 1 : 0),
    liquidAt: () => 0,
    active: () => true,
  };
}

describe('survival player', () => {
  it('mines over time and drops what the tool allows', () => {
    const w = flatWorld();
    const items = new ItemEntities();
    const s = new Survivor();
    s.mode = 'survival';
    const cell = { x: 5, y: 9, z: 5 };
    // Stone by hand: 7.5 s, and nothing drops.
    let broke = null;
    let t = 0;
    for (; t < 10 && !broke; t += 0.05) broke = s.updateMining(w, items, cell, true, 0.05);
    expect(broke).toEqual(cell);
    expect(t).toBeGreaterThan(7);
    expect(items.list.length).toBe(0);
    // With a wooden pickaxe it's quick and gives cobblestone; the pickaxe wears.
    s.inventory[0] = stack(toolId('pickaxe', 0));
    const next = { x: 6, y: 9, z: 5 };
    t = 0;
    broke = null;
    for (; t < 10 && !broke; t += 0.05) broke = s.updateMining(w, items, next, true, 0.05);
    expect(t).toBeLessThan(1.6);
    expect(items.list.map((e) => e.stack)).toEqual([stack(B.COBBLESTONE)]);
    expect(s.inventory[0]!.damage).toBe(1);
  });

  it('resets progress when the target changes or the button is released', () => {
    const w = flatWorld();
    const s = new Survivor();
    s.mode = 'survival';
    s.updateMining(w, new ItemEntities(), { x: 5, y: 10, z: 5 }, true, 0.3);
    expect(s.mining!.progress).toBeGreaterThan(0.3);
    s.updateMining(w, new ItemEntities(), { x: 6, y: 10, z: 5 }, true, 0.05);
    expect(s.mining!.progress).toBeLessThan(0.1);
    s.updateMining(w, new ItemEntities(), null, false, 0.05);
    expect(s.mining).toBeNull();
  });

  it('takes fall damage when landing, not in creative', () => {
    const w = flatWorld();
    const s = new Survivor();
    s.mode = 'survival';
    const body = createBody(5.5, 21, 5.5);
    const col = collision(w);
    for (let i = 0; i < 200; i++) {
      const [px, py, pz] = [body.x, body.y, body.z];
      stepBody(col, body, { forward: 0, strafe: 0, jump: false, down: false, yaw: 0 }, 1 / 60);
      s.afterMove(body, px, py, pz, false);
    }
    expect(body.onGround).toBe(true);
    expect(s.vitals.health).toBe(20 - 7); // fell 10 blocks
  });

  it('eats food after holding use long enough', () => {
    const s = new Survivor();
    s.mode = 'survival';
    s.vitals.hunger = 10;
    s.inventory[0] = stack(I.APPLE, 2);
    expect(s.updateEating(true, 1)).toBe(false);
    expect(s.updateEating(true, 1)).toBe(true);
    expect(s.vitals.hunger).toBe(14);
    expect(s.inventory[0]).toEqual(stack(I.APPLE, 1));
  });

  it('drops everything and starts fresh after dying', () => {
    const s = new Survivor();
    s.mode = 'survival';
    let died = '';
    s.events.died = (c) => (died = c);
    s.inventory[3] = stack(B.DIRT, 5);
    s.damage(25, 'lava');
    expect(died).toBe('lava');
    expect(s.takeAll()).toEqual([stack(B.DIRT, 5)]);
    s.respawn();
    expect(s.vitals.health).toBe(20);
    expect(s.dead).toBe(false);
  });
});

describe('item entities', () => {
  it('fall, merge, get picked up and despawn', () => {
    const w = flatWorld();
    const col = collision(w);
    const items = new ItemEntities();
    items.spawn(stack(B.DIRT, 3), 5.5, 14, 5.5, 0, 0, 0, 0);
    items.spawn(stack(B.DIRT, 2), 5.6, 14, 5.4, 0, 0, 0, 0);
    for (let i = 0; i < 120; i++) items.update(col, 1 / 60, null);
    expect(items.list.length).toBe(1);
    expect(items.list[0]!.stack.count).toBe(5);
    expect(items.list[0]!.body.y).toBeCloseTo(11, 1);
    const got: number[] = [];
    const player = { x: 7, y: 11, z: 5.5, collect: (s: { count: number }) => (got.push(s.count), 0) };
    for (let i = 0; i < 120 && items.list.length; i++) items.update(col, 1 / 60, player);
    expect(got).toEqual([5]);
    expect(items.list.length).toBe(0);
    items.spawn(stack(B.SAND), 5.5, 11, 5.5);
    items.list[0]!.age = 299.99;
    items.update(col, 0.1, null);
    expect(items.list.length).toBe(0);
  });
});

describe('sneaking', () => {
  it('stops at the edge of a block instead of walking off', () => {
    const w = classicWorld(32, 32, 32, (x, y) => (y === 10 && x < 10 ? B.STONE : 0));
    const col = collision(w);
    const body = createBody(8.5, 11, 5.5);
    body.onGround = true;
    // yaw −π/2 faces +X, toward the edge at x = 10.
    for (let i = 0; i < 240; i++) stepBody(col, body, { forward: 1, strafe: 0, jump: false, down: false, yaw: -Math.PI / 2, sneak: true, speed: 0.3 }, 1 / 60);
    expect(body.y).toBeCloseTo(11);
    expect(body.x).toBeGreaterThan(9.6);
    expect(body.x).toBeLessThan(10.31);
    // Without sneaking the same walk falls off.
    for (let i = 0; i < 240; i++) stepBody(col, body, { forward: 1, strafe: 0, jump: false, down: false, yaw: -Math.PI / 2 }, 1 / 60);
    expect(body.y).toBeLessThan(11);
  });
});
