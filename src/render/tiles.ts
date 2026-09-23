/**
 * Procedural 16×16 pixel-art tiles. Pure: every painter writes into an RGBA
 * buffer using a PRNG seeded by the tile id, so output is deterministic.
 */
import { Rng } from '../util/prng';
import {
  CRACK_STAGES,
  DEFAULT_FOLIAGE_TINT,
  DEFAULT_GRASS_TINT,
  DEFAULT_WATER_TINT,
  T,
  TILE_COUNT,
} from '../world/blocks';

export const TILE_PX = 16;

type RGB = readonly [number, number, number];

function hex(s: string): RGB {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function scale(c: RGB, f: number): RGB {
  return [c[0] * f, c[1] * f, c[2] * f];
}

/** A grey level (0–1) as a colour; tinted in the shader. */
function grey(v: number): RGB {
  return [v * 255, v * 255, v * 255];
}

/** Alpha that marks an opaque pixel as "multiply by the biome tint". */
export const TINT_MASK_ALPHA = 128;

class Tile {
  readonly data: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);

  set(x: number, y: number, c: RGB, a = 255): void {
    const i = ((((y % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }

  get(x: number, y: number): RGB {
    const i = ((((y % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }

  alpha(x: number, y: number): number {
    return this.data[((((y % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)) * 4 + 3]!;
  }

  fill(c: RGB, a = 255): void {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) this.set(x, y, c, a);
  }

  clear(): void {
    this.data.fill(0);
  }

  /** Multiply the colour of a pixel. */
  shadePx(x: number, y: number, f: number): void {
    this.set(x, y, scale(this.get(x, y), f), this.alpha(x, y));
  }
}

/** Smooth, tileable value noise on a `cells`×`cells` lattice; values in [0, 1]. */
function blob(rng: Rng, cells: number): Float32Array {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
  const out = new Float32Array(256);
  const step = 16 / cells;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const gx = x / step;
      const gy = y / step;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = gx - x0;
      const ty = gy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (cx: number, cy: number): number => lattice[(cy % cells) * cells + (cx % cells)]!;
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      out[y * 16 + x] = a + (b - a) * sy;
    }
  }
  return out;
}

/** Quantise a [0,1) value onto a palette. */
function pick(pal: readonly RGB[], v: number): RGB {
  const i = Math.max(0, Math.min(pal.length - 1, Math.floor(v * pal.length)));
  return pal[i]!;
}

/** Palette-dithered texture: smooth blobs + per-pixel jitter. */
function dithered(t: Tile, rng: Rng, pal: readonly RGB[], cells: number, smooth: number): void {
  const n = blob(rng, cells);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      t.set(x, y, pick(pal, n[y * 16 + x]! * smooth + rng.next() * (1 - smooth)));
    }
  }
}

const P = {
  stone: ['#6e6e6e', '#767676', '#7e7e7e', '#868686', '#8e8e8e'].map(hex),
  dirt: ['#6c4a30', '#7a5537', '#86603f', '#936b47', '#9f7651'].map(hex),
  // Grass, leaves and water are grey and take their colour from the biome tint.
  grass: [0.62, 0.71, 0.8, 0.89, 1].map(grey),
  sand: ['#cabd86', '#d4c892', '#dcd19e', '#e4dbab'].map(hex),
  bedrock: ['#262626', '#3a3a3a', '#505050', '#6a6a6a', '#858585'].map(hex),
  water: [0.72, 0.79, 0.85, 0.92, 1].map(grey),
  lava: ['#b8340a', '#d24a0c', '#e86410', '#f68118', '#ffa326', '#ffc84a'].map(hex),
  leaves: [0.52, 0.64, 0.76, 0.88, 1].map(grey),
  obsidian: ['#0e0a15', '#150f20', '#1c142b', '#241a37', '#342650'].map(hex),
};

const WOOL_COLORS: readonly RGB[] = [
  '#cf3b3b', '#df7c2a', '#e2cf3a', '#8ccf3a', '#3fae49', '#39ae8a', '#39b4c6', '#5897de',
  '#4a5fd4', '#6a4ed4', '#984ed4', '#cf4ec4', '#de7aa6', '#3d3d3d', '#8c8c8c', '#e6e6e6',
].map(hex);

// ---- Individual painters ----

function stone(t: Tile, rng: Rng): void {
  dithered(t, rng, P.stone, 4, 0.55);
  for (let k = 0; k < 6; k++) {
    const x = rng.int(16);
    const y = rng.int(16);
    const len = 2 + rng.int(3);
    for (let i = 0; i < len; i++) t.set(x + i, y, hex('#666666'));
  }
}

function dirt(t: Tile, rng: Rng): void {
  dithered(t, rng, P.dirt, 8, 0.45);
  for (let k = 0; k < 5; k++) t.set(rng.int(16), rng.int(16), hex('#a58868'));
  for (let k = 0; k < 6; k++) t.set(rng.int(16), rng.int(16), hex('#5c3e27'));
}

function grassTop(t: Tile, rng: Rng): void {
  dithered(t, rng, P.grass, 8, 0.5);
  for (let k = 0; k < 10; k++) t.set(rng.int(16), rng.int(16), grey(0.53));
  maskAll(t);
}

/** Mark every pixel as tinted (opaque tiles coloured by the biome). */
function maskAll(t: Tile): void {
  for (let i = 3; i < t.data.length; i += 4) t.data[i] = TINT_MASK_ALPHA;
}

/** Dirt with a ragged fringe on top in `pal`; `mask` marks the fringe as tinted. */
function fringed(t: Tile, rng: Rng, pal: readonly RGB[], mask: boolean): void {
  dirt(t, rng);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + (rng.chance(0.5) ? 1 : 0) + (rng.chance(0.25) ? 1 : 0);
    for (let y = 0; y < depth; y++) {
      const c = pick(pal, rng.next());
      t.set(x, y, y === depth - 1 ? scale(c, 0.82) : c, mask ? TINT_MASK_ALPHA : 255);
    }
  }
}

function grassSide(t: Tile, rng: Rng): void {
  fringed(t, rng, P.grass, true);
}

function sand(t: Tile, rng: Rng): void {
  dithered(t, rng, P.sand, 8, 0.35);
  for (let k = 0; k < 6; k++) t.set(rng.int(16), rng.int(16), hex('#bfae74'));
}

function gravel(t: Tile, rng: Rng): void {
  const base = hex('#7a7373');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, scale(base, 0.9 + rng.next() * 0.15));
  const stones = ['#9a9292', '#6a6363', '#8b8383', '#aaa2a2', '#5b5555', '#8f857a'].map(hex);
  for (let k = 0; k < 22; k++) {
    const x = rng.int(16);
    const y = rng.int(16);
    const w = 1 + rng.int(3);
    const h = 1 + rng.int(2);
    const c = stones[rng.int(stones.length)]!;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) t.set(x + dx, y + dy, c);
    t.set(x + w, y + h, scale(c, 0.7));
  }
}

/** Cobblestone: Voronoi stones on a torus with dark mortar outlines. */
function cobble(t: Tile, rng: Rng, base = hex('#828282')): Int8Array {
  const pts: Array<[number, number, number]> = [];
  for (let k = 0; k < 10; k++) pts.push([rng.next() * 16, rng.next() * 16, 0.78 + rng.next() * 0.34]);
  const owner = new Int8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let best = 1e9;
      let who = 0;
      pts.forEach(([px, py], k) => {
        let dx = Math.abs(x + 0.5 - px);
        let dy = Math.abs(y + 0.5 - py);
        dx = Math.min(dx, 16 - dx);
        dy = Math.min(dy, 16 - dy);
        const d = dx * dx + dy * dy * 1.3;
        if (d < best) {
          best = d;
          who = k;
        }
      });
      owner[y * 16 + x] = who;
    }
  }
  const at = (x: number, y: number): number => owner[((y + 16) % 16) * 16 + ((x + 16) % 16)]!;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const o = at(x, y);
      const edge = at(x + 1, y) !== o || at(x, y + 1) !== o;
      if (edge) {
        t.set(x, y, hex('#484848'));
        continue;
      }
      let c = scale(base, pts[o]![2] * (0.94 + rng.next() * 0.1));
      if (at(x - 1, y) !== o || at(x, y - 1) !== o) c = scale(c, 1.14);
      t.set(x, y, c);
    }
  }
  return owner;
}

