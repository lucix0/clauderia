import * as THREE from 'three';
import { ATLAS_TILES_PER_ROW } from '../world/blocks';
import { paintAllTiles, TILE_PX } from './tiles';

export interface Atlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.Texture;
  /** A standalone repeating texture made from one tile (edge ocean, floor). */
  tileTexture(tile: number): THREE.Texture;
}

function pixelTexture(source: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(source);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Paint every tile into one canvas atlas and wrap it in a texture. */
export function createAtlas(): Atlas {
  const size = ATLAS_TILES_PER_ROW * TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const tiles = paintAllTiles();
  tiles.forEach((rgba, id) => {
    const img = new ImageData(new Uint8ClampedArray(rgba), TILE_PX, TILE_PX);
    ctx.putImageData(img, (id % ATLAS_TILES_PER_ROW) * TILE_PX, Math.floor(id / ATLAS_TILES_PER_ROW) * TILE_PX);
  });
  const texture = pixelTexture(canvas);

  return {
    canvas,
    texture,
    tileTexture(tile: number): THREE.Texture {
      const c = document.createElement('canvas');
      c.width = TILE_PX;
      c.height = TILE_PX;
      const cctx = c.getContext('2d');
      if (!cctx) throw new Error('2D canvas unavailable');
      const rgba = tiles[tile];
      if (rgba) cctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), TILE_PX, TILE_PX), 0, 0);
      const tex = pixelTexture(c);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      return tex;
    },
  };
}
