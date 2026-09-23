import * as THREE from 'three';
import { ITEM_FIRST } from '../items/items';
import { ATLAS_TILES_PER_ROW } from '../world/blocks';
import { ITEM_ATLAS_COLUMNS, ITEM_ATLAS_SLOTS, paintItem } from './itemTiles';
import { displayTile, paintAllTiles, TILE_PX } from './tiles';

export interface Atlas {
  /** Tiles with their default tints applied (icons and UI). */
  readonly canvas: HTMLCanvasElement;
  /** The GPU atlas: grey tintable tiles, tint masks in the alpha of opaque tiles. */
  readonly texture: THREE.Texture;
  /** A standalone repeating texture made from one tile (edge ocean, floor). */
  tileTexture(tile: number): THREE.Texture;
  /** Item sprites (non-block items), for icons and dropped items. */
  readonly itemCanvas: HTMLCanvasElement;
  readonly itemTexture: THREE.Texture;
}

function pixelTexture<T extends THREE.Texture>(tex: T): T {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Paint every tile into one atlas. The GPU copy is a raw data texture so the
 * tint-mask alpha isn't disturbed by canvas premultiplication.
 */
export function createAtlas(): Atlas {
  const size = ATLAS_TILES_PER_ROW * TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const tiles = paintAllTiles();
  const display = tiles.map((rgba, id) => displayTile(id, rgba));
  const data = new Uint8Array(size * size * 4);
  tiles.forEach((rgba, id) => {
    const ox = (id % ATLAS_TILES_PER_ROW) * TILE_PX;
    const oy = Math.floor(id / ATLAS_TILES_PER_ROW) * TILE_PX;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(display[id]!), TILE_PX, TILE_PX), ox, oy);
    // Data textures aren't flipped: row 0 is the bottom (v = 0).
    for (let y = 0; y < TILE_PX; y++) {
      const dst = ((size - 1 - (oy + y)) * size + ox) * 4;
      data.set(rgba.subarray(y * TILE_PX * 4, (y + 1) * TILE_PX * 4), dst);
    }
  });
  const texture = pixelTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType));
  const items = createItemAtlas();

  return {
    canvas,
    texture,
    itemCanvas: items.canvas,
    itemTexture: items.texture,
    tileTexture(tile: number): THREE.Texture {
      const c = document.createElement('canvas');
      c.width = TILE_PX;
      c.height = TILE_PX;
      const cctx = c.getContext('2d');
      if (!cctx) throw new Error('2D canvas unavailable');
      const rgba = display[tile];
      if (rgba) cctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), TILE_PX, TILE_PX), 0, 0);
      const tex = pixelTexture(new THREE.CanvasTexture(c));
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      return tex;
    },
  };
}

/** Item sprites in a 16-column atlas (index = id − ITEM_FIRST). */
function createItemAtlas(): { canvas: HTMLCanvasElement; texture: THREE.Texture } {
  const rows = Math.ceil(ITEM_ATLAS_SLOTS / ITEM_ATLAS_COLUMNS);
  const canvas = document.createElement('canvas');
  canvas.width = ITEM_ATLAS_COLUMNS * TILE_PX;
  canvas.height = rows * TILE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  for (let i = 0; i < ITEM_ATLAS_SLOTS; i++) {
    const rgba = paintItem(ITEM_FIRST + i);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), TILE_PX, TILE_PX), (i % ITEM_ATLAS_COLUMNS) * TILE_PX, Math.floor(i / ITEM_ATLAS_COLUMNS) * TILE_PX);
  }
  const texture = pixelTexture(new THREE.CanvasTexture(canvas));
  return { canvas, texture };
}
