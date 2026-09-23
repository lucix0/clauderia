/**
 * Procedural mob skins: 16×16 tiles painted into a 16-column atlas, one tile
 * per distinct surface (hide, face, legs…). Pure pixel painting.
 */
import { Rng } from '../util/prng';

type RGB = readonly [number, number, number];

function hex(s: string): RGB {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mul(c: RGB, f: number): RGB {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

class Tile {
  readonly data = new Uint8ClampedArray(16 * 16 * 4);
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    const i = (y * 16 + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  /** Noisy fill from a base colour. */
  fill(rng: Rng, base: RGB, noise = 0.12): void {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) this.set(x, y, mul(base, 1 - noise / 2 + rng.next() * noise));
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
}

/** Tile names in atlas order. */
export const MOB_TILES = [
  // Pig: pink-tan with brown spots and a bristly ridge.
  'pig.hide', 'pig.back', 'pig.belly', 'pig.face', 'pig.snout', 'pig.ear', 'pig.leg', 'pig.hoof',
  // Cow: dun, shaggy, cream muzzle, pale horns.
  'cow.hide', 'cow.back', 'cow.face', 'cow.horn', 'cow.leg', 'cow.hoof',
  // Sheep: off-white fleece, dark face and legs.
  'sheep.wool', 'sheep.face', 'sheep.head', 'sheep.leg',
  // Zombie: grey-green skin, rag tunic, patched trousers.
  'zombie.face', 'zombie.skin', 'zombie.tunic', 'zombie.tunicFront', 'zombie.trousers', 'zombie.arm',
  // Skeleton: bone, skull, ribs, bow.
  'skeleton.skull', 'skeleton.bone', 'skeleton.ribs', 'skeleton.bow',
  // Spider: dark hairy body, eyes, chevron abdomen, legs.
  'spider.head', 'spider.body', 'spider.abdomen', 'spider.leg',
  'arrow',
] as const;

export type MobTile = (typeof MOB_TILES)[number];

export function mobTile(name: MobTile): number {
  return MOB_TILES.indexOf(name);
}

export const MOB_ATLAS_COLUMNS = 16;

function paint(name: MobTile, t: Tile, rng: Rng): void {
  const pig = hex('#e7a891');
  const cow = hex('#9a6a3e');
  const wool = hex('#e9e4d6');
  const sheepFace = hex('#3d3530');
  const zskin = hex('#7d9468');
  const bone = hex('#ddd8c6');
  const spider = hex('#2c2420');
  switch (name) {
    case 'pig.hide':
    case 'pig.back':
    case 'pig.belly': {
      t.fill(rng, name === 'pig.belly' ? mul(pig, 1.08) : pig);
      if (name !== 'pig.belly') {
        for (let k = 0; k < 3; k++) {
          const cx = 2 + rng.int(12);
          const cy = 2 + rng.int(12);
          const r = 1.5 + rng.next() * 2;
          for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= r * r) t.set(cx + x, cy + y, mul(hex('#8a5a3a'), 0.9 + rng.next() * 0.2));
        }
      }
      if (name === 'pig.back') for (let y = 0; y < 16; y++) for (const x of [7, 8]) t.set(x, y, mul(hex('#b87a62'), 0.9 + rng.next() * 0.2));
      break;
    }
    case 'pig.face':
      t.fill(rng, pig);
      t.rect(3, 5, 2, 2, hex('#1a1210'));
      t.rect(11, 5, 2, 2, hex('#1a1210'));
      t.set(3, 5, hex('#ffffff'));
      t.set(11, 5, hex('#ffffff'));
      break;
    case 'pig.snout':
      t.fill(rng, hex('#d98a78'));
      t.rect(4, 6, 3, 4, hex('#5a2a22'));
      t.rect(9, 6, 3, 4, hex('#5a2a22'));
      break;
    case 'pig.ear':
      t.fill(rng, mul(pig, 0.9));
      break;
    case 'pig.leg':
    case 'cow.leg':
      t.fill(rng, name === 'pig.leg' ? mul(pig, 0.92) : mul(cow, 0.8));
      t.rect(0, 12, 16, 4, hex('#3a2a20'));
      break;
    case 'pig.hoof':
    case 'cow.hoof':
      t.fill(rng, hex('#3a2a20'));
      break;
    case 'cow.hide':
    case 'cow.back':
      t.fill(rng, cow, 0.2);
      // Shaggy streaks.
      for (let k = 0; k < 14; k++) {
        const x = rng.int(16);
        const y = rng.int(16);
        for (let i = 0; i < 3; i++) t.set(x, y + i, mul(cow, name === 'cow.back' ? 0.7 : 1.25));
      }
      break;
    case 'cow.face':
      t.fill(rng, mul(cow, 0.85), 0.15);
      t.rect(3, 10, 10, 6, hex('#e8d6b4'));
      t.rect(5, 12, 2, 2, hex('#3a2418'));
      t.rect(9, 12, 2, 2, hex('#3a2418'));
      t.rect(3, 5, 2, 2, hex('#101010'));
      t.rect(11, 5, 2, 2, hex('#101010'));
      // Shaggy fringe over the eyes.
      for (let x = 0; x < 16; x++) for (let y = 0; y < 3 + (x % 3 === 0 ? 1 : 0); y++) t.set(x, y, mul(cow, 1.2));
      break;
    case 'cow.horn':
      t.fill(rng, hex('#e8e0c8'), 0.1);
      t.rect(0, 12, 16, 4, hex('#7a7060'));
      break;
    case 'sheep.wool':
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const curl = Math.sin(x * 1.3 + y * 0.7) * Math.cos(y * 1.1 - x * 0.4);
          t.set(x, y, mul(wool, 0.86 + curl * 0.08 + rng.next() * 0.08));
        }
      }
      break;
    case 'sheep.face':
      t.fill(rng, sheepFace);
      t.rect(3, 6, 3, 2, hex('#e6e0c0'));
      t.rect(10, 6, 3, 2, hex('#e6e0c0'));
      t.rect(4, 6, 1, 2, hex('#101010'));
      t.rect(11, 6, 1, 2, hex('#101010'));
      t.rect(6, 12, 4, 1, hex('#1a1614'));
      for (let x = 0; x < 16; x++) for (let y = 0; y < 3; y++) t.set(x, y, mul(wool, 0.9 + rng.next() * 0.1));
      break;
    case 'sheep.head':
      t.fill(rng, sheepFace);
      for (let x = 0; x < 16; x++) for (let y = 0; y < 5; y++) t.set(x, y, mul(wool, 0.88 + rng.next() * 0.1));
      break;
    case 'sheep.leg':
      t.fill(rng, sheepFace);
      for (let x = 0; x < 16; x++) for (let y = 0; y < 5; y++) t.set(x, y, mul(wool, 0.88 + rng.next() * 0.1));
      break;
    case 'zombie.face':
      t.fill(rng, zskin, 0.18);
      t.rect(3, 6, 3, 2, hex('#1c1a10'));
      t.rect(10, 6, 3, 2, hex('#1c1a10'));
      t.set(4, 6, hex('#e8d24a'));
      t.set(11, 6, hex('#e8d24a'));
      // Stitched mouth.
      for (let x = 4; x < 12; x++) t.set(x, 11, hex('#3a2a20'));
      for (let x = 4; x < 12; x += 2) {
        t.set(x, 10, hex('#3a2a20'));
        t.set(x, 12, hex('#3a2a20'));
      }
      break;
    case 'zombie.skin':
    case 'zombie.arm':
      t.fill(rng, zskin, 0.2);
      if (name === 'zombie.arm') {
        // Torn sleeve at the top.
        for (let x = 0; x < 16; x++) for (let y = 0; y < 5 + (x % 4 === 0 ? 2 : 0); y++) t.set(x, y, mul(hex('#4a5060'), 0.9 + rng.next() * 0.2));
      }
      break;
    case 'zombie.tunic':
    case 'zombie.tunicFront':
      t.fill(rng, hex('#4a5060'), 0.2);
      if (name === 'zombie.tunicFront') {
        t.rect(9, 3, 4, 4, hex('#6a5a3a'));
        for (let y = 0; y < 16; y += 3) t.set(7, y, hex('#2a2e38'));
      }
      for (let x = 0; x < 16; x++) if (rng.chance(0.4)) t.set(x, 15, [0, 0, 0], 0);
      break;
    case 'zombie.trousers':
      t.fill(rng, hex('#5a4630'), 0.2);
      t.rect(2, 6, 4, 3, hex('#3a5a4a'));
      break;
    case 'skeleton.skull':
      t.fill(rng, bone, 0.1);
      t.rect(3, 5, 3, 3, hex('#141210'));
      t.rect(10, 5, 3, 3, hex('#141210'));
      t.rect(7, 9, 2, 2, hex('#2a2620'));
      for (let x = 4; x < 12; x++) t.set(x, 13, x % 2 ? hex('#2a2620') : bone);
      break;
    case 'skeleton.bone':
      t.fill(rng, bone, 0.1);
      break;
    case 'skeleton.ribs':
      t.fill(rng, hex('#1a1714'), 0.2);
      for (let y = 1; y < 15; y += 3) for (let x = 1; x < 15; x++) t.set(x, y, mul(bone, 0.95 + rng.next() * 0.1));
      for (let y = 0; y < 16; y++) t.set(7, y, bone);
      break;
    case 'skeleton.bow':
      t.fill(rng, hex('#6a4a28'), 0.15);
      break;
    case 'spider.head':
      t.fill(rng, spider, 0.2);
      for (const [x, y] of [[3, 5], [12, 5], [5, 7], [10, 7], [6, 4], [9, 4]] as const) {
        t.rect(x, y, 2, 2, hex('#d8301e'));
        t.set(x, y, hex('#ff8a6a'));
      }
      t.rect(6, 12, 1, 3, hex('#8a7a6a'));
      t.rect(9, 12, 1, 3, hex('#8a7a6a'));
      break;
    case 'spider.body':
    case 'spider.leg':
      t.fill(rng, spider, 0.25);
      for (let k = 0; k < 20; k++) t.set(rng.int(16), rng.int(16), mul(spider, 1.8));
      break;
    case 'spider.abdomen':
      t.fill(rng, spider, 0.25);
      for (let k = 0; k < 20; k++) t.set(rng.int(16), rng.int(16), mul(spider, 1.8));
      // A pale chevron.
      for (let i = 0; i < 6; i++) {
        t.set(7 - i, 4 + i, hex('#c8b890'));
        t.set(8 + i, 4 + i, hex('#c8b890'));
        t.set(7 - i, 7 + i, hex('#a89870'));
        t.set(8 + i, 7 + i, hex('#a89870'));
      }
      break;
    case 'arrow':
      t.fill(rng, hex('#7a5a33'), 0.1);
      t.rect(0, 0, 16, 3, hex('#9a9a9a'));
      t.rect(0, 13, 16, 3, hex('#e0e0e0'));
      break;
  }
}

export function paintMobTile(index: number): Uint8ClampedArray {
  const t = new Tile();
  const name = MOB_TILES[index];
  if (name) paint(name, t, new Rng(0x40b + index * 131));
  return t.data;
}