function mossy(t: Tile, rng: Rng): void {
  cobble(t, rng);
  const n = blob(rng, 4);
  const moss = ['#3f6a28', '#4d7c31', '#5b8d3a', '#6a9c44'].map(hex);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (n[y * 16 + x]! + rng.next() * 0.25 > 0.72) t.set(x, y, pick(moss, rng.next()));
    }
  }
}

function planks(t: Tile, rng: Rng, palette = ['#a3824f', '#ab8854', '#9c7c4a', '#b08c58'], lineHex = '#6a5031'): void {
  const boards = palette.map(hex);
  const line = hex(lineHex);
  for (let b = 0; b < 4; b++) {
    const c = boards[rng.int(boards.length)]!;
    const seam = rng.int(16);
    for (let y = b * 4; y < b * 4 + 4; y++) {
      for (let x = 0; x < 16; x++) {
        if (y === b * 4 + 3) t.set(x, y, line);
        else if (x === seam) t.set(x, y, scale(line, 1.15));
        else t.set(x, y, scale(c, 0.95 + rng.next() * 0.08));
      }
    }
    // Grain streaks.
    for (let k = 0; k < 3; k++) {
      const y = b * 4 + rng.int(3);
      const x = rng.int(16);
      const len = 2 + rng.int(4);
      for (let i = 0; i < len; i++) if ((x + i) % 16 !== seam) t.set(x + i, y, scale(c, 0.84));
    }
  }
}

function logSide(
  t: Tile,
  rng: Rng,
  palette = ['#5a4329', '#644b2e', '#6d5334', '#765b3a'],
  streak = '#44321e',
): void {
  const bark = palette.map(hex);
  for (let x = 0; x < 16; x++) {
    const colBase = bark[rng.int(bark.length)]!;
    for (let y = 0; y < 16; y++) t.set(x, y, scale(colBase, 0.93 + rng.next() * 0.12));
  }
  for (let k = 0; k < 9; k++) {
    const x = rng.int(16);
    const y = rng.int(16);
    const len = 3 + rng.int(6);
    for (let i = 0; i < len; i++) t.set(x, y + i, hex(streak));
  }
}

function logTop(
  t: Tile,
  rng: Rng,
  rings = ['#b8955e', '#9d7c4a'],
  bark = ['#5a4329', '#6d5334'],
): void {
  const light = hex(rings[0]!);
  const dark = hex(rings[1]!);
  const rim = bark.map(hex);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x - 7.5);
      const dy = Math.abs(y - 7.5);
      const d = Math.max(dx, dy) * 0.7 + Math.hypot(dx, dy) * 0.3;
      let c: RGB;
      if (Math.max(dx, dy) >= 7) c = pick(rim, rng.next());
      else c = Math.floor(d) % 2 === 0 ? light : dark;
      t.set(x, y, scale(c, 0.95 + rng.next() * 0.08));
    }
  }
}

/** Birch bark: pale with dark horizontal scars. */
function birchSide(t: Tile, rng: Rng): void {
  const bark = ['#e4e1d6', '#dcd9cd', '#d3d0c3', '#ebe8de'].map(hex);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, pick(bark, rng.next()));
  for (let k = 0; k < 7; k++) {
    const x = rng.int(16);
    const y = rng.int(16);
    const len = 2 + rng.int(4);
    for (let i = 0; i < len; i++) t.set(x + i, y, hex(i === 0 || i === len - 1 ? '#5a5850' : '#2f2e2a'));
    if (rng.chance(0.5)) t.set(x + 1, y + 1, hex('#77746a'));
  }
}

