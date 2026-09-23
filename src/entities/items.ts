/**
 * Dropped item entities: fall and slide with the shared body physics, bob,
 * drift toward a nearby player to be picked up, merge with neighbours of the
 * same kind and despawn after five minutes. Nothing moves in chunks that
 * aren't loaded and lit. Pure logic (rendering lives in itemRender.ts).
 */
import { canMerge, type ItemStack } from '../items/inventory';
import { isValidItem, maxStack } from '../items/items';
import { createBody, moveBody, type Body, type CollisionWorld } from '../player/physics';

export const ITEM_SIZE = 0.25;
/** Seconds before an item despawns. */
export const ITEM_LIFETIME = 300;
const GRAVITY = 16;
/** Items drift toward a player this close (to the middle of the body). */
const PICKUP_RADIUS = 2.6;
/** Collected once inside the player's box grown by this much. */
const COLLECT_REACH_H = 0.6;
const COLLECT_REACH_V = 0.5;
const MERGE_RADIUS = 0.8;

export interface ItemEntity {
  readonly id: number;
  stack: ItemStack;
  readonly body: Body;
  /** Seconds alive. */
  age: number;
  /** Seconds until it can be picked up. */
  pickupDelay: number;
  /** Random phase for the bobbing animation. */
  readonly phase: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  removed: boolean;
}

/** What item updates need from the game. */
export interface ItemWorld extends CollisionWorld {
  /** Is the column loaded and lit (safe to simulate)? */
  active(x: number, z: number): boolean;
}

export interface Collector {
  /** Player feet position, or null when nobody can collect (dead, spectating). */
  x: number;
  y: number;
  z: number;
  /** Put a stack into the inventory; returns how many didn't fit. */
  collect(stack: ItemStack): number;
}

export class ItemEntities {
  readonly list: ItemEntity[] = [];
  private nextId = 1;
  private mergeTimer = 0;
  /** Called when something was collected (sound / HUD refresh). */
  onCollect: (stack: ItemStack) => void = () => {};

  spawn(stack: ItemStack, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, pickupDelay = 0.5): ItemEntity | null {
    if (stack.count <= 0 || !isValidItem(stack.id)) return null;
    const body = createBody(x, y, z, ITEM_SIZE, ITEM_SIZE);
    body.vx = vx;
    body.vy = vy;
    body.vz = vz;
    const e: ItemEntity = {
      id: this.nextId++,
      stack: { ...stack },
      body,
      age: 0,
      pickupDelay,
      phase: Math.random() * Math.PI * 2,
      prevX: x,
      prevY: y,
      prevZ: z,
      removed: false,
    };
    this.list.push(e);
    return e;
  }

  /** Drop a stack popping out of a block cell (centre, small random kick). */
  dropFromBlock(stack: ItemStack, x: number, y: number, z: number, rand: () => number = Math.random): void {
    this.spawn(stack, x + 0.5, y + 0.25, z + 0.5, (rand() - 0.5) * 2.5, 3 + rand() * 1.5, (rand() - 0.5) * 2.5, 0.5);
  }

