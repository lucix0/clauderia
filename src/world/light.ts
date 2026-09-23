/**
 * Flood-fill lighting (pure). Light per cell is packed as sky << 4 | block,
 * both 0–15. Sky light 15 falls straight down through clear cells without
 * fading; every other step loses max(1, opacity). Emitters seed block light.
 *
 * - `computeChunkLight` lights one column from the ids of its 3×3
 *   neighbourhood (exact: nothing farther than 15 blocks can reach it).
 * - `relight` updates light incrementally after one block changed, with a
 *   removal pass then a re-add pass, across chunk borders.
 * - `borderSeeds` + `spread` reconcile light across the borders of a
 *   freshly lit chunk.
 */
import { LIGHT_EMIT, LIGHT_OPACITY } from './blocks';
import { CHUNK_HEIGHT } from './coords';

/** Side of the square id region handed to `computeChunkLight` (3 chunks). */
export const REGION = 48;
export const REGION_LAYER = REGION * REGION;
export const REGION_VOLUME = REGION_LAYER * CHUNK_HEIGHT;

const H = CHUNK_HEIGHT;

/** Growable int queue (FIFO over a reused buffer). */
class IntQueue {
  data = new Int32Array(1 << 14);
  head = 0;
  tail = 0;

  push(v: number): void {
    if (this.tail === this.data.length) {
      if (this.head > 0) {
        this.data.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      }
      if (this.tail === this.data.length) {
        const next = new Int32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
      }
    }
    this.data[this.tail++] = v;
  }

  get empty(): boolean {
    return this.head === this.tail;
  }

  shift(): number {
    return this.data[this.head++]!;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
  }
}

/** Index of a cell in the region: x, z ∈ [0, 48), y ∈ [0, 128). */
export function regionIndex(x: number, y: number, z: number): number {
  return (y * REGION + z) * REGION + x;
}

/**
 * Light the centre chunk of a 48×48×128 id region (centre = x, z in 16..31).
 * Returns the centre's packed light, indexed like chunk blocks.
 */
export function computeChunkLight(ids: Uint8Array): Uint8Array {
  const N = REGION;
  const L = REGION_LAYER;
  const sky = new Uint8Array(REGION_VOLUME);
  const blk = new Uint8Array(REGION_VOLUME);
  const top = new Int16Array(L); // lowest y still at full sky, per column
  const q = new IntQueue();

  // 1. Sky straight down each column.
  for (let c = 0; c < L; c++) {
    let level = 15;
    let full = H;
    for (let y = H - 1; y >= 0; y--) {
      const i = y * L + c;
      const o = LIGHT_OPACITY[ids[i]!]!;
      if (o >= 15) break;
      level = level === 15 && o === 0 ? 15 : level - Math.max(1, o);
      if (level <= 0) break;
      sky[i] = level;
      if (level === 15) full = y;
    }
    top[c] = full;
  }

  // 2. Seed cells that can light shaded neighbours: the band of each column
  //    that is fully lit while a neighbouring column is not, plus every
  //    partially lit cell (under leaves / water).
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const c = z * N + x;
      const t = top[c]!;
      let hi = t;
      if (x > 0) hi = Math.max(hi, top[c - 1]!);
      if (x < N - 1) hi = Math.max(hi, top[c + 1]!);
      if (z > 0) hi = Math.max(hi, top[c - N]!);
      if (z < N - 1) hi = Math.max(hi, top[c + N]!);
      for (let y = t; y < hi && y < H; y++) q.push(y * L + c);
      for (let y = t - 1; y >= 0; y--) {
        const i = y * L + c;
        const v = sky[i]!;
        if (v === 0) break;
        if (v > 1) q.push(i);
      }
    }
  }
  flood(q, sky, ids, true);

  // 3. Block light from emitters.
  for (let i = 0; i < REGION_VOLUME; i++) {
    const e = LIGHT_EMIT[ids[i]!]!;
    if (e > 0) {
      blk[i] = e;
      q.push(i);
    }
  }
  flood(q, blk, ids, false);

  // 4. Cut out the centre.
  const out = new Uint8Array(16 * 16 * H);
  for (let y = 0; y < H; y++) {
    for (let lz = 0; lz < 16; lz++) {
      let i = regionIndex(16, y, lz + 16);
      let o = (y << 8) | (lz << 4);
      for (let lx = 0; lx < 16; lx++, i++, o++) out[o] = (sky[i]! << 4) | blk[i]!;
    }
  }
  return out;
}