function leaves(t: Tile, rng: Rng, holes = 0.3): void {
  const n = blob(rng, 8);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = n[y * 16 + x]! * 0.5 + rng.next() * 0.5;
      if (v < holes) {
        t.set(x, y, [0, 0, 0], 0);
      } else {
        t.set(x, y, pick(P.leaves, (v - holes) / (1 - holes)));
      }
    }
  }
  // Dark rim under holes for depth.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (t.alpha(x, y) && !t.alpha(x, y - 1)) t.shadePx(x, y, 0.78);
    }
  }
}

/** Spruce needles: dense vertical strokes with small gaps. */
function spruceLeaves(t: Tile, rng: Rng): void {
  t.clear();
  for (let x = 0; x < 16; x++) {
    let y = -rng.int(4);
    while (y < 16) {
      const len = 2 + rng.int(4);
      const v = 0.55 + rng.next() * 0.45;
      for (let i = 0; i < len; i++) t.set(x, y + i, grey(v * (i === len - 1 ? 0.8 : 1)));
      y += len + (rng.chance(0.4) ? 1 : 0);
    }
  }
  for (let k = 0; k < 18; k++) t.set(rng.int(16), rng.int(16), [0, 0, 0], 0);
}

function sandstoneSide(t: Tile, rng: Rng): void {
  const pal = ['#d4c68c', '#d9cc93', '#ddd19a', '#cfc084'].map(hex);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c = pick(pal, rng.next() * 0.6 + 0.2);
      if (y < 3) c = scale(c, 1.06);
      if (y === 3 || y === 12) c = hex('#b9a86f');
      if (y >= 13) c = scale(c, 0.94 + (y - 13) * 0.02);
      t.set(x, y, c);
    }
  }
  for (let k = 0; k < 8; k++) {
    const y = 5 + rng.int(6);
    const x = rng.int(16);
    const len = 2 + rng.int(4);
    for (let i = 0; i < len; i++) t.set(x + i, y, hex('#c7b67b'));
  }
}

function sandstoneTop(t: Tile, rng: Rng, bottom: boolean): void {
  dithered(t, rng, ['#d6c98f', '#dbce96', '#dfd39d', '#e3d8a4'].map(hex), 4, 0.6);
  if (bottom) {
    for (let k = 0; k < 10; k++) t.set(rng.int(16), rng.int(16), hex('#bcab72'));
  }
}

function snow(t: Tile, rng: Rng): void {
  dithered(t, rng, ['#e3ecf1', '#ebf2f6', '#f2f7f9', '#f8fbfc'].map(hex), 8, 0.4);
  for (let k = 0; k < 6; k++) t.set(rng.int(16), rng.int(16), hex('#d6e2ea'));
}

function snowySide(t: Tile, rng: Rng): void {
  fringed(t, rng, ['#e6eef3', '#eef4f7', '#f5f9fb', '#dde8ef'].map(hex), false);
}

function ice(t: Tile, rng: Rng): void {
  const pal = ['#8db3f2', '#97baf4', '#a1c2f6', '#abc9f7'].map(hex);
  const n = blob(rng, 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) t.set(x, y, pick(pal, n[y * 16 + x]! * 0.8 + rng.next() * 0.2), 190);
  }
  // A few long diagonal cracks catching the light.
  for (let k = 0; k < 3; k++) {
    let x = rng.int(16);
    let y = rng.int(16);
    const len = 4 + rng.int(6);
    for (let i = 0; i < len; i++) {
      t.set(x, y, hex('#dbe9ff'), 220);
      x++;
      if (rng.chance(0.6)) y--;
    }
  }
}

function cactusSide(t: Tile, rng: Rng): void {
  const ribs = ['#2d6e2b', '#3b8436', '#4b9a41', '#3b8436'].map(hex);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c = ribs[x % 4]!;
      c = scale(c, 0.94 + rng.next() * 0.1);
      if (x === 0 || x === 15) c = hex('#24561f');
      t.set(x, y, c);
    }
  }
  // Pale spines along the ribs.
  for (let y = 1; y < 16; y += 3) {
    for (let x = 2 + ((y >> 1) & 1) * 2; x < 15; x += 4) {
      t.set(x, y, hex('#e6e1a8'));
      t.set(x, y + 1, hex('#a9a36a'));
    }
  }
}

function cactusTop(t: Tile, rng: Rng, bottom: boolean): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      let c = hex(d > 6 ? '#2d6e2b' : d > 4 ? '#3b8436' : d > 2 ? '#4b9a41' : '#5aa84c');
      if (bottom) c = scale(c, 0.8);
      t.set(x, y, scale(c, 0.95 + rng.next() * 0.08));
    }
  }
  if (!bottom) {
    for (const [x, y] of [[4, 4], [11, 4], [4, 11], [11, 11], [7, 2], [2, 8], [13, 7], [8, 13]] as const) {
      t.set(x, y, hex('#e6e1a8'));
    }
  }
}

function deadBush(t: Tile, rng: Rng): void {
  t.clear();
  const twig = ['#7a5a2f', '#8b6737', '#6a4d27'].map(hex);
  const branch = (x: number, y: number, dx: number, len: number, depth: number): void => {
    for (let i = 0; i < len; i++) {
      t.set(Math.round(x), y, pick(twig, rng.next()));
      y--;
      x += dx * (rng.chance(0.6) ? 1 : 0);
      if (depth > 0 && i > 1 && rng.chance(0.3)) branch(x, y, -dx || (rng.chance(0.5) ? 1 : -1), len - i - 1, depth - 1);
      if (y < 1 || x < 0 || x > 15) return;
    }
  };
  branch(7, 15, -1, 9, 2);
  branch(8, 15, 1, 10, 2);
  branch(7, 14, 0, 6, 1);
}

