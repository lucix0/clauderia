/**
 * Small isometric block icons drawn from the atlas canvas with 2D transforms.
 * Cross-shaped blocks get a flat sprite instead.
 */
import { ATLAS_TILES_PER_ROW, BLOCKS, SHAPE, SHAPE_CROSS, SHAPE_SLAB } from '../world/blocks';

const TILE = 16;

function drawFace(
  ctx: CanvasRenderingContext2D,
  atlas: HTMLCanvasElement,
  tile: number,
  m: [number, number, number, number, number, number],
  shade: number,
  srcY = 0,
  srcH = TILE,
): void {
  const sx = (tile % ATLAS_TILES_PER_ROW) * TILE;
  const sy = Math.floor(tile / ATLAS_TILES_PER_ROW) * TILE;
  ctx.save();
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(atlas, sx, sy + srcY, TILE, srcH, 0, srcY, TILE, srcH);
  if (shade < 1) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = `rgba(0, 0, 0, ${1 - shade})`;
    ctx.fillRect(0, srcY, TILE, srcH);
  }
  ctx.restore();
}

/** Render one block icon into a new canvas of `size`×`size` pixels. */
export function renderIcon(atlas: HTMLCanvasElement, id: number, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const def = BLOCKS[id];
  if (!ctx || !def) return canvas;
  ctx.imageSmoothingEnabled = false;

  if (SHAPE[id] === SHAPE_CROSS) {
    const t = def.tiles[2];
    const pad = size * 0.08;
    ctx.drawImage(
      atlas,
      (t % ATLAS_TILES_PER_ROW) * TILE,
      Math.floor(t / ATLAS_TILES_PER_ROW) * TILE,
      TILE,
      TILE,
      pad,
      pad,
      size - pad * 2,
      size - pad * 2,
    );
    return canvas;
  }

  // Each face is a parallelogram; the transform maps tile pixels onto it.
  const s = size * 0.94;
  const ox = (size - s) / 2;
  const oy = (size - s) / 2;
  const k = s / TILE;
  const slab = SHAPE[id] === SHAPE_SLAB;
  const drop = slab ? s / 4 : 0; // top face sits half a block lower
  const top = def.tiles[2];
  const left = def.tiles[4]; // south face
  const right = def.tiles[0]; // east face

  // Top: (0,0)→left corner, u → top corner, v → bottom corner.
  drawFace(ctx, atlas, top, [k / 2, -k / 4, k / 2, k / 4, ox, oy + s / 4 + drop], 1);
  // Left (south): u along the lower-left edge, v straight down.
  const sideSrcY = slab ? TILE / 2 : 0;
  const sideSrcH = slab ? TILE / 2 : TILE;
  drawFace(ctx, atlas, left, [k / 2, k / 4, 0, k / 2, ox, oy + s / 4], 0.8, sideSrcY, sideSrcH);
  // Right (east): from the front corner up to the right corner.
  drawFace(ctx, atlas, right, [k / 2, -k / 4, 0, k / 2, ox + s / 2, oy + s / 2], 0.6, sideSrcY, sideSrcH);
  return canvas;
}

/** Cache of icon data URLs, keyed by block id. */
export class IconCache {
  private readonly urls = new Map<number, string>();

  constructor(
    private readonly atlas: HTMLCanvasElement,
    private readonly size = 48,
  ) {}

  url(id: number): string {
    let u = this.urls.get(id);
    if (!u) {
      u = renderIcon(this.atlas, id, this.size).toDataURL();
      this.urls.set(id, u);
    }
    return u;
  }
}
