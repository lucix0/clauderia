/**
 * Tiny pixel-art status icons (hearts, hunger, air bubbles), painted once
 * into data URLs.
 */

type Icon = 'heart' | 'heart-half' | 'heart-empty' | 'food' | 'food-half' | 'food-empty' | 'bubble';

const HEART = ['.XX.XX.', 'XHRXRRX', 'XRRRRRX', 'XRRRRRX', '.XRRRX.', '..XRX..', '...X...'];
const FOOD = ['....XX.', '...XMMX', '..XMMMX', '.XMMMX.', 'XBXXX..', 'XB.....', '.X.....'];
const BUBBLE = ['..XXX..', '.XWLLX.', 'XWLLLLX', 'XLLLLLX', 'XLLLLLX', '.XLLLX.', '..XXX..'];

const COLORS: Record<string, string> = {
  X: '#1a0a0a',
  R: '#d42222',
  H: '#ff9a9a',
  M: '#b0703a',
  B: '#efe6d2',
  W: '#ffffff',
  L: '#7fb8ff',
  E: '#3a2a2a',
};

function paint(rows: readonly string[], map: (ch: string, x: number) => string | null): string {
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = 7 * scale;
  canvas.height = 7 * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = map(row[x]!, x);
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  });
  return canvas.toDataURL();
}

const cache = new Map<Icon, string>();

export function statusIcon(icon: Icon): string {
  let url = cache.get(icon);
  if (url) return url;
  const full = (ch: string): string | null => (ch === '.' ? null : COLORS[ch] ?? null);
  // Empty icons keep the outline and fill with a dark tone; halves fill the left side.
  const empty = (ch: string): string | null => (ch === '.' ? null : ch === 'X' ? COLORS['X']! : COLORS['E']!);
  const half = (ch: string, x: number): string | null => (x <= 3 ? full(ch) : empty(ch));
  switch (icon) {
    case 'heart':
      url = paint(HEART, full);
      break;
    case 'heart-half':
      url = paint(HEART, half);
      break;
    case 'heart-empty':
      url = paint(HEART, empty);
      break;
    case 'food':
      url = paint(FOOD, full);
      break;
    case 'food-half':
      url = paint(FOOD, (ch, x) => (x >= 3 ? full(ch) : empty(ch)));
      break;
    case 'food-empty':
      url = paint(FOOD, empty);
      break;
    case 'bubble':
      url = paint(BUBBLE, full);
      break;
  }
  cache.set(icon, url);
  return url;
}