function tallGrass(t: Tile, rng: Rng): void {
  t.clear();
  for (let k = 0; k < 11; k++) {
    let x = 1 + rng.int(14);
    const h = 5 + rng.int(9);
    const lean = rng.chance(0.5) ? 1 : -1;
    const v = 0.6 + rng.next() * 0.4;
    for (let i = 0; i < h; i++) {
      t.set(x, 15 - i, grey(v * (1 - i * 0.012)));
      if (i > 3 && rng.chance(0.18)) x += lean;
      if (x < 0 || x > 15) break;
    }
  }
}

function clay(t: Tile, rng: Rng): void {
  dithered(t, rng, ['#9aa0ad', '#a0a6b2', '#a6acb8', '#adb3be'].map(hex), 4, 0.7);
  for (let k = 0; k < 5; k++) t.set(rng.int(16), rng.int(16), hex('#8c929f'));
}

function craftingTop(t: Tile, rng: Rng): void {
  planks(t, rng, ['#b08c58', '#a3824f', '#b8955e', '#ab8854']);
  const line = hex('#5a4329');
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, line);
    t.set(i, 15, line);
    t.set(0, i, line);
    t.set(15, i, line);
    // A 3×3 grid scored into the top.
    t.set(5, i, scale(line, 1.2));
    t.set(10, i, scale(line, 1.2));
    t.set(i, 5, scale(line, 1.2));
    t.set(i, 10, scale(line, 1.2));
  }
}

function craftingSide(t: Tile, rng: Rng, front: boolean): void {
  planks(t, rng);
  const dark = hex('#4a3620');
  for (let x = 0; x < 16; x++) {
    t.set(x, 0, hex('#8a6a40'));
    t.set(x, 1, hex('#b08c58'));
    t.set(x, 2, dark);
  }
  if (front) {
    // A saw and a hammer hanging on the front.
    for (let i = 0; i < 7; i++) {
      t.set(3 + i, 5 + (i >> 1), hex('#c8c8c8'));
      t.set(3 + i, 6 + (i >> 1), hex('#9a9a9a'));
    }
    for (let y = 5; y < 13; y++) t.set(12, y, hex('#6d5334'));
    t.set(11, 5, hex('#8d8d8d'));
    t.set(12, 5, hex('#8d8d8d'));
    t.set(13, 5, hex('#8d8d8d'));
    t.set(11, 6, hex('#6d6d6d'));
    t.set(13, 6, hex('#6d6d6d'));
  } else {
    // Hanging tools silhouette.
    for (let y = 5; y < 12; y++) t.set(4, y, hex('#6d5334'));
    for (let x = 2; x < 7; x++) t.set(x, 5, hex('#8d8d8d'));
    for (let y = 6; y < 13; y++) t.set(11, y, hex('#6d5334'));
    for (let y = 4; y < 7; y++) t.set(10, y, hex('#8d8d8d'));
  }
}

function furnaceSide(t: Tile, rng: Rng, top: boolean): void {
  cobble(t, rng, hex('#7a7a7a'));
  if (top) {
    for (let i = 0; i < 16; i++) {
      t.set(i, 0, hex('#5a5a5a'));
      t.set(0, i, hex('#5a5a5a'));
      t.set(i, 15, hex('#4a4a4a'));
      t.set(15, i, hex('#4a4a4a'));
    }
  }
}

function furnaceFront(t: Tile, rng: Rng, lit: boolean): void {
  furnaceSide(t, rng, false);
  // Mouth.
  for (let y = 8; y < 14; y++) {
    for (let x = 3; x < 13; x++) {
      const edge = y === 8 || x === 3 || x === 12;
      let c = edge ? hex('#3a3a3a') : hex('#161616');
      if (lit && !edge) {
        const heat = (y - 8) / 6 + rng.next() * 0.3;
        c = heat > 0.9 ? hex('#ffd24a') : heat > 0.6 ? hex('#ff8a1c') : heat > 0.4 ? hex('#c8400e') : hex('#301008');
      }
      t.set(x, y, c);
    }
  }
  // Vent slot above the mouth.
  for (let x = 4; x < 12; x++) t.set(x, 4, lit ? hex('#6a2a10') : hex('#262626'));
}

function chest(t: Tile, rng: Rng, part: 'front' | 'side' | 'top'): void {
  planks(t, rng, ['#9c6a2c', '#a47233', '#946427', '#ab7938'], '#5a3a14');
  const rim = hex('#4a2e10');
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, rim);
    t.set(i, 15, rim);
    t.set(0, i, rim);
    t.set(15, i, rim);
    if (part !== 'top') t.set(i, 5, rim);
  }
  if (part === 'front') {
    for (let y = 4; y < 8; y++) for (let x = 7; x < 9; x++) t.set(x, y, hex('#c8c8c8'));
    t.set(7, 7, hex('#8a8a8a'));
    t.set(8, 7, hex('#8a8a8a'));
  }
}

/** Crack overlay stage `n` (0–9): dark lines on transparent. */
function crack(t: Tile, n: number): void {
  t.clear();
  const rng = new Rng(0xc4ac + 1);
  // The same branching lines every stage; later stages draw more of them.
  const segments: Array<[number, number]> = [];
  for (let k = 0; k < 6; k++) {
    let x = 8 + rng.int(3) - 1;
    let y = 8 + rng.int(3) - 1;
    const dx = rng.int(3) - 1;
    const dy = rng.int(3) - 1 || 1;
    for (let i = 0; i < 12; i++) {
      segments.push([x, y]);
      x += rng.chance(0.6) ? dx || (rng.chance(0.5) ? 1 : -1) : 0;
      y += rng.chance(0.6) ? dy : 0;
    }
  }
  const show = Math.round(((n + 1) / 10) * segments.length);
  for (let i = 0; i < show; i++) {
    const [x, y] = segments[i]!;
    t.set(x, y, [20, 20, 20], 200);
  }
}