/** Breadth-first spread inside the region. */
function flood(q: IntQueue, light: Uint8Array, ids: Uint8Array, isSky: boolean): void {
  const N = REGION;
  const L = REGION_LAYER;
  while (!q.empty) {
    const i = q.shift();
    const level = light[i]!;
    if (level <= 1) continue;
    const y = Math.floor(i / L);
    const r = i - y * L;
    const z = Math.floor(r / N);
    const x = r - z * N;
    for (let d = 0; d < 6; d++) {
      let j: number;
      switch (d) {
        case 0:
          if (x === N - 1) continue;
          j = i + 1;
          break;
        case 1:
          if (x === 0) continue;
          j = i - 1;
          break;
        case 2:
          if (z === N - 1) continue;
          j = i + N;
          break;
        case 3:
          if (z === 0) continue;
          j = i - N;
          break;
        case 4:
          if (y === H - 1) continue;
          j = i + L;
          break;
        default:
          if (y === 0) continue;
          j = i - L;
      }
      const o = LIGHT_OPACITY[ids[j]!]!;
      if (o >= 15) continue;
      const nl = isSky && d === 5 && level === 15 && o === 0 ? 15 : level - Math.max(1, o);
      if (nl > light[j]!) {
        light[j] = nl;
        q.push(j);
      }
    }
  }
}

// ---- Incremental updates on live chunks ----

/** Access to live light across chunk borders. */
export interface LightStore {
  /** Block id; unloaded cells report 255 (opaque). */
  id(x: number, y: number, z: number): number;
  /** Packed light, or −1 when the chunk isn't loaded and lit. */
  get(x: number, y: number, z: number): number;
  /** Write packed light (and mark meshes dirty). */
  set(x: number, y: number, z: number, packed: number): void;
}

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 0, 0, 1, -1];
const DZ = [0, 0, 1, -1, 0, 0];
const DOWN = 5;

/** Packed-position queue entries: coordinates relative to an origin. */
interface Work {
  xs: number[];
  ys: number[];
  zs: number[];
  ls: number[];
}

function work(): Work {
  return { xs: [], ys: [], zs: [], ls: [] };
}

function push(w: Work, x: number, y: number, z: number, l: number): void {
  w.xs.push(x);
  w.ys.push(y);
  w.zs.push(z);
  w.ls.push(l);
}

function channel(packed: number, isSky: boolean): number {
  return isSky ? packed >> 4 : packed & 15;
}

function withChannel(packed: number, isSky: boolean, v: number): number {
  return isSky ? (packed & 0x0f) | (v << 4) : (packed & 0xf0) | v;
}

function setChannel(s: LightStore, x: number, y: number, z: number, isSky: boolean, v: number): boolean {
  const p = s.get(x, y, z);
  if (p < 0) return false;
  const n = withChannel(p, isSky, v);
  if (n !== p) s.set(x, y, z, n);
  return true;
}

/** Spread increases outward from the queued cells. */
function addPass(s: LightStore, q: Work, isSky: boolean): void {
  for (let k = 0; k < q.xs.length; k++) {
    const x = q.xs[k]!;
    const y = q.ys[k]!;
    const z = q.zs[k]!;
    const p = s.get(x, y, z);
    if (p < 0) continue;
    const level = channel(p, isSky);
    if (level <= 1) continue;
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!;
      const ny = y + DY[d]!;
      const nz = z + DZ[d]!;
      if (ny < 0 || ny >= H) continue;
      const np = s.get(nx, ny, nz);
      if (np < 0) continue;
      const o = LIGHT_OPACITY[s.id(nx, ny, nz)]!;
      if (o >= 15) continue;
      const nl = isSky && d === DOWN && level === 15 && o === 0 ? 15 : level - Math.max(1, o);
      if (nl > channel(np, isSky)) {
        s.set(nx, ny, nz, withChannel(np, isSky, nl));
        push(q, nx, ny, nz, nl);
      }
    }
  }
}

