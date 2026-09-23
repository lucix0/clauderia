import { BLOCKS_LIGHT } from './blocks';

/**
 * Per-column light height: the y of the highest light-blocking block, or -1.
 * A cell (x, y, z) is lit when y > height(x, z).
 */
export class HeightMap {
  readonly heights: Int16Array;

  constructor(
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
  ) {
    this.heights = new Int16Array(sx * sz).fill(-1);
  }

  get(x: number, z: number): number {
    return this.heights[z * this.sx + x]!;
  }

  isLit(x: number, y: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return true;
    return y > this.heights[z * this.sx + x]!;
  }

  recomputeAll(blocks: Uint8Array): void {
    const { sx, sy, sz } = this;
    const layer = sx * sz;
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const col = z * sx + x;
        let h = -1;
        for (let y = sy - 1; y >= 0; y--) {
          if (BLOCKS_LIGHT[blocks[y * layer + col]!]) {
            h = y;
            break;
          }
        }
        this.heights[col] = h;
      }
    }
  }

  /**
   * Update the column after the block at (x, y, z) changed to `id`.
   * Returns the previous height (the new one is `get(x, z)`).
   */
  update(blocks: Uint8Array, x: number, y: number, z: number, id: number): number {
    const col = z * this.sx + x;
    const old = this.heights[col]!;
    if (BLOCKS_LIGHT[id]) {
      if (y > old) this.heights[col] = y;
    } else if (y === old) {
      const layer = this.sx * this.sz;
      let h = -1;
      for (let yy = y - 1; yy >= 0; yy--) {
        if (BLOCKS_LIGHT[blocks[yy * layer + col]!]) {
          h = yy;
          break;
        }
      }
      this.heights[col] = h;
    }
    return old;
  }
}