function glass(t: Tile): void {
  t.clear();
  const frame = hex('#d6e8ee');
  const corner = hex('#a9c3cc');
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, frame);
    t.set(i, 15, frame);
    t.set(0, i, frame);
    t.set(15, i, frame);
  }
  for (const [x, y] of [
    [0, 0],
    [15, 0],
    [0, 15],
    [15, 15],
  ] as const)
    t.set(x, y, corner);
  const glint = hex('#f3fbff');
  for (const [x, y] of [
    [3, 5],
    [4, 4],
    [5, 3],
    [4, 6],
    [11, 10],
    [12, 9],
    [10, 11],
  ] as const)
    t.set(x, y, glint);
}

function bedrock(t: Tile, rng: Rng): void {
  dithered(t, rng, P.bedrock, 4, 0.5);
}

function water(t: Tile, rng: Rng): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const wave = Math.sin(((x + 3 * Math.sin((y * Math.PI) / 8)) * Math.PI) / 4) * 0.5 + 0.5;
      t.set(x, y, pick(P.water, wave * 0.6 + rng.next() * 0.4), 176);
    }
  }
}

function lava(t: Tile, rng: Rng): void {
  const n = blob(rng, 4);
  const m = blob(rng, 8);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      t.set(x, y, pick(P.lava, n[y * 16 + x]! * 0.55 + m[y * 16 + x]! * 0.3 + rng.next() * 0.15));
    }
  }
}

function ore(t: Tile, rng: Rng, colors: readonly RGB[], clusters: number): void {
  stone(t, rng);
  for (let k = 0; k < clusters; k++) {
    const cx = 1 + rng.int(14);
    const cy = 1 + rng.int(14);
    const size = 3 + rng.int(3);
    let x = cx;
    let y = cy;
    for (let i = 0; i < size; i++) {
      t.set(x, y, colors[i === 0 ? 1 : 0]!);
      t.set(x + 1, y + 1, scale(colors[0]!, 0.7));
      if (rng.chance(0.5)) x += rng.chance(0.5) ? 1 : -1;
      else y += rng.chance(0.5) ? 1 : -1;
    }
  }
}

function metal(t: Tile, rng: Rng, base: RGB, edge: RGB, part: 'top' | 'side' | 'bottom'): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c = scale(base, 0.97 + rng.next() * 0.05);
      if (x === 0 || y === 0 || x === 15 || y === 15) c = edge;
      else if (x === 1 || y === 1) c = scale(base, 1.1);
      else if (x === 14 || y === 14) c = scale(base, 0.88);
      if (part === 'side' && (y === 7 || y === 8) && x > 0 && x < 15) c = y === 7 ? scale(base, 0.86) : scale(base, 1.08);
      if (part === 'bottom') c = scale(c, 0.8);
      t.set(x, y, c);
    }
  }
  if (part !== 'bottom') {
    for (const [x, y] of [
      [3, 3],
      [12, 3],
      [3, 12],
      [12, 12],
    ] as const) {
      t.set(x, y, scale(base, 0.75));
      t.set(x - 1, y - 1, scale(base, 1.15));
    }
  }
}

function bricks(t: Tile, rng: Rng): void {
  const mortar = hex('#b5aca2');
  const pal = ['#93432f', '#9f4b35', '#8a3d2a', '#a8543f'].map(hex);
  for (let row = 0; row < 4; row++) {
    const off = row % 2 === 0 ? 0 : 4;
    for (let b = 0; b < 3; b++) {
      const c = pal[rng.int(pal.length)]!;
      for (let y = row * 4; y < row * 4 + 3; y++) {
        for (let i = 0; i < 8; i++) {
          const x = off + b * 8 + i;
          t.set(x, y, i === 7 ? mortar : scale(c, 0.92 + rng.next() * 0.14));
        }
      }
    }
    for (let x = 0; x < 16; x++) t.set(x, row * 4 + 3, scale(mortar, 0.95 + rng.next() * 0.06));
  }
}

function obsidian(t: Tile, rng: Rng): void {
  dithered(t, rng, P.obsidian, 4, 0.4);
  for (let k = 0; k < 4; k++) {
    const x = rng.int(16);
    const y = rng.int(16);
    t.set(x, y, hex('#5a4585'));
    t.set(x + 1, y, hex('#3f2f63'));
  }
}

function sponge(t: Tile, rng: Rng): void {
  const pal = ['#c9c046', '#d2c94f', '#d9d159', '#cdc44a'].map(hex);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, pick(pal, rng.next()));
  for (let k = 0; k < 16; k++) {
    const x = rng.int(16);
    const y = rng.int(16);
    const big = rng.chance(0.35);
    t.set(x, y, hex('#958c2c'));
    if (big) {
      t.set(x + 1, y, hex('#958c2c'));
      t.set(x, y + 1, hex('#a39a33'));
      t.set(x + 1, y + 1, hex('#a39a33'));
    }
    t.set(x - 1, y - 1, hex('#e3dc70'));
  }
}

function bookshelf(t: Tile, rng: Rng): void {
  planks(t, rng);
  const spines = ['#8b2d2d', '#2d4f8b', '#2d7a3a', '#8b7a2d', '#6a2d8b', '#b5651d', '#3a7d7d', '#7a3a2d'].map(hex);
  const gap = hex('#3a2a18');
  for (const top of [2, 9]) {
    let x = 1;
    while (x < 15) {
      const w = Math.min(15 - x, 1 + rng.int(3));
      const c = spines[rng.int(spines.length)]!;
      const h = 5 - rng.int(2);
      for (let i = 0; i < w; i++) {
        for (let y = top; y < top + 5; y++) {
          const bookY = y >= top + 5 - h;
          t.set(x + i, y, bookY ? (i === 0 ? scale(c, 1.2) : c) : gap);
        }
        if (h === 5) t.set(x + i, top + 1, scale(c, 0.7));
      }
      x += w;
      if (rng.chance(0.2) && x < 15) {
        for (let y = top; y < top + 5; y++) t.set(x, y, gap);
        x++;
      }
    }
    for (let y = top; y < top + 5; y++) {
      t.set(0, y, hex('#6a5031'));
      t.set(15, y, hex('#6a5031'));
    }
  }
}

