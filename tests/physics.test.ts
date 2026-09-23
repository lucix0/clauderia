import { describe, expect, it } from 'vitest';
import { JUMP_HEIGHT, STEP_DT } from '../src/config';
import { bodyOverlapsCell, createBody, moveBody, stepBody, type MoveInput } from '../src/player/physics';
import { collisionWorld } from '../src/player/player';
import { B } from '../src/world/blocks';
import { canPlace } from '../src/world/placement';
import { World } from '../src/world/world';

const idle: MoveInput = { forward: 0, strafe: 0, jump: false, down: false, yaw: 0 };

function floorWorld(): World {
  const w = new World(32, 32, 32, 0);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setBlock(x, 4, z, B.STONE);
  return w;
}

function run(world: World, body: ReturnType<typeof createBody>, input: MoveInput, seconds: number): void {
  const cw = collisionWorld(world);
  for (let t = 0; t < seconds; t += STEP_DT) stepBody(cw, body, input, STEP_DT);
}

describe('player collision', () => {
  it('falls and lands on the ground', () => {
    const w = floorWorld();
    const body = createBody(10.5, 12, 10.5);
    run(w, body, idle, 2);
    expect(body.y).toBeCloseTo(5, 6);
    expect(body.onGround).toBe(true);
    expect(body.vy).toBe(0);
  });

  it('never tunnels through a floor, even at huge speed', () => {
    const w = floorWorld();
    const body = createBody(10.5, 20, 10.5);
    moveBody(collisionWorld(w), body, 0, -500, 0);
    expect(body.y).toBeCloseTo(5, 6);
  });

  it('is blocked by walls and keeps sliding along them', () => {
    const w = floorWorld();
    for (let z = 0; z < 32; z++) {
      w.setBlock(14, 5, z, B.STONE);
      w.setBlock(14, 6, z, B.STONE);
    }
    const body = createBody(10.5, 5, 10.5);
    body.onGround = true;
    // Walk east (+X) with a little southward drift.
    run(w, body, { ...idle, forward: 0, strafe: 1, yaw: 0 }, 3);
    expect(body.x).toBeCloseTo(14 - 0.3, 5);
    const r = moveBody(collisionWorld(w), body, 1, 0, 0.5);
    expect(r.hitX).toBe(true);
    expect(r.dz).toBeCloseTo(0.5);
  });

  it('cannot walk off the edge of the map', () => {
    const w = floorWorld();
    const body = createBody(1.5, 5, 10.5);
    body.onGround = true;
    run(w, body, { ...idle, strafe: -1 }, 2);
    expect(body.x).toBeCloseTo(0.3, 5);
  });

  it('jumps about 1.25 blocks', () => {
    const w = floorWorld();
    const body = createBody(10.5, 5, 10.5);
    run(w, body, idle, 0.2);
    const cw = collisionWorld(w);
    let peak = body.y;
    stepBody(cw, body, { ...idle, jump: true }, STEP_DT);
    for (let i = 0; i < 90; i++) {
      stepBody(cw, body, idle, STEP_DT);
      peak = Math.max(peak, body.y);
    }
    expect(peak - 5).toBeGreaterThan(JUMP_HEIGHT - 0.05);
    expect(peak - 5).toBeLessThan(JUMP_HEIGHT + 0.05);
    expect(body.y).toBeCloseTo(5, 6);
  });

  it('bumps its head on ceilings', () => {
    const w = floorWorld();
    w.setBlock(10, 7, 10, B.STONE);
    const body = createBody(10.5, 5, 10.5);
    run(w, body, idle, 0.1);
    const cw = collisionWorld(w);
    stepBody(cw, body, { ...idle, jump: true }, STEP_DT);
    let peak = body.y;
    for (let i = 0; i < 60; i++) {
      stepBody(cw, body, idle, STEP_DT);
      peak = Math.max(peak, body.y);
    }
    expect(peak + 1.8).toBeLessThanOrEqual(7 + 1e-6);
  });

  it('steps up onto slabs but not onto full blocks', () => {
    const w = floorWorld();
    w.setBlock(12, 5, 10, B.SLAB);
    w.setBlock(12, 5, 14, B.STONE);
    const onSlab = createBody(10.5, 5, 10.5);
    run(w, onSlab, idle, 0.1);
    run(w, onSlab, { ...idle, strafe: 1 }, 1);
    expect(onSlab.x).toBeGreaterThan(12);
    expect(onSlab.y).toBeGreaterThanOrEqual(5);
    const atWall = createBody(10.5, 5, 14.5);
    run(w, atWall, idle, 0.1);
    run(w, atWall, { ...idle, strafe: 1 }, 1);
    expect(atWall.x).toBeCloseTo(11.7, 5);
    expect(atWall.y).toBeCloseTo(5, 6);
  });

  it('swims slower in water and rises with jump', () => {
    const w = floorWorld();
    for (let y = 5; y < 9; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setBlock(x, y, z, B.WATER);
    const body = createBody(10.5, 5, 10.5);
    run(w, body, idle, 0.2);
    expect(body.liquid).toBe(1);
    const x0 = body.x;
    run(w, body, { ...idle, strafe: 1 }, 1);
    expect(body.x - x0).toBeLessThan(4.3 * 0.6);
    const y0 = body.y;
    run(w, body, { ...idle, jump: true }, 0.5);
    expect(body.y).toBeGreaterThan(y0 + 0.5);
  });

  it('flies without gravity', () => {
    const w = floorWorld();
    const body = createBody(10.5, 12, 10.5);
    body.flying = true;
    run(w, body, idle, 1);
    expect(body.y).toBeCloseTo(12, 3);
    run(w, body, { ...idle, jump: true }, 0.5);
    expect(body.y).toBeGreaterThan(14);
  });
});

describe('placement', () => {
  it('refuses to place a solid block inside the player', () => {
    const w = floorWorld();
    const body = createBody(10.5, 5, 10.5);
    const overlaps = (c: { x: number; y: number; z: number }, h: number): boolean =>
      bodyOverlapsCell(body, c.x, c.y, c.z, h);
    expect(canPlace(w, { x: 10, y: 5, z: 10 }, B.STONE, overlaps)).toBe(false); // feet
    expect(canPlace(w, { x: 10, y: 6, z: 10 }, B.STONE, overlaps)).toBe(false); // head
    expect(canPlace(w, { x: 11, y: 5, z: 10 }, B.STONE, overlaps)).toBe(true); // beside
    expect(canPlace(w, { x: 10, y: 7, z: 10 }, B.STONE, overlaps)).toBe(true); // above head
    // Non-solid plants may go where the player stands.
    expect(canPlace(w, { x: 10, y: 5, z: 10 }, B.ROSE, overlaps)).toBe(true);
    // Never into an occupied cell.
    expect(canPlace(w, { x: 12, y: 4, z: 12 }, B.DIRT, overlaps)).toBe(false);
  });

  it('only places plants on solid ground', () => {
    const w = floorWorld();
    const never = (): boolean => false;
    expect(canPlace(w, { x: 3, y: 5, z: 3 }, B.DANDELION, never)).toBe(true);
    expect(canPlace(w, { x: 3, y: 6, z: 3 }, B.DANDELION, never)).toBe(false);
  });
});