  update(world: ItemWorld, dt: number, player: Collector | null): void {
    for (const e of this.list) {
      if (e.removed) continue;
      const b = e.body;
      e.prevX = b.x;
      e.prevY = b.y;
      e.prevZ = b.z;
      if (!world.active(Math.floor(b.x), Math.floor(b.z))) continue;
      e.age += dt;
      if (e.age >= ITEM_LIFETIME) {
        e.removed = true;
        continue;
      }
      e.pickupDelay = Math.max(0, e.pickupDelay - dt);

      // Drift toward the player once pickable.
      let pulled = false;
      if (player && e.pickupDelay === 0) {
        const dx = player.x - b.x;
        const dy = player.y + 0.9 - b.y;
        const dz = player.z - b.z;
        const d = Math.hypot(dx, dy, dz);
        const reach = 0.3 + COLLECT_REACH_H;
        const inside =
          Math.abs(dx) < reach && Math.abs(dz) < reach && b.y > player.y - COLLECT_REACH_V && b.y < player.y + 1.8 + COLLECT_REACH_V;
        if (inside) {
          const left = player.collect(e.stack);
          if (left < e.stack.count) this.onCollect({ ...e.stack, count: e.stack.count - left });
          if (left <= 0) {
            e.removed = true;
            continue;
          }
          e.stack.count = left;
        } else if (d < PICKUP_RADIUS) {
          const pull = 14 / Math.max(d, 0.3);
          b.vx += (dx * pull - b.vx) * Math.min(1, dt * 6);
          b.vy += (dy * pull - b.vy) * Math.min(1, dt * 6);
          b.vz += (dz * pull - b.vz) * Math.min(1, dt * 6);
          pulled = true;
        }
      }

      const liquid = world.liquidAt(Math.floor(b.x), Math.floor(b.y + 0.1), Math.floor(b.z));
      if (!pulled) {
        if (liquid) {
          // Float gently up in water, sink slowly in lava.
          b.vy += ((liquid === 1 ? 1.2 : -0.5) - b.vy) * Math.min(1, dt * 3);
          b.vx *= 1 - Math.min(1, dt * 3);
          b.vz *= 1 - Math.min(1, dt * 3);
        } else {
          b.vy = Math.max(-40, b.vy - GRAVITY * dt);
        }
        if (b.onGround) {
          const f = 1 - Math.min(1, dt * 10);
          b.vx *= f;
          b.vz *= f;
        }
      }
      const dy = b.vy * dt;
      const r = moveBody(world, b, b.vx * dt, dy, b.vz * dt);
      if (r.hitX) b.vx = 0;
      if (r.hitZ) b.vz = 0;
      if (r.landed) {
        b.onGround = true;
        b.vy = 0;
      } else {
        if (r.hitY) b.vy = 0;
        b.onGround = false;
      }
      if (b.y < -64) e.removed = true;
    }

    this.mergeTimer += dt;
    if (this.mergeTimer >= 0.5) {
      this.mergeTimer = 0;
      this.merge();
    }
    this.compact();
  }

  /** Stacks of the same item lying close together become one. */
  private merge(): void {
    const items = this.list;
    for (let i = 0; i < items.length; i++) {
      const a = items[i]!;
      if (a.removed) continue;
      const max = maxStack(a.stack.id);
      if (a.stack.count >= max) continue;
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j]!;
        if (b.removed || !canMerge(a.stack, b.stack)) continue;
        const d = Math.hypot(a.body.x - b.body.x, a.body.y - b.body.y, a.body.z - b.body.z);
        if (d > MERGE_RADIUS) continue;
        const move = Math.min(b.stack.count, max - a.stack.count);
        a.stack.count += move;
        b.stack.count -= move;
        a.age = Math.min(a.age, b.age);
        if (b.stack.count <= 0) b.removed = true;
        if (a.stack.count >= max) break;
      }
    }
  }

  private compact(): void {
    let w = 0;
    for (const e of this.list) if (!e.removed) this.list[w++] = e;
    this.list.length = w;
  }

  /** Items whose position lies in chunk (cx, cz); `remove` takes them out. */
  inChunk(cx: number, cz: number, remove: boolean): ItemEntity[] {
    const out: ItemEntity[] = [];
    for (const e of this.list) {
      if (e.removed) continue;
      if (Math.floor(e.body.x) >> 4 !== cx || Math.floor(e.body.z) >> 4 !== cz) continue;
      out.push(e);
      if (remove) e.removed = true;
    }
    if (remove) this.compact();
    return out;
  }

  clear(): void {
    this.list.length = 0;
  }
}

/** Save form of an item entity. */
export interface SavedItem {
  id: number;
  count: number;
  damage: number;
  x: number;
  y: number;
  z: number;
  age: number;
}

export function saveItem(e: ItemEntity): SavedItem {
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return { ...e.stack, x: r(e.body.x), y: r(e.body.y), z: r(e.body.z), age: Math.round(e.age) };
}

/** Restore saved items (skipping anything malformed). */
export function loadItems(entities: ItemEntities, raw: readonly unknown[]): number {
  let n = 0;
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const nums = ['id', 'count', 'damage', 'x', 'y', 'z', 'age'].map((k) => o[k]);
    if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const [id, count, damage, x, y, z, age] = nums as number[];
    const e = entities.spawn({ id: id!, count: Math.min(count!, maxStack(id!)), damage: damage! }, x!, y!, z!, 0, 0, 0, 0);
    if (e) {
      e.age = age!;
      n++;
    }
  }
  return n;
}