const GLYPHS: Record<string, readonly string[]> = {
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
};

function tntSide(t: Tile, rng: Rng): void {
  const red = ['#c4352a', '#b52f25', '#cf3d31'].map(hex);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c = pick(red, rng.next());
      if (x % 4 === 3) c = scale(c, 0.72);
      t.set(x, y, c);
    }
  }
  const band = hex('#e6e0d2');
  for (let y = 4; y < 12; y++) for (let x = 0; x < 16; x++) t.set(x, y, scale(band, 0.96 + rng.next() * 0.05));
  let x = 2;
  for (const ch of 'TNT') {
    const g = GLYPHS[ch]!;
    for (let gy = 0; gy < g.length; gy++) {
      const row = g[gy]!;
      for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') t.set(x + gx, 5 + gy + 1, hex('#2a2a2a'));
    }
    x += g[0]!.length + 1;
  }
}

function tntTop(t: Tile, rng: Rng, bottom: boolean): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, scale(hex('#b8352b'), 0.94 + rng.next() * 0.08));
  for (const [cx, cy] of [
    [4, 4],
    [11, 4],
    [4, 11],
    [11, 11],
  ] as const) {
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        const d = Math.hypot(x, y);
        if (d > 3.4) continue;
        const rim = d > 2.3;
        t.set(cx + x, cy + y, rim ? hex('#d24a3c') : bottom ? hex('#a02c23') : hex('#c83f33'));
      }
    }
  }
  if (!bottom) {
    t.set(7, 7, hex('#3a3a3a'));
    t.set(8, 8, hex('#3a3a3a'));
    t.set(8, 7, hex('#5a5a5a'));
    t.set(7, 8, hex('#5a5a5a'));
  }
}

function slabSide(t: Tile, rng: Rng): void {
  const base = hex('#a9a9a9');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ly = y % 8;
      let c = scale(base, 0.97 + rng.next() * 0.05);
      if (ly === 0) c = scale(base, 1.1);
      if (ly === 7) c = hex('#7c7c7c');
      if (x === 0) c = scale(c, 1.05);
      if (x === 15) c = scale(c, 0.9);
      t.set(x, y, c);
    }
  }
}

function slabTop(t: Tile, rng: Rng): void {
  const base = hex('#b0b0b0');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c = scale(base, 0.97 + rng.next() * 0.05);
      if (x === 0 || y === 0) c = scale(base, 1.1);
      if (x === 15 || y === 15) c = hex('#848484');
      t.set(x, y, c);
    }
  }
}

function stem(t: Tile, from: number, to: number): void {
  const green = hex('#3b8a28');
  for (let y = from; y <= to; y++) t.set(7, y, y % 3 === 0 ? scale(green, 0.85) : green);
  t.set(6, 12, green);
  t.set(5, 11, scale(green, 1.1));
  t.set(8, 13, green);
  t.set(9, 12, scale(green, 1.1));
}

function dandelion(t: Tile): void {
  t.clear();
  stem(t, 8, 15);
  const petals = hex('#f4d82a');
  const light = hex('#fff06a');
  for (const [x, y] of [
    [6, 5],
    [7, 5],
    [8, 5],
    [6, 6],
    [8, 6],
    [6, 7],
    [7, 7],
    [8, 7],
    [7, 4],
    [5, 6],
    [9, 6],
  ] as const)
    t.set(x, y, petals);
  t.set(7, 6, hex('#d49a12'));
  t.set(6, 5, light);
  t.set(8, 7, scale(petals, 0.85));
}

function rose(t: Tile): void {
  t.clear();
  stem(t, 8, 15);
  const red = hex('#d1172f');
  const dark = hex('#8e0c1f');
  const light = hex('#ee4a5a');
  for (let y = 3; y <= 7; y++) {
    for (let x = 5; x <= 9; x++) {
      const d = Math.hypot(x - 7, y - 5);
      if (d > 2.4) continue;
      t.set(x, y, (x + y) % 3 === 0 ? dark : red);
    }
  }
  t.set(6, 4, light);
  t.set(7, 3, light);
  t.set(8, 5, dark);
}

function mushroom(t: Tile, red: boolean): void {
  t.clear();
  const stemC = red ? hex('#e8dcc0') : hex('#d8caa9');
  for (let y = 10; y <= 15; y++) {
    t.set(7, y, stemC);
    t.set(8, y, scale(stemC, 0.86));
  }
  if (red) {
    const cap = hex('#cf2a2a');
    for (let y = 5; y <= 9; y++) {
      const half = y === 5 ? 2 : y === 6 ? 3 : 4;
      for (let x = 8 - half; x < 8 + half; x++) t.set(x, y, y === 9 ? scale(cap, 0.75) : cap);
    }
    for (const [x, y] of [
      [6, 6],
      [9, 7],
      [5, 8],
      [8, 5],
      [10, 8],
    ] as const)
      t.set(x, y, hex('#f4efe6'));
  } else {
    const cap = hex('#9c6b43');
    for (let y = 7; y <= 10; y++) {
      const half = y === 7 ? 3 : y === 8 ? 5 : 6;
      for (let x = 8 - half; x < 8 + half; x++) t.set(x, y, y === 10 ? scale(cap, 0.72) : scale(cap, y === 7 ? 1.12 : 1));
    }
  }
}

