import { CHUNK_SIZE, CHUNK_VOLUME, SECTIONS, chunkKey } from './coords';

/**
 * One 16×16×128 column. Blocks are `Uint16` values (id | state << 8).
 * Pure data; rendering state lives in the renderer.
 */
export class Chunk {
  readonly key: number;
  readonly blocks: Uint16Array;
  /**
   * Classic column shadows: y of the highest light-blocking block per column,
   * or −1. Replaced by flood-fill light in a later milestone.
   */
  readonly heights: Int16Array;
  /** Changed since generation: must be saved. */
  modified = false;
  /** Bumped on every block change (lets async jobs detect stale inputs). */
  version = 0;
  /** `version` at the last successful save. */
  savedVersion = 0;
  /** Bitmask of sections whose mesh is stale. */
  dirtySections = 0;
  /** Bitmask of sections containing at least one non-air block. */
  nonEmpty = 0;

  constructor(
    readonly cx: number,
    readonly cz: number,
    blocks?: Uint16Array,
  ) {
    this.key = chunkKey(cx, cz);
    this.blocks = blocks ?? new Uint16Array(CHUNK_VOLUME);
    if (this.blocks.length !== CHUNK_VOLUME) throw new Error('Bad chunk block array');
    this.heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE).fill(-1);
  }

  /** Recompute which sections hold anything. */
  updateNonEmpty(): void {
    let mask = 0;
    const b = this.blocks;
    for (let s = 0; s < SECTIONS; s++) {
      const start = s * 4096;
      for (let i = start; i < start + 4096; i++) {
        if (b[i] !== 0) {
          mask |= 1 << s;
          break;
        }
      }
    }
    this.nonEmpty = mask;
  }

  markAllDirty(): void {
    this.dirtySections = (1 << SECTIONS) - 1;
  }
}
