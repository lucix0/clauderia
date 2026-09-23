/**
 * Padded 18×18×18 view of one 16³ section plus a one-cell apron from its
 * neighbours (filled from a MeshInput). Pure: used on the main thread for
 * edits and in mesh workers.
 */

export const PAD = 18;
export const PAD_VOLUME = PAD * PAD * PAD;

/** Index into padded arrays for local coords in −1..16. */
export function padIndex(x: number, y: number, z: number): number {
  return ((y + 1) * PAD + (z + 1)) * PAD + (x + 1);
}

export interface PaddedSection {
  readonly blocks: Uint16Array;
  readonly light: Uint8Array;
  /** Section index (0–7) and column. */
  sy: number;
  cx: number;
  cz: number;
}

export function createPadded(): PaddedSection {
  return { blocks: new Uint16Array(PAD_VOLUME), light: new Uint8Array(PAD_VOLUME), sy: 0, cx: 0, cz: 0 };
}