function sapling(t: Tile, rng: Rng): void {
  t.clear();
  const bark = hex('#6b4f2a');
  for (let y = 9; y <= 15; y++) t.set(7, y, bark);
  t.set(8, 12, bark);
  const greens = ['#2f7020', '#3d8a2a', '#4f9f36', '#63b045'].map(hex);
  for (let y = 1; y <= 11; y++) {
    for (let x = 2; x <= 13; x++) {
      const d = Math.hypot((x - 7.5) * 0.9, (y - 6) * 1.1);
      if (d < 5 && rng.next() > 0.3 + d * 0.06) t.set(x, y, pick(greens, rng.next()));
    }
  }
}

function torch(t: Tile): void {
  t.clear();
  const wood = hex('#7a5a33');
  const dark = hex('#5a4124');
  for (let y = 8; y <= 15; y++) {
    t.set(7, y, y % 3 === 0 ? dark : wood);
    t.set(8, y, dark);
  }
  // Glowing tip.
  t.set(7, 6, hex('#fff7c2'));
  t.set(8, 6, hex('#ffd24a'));
  t.set(7, 7, hex('#ffb12e'));
  t.set(8, 7, hex('#ff8a1c'));
}

function wool(t: Tile, rng: Rng, color: RGB): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let f = 1 + ((x + y) % 2 === 0 ? 0.035 : -0.035) + (rng.next() - 0.5) * 0.07;
      if (y % 4 === 0) f -= 0.05;
      if ((x + (y >> 2)) % 4 === 0 && y % 2 === 1) f -= 0.04;
      t.set(x, y, scale(color, f));
    }
  }
}

/** Paint one tile to a fresh 16×16 RGBA buffer. */
export function paintTile(id: number): Uint8ClampedArray<ArrayBuffer> {
  const t = new Tile();
  const rng = new Rng(0xb10c7 + id * 7919);
  switch (id) {
    case T.STONE: stone(t, rng); break;
    case T.GRASS_TOP: grassTop(t, rng); break;
    case T.GRASS_SIDE: grassSide(t, rng); break;
    case T.DIRT: dirt(t, rng); break;
    case T.COBBLE: cobble(t, rng); break;
    case T.PLANKS: planks(t, rng); break;
    case T.LOG_SIDE: logSide(t, rng); break;
    case T.LOG_TOP: logTop(t, rng); break;
    case T.LEAVES: leaves(t, rng); break;
    case T.GLASS: glass(t); break;
    case T.SAND: sand(t, rng); break;
    case T.GRAVEL: gravel(t, rng); break;
    case T.BEDROCK: bedrock(t, rng); break;
    case T.WATER: water(t, rng); break;
    case T.LAVA: lava(t, rng); break;
    case T.COAL_ORE: ore(t, rng, [hex('#262626'), hex('#3e3e3e')], 5); break;
    case T.IRON_ORE: ore(t, rng, [hex('#c79c80'), hex('#e4c1a8')], 4); break;
    case T.GOLD_ORE: ore(t, rng, [hex('#e9c92c'), hex('#fff27a')], 4); break;
    case T.IRON_TOP: metal(t, rng, hex('#d8d8d8'), hex('#9d9d9d'), 'top'); break;
    case T.IRON_SIDE: metal(t, rng, hex('#d0d0d0'), hex('#9d9d9d'), 'side'); break;
    case T.IRON_BOTTOM: metal(t, rng, hex('#c8c8c8'), hex('#8d8d8d'), 'bottom'); break;
    case T.GOLD_TOP: metal(t, rng, hex('#f4d43c'), hex('#b8891a'), 'top'); break;
    case T.GOLD_SIDE: metal(t, rng, hex('#ecc932'), hex('#b8891a'), 'side'); break;
    case T.GOLD_BOTTOM: metal(t, rng, hex('#e2bd2c'), hex('#a57a14'), 'bottom'); break;
    case T.BRICKS: bricks(t, rng); break;
    case T.MOSSY: mossy(t, rng); break;
    case T.OBSIDIAN: obsidian(t, rng); break;
    case T.SPONGE: sponge(t, rng); break;
    case T.BOOKSHELF: bookshelf(t, rng); break;
    case T.TNT_SIDE: tntSide(t, rng); break;
    case T.TNT_TOP: tntTop(t, rng, false); break;
    case T.TNT_BOTTOM: tntTop(t, rng, true); break;
    case T.SLAB_SIDE: slabSide(t, rng); break;
    case T.SLAB_TOP: slabTop(t, rng); break;
    case T.DANDELION: dandelion(t); break;
    case T.ROSE: rose(t); break;
    case T.RED_MUSHROOM: mushroom(t, true); break;
    case T.BROWN_MUSHROOM: mushroom(t, false); break;
    case T.SAPLING: sapling(t, rng); break;
    case T.TORCH: torch(t); break;
    case T.SANDSTONE_TOP: sandstoneTop(t, rng, false); break;
    case T.SANDSTONE_SIDE: sandstoneSide(t, rng); break;
    case T.SANDSTONE_BOTTOM: sandstoneTop(t, rng, true); break;
    case T.SNOW: snow(t, rng); break;
    case T.ICE: ice(t, rng); break;
    case T.CACTUS_SIDE: cactusSide(t, rng); break;
    case T.CACTUS_TOP: cactusTop(t, rng, false); break;
    case T.CACTUS_BOTTOM: cactusTop(t, rng, true); break;
    case T.DEAD_BUSH: deadBush(t, rng); break;
    case T.TALL_GRASS: tallGrass(t, rng); break;
    case T.CLAY: clay(t, rng); break;
    case T.SPRUCE_LOG: logSide(t, rng, ['#3b2a18', '#43301c', '#4b3620', '#523b23'], '#2b1e10'); break;
    case T.SPRUCE_LOG_TOP: logTop(t, rng, ['#8a6a40', '#6f5230'], ['#3b2a18', '#4b3620']); break;
    case T.SPRUCE_LEAVES: spruceLeaves(t, rng); break;
    case T.SPRUCE_PLANKS: planks(t, rng, ['#6f5233', '#77583a', '#6a4e30', '#7d5e3d'], '#43301c'); break;
    case T.BIRCH_LOG: birchSide(t, rng); break;
    case T.BIRCH_LOG_TOP: logTop(t, rng, ['#d2bd84', '#bda46c'], ['#e4e1d6', '#cfccc0']); break;
    case T.BIRCH_LEAVES: leaves(t, rng, 0.26); break;
    case T.BIRCH_PLANKS: planks(t, rng, ['#c9b47b', '#cfba81', '#c2ad73', '#d4bf87'], '#8f7b4c'); break;
    case T.DIAMOND_ORE: ore(t, rng, [hex('#4fd8de'), hex('#b9fbff')], 4); break;
    case T.DIAMOND_BLOCK: metal(t, rng, hex('#6fe0dc'), hex('#2e9f9b'), 'top'); break;
    case T.GRASS_SIDE_SNOW: snowySide(t, rng); break;
    case T.CRAFTING_TOP: craftingTop(t, rng); break;
    case T.CRAFTING_SIDE: craftingSide(t, rng, false); break;
    case T.CRAFTING_FRONT: craftingSide(t, rng, true); break;
    case T.FURNACE_FRONT: furnaceFront(t, rng, false); break;
    case T.FURNACE_FRONT_LIT: furnaceFront(t, rng, true); break;
    case T.FURNACE_SIDE: furnaceSide(t, rng, false); break;
    case T.FURNACE_TOP: furnaceSide(t, rng, true); break;
    case T.CHEST_FRONT: chest(t, rng, 'front'); break;
    case T.CHEST_SIDE: chest(t, rng, 'side'); break;
    case T.CHEST_TOP: chest(t, rng, 'top'); break;
    default:
      if (id >= T.WOOL_FIRST && id < T.WOOL_FIRST + 16) wool(t, rng, WOOL_COLORS[id - T.WOOL_FIRST]!);
      else if (id >= T.CRACK_FIRST && id < T.CRACK_FIRST + CRACK_STAGES) crack(t, id - T.CRACK_FIRST);
      else t.fill([255, 0, 255]);
  }
  return t.data;
}

