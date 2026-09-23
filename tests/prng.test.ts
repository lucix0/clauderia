import { describe, expect, it } from 'vitest';
import { GradientNoise, OctaveNoise } from '../src/util/noise';
import { Rng, seedFromString } from '../src/util/prng';

describe('prng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 8 }, () => a.nextU32());
    const sb = Array.from({ length: 8 }, () => b.nextU32());
    const sc = Array.from({ length: 8 }, () => c.nextU32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('produces floats in [0, 1) and ints in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const f = r.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = r.int(5);
      expect(Number.isInteger(n) && n >= 0 && n < 5).toBe(true);
    }
  });

  it('turns text seeds into stable numbers', () => {
    expect(seedFromString('123')).toBe(123);
    expect(seedFromString('hello')).toBe(seedFromString(' hello '));
    expect(seedFromString('hello')).not.toBe(seedFromString('world'));
  });
});

describe('noise', () => {
  it('is deterministic and bounded', () => {
    const n1 = new GradientNoise(new Rng(1));
    const n2 = new GradientNoise(new Rng(1));
    for (let i = 0; i < 100; i++) {
      const x = i * 0.37;
      const y = i * 0.11;
      expect(n1.sample(x, y)).toBe(n2.sample(x, y));
      expect(Math.abs(n1.sample(x, y))).toBeLessThanOrEqual(1.5);
    }
    const o = new OctaveNoise(new Rng(3), 4);
    expect(Number.isFinite(o.sample(10.5, 3.25))).toBe(true);
  });
});
