import { describe, expect, it } from 'vitest';
import { B } from '../src/world/blocks';
import { FALLING, fluidHeight, fluidLevel, updateFluid, type FluidWorld } from '../src/world/fluids';

/** A tiny world: stone floor at y = 0 unless carved; a scheduled-update queue like the ticker's. */
class Sim implements FluidWorld {
  readonly cells = new Map<string, number>();
  private queue = new Map<string, number>();
  private now = 0;
  constructor(private readonly floor = B.STONE) {}
  key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }
  get(x: number, y: number, z: number): number {
    return this.cells.get(this.key(x, y, z)) ?? (y <= 0 ? this.floor : B.AIR);
  }
  set(x: number, y: number, z: number, v: number): void {
    this.cells.set(this.key(x, y, z), v);
    // Like the ticker: the changed cell and its fluid neighbours take another look.
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
      const id = this.get(x + dx, y + dy, z + dz) & 0xff;
      if (id === B.WATER || id === B.LAVA) this.schedule(x + dx, y + dy, z + dz, id === B.WATER ? 5 : 30);
    }
  }
  inBounds(_x: number, y: number): boolean {
    return y >= 0 && y < 64;
  }
  schedule = (x: number, y: number, z: number, delay: number): void => {
    const k = this.key(x, y, z);
    const t = this.now + delay;
    const cur = this.queue.get(k);
    if (cur === undefined || cur > t) this.queue.set(k, t);
  };
  run(maxTicks = 5000): number {
    for (let t = 0; t < maxTicks && this.queue.size; t++) {
      this.now++;
      for (const [k, due] of [...this.queue]) {
        if (due > this.now) continue;
        this.queue.delete(k);
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        updateFluid(this, x, y, z, this.schedule);
      }
    }
    return this.now;
  }
  place(x: number, y: number, z: number, v: number): void {
    this.set(x, y, z, v);
  }
  count(id: number): number {
    let n = 0;
    for (const v of this.cells.values()) if ((v & 0xff) === id) n++;
    return n;
  }
}

describe('finite fluids', () => {
  it('spreads water 7 blocks from a source on flat ground', () => {
    const s = new Sim();
    s.place(0, 1, 0, B.WATER);
    s.run();
    expect(fluidLevel(s.get(7, 1, 0))).toBe(7);
    expect(s.get(8, 1, 0) & 0xff).toBe(B.AIR);
    expect(fluidLevel(s.get(3, 1, 3))).toBe(6);
    // A diamond of radius 7: 1 + 4 × (1 + 2 + … + 7) cells.
    expect(s.count(B.WATER)).toBe(1 + 4 * 28);
  });

  it('spreads lava only 3 blocks, and more slowly', () => {
    const s = new Sim();
    s.place(0, 1, 0, B.LAVA);
    const ticks = s.run();
    expect(s.get(3, 1, 0) & 0xff).toBe(B.LAVA);
    expect(s.get(4, 1, 0) & 0xff).toBe(B.AIR);
    expect(ticks).toBeGreaterThan(90);
  });

  it('dries up when the source is removed', () => {
    const s = new Sim();
    s.place(0, 1, 0, B.WATER);
    s.run();
    s.place(0, 1, 0, B.AIR);
    s.run();
    expect(s.count(B.WATER)).toBe(0);
  });

  it('heads for the nearest drop and pours down it', () => {
    const s = new Sim();
    s.cells.set(s.key(3, 0, 0), B.AIR); // a hole three blocks east
    s.place(0, 1, 0, B.WATER);
    s.run();
    expect(s.get(3, 0, 0) & 0xff).toBe(B.WATER);
    expect((s.get(3, 0, 0) >> 8) & FALLING).toBeTruthy();
    // Only the path toward the hole fills; west stays dry.
    expect(s.get(-1, 1, 0) & 0xff).toBe(B.AIR);
  });

  it('makes a new source between two sources', () => {
    const s = new Sim();
    s.place(0, 1, 0, B.WATER);
    s.place(2, 1, 0, B.WATER);
    s.run();
    expect(s.get(1, 1, 0)).toBe(B.WATER); // level 0 = source
    s.place(0, 1, 0, B.AIR);
    s.place(2, 1, 0, B.AIR);
    s.run();
    expect(s.get(1, 1, 0)).toBe(B.WATER); // it keeps itself going
  });

  it('turns lava into obsidian or cobblestone where water meets it', () => {
    const s = new Sim();
    s.place(0, 1, 0, B.LAVA);
    s.run();
    // Flowing lava next to new water → cobblestone; the source → obsidian.
    s.place(0, 1, 3, B.WATER);
    s.run();
    expect(s.count(B.COBBLESTONE)).toBeGreaterThan(0);
    s.place(0, 2, 0, B.WATER);
    s.run();
    expect(s.get(0, 1, 0)).toBe(B.OBSIDIAN);
  });

  it('draws weaker flows lower', () => {
    expect(fluidHeight(B.WATER, B.AIR)).toBeCloseTo(8 / 9);
    expect(fluidHeight(B.WATER | (7 << 8), B.AIR)).toBeCloseTo(1 / 9);
    expect(fluidHeight(B.WATER | (3 << 8), B.WATER)).toBe(1);
  });
});
