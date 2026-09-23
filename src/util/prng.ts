/**
 * Small, fast, seedable PRNG (sfc32, seeded through splitmix32).
 * Deterministic across platforms: only 32-bit integer maths.
 */

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const sm = splitmix32(seed);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    // Warm up so nearby seeds diverge quickly.
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Derive an independent sub-seed from a seed and a salt. */
export function deriveSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 0x632be5ab, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hash a string to a 32-bit seed (FNV-1a). Numeric strings map to themselves. */
export function seedFromString(text: string): number {
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(BigInt.asUintN(32, BigInt(trimmed)));
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! >>> 0;
}
