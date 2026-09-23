import { describe, expect, it } from 'vitest';
import { effectiveLight, Mobs, type MobTarget, type MobWorld } from '../src/entities/mobs';
import { I } from '../src/items/items';
import { B } from '../src/world/blocks';

/** Flat stone floor at y < 10; `light` gives packed light everywhere. */
function flat(light = 0xf0, daylight = 1, extra: (x: number, y: number, z: number) => number | null = () => null): MobWorld {
  const id = (x: number, y: number, z: number): number => extra(x, y, z) ?? (y < 10 ? B.STONE : B.AIR);
  return {
    solidHeight: (x, y, z) => (id(x, y, z) === B.STONE ? 1 : 0),
    liquidAt: (x, y, z) => (id(x, y, z) === B.WATER ? 1 : id(x, y, z) === B.LAVA ? 2 : 0),
    active: () => true,
    blockId: id,
    light: () => light,
    daylight,
  };
}

function target(x: number, z: number): MobTarget & { taken: number } {
  const t = {
    x,
    y: 10,
    z,
    attackable: true,
    taken: 0,
    hurt(amount: number) {
      t.taken += amount;
      return amount;
    },
  };
  return t;
}

function run(mobs: Mobs, w: MobWorld, seconds: number, player: MobTarget | null, peaceful = false): void {
  for (let t = 0; t < seconds * 60; t++) mobs.update(w, 1 / 60, player, peaceful);
}

