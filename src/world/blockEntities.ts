/**
 * Block entities: the extra state behind furnaces and chests, keyed by
 * block position. Furnaces tick (only in active chunks); both are saved
 * with their chunk and spill their contents when the block goes.
 */
import { emptySlots, slotsFromJSON, slotsToJSON, type ItemStack, type Slots } from '../items/inventory';
import { newFurnace, tickFurnace, type FurnaceState } from '../items/smelting';
import { posFromKey, posKey } from './coords';

export const CHEST_SLOTS = 27;

export type BlockEntity =
  | { kind: 'furnace'; readonly x: number; readonly y: number; readonly z: number; readonly furnace: FurnaceState }
  | { kind: 'chest'; readonly x: number; readonly y: number; readonly z: number; readonly slots: Slots };

export class BlockEntities {
  private readonly map = new Map<number, BlockEntity>();

  get size(): number {
    return this.map.size;
  }

  get(x: number, y: number, z: number): BlockEntity | undefined {
    return this.map.get(posKey(x, y, z));
  }

  /** The furnace at a cell, created empty if missing. */
  furnace(x: number, y: number, z: number): FurnaceState {
    const e = this.get(x, y, z);
    if (e?.kind === 'furnace') return e.furnace;
    const furnace = newFurnace();
    this.map.set(posKey(x, y, z), { kind: 'furnace', x, y, z, furnace });
    return furnace;
  }

  /** The chest's 27 slots at a cell, created empty if missing. */
  chest(x: number, y: number, z: number): Slots {
    const e = this.get(x, y, z);
    if (e?.kind === 'chest') return e.slots;
    const slots = emptySlots(CHEST_SLOTS);
    this.map.set(posKey(x, y, z), { kind: 'chest', x, y, z, slots });
    return slots;
  }

  /** Take a block entity out (its block was broken); returns it. */
  remove(x: number, y: number, z: number): BlockEntity | undefined {
    const k = posKey(x, y, z);
    const e = this.map.get(k);
    this.map.delete(k);
    return e;
  }

  /** Everything a block entity holds (to drop when broken). */
  static contents(e: BlockEntity): ItemStack[] {
    const slots = e.kind === 'chest' ? e.slots : e.furnace.slots;
    return slots.filter((s): s is ItemStack => s !== null);
  }

  /** Tick furnaces in active chunks; `lit` reports furnaces that lit up or went out. */
  tick(active: (x: number, z: number) => boolean, lit: (x: number, y: number, z: number, on: boolean) => void): void {
    for (const e of this.map.values()) {
      if (e.kind !== 'furnace' || !active(e.x, e.z)) continue;
      if (tickFurnace(e.furnace)) lit(e.x, e.y, e.z, e.furnace.burn > 0);
    }
  }

  /** Block entities in chunk (cx, cz) in save form; `remove` unloads them. */
  inChunk(cx: number, cz: number, remove: boolean): unknown[] {
    const out: unknown[] = [];
    for (const [k, e] of this.map) {
      if (e.x >> 4 !== cx || e.z >> 4 !== cz) continue;
      out.push(saveEntity(e));
      if (remove) this.map.delete(k);
    }
    return out;
  }

  load(raw: readonly unknown[]): void {
    for (const r of raw) {
      const e = loadEntity(r);
      if (e) this.map.set(posKey(e.x, e.y, e.z), e);
    }
  }

  clear(): void {
    this.map.clear();
  }

  positions(): Array<[number, number, number]> {
    return [...this.map.keys()].map(posFromKey);
  }
}

function saveEntity(e: BlockEntity): unknown {
  if (e.kind === 'chest') return { kind: 'chest', x: e.x, y: e.y, z: e.z, slots: slotsToJSON(e.slots) };
  const f = e.furnace;
  return { kind: 'furnace', x: e.x, y: e.y, z: e.z, slots: slotsToJSON(f.slots), burn: f.burn, burnMax: f.burnMax, progress: f.progress };
}

function loadEntity(raw: unknown): BlockEntity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const n = (k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : NaN);
  const x = n('x');
  const y = n('y');
  const z = n('z');
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null;
  if (r['kind'] === 'chest') return { kind: 'chest', x, y, z, slots: slotsFromJSON(r['slots'], CHEST_SLOTS) };
  if (r['kind'] === 'furnace') {
    const furnace = newFurnace();
    const slots = slotsFromJSON(r['slots'], 3);
    for (let i = 0; i < 3; i++) furnace.slots[i] = slots[i] ?? null;
    furnace.burn = Math.max(0, n('burn') || 0);
    furnace.burnMax = Math.max(0, n('burnMax') || 0);
    furnace.progress = Math.max(0, n('progress') || 0);
    return { kind: 'furnace', x, y, z, furnace };
  }
  return null;
}
