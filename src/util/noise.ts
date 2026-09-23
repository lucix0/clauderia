/**
 * Seeded gradient ("improved Perlin") noise plus the octave / combined helpers
 * the level generator uses. Pure maths, no allocation per sample.
 */
import { Rng } from './prng';

const GRAD3: readonly number[] = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

export interface Noise2D {
  sample(x: number, y: number): number;
}

/** Gradient noise with a seeded permutation table. Output roughly in [-1, 1]. */
export class GradientNoise implements Noise2D {
  private readonly perm = new Uint8Array(512);

  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  sample(x: number, y: number): number {
    return this.sample3(x, y, 0.5);
  }

  sample3(x: number, y: number, z: number): number {
    const perm = this.perm;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = perm[X]! + Y;
    const AA = perm[A]! + Z;
    const AB = perm[A + 1]! + Z;
    const B = perm[X + 1]! + Y;
    const BA = perm[B]! + Z;
    const BB = perm[B + 1]! + Z;
    return lerp(
      w,
      lerp(
        v,
        lerp(u, grad(perm[AA]!, x, y, z), grad(perm[BA]!, x - 1, y, z)),
        lerp(u, grad(perm[AB]!, x, y - 1, z), grad(perm[BB]!, x - 1, y - 1, z)),
      ),
      lerp(
        v,
        lerp(u, grad(perm[AA + 1]!, x, y, z - 1), grad(perm[BA + 1]!, x - 1, y, z - 1)),
        lerp(u, grad(perm[AB + 1]!, x, y - 1, z - 1), grad(perm[BB + 1]!, x - 1, y - 1, z - 1)),
      ),
    );
  }
}

function grad(hash: number, x: number, y: number, z: number): number {
  const g = (hash & 15) * 3;
  return GRAD3[g]! * x + GRAD3[g + 1]! * y + GRAD3[g + 2]! * z;
}

/**
 * Sum of `octaves` noise layers; octave i has 2^i times the feature size and
 * 2^i times the amplitude, so large features dominate (Classic style).
 */
export class OctaveNoise implements Noise2D {
  private readonly layers: GradientNoise[] = [];

  constructor(rng: Rng, octaves: number) {
    for (let i = 0; i < octaves; i++) this.layers.push(new GradientNoise(rng));
  }

  sample(x: number, y: number): number {
    let sum = 0;
    let scale = 1;
    for (const layer of this.layers) {
      sum += layer.sample(x / scale, y / scale) * scale;
      scale *= 2;
    }
    return sum;
  }
}

/** Domain-warped noise: a(x + b(x, y), y). */
export class CombinedNoise implements Noise2D {
  constructor(
    private readonly a: Noise2D,
    private readonly b: Noise2D,
  ) {}

  sample(x: number, y: number): number {
    return this.a.sample(x + this.b.sample(x, y), y);
  }
}
