/**
 * Procedural 16×16 item sprites (non-block items). Pure: deterministic RGBA
 * buffers, laid out in an item atlas at index `id − ITEM_FIRST`.
 */
import { I, ITEM_FIRST, TIERS, TOOL_FIRST, TOOL_KINDS, type ToolKind } from '../items/items';

export const ITEM_ATLAS_COLUMNS = 16;
/** Sprites in the item atlas (ids ITEM_FIRST … ITEM_FIRST + 63). */
export const ITEM_ATLAS_SLOTS = 64;

type RGB = readonly [number, number, number];

function hex(s: string): RGB {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mul(c: RGB, f: number): RGB {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

class Sprite {
  readonly data = new Uint8ClampedArray(16 * 16 * 4);
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x > 15 || y > 15) return;
    const i = (y * 16 + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  /** Draw pixels from rows of characters mapped through a palette ('.' is empty). */
  draw(rows: readonly string[], pal: Readonly<Record<string, RGB>>, ox = 0, oy = 0): void {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = pal[row[x]!];
        if (c) this.set(ox + x, oy + y, c);
      }
    });
  }
  /** A dark outline around every opaque pixel, for legibility. */
  outline(c: RGB = [30, 22, 16]): void {
    const src = this.data.slice();
    const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < 16 && y < 16 && src[(y * 16 + x) * 4 + 3]! > 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (at(x, y)) continue;
        if (at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1)) this.set(x, y, c, 200);
      }
    }
  }
}

const WOOD: Record<string, RGB> = { a: hex('#8a6a3a'), b: hex('#6a4e28'), c: hex('#a8844a') };

/** Diagonal stick from bottom-left toward the top-right, `len` pixels. */
function stickDiag(s: Sprite, len: number, x0 = 2, y0 = 13): void {
  for (let i = 0; i < len; i++) {
    s.set(x0 + i, y0 - i, WOOD.a!);
    s.set(x0 + i + 1, y0 - i, WOOD.b!);
  }
}

function tierColors(tier: number): { base: RGB; light: RGB; dark: RGB } {
  const base = [hex('#9c7a45'), hex('#8a8a8a'), hex('#d8d8d8'), hex('#f2d23c'), hex('#5de8e0')][tier]!;
  return { base, light: mul(base, 1.25), dark: mul(base, 0.65) };
}

function tool(s: Sprite, kind: ToolKind, tier: number): void {
  const { base, light, dark } = tierColors(tier);
  const pal = { X: base, L: light, D: dark };
  switch (kind) {
    case 'pickaxe':
      stickDiag(s, 10, 3, 14);
      s.draw(['..LXXXXD....', '.LX....XD...', 'LX......XD..', 'X........X..', '.........X..'], pal, 3, 1);
      break;
    case 'axe':
      stickDiag(s, 10, 3, 14);
      s.draw(['...LXX.', '..LXXXD', '.LXXXD.', '.XXXD..', '..XD...'], pal, 7, 1);
      break;
    case 'shovel':
      stickDiag(s, 9, 2, 14);
      s.draw(['..LXX', '.LXXD', 'LXXXD', 'XXXD.', '.DD..'], pal, 9, 1);
      break;
    case 'sword':
      stickDiag(s, 4, 2, 13);
      s.draw(['D..', '.D.', 'D.D'], { D: hex('#4a3620') }, 2, 10);
      for (let i = 0; i < 9; i++) {
        s.set(5 + i, 10 - i, light);
        s.set(6 + i, 10 - i, base);
        s.set(6 + i, 11 - i, dark);
      }
      s.draw(['XXX', '.X.'], { X: hex('#5a4020') }, 3, 9);
      break;
  }
  s.outline();
}

