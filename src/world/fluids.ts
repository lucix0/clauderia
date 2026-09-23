/**
 * Finite fluids (Infinite worlds). A fluid block's state holds its level:
 * 0 is a source, 1–7 flowing (higher = weaker), plus a "falling" flag for
 * fluid pouring down. Water spreads 7 blocks from a source, lava 3 (and
 * slower); both head for the nearest drop. Flowing fluid with nothing
 * feeding it dries up. Two water sources side by side make a new source.
 * Lava meeting water hardens: sources into obsidian, flowing lava into
 * cobblestone. Pure: operates on anything with get / set.
 */
import { B, IS_LIQUID, IS_PLANT, REPLACEABLE } from './blocks';

export const FALLING = 8;
export const WATER_TICKS = 5;
export const LAVA_TICKS = 30;

/** What fluid updates need from the world. */
export interface FluidWorld {
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, value: number): void;
  inBounds(x: number, y: number, z: number): boolean;
}

const HORIZONTAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function isFluid(id: number): boolean {
  return id === B.WATER || id === B.LAVA;
}

/** Level (0 source … 7) of a fluid value; falling counts as 0 for spreading. */
export function fluidLevel(value: number): number {
  const s = value >> 8;
  return s & FALLING ? 0 : s & 7;
}

export function isSource(value: number): boolean {
  return value >> 8 === 0;
}

/** How far each step weakens the flow. */
function stepOf(id: number): number {
  return id === B.WATER ? 1 : 2;
}

/** How far (in blocks) a fluid looks for a drop to head toward. */
function slopeReach(id: number): number {
  return id === B.WATER ? 4 : 2;
}

/**
 * Visual height (0–1) of a fluid cell: sources and falling fluid 8/9,
 * weaker flows lower; full when the same fluid sits on top.
 */
export function fluidHeight(value: number, aboveId: number): number {
  const id = value & 0xff;
  if (aboveId === id) return 1;
  const s = value >> 8;
  if (s & FALLING) return 8 / 9;
  return (8 - (s & 7)) / 9;
}

/** Can fluid wash into this cell (replacing it)? */
function washable(id: number): boolean {
  return id === B.AIR || REPLACEABLE[id] === 1 || IS_PLANT[id] === 1 || id === B.TORCH;
}

/**
 * Can `fluid` flow into a cell holding `value` at strength `level`?
 * Weaker flows of the same fluid get strengthened.
 */
function canFlowInto(fluid: number, value: number, level: number): boolean {
  const id = value & 0xff;
  if (washable(id)) return true;
  if (id !== fluid) return false;
  if (isSource(value)) return false;
  const s = value >> 8;
  return !(s & FALLING) && (s & 7) > level;
}

/**
 * What a flow of `fluid` entering a cell that holds the other fluid turns
 * into (null: no reaction).
 */
function reaction(fluid: number, target: number): number | null {
  const tid = target & 0xff;
  if (fluid === B.WATER && tid === B.LAVA) return isSource(target) ? B.OBSIDIAN : B.COBBLESTONE;
  if (fluid === B.LAVA && tid === B.WATER) return B.STONE;
  return null;
}

/**
 * Update one fluid cell. Calls `schedule(x, y, z, delay)` for cells that need
 * another look. Returns true if anything changed.
 */