describe('mobs', () => {
  it('take hits with knockback, die, and drop loot', () => {
    const mobs = new Mobs(() => 0.5);
    const w = flat();
    const pig = mobs.spawn('pig', 0.5, 10, 0.5);
    run(mobs, w, 0.5, null);
    let loot: unknown[] = [];
    mobs.events.died = (_m, l) => (loot = l);
    expect(mobs.hit(pig, 4, -2, 0.5)).toBe(true);
    expect(mobs.hit(pig, 4, -2, 0.5)).toBe(false); // still flashing
    expect(pig.body.vx).toBeGreaterThan(0);
    expect(pig.mode).toBe('flee');
    run(mobs, w, 0.6, null);
    mobs.hit(pig, 10, -2, 0.5);
    expect(pig.dying).toBeGreaterThanOrEqual(0);
    run(mobs, w, 1, null);
    expect(mobs.list.length).toBe(0);
    expect(loot).toEqual([{ id: I.RAW_PORK, count: 2, damage: 0 }]);
  });

  it('zombies chase and hit the player', () => {
    const mobs = new Mobs();
    const w = flat(0, 0);
    mobs.spawn('zombie', 0.5, 10, 0.5);
    const p = target(8.5, 0.5);
    run(mobs, w, 6, p);
    expect(p.taken).toBeGreaterThanOrEqual(3);
    // Creative players (not attackable) are ignored.
    const q = target(8.5, 0.5);
    q.attackable = false;
    const calm = new Mobs();
    calm.spawn('zombie', 0.5, 10, 0.5);
    run(calm, w, 6, q);
    expect(q.taken).toBe(0);
  });

  it('skeletons keep their distance and shoot arcing arrows', () => {
    const mobs = new Mobs(() => 0.5);
    const w = flat(0, 0);
    const s = mobs.spawn('skeleton', 0.5, 10, 0.5);
    const p = target(10.5, 0.5);
    let sawArrow = false;
    for (let t = 0; t < 8 * 60; t++) {
      mobs.update(w, 1 / 60, p, false);
      if (mobs.arrows.some((a) => a.y > 11.9)) sawArrow = true; // arcs above the straight line
    }
    expect(sawArrow).toBe(true);
    expect(p.taken).toBeGreaterThan(0);
    expect(Math.abs(s.body.x - p.x)).toBeGreaterThan(4);
  });

  it('spiders ignore you in daylight unless provoked', () => {
    const w = flat(0xf0, 1);
    const mobs = new Mobs();
    const sp = mobs.spawn('spider', 0.5, 10, 0.5);
    const p = target(4.5, 0.5);
    run(mobs, w, 4, p);
    expect(p.taken).toBe(0);
    mobs.hit(sp, 1, 4.5, 0.5);
    run(mobs, w, 4, p);
    expect(p.taken).toBeGreaterThan(0);
  });

  it('undead burn in sunlight, not in the dark', () => {
    const mobs = new Mobs();
    const z = mobs.spawn('zombie', 0.5, 10, 0.5);
    run(mobs, flat(0xf0, 1), 3, null);
    expect(z.health).toBeLessThan(20);
    const dark = new Mobs();
    const z2 = dark.spawn('zombie', 0.5, 10, 0.5);
    run(dark, flat(0x00, 1), 3, null);
    expect(z2.health).toBe(20);
  });

  it('spawn hostiles only in the dark, away from the player, and not on Peaceful', () => {
    const player = { x: 0.5, y: 10, z: 0.5 };
    const lit = new Mobs();
    for (let i = 0; i < 20; i++) lit.spawnTick(flat(0xf0, 1), player, 1, true);
    expect(lit.list.length).toBe(0);
    const night = new Mobs();
    for (let i = 0; i < 20; i++) night.spawnTick(flat(0xf0, 0), player, 1, true);
    const alive = night.list.filter((m) => !m.removed);
    expect(alive.length).toBeGreaterThan(0);
    expect(alive.length).toBeLessThanOrEqual(20);
    for (const m of alive) expect(Math.hypot(m.body.x - player.x, m.body.z - player.z)).toBeGreaterThanOrEqual(23);
    run(night, flat(0xf0, 0), 0.1, null, true);
    expect(night.list.length).toBe(0);
    expect(effectiveLight(0xf0, 0)).toBe(4);
    expect(effectiveLight(0x3a, 1)).toBe(10);
  });

  it('hops up one-block steps and won’t wander off cliffs', () => {
    // A step up at x ≥ 3.
    const step = flat(0xf0, 1, (x, y) => (x >= 3 && y === 10 ? B.STONE : null));
    const mobs = new Mobs();
    const cow = mobs.spawn('cow', 0.5, 10, 0.5, -Math.PI / 2);
    cow.mode = 'wander';
    cow.targetX = 8;
    cow.targetZ = 0.5;
    cow.timer = 99;
    run(mobs, step, 4, null);
    expect(cow.body.y).toBeCloseTo(11);
    expect(cow.body.x).toBeGreaterThan(5);
    // A cliff at x ≥ 3: the floor drops away.
    const cliff = flat(0xf0, 1, (x, y) => (x >= 3 && y < 10 ? B.AIR : null));
    const calm = new Mobs();
    const pig = calm.spawn('pig', 0.5, 10, 0.5, -Math.PI / 2);
    pig.mode = 'wander';
    pig.targetX = 8;
    pig.targetZ = 0.5;
    pig.timer = 99;
    run(calm, cliff, 4, null);
    expect(pig.body.y).toBeCloseTo(10);
  });

  it('saves passive mobs with their chunk and lets hostiles vanish', () => {
    const mobs = new Mobs();
    mobs.spawn('sheep', 3.5, 10, 4.5);
    mobs.spawn('zombie', 5.5, 10, 5.5);
    const saved = mobs.inChunk(0, 0, true);
    expect(mobs.list.length).toBe(0);
    expect(saved).toHaveLength(1);
    const again = new Mobs();
    again.load(JSON.parse(JSON.stringify(saved)));
    expect(again.list.map((m) => m.def.kind)).toEqual(['sheep']);
  });

  it('finds mobs along a ray', () => {
    const mobs = new Mobs();
    const cow = mobs.spawn('cow', 3.5, 10, 0.5);
    const hit = mobs.raycast(0.5, 11, 0.5, 1, 0, 0, 5);
    expect(hit?.mob).toBe(cow);
    expect(hit!.t).toBeCloseTo(2.55, 1);
    expect(mobs.raycast(0.5, 11, 0.5, -1, 0, 0, 5)).toBeNull();
  });
});