function paint(id: number, s: Sprite): void {
  switch (id) {
    case I.STICK:
      stickDiag(s, 11, 2, 13);
      break;
    case I.COAL:
    case I.CHARCOAL: {
      const c = id === I.COAL ? hex('#2a2a2a') : hex('#3a2a20');
      s.draw(['..XXXX..', '.XXLXXX.', 'XXXXXXLX', 'XLXXXXXX', 'XXXXXLX.', '.XXXXXX.', '..XXX...'], { X: c, L: mul(c, 1.9) }, 4, 4);
      break;
    }
    case I.IRON_INGOT:
    case I.GOLD_INGOT: {
      const c = id === I.IRON_INGOT ? hex('#d0d0d0') : hex('#f0cc30');
      s.draw(['...LLLLLLL.', '..LXXXXXXXD', '.LXXXXXXXD.', 'LXXXXXXXD..', 'DDDDDDDD...'], { X: c, L: mul(c, 1.2), D: mul(c, 0.6) }, 2, 6);
      break;
    }
    case I.DIAMOND:
      s.draw(['..LLLL..', '.LXXXXD.', 'LXXXXXXD', '.DXXXXD.', '..DXXD..', '...DD...'], { X: hex('#5de8e0'), L: hex('#c8fffb'), D: hex('#2a9f9a') }, 4, 5);
      break;
    case I.APPLE:
      s.draw(['....G...', '...B.GG.', '.RRBRR..', 'RRLRRRR.', 'RLRRRRRR', 'RRRRRRRR', 'RRRRRRRD', '.RRRRRD.', '..RDDD..'], { R: hex('#d42a2a'), L: hex('#ff8a8a'), D: hex('#8e1414'), B: hex('#5a3a14'), G: hex('#3f9a2a') }, 4, 3);
      break;
    case I.RAW_PORK:
    case I.COOKED_PORK: {
      const cooked = id === I.COOKED_PORK;
      const m = cooked ? hex('#b5733a') : hex('#f0a0a0');
      s.draw(['..MMMMM...', '.MMLMMMMF.', 'MMMMMMMMFF', 'MLMMMMMMMF', 'MMMMMMMMF.', '.MMMMMMF..', '..FFFF....'], { M: m, L: mul(m, 1.2), F: cooked ? hex('#e8d0a0') : hex('#fff0f0') }, 3, 5);
      break;
    }
    case I.RAW_BEEF:
    case I.COOKED_BEEF: {
      const cooked = id === I.COOKED_BEEF;
      const m = cooked ? hex('#7a4a2a') : hex('#c8342a');
      s.draw(['.MMMMMM..', 'MMFMMMMM.', 'MMMMMFMMM', 'MFMMMMMMM', 'MMMMMMFM.', '.MMMMMMM.', '..MMMM...'], { M: m, F: cooked ? mul(m, 1.4) : hex('#f0e0d0') }, 4, 5);
      break;
    }
    case I.BONE:
      for (let i = 0; i < 8; i++) s.set(4 + i, 11 - i, hex('#eeeadc'));
      s.draw(['XX', 'XX.', '.X'], { X: hex('#eeeadc') }, 2, 11);
      s.draw(['X.', 'XX', '.XX'], { X: hex('#eeeadc') }, 11, 2);
      break;
    case I.BONE_MEAL:
      for (const [x, y] of [[6, 7], [8, 6], [9, 9], [7, 10], [5, 9], [10, 7], [7, 8], [8, 8]] as const) s.set(x, y, hex('#f4f4f0'));
      for (const [x, y] of [[6, 8], [9, 8], [8, 10]] as const) s.set(x, y, hex('#c8c8c0'));
      break;
    case I.STRING:
      for (let i = 0; i < 12; i++) s.set(2 + i, 8 + Math.round(Math.sin(i * 0.9) * 2.5), hex('#f0f0f0'));
      break;
    case I.BUCKET:
    case I.WATER_BUCKET:
    case I.LAVA_BUCKET: {
      s.draw(['..DDDDDDDD..', '.D........D.', 'DXLLLLLLLLXD', 'DXXXXXXXXXXD', '.DXXXXXXXXD.', '.DXXXXXXXXD.', '..DXXXXXXD..', '..DDDDDDDD..'], { X: hex('#c8c8c8'), L: hex('#e8e8e8'), D: hex('#6a6a6a') }, 2, 5);
      if (id !== I.BUCKET) {
        const c = id === I.WATER_BUCKET ? hex('#3b6fe2') : hex('#f07a18');
        for (let x = 3; x < 13; x++) s.set(x, 7, c);
        for (let x = 4; x < 12; x++) s.set(x, 6, mul(c, 1.2));
      }
      break;
    }
    case I.FLINT:
      s.draw(['...LX...', '..LXXD..', '.LXXXXD.', 'LXXLXXXD', 'XXXXXXD.', '.XXXXD..', '..DDD...'], { X: hex('#3c3c40'), L: hex('#7a7a82'), D: hex('#1e1e22') }, 4, 4);
      break;
    case I.ARROW:
      stickDiag(s, 10, 3, 12);
      // Flint head at the top right, a notched tail at the bottom left.
      s.draw(['.LXX', 'LXXX', '.XXD', '.XD.'], { X: hex('#4a4a50'), L: hex('#8a8a92'), D: hex('#26262a') }, 11, 1);
      s.draw(['D.D', '.D.', 'D.D'], { D: hex('#5a4020') }, 1, 12);
      break;
    case I.BOW: {
      // The string runs along the diagonal; the limb bows out toward the top right.
      for (let i = 0; i <= 11; i++) s.set(2 + i, 2 + i, hex('#e8e8e8'));
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const bulge = Math.sin(Math.PI * t) * 3.2;
        const x = Math.round(2 + t * 11 + bulge);
        const y = Math.round(2 + t * 11 - bulge);
        s.set(x, y, WOOD.a!);
        s.set(x + 1, y, WOOD.b!);
      }
      s.draw(['XX', 'XX'], { X: hex('#4a3620') }, 10, 4);
      break;
    }
    default:
      if (id >= TOOL_FIRST && id < TOOL_FIRST + TOOL_KINDS.length * TIERS.length) {
        const k = id - TOOL_FIRST;
        tool(s, TOOL_KINDS[Math.floor(k / TIERS.length)]!, k % TIERS.length);
        return;
      }
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s.set(x, y, [255, 0, 255]);
      return;
  }
  s.outline();
}

/** Paint the sprite of item `id` (≥ ITEM_FIRST). */
export function paintItem(id: number): Uint8ClampedArray {
  const s = new Sprite();
  paint(id, s);
  return s.data;
}

export function itemAtlasIndex(id: number): number {
  return id - ITEM_FIRST;
}