export function updateFluid(
  w: FluidWorld,
  x: number,
  y: number,
  z: number,
  schedule: (x: number, y: number, z: number, delay: number) => void,
): boolean {
  let value = w.get(x, y, z);
  const fluid = value & 0xff;
  if (!isFluid(fluid)) return false;
  const delay = fluid === B.WATER ? WATER_TICKS : LAVA_TICKS;
  const step = stepOf(fluid);
  let changed = false;

  // Lava touching water hardens.
  if (fluid === B.LAVA) {
    const touching = [[0, 1, 0], ...HORIZONTAL.map(([dx, dz]) => [dx, 0, dz])].some(
      ([dx, dy, dz]) => (w.get(x + dx!, y + dy!, z + dz!) & 0xff) === B.WATER,
    );
    if (touching) {
      w.set(x, y, z, isSource(value) ? B.OBSIDIAN : B.COBBLESTONE);
      return true;
    }
  }

  // 1. Settle this cell's own level from what feeds it.
  if (!isSource(value)) {
    const above = w.get(x, y + 1, z);
    let nextState: number;
    if ((above & 0xff) === fluid) {
      nextState = FALLING;
    } else {
      let best = 99;
      let sources = 0;
      for (const [dx, dz] of HORIZONTAL) {
        const n = w.get(x + dx, y, z + dz);
        if ((n & 0xff) !== fluid) continue;
        if (isSource(n)) sources++;
        // Only fluid resting on something feeds sideways (falling columns don't).
        if ((n >> 8) & FALLING) {
          const under = w.get(x + dx, y - 1, z + dz) & 0xff;
          if (washable(under) || under === fluid) continue;
        }
        best = Math.min(best, fluidLevel(n));
      }
      let level = best + step;
      const below = w.get(x, y - 1, z);
      const firmBelow = !washable(below & 0xff) && !((below & 0xff) === fluid && !isSource(below));
      if (fluid === B.WATER && sources >= 2 && firmBelow) level = 0;
      if (level > 7) {
        w.set(x, y, z, B.AIR);
        return true;
      }
      nextState = level;
    }
    const nextValue = fluid | (nextState << 8);
    if (nextValue !== value) {
      w.set(x, y, z, nextValue);
      value = nextValue;
      changed = true;
      schedule(x, y, z, delay);
    }
  }

  // 2. Pour down if possible.
  const level = fluidLevel(value);
  if (y > 0 && w.inBounds(x, y - 1, z)) {
    const below = w.get(x, y - 1, z);
    const react = reaction(fluid, below);
    if (react !== null && (below & 0xff) !== fluid) {
      w.set(x, y - 1, z, react);
      changed = true;
    } else if (washable(below & 0xff) || ((below & 0xff) === fluid && !isSource(below) && !((below >> 8) & FALLING))) {
      w.set(x, y - 1, z, fluid | (FALLING << 8));
      schedule(x, y - 1, z, delay);
      changed = true;
      // Flowing fluid that can fall doesn't also spread; sources do.
      if (!isSource(value)) return changed;
    } else if ((below & 0xff) === fluid && !isSource(value)) {
      // Resting on its own fluid (a pool below): no sideways spread.
      return changed;
    }
  }

  // 3. Spread sideways, toward the nearest drop if there is one.
  const spreadLevel = level + step;
  if (spreadLevel > 7) return changed;
  const dirs = flowDirections(w, x, y, z, fluid);
  for (const [dx, dz] of dirs) {
    const nx = x + dx;
    const nz = z + dz;
    if (!w.inBounds(nx, y, nz)) continue;
    const n = w.get(nx, y, nz);
    const react = reaction(fluid, n);
    if (react !== null) {
      w.set(nx, y, nz, react);
      changed = true;
      continue;
    }
    if (!canFlowInto(fluid, n, spreadLevel)) continue;
    w.set(nx, y, nz, fluid | (spreadLevel << 8));
    schedule(nx, y, nz, delay);
    changed = true;
  }
  return changed;
}

/**
 * Directions to spread in: those whose path reaches a drop soonest (within
 * the fluid's reach); all open directions when no drop is near.
 */
function flowDirections(w: FluidWorld, x: number, y: number, z: number, fluid: number): Array<readonly [number, number]> {
  const reach = slopeReach(fluid);
  let best = Infinity;
  const scored: Array<[readonly [number, number], number]> = [];
  for (const d of HORIZONTAL) {
    const nx = x + d[0];
    const nz = z + d[1];
    if (!w.inBounds(nx, y, nz)) continue;
    const n = w.get(nx, y, nz);
    const nid = n & 0xff;
    if (!washable(nid) && nid !== fluid && !IS_LIQUID[nid]) continue;
    if (nid === fluid && isSource(n)) continue;
    const dist = dropDistance(w, nx, y, nz, fluid, reach, d);
    scored.push([d, dist]);
    best = Math.min(best, dist);
  }
  return scored.filter(([, dist]) => dist === best).map(([d]) => d);
}

/** Blocks walked (1 = right here) before the ground falls away, or reach + 1. */
function dropDistance(
  w: FluidWorld,
  x: number,
  y: number,
  z: number,
  fluid: number,
  reach: number,
  from: readonly [number, number],
): number {
  // Breadth-first over open cells on this level, never stepping back.
  const seen = new Set<string>([`${x - from[0]},${z - from[1]}`]);
  let frontier: Array<[number, number]> = [[x, z]];
  for (let dist = 1; dist <= reach; dist++) {
    const next: Array<[number, number]> = [];
    for (const [cx, cz] of frontier) {
      const key = `${cx},${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const below = w.get(cx, y - 1, cz) & 0xff;
      if (washable(below) || below === fluid) return dist;
      for (const [dx, dz] of HORIZONTAL) {
        const nx = cx + dx;
        const nz = cz + dz;
        const nid = w.get(nx, y, nz) & 0xff;
        if (washable(nid) || nid === fluid) next.push([nx, nz]);
      }
    }
    frontier = next;
  }
  return reach + 1;
}
