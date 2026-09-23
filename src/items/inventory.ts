/**
 * Item stacks and slot operations (pure). A slot array is a plain
 * `Array<ItemStack | null>`; the player inventory is 36 slots, 0–8 being the
 * hotbar. The "cursor" is the stack carried by the mouse in a container UI.
 */
import { itemDef, maxStack } from './items';

export interface ItemStack {
  id: number;
  count: number;
  /** Durability used up (tools); 0 for everything else. */
  damage: number;
}

export type Slots = Array<ItemStack | null>;

export const INVENTORY_SIZE = 36;
export const HOTBAR_SLOTS = 9;

export function stack(id: number, count = 1, damage = 0): ItemStack {
  return { id, count, damage };
}

export function emptySlots(n: number): Slots {
  return Array.from({ length: n }, () => null);
}

/** Can b be merged onto a (same item, both undamaged, stackable)? */
export function canMerge(a: ItemStack, b: ItemStack): boolean {
  return a.id === b.id && a.damage === 0 && b.damage === 0 && maxStack(a.id) > 1;
}

/** Hotbar first, then the main inventory: where picked-up items go. */
export const PICKUP_ORDER: readonly number[] = Array.from({ length: INVENTORY_SIZE }, (_, i) => i);

/**
 * Put as much of `s` as fits into `slots` (only the indices in `order`):
 * first onto matching stacks, then into empty slots. Returns what's left
 * (0 when it all fit). Mutates `slots`, not `s`.
 */
export function addStack(slots: Slots, s: ItemStack, order: readonly number[] = slots.map((_, i) => i)): number {
  let left = s.count;
  const max = maxStack(s.id);
  for (const i of order) {
    if (left <= 0) break;
    const cur = slots[i];
    if (!cur || !canMerge(cur, s)) continue;
    const move = Math.min(left, max - cur.count);
    if (move > 0) {
      cur.count += move;
      left -= move;
    }
  }
  for (const i of order) {
    if (left <= 0) break;
    if (slots[i]) continue;
    const move = Math.min(left, max);
    slots[i] = { id: s.id, count: move, damage: s.damage };
    left -= move;
  }
  return left;
}

/** How many of item `id` the slots hold in total. */
export function countItem(slots: Slots, id: number): number {
  let n = 0;
  for (const s of slots) if (s && s.id === id) n += s.count;
  return n;
}

/** Remove one item from a slot (placing a block, eating). */
export function takeOne(slots: Slots, i: number): ItemStack | null {
  const s = slots[i];
  if (!s) return null;
  s.count--;
  if (s.count <= 0) slots[i] = null;
  return { id: s.id, count: 1, damage: s.damage };
}

/**
 * Wear a tool (or bow) in a slot by `amount`; it breaks (slot empties) when its
 * durability runs out. Returns true if it broke.
 */
export function wearTool(slots: Slots, i: number, amount = 1): boolean {
  const s = slots[i];
  const durability = s ? (itemDef(s.id)?.durability ?? 0) : 0;
  if (!s || durability <= 0) return false;
  s.damage += amount;
  if (s.damage >= durability) {
    slots[i] = null;
    return true;
  }
  return false;
}

export type Button = 'left' | 'right';

/**
 * Click slot `i` holding `cursor`; returns the new cursor. Left: pick up,
 * put down, merge or swap. Right: pick up half, or put down one.
 * `accepts` limits what may be put into the slot.
 */
export function clickSlot(
  slots: Slots,
  i: number,
  cursor: ItemStack | null,
  button: Button,
  accepts: (s: ItemStack) => boolean = () => true,
): ItemStack | null {
  const cur = slots[i] ?? null;
  if (!cursor) {
    if (!cur) return null;
    if (button === 'left') {
      slots[i] = null;
      return cur;
    }
    const take = Math.ceil(cur.count / 2);
    const picked = { ...cur, count: take };
    cur.count -= take;
    if (cur.count <= 0) slots[i] = null;
    return picked;
  }
  if (!accepts(cursor)) return cursor;
  const max = maxStack(cursor.id);
  if (!cur) {
    if (button === 'left') {
      const put = Math.min(cursor.count, max);
      slots[i] = { ...cursor, count: put };
      return cursor.count - put > 0 ? { ...cursor, count: cursor.count - put } : null;
    }
    slots[i] = { ...cursor, count: 1 };
    return cursor.count > 1 ? { ...cursor, count: cursor.count - 1 } : null;
  }
  if (canMerge(cur, cursor)) {
    const room = max - cur.count;
    const put = Math.min(room, button === 'left' ? cursor.count : 1);
    cur.count += put;
    return cursor.count - put > 0 ? { ...cursor, count: cursor.count - put } : null;
  }
  // Different items: swap.
  slots[i] = cursor;
  return cur;
}

/**
 * Take a result (crafting output) into the cursor: only if the cursor is
 * empty or can absorb the whole result. Returns the new cursor, or null
 * with `taken` false when it can't.
 */
export function takeResult(cursor: ItemStack | null, result: ItemStack): { cursor: ItemStack | null; taken: boolean } {
  if (!cursor) return { cursor: { ...result }, taken: true };
  if (canMerge(cursor, result) && cursor.count + result.count <= maxStack(result.id)) {
    return { cursor: { ...cursor, count: cursor.count + result.count }, taken: true };
  }
  return { cursor, taken: false };
}

/**
 * Shift-click: move a whole stack from slot `i` of `from` into `to`
 * (in `order`). Whatever doesn't fit stays.
 */
export function quickMove(from: Slots, i: number, to: Slots, order: readonly number[]): void {
  const s = from[i];
  if (!s) return;
  const left = addStack(to, s, order);
  if (left <= 0) from[i] = null;
  else s.count = left;
}

/** Serialise slots for a save (null for empty). */
export function slotsToJSON(slots: Slots): Array<[number, number, number] | null> {
  return slots.map((s) => (s ? [s.id, s.count, s.damage] : null));
}

/** Read slots back, dropping anything unknown or malformed. */
export function slotsFromJSON(raw: unknown, size: number): Slots {
  const out = emptySlots(size);
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < Math.min(size, raw.length); i++) {
    const r: unknown = raw[i];
    if (!Array.isArray(r)) continue;
    const [id, count, damage] = r as unknown[];
    if (typeof id !== 'number' || typeof count !== 'number' || !itemDef(id)) continue;
    const n = Math.max(0, Math.min(maxStack(id), Math.floor(count)));
    if (n > 0) out[i] = { id, count: n, damage: typeof damage === 'number' && damage > 0 ? Math.floor(damage) : 0 };
  }
  return out;
}