/** Paint every tile. Index = tile id. */
export function paintAllTiles(): Array<Uint8ClampedArray<ArrayBuffer>> {
  return Array.from({ length: TILE_COUNT }, (_, id) => paintTile(id));
}

/** Default colour for tiles that are grey and tinted in the world. */
export const TILE_TINTS: ReadonlyMap<number, number> = new Map([
  [T.GRASS_TOP, DEFAULT_GRASS_TINT],
  [T.GRASS_SIDE, DEFAULT_GRASS_TINT],
  [T.TALL_GRASS, DEFAULT_GRASS_TINT],
  [T.LEAVES, DEFAULT_FOLIAGE_TINT],
  [T.WATER, DEFAULT_WATER_TINT],
  [T.SPRUCE_LEAVES, 0x5f8f5f],
  [T.BIRCH_LEAVES, 0x80a755],
]);

/**
 * A tile as it looks with its default tint applied (icons, the Classic edge
 * ocean). Opaque tint-masked pixels get their alpha back.
 */
export function displayTile(id: number, rgba: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer> {
  const tint = TILE_TINTS.get(id);
  if (tint === undefined) return rgba;
  const out = new Uint8ClampedArray(rgba);
  const r = (tint >> 16) & 255;
  const g = (tint >> 8) & 255;
  const b = tint & 255;
  // Masked opaque tiles tint only the masked pixels; cutout / translucent ones tint everything.
  const masked = id === T.GRASS_TOP || id === T.GRASS_SIDE;
  for (let i = 0; i < out.length; i += 4) {
    if (masked && out[i + 3] !== TINT_MASK_ALPHA) continue;
    out[i] = (out[i]! * r) / 255;
    out[i + 1] = (out[i + 1]! * g) / 255;
    out[i + 2] = (out[i + 2]! * b) / 255;
    if (masked) out[i + 3] = 255;
  }
  return out;
}

/** Tileable cloud mask (white, alpha where cloudy), `size`×`size` RGBA. */
export function paintClouds(size: number, seed: number): Uint8ClampedArray<ArrayBuffer> {
  const rng = new Rng(seed);
  const cells = 8;
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
  const fine = new Float32Array(32 * 32);
  for (let i = 0; i < fine.length; i++) fine[i] = rng.next();
  const out = new Uint8ClampedArray(size * size * 4);
  const sample = (lat: Float32Array, n: number, x: number, y: number): number => {
    const gx = (x / size) * n;
    const gy = (y / size) * n;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const at = (cx: number, cy: number): number => lat[(cy % n) * n + (cx % n)]!;
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = sample(lattice, cells, x, y) * 0.75 + sample(fine, 32, x, y) * 0.25;
      const i = (y * size + x) * 4;
      out[i] = 255;
      out[i + 1] = 255;
      out[i + 2] = 255;
      out[i + 3] = v > 0.56 ? 215 : 0;
    }
  }
  return out;
}

/** 16×16 sun: a bright square with a soft rim (drawn additively). */
export function paintSun(): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      const i = (y * 16 + x) * 4;
      const core = d < 4.5;
      const glow = Math.max(0, 1 - (d - 4) / 4);
      out[i] = 255;
      out[i + 1] = core ? 246 : 214;
      out[i + 2] = core ? 196 : 120;
      out[i + 3] = core ? 255 : Math.round(glow * glow * 150);
    }
  }
  return out;
}

/** 16×16 moon: a pale square with a few craters. */
export function paintMoon(): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(16 * 16 * 4);
  const craters = new Set(['6,5', '7,5', '6,6', '10,9', '9,10', '10,10', '5,10', '11,5']);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      if (x < 3 || x > 12 || y < 3 || y > 12) continue;
      const c = craters.has(`${x},${y}`) ? 170 : 222 - ((x + y) % 3) * 6;
      out[i] = c;
      out[i + 1] = c;
      out[i + 2] = c + 12;
      out[i + 3] = 255;
    }
  }
  return out;
}