/** Relight one channel after the block at (x, y, z) changed. */
function relightChannel(s: LightStore, x: number, y: number, z: number, isSky: boolean): void {
  const here = s.get(x, y, z);
  if (here < 0) return;
  const removal = work();
  const add = work();
  const old = channel(here, isSky);
  setChannel(s, x, y, z, isSky, 0);
  if (old > 0) push(removal, x, y, z, old);

  // Removal: clear everything that depended on the old value.
  for (let k = 0; k < removal.xs.length; k++) {
    const px = removal.xs[k]!;
    const py = removal.ys[k]!;
    const pz = removal.zs[k]!;
    const level = removal.ls[k]!;
    for (let d = 0; d < 6; d++) {
      const nx = px + DX[d]!;
      const ny = py + DY[d]!;
      const nz = pz + DZ[d]!;
      if (ny < 0 || ny >= H) continue;
      const np = s.get(nx, ny, nz);
      if (np < 0) continue;
      const nl = channel(np, isSky);
      if (nl === 0) continue;
      const fed = nl < level || (isSky && d === DOWN && level === 15 && nl === 15);
      if (fed) {
        s.set(nx, ny, nz, withChannel(np, isSky, 0));
        push(removal, nx, ny, nz, nl);
      } else {
        push(add, nx, ny, nz, nl); // an independent source: spreads back in
      }
    }
  }

  // Re-add: the changed cell's own emission / sky, and its neighbours.
  const id = s.id(x, y, z);
  const o = LIGHT_OPACITY[id]!;
  if (isSky) {
    if (y === H - 1 && o < 15) {
      setChannel(s, x, y, z, true, o === 0 ? 15 : Math.max(0, 15 - o));
    }
  } else if (LIGHT_EMIT[id]! > 0) {
    setChannel(s, x, y, z, false, LIGHT_EMIT[id]!);
  }
  push(add, x, y, z, 0);
  for (let d = 0; d < 6; d++) {
    const ny = y + DY[d]!;
    if (ny < 0 || ny >= H) continue;
    push(add, x + DX[d]!, ny, z + DZ[d]!, 0);
  }
  addPass(s, add, isSky);
}

/** Update sky and block light after the block at (x, y, z) changed. */
export function relight(s: LightStore, x: number, y: number, z: number): void {
  relightChannel(s, x, y, z, true);
  relightChannel(s, x, y, z, false);
}

/** Spread light outward from the given cells (e.g. seeds found by a border stitch). */
export function spread(s: LightStore, cells: ReadonlyArray<readonly [number, number, number]>, isSky: boolean): void {
  if (cells.length === 0) return;
  const q = work();
  for (const [x, y, z] of cells) push(q, x, y, z, 0);
  addPass(s, q, isSky);
}

/**
 * Border cells of chunk `a` (at cx, cz) and its neighbour `b` (at +1 in x
 * when `alongX`, else +1 in z) where light should flow across but hasn't.
 */
export function borderSeeds(
  aBlocks: Uint16Array,
  aLight: Uint8Array,
  bBlocks: Uint16Array,
  bLight: Uint8Array,
  cx: number,
  cz: number,
  alongX: boolean,
  isSky: boolean,
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const shift = isSky ? 4 : 0;
  for (let y = 0; y < H; y++) {
    for (let i = 0; i < 16; i++) {
      // a's cell on the shared border and b's cell across it.
      const ai = alongX ? (y << 8) | (i << 4) | 15 : (y << 8) | (15 << 4) | i;
      const bi = alongX ? (y << 8) | (i << 4) : (y << 8) | i;
      const la = (aLight[ai]! >> shift) & 15;
      const lb = (bLight[bi]! >> shift) & 15;
      if (la === lb) continue;
      const ax = cx * 16 + (alongX ? 15 : i);
      const az = cz * 16 + (alongX ? i : 15);
      if (la > lb + 1) {
        const o = LIGHT_OPACITY[bBlocks[bi]! & 0xff]!;
        if (o < 15 && la - Math.max(1, o) > lb) out.push([ax, y, az]);
      } else if (lb > la + 1) {
        const o = LIGHT_OPACITY[aBlocks[ai]! & 0xff]!;
        if (o < 15 && lb - Math.max(1, o) > la) out.push([ax + (alongX ? 1 : 0), y, az + (alongX ? 0 : 1)]);
      }
    }
  }
  return out;
}
