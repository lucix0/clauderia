/**
 * The player's survival side: game mode, inventory, vitals, mining progress,
 * eating and death. The game feeds it input and world state each step; it
 * changes the world only through the World API and reports effects back.
 */
import { ItemEntities } from '../entities/items';
import {
  addStack,
  emptySlots,
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  PICKUP_ORDER,
  slotsFromJSON,
  slotsToJSON,
  takeOne,
  wearTool,
  type ItemStack,
  type Slots,
} from '../items/inventory';
import { itemDef, maxStack } from '../items/items';
import type { Body } from '../player/physics';
import type { Difficulty, GameMode } from '../save/records';
import { B, idOf, IS_LIQUID, OCCLUDES } from '../world/blocks';
import { breakBlock, type Cell } from '../world/placement';
import type { World } from '../world/world';
import { breakTime, drops, toolWear } from './mining';
import {
  canSprint,
  eat,
  exhaust,
  fallDamage,
  hurt,
  newVitals,
  tickVitals,
  vitalsFromJSON,
  vitalsToJSON,
  type DamageCause,
  type Hit,
  type Vitals,
} from './vitals';

/** Seconds of holding use to finish eating. */
export const EAT_TIME = 1.6;

export interface MiningState {
  x: number;
  y: number;
  z: number;
  /** 0–1. */
  progress: number;
}

export interface SurvivorEvents {
  hurt(hit: Hit): void;
  died(cause: DamageCause): void;
  /** Inventory contents changed (redraw the hotbar). */
  inventory(): void;
}

export class Survivor {
  mode: GameMode = 'creative';
  difficulty: Difficulty = 'normal';
  vitals: Vitals = newVitals();
  inventory: Slots = emptySlots(INVENTORY_SIZE);
  selected = 0;
  sprinting = false;
  sneaking = false;
  mining: MiningState | null = null;
  eating: { slot: number; time: number } | null = null;
  dead = false;
  deathCause: DamageCause | null = null;
  /** Seconds before the next block can start breaking. */
  private mineCooldown = 0;
  events: SurvivorEvents = { hurt: () => {}, died: () => {}, inventory: () => {} };
  private wasOnGround = true;

  get survival(): boolean {
    return this.mode === 'survival';
  }

  get held(): ItemStack | null {
    return this.inventory[this.selected] ?? null;
  }

  // ---- Damage ----

  /** Take damage from an outside source (mobs, commands). Creative ignores it. */
  damage(amount: number, cause: DamageCause): number {
    if (!this.survival || this.dead) return 0;
    const dealt = hurt(this.vitals, amount, cause);
    if (dealt > 0) this.afterHit({ amount: dealt, cause });
    return dealt;
  }

  private afterHit(hit: Hit): void {
    this.events.hurt(hit);
    this.eating = null;
    if (this.vitals.health <= 0 && !this.dead) {
      this.dead = true;
      this.deathCause = hit.cause;
      this.mining = null;
      this.sprinting = false;
      this.events.died(hit.cause);
    }
  }

  /** Everything carried, emptied out (for dropping on death). */
  takeAll(): ItemStack[] {
    const out: ItemStack[] = [];
    for (let i = 0; i < this.inventory.length; i++) {
      const s = this.inventory[i];
      if (s) out.push(s);
      this.inventory[i] = null;
    }
    this.events.inventory();
    return out;
  }

  respawn(): void {
    this.vitals = newVitals();
    this.dead = false;
    this.deathCause = null;
    this.mining = null;
    this.eating = null;
    this.sprinting = false;
  }

  // ---- Per physics step (60 Hz) ----

  /**
   * Movement bookkeeping after the body moved: falling, landing, exhaustion
   * from walking / sprinting / jumping.
   */
  afterMove(body: Body, prevX: number, prevY: number, prevZ: number, jumped: boolean): void {
    if (!this.survival || this.dead) {
      this.vitals.fallDistance = 0;
      this.wasOnGround = body.onGround;
      return;
    }
    const v = this.vitals;
    const dy = body.y - prevY;
    if (body.flying || body.liquid) {
      v.fallDistance = 0;
    } else if (!body.onGround && dy < 0) {
      v.fallDistance -= dy;
    }
    if (body.onGround && !this.wasOnGround) {
      const dmg = fallDamage(v.fallDistance);
      v.fallDistance = 0;
      if (dmg > 0) {
        const dealt = hurt(v, dmg, 'fall');
        if (dealt > 0) this.afterHit({ amount: dealt, cause: 'fall' });
      }
    } else if (body.onGround) {
      v.fallDistance = 0;
    }
    this.wasOnGround = body.onGround;
    const moved = Math.hypot(body.x - prevX, body.z - prevZ);
    if (this.sprinting) exhaust(v, moved * 0.1);
    else if (body.liquid) exhaust(v, moved * 0.01);
    if (jumped) exhaust(v, this.sprinting ? 0.2 : 0.05);
  }

  /** Keep sprinting only while it's allowed. */
  updateSprint(wantForward: boolean, body: Body): void {
    if (!wantForward || this.sneaking || body.hitWall || (this.survival && !canSprint(this.vitals))) this.sprinting = false;
  }

  /**
   * Survival mining: hold attack on a block until it breaks. Returns the
   * cell that broke (so the caller can remesh), or null.
   */
  updateMining(world: World, items: ItemEntities, target: Cell | null, attacking: boolean, dt: number): Cell | null {
    this.mineCooldown = Math.max(0, this.mineCooldown - dt);
    if (!attacking || !target || this.dead || this.mineCooldown > 0) {
      this.mining = null;
      return null;
    }
    const m = this.mining;
    if (!m || m.x !== target.x || m.y !== target.y || m.z !== target.z) {
      this.mining = { x: target.x, y: target.y, z: target.z, progress: 0 };
    }
    const cur = this.mining!;
    const value = world.get(target.x, target.y, target.z);
    const id = idOf(value);
    if (id === B.AIR || IS_LIQUID[id]) {
      this.mining = null;
      return null;
    }
    const time = breakTime(id, this.held);
    if (!Number.isFinite(time)) return null;
    cur.progress = time <= 0 ? 1 : cur.progress + dt / time;
    if (cur.progress < 1) return null;
    this.mining = null;
    this.mineCooldown = 0.25;
    return this.harvest(world, items, target, value) ? target : null;
  }

  /** Break a block the survival way: drops, tool wear, hunger. */
  harvest(world: World, items: ItemEntities, cell: Cell, value: number): boolean {
    const id = idOf(value);
    const held = this.held;
    if (!breakBlock(world, cell.x, cell.y, cell.z)) return false;
    for (const s of drops(value, held, Math.random)) items.dropFromBlock(s, cell.x, cell.y, cell.z);
    const wear = toolWear(id, held);
    if (wear > 0) {
      wearTool(this.inventory, this.selected, wear);
      this.events.inventory();
    }
    exhaust(this.vitals, 0.005);
    return true;
  }

  /** Hold use with food: eat once the timer runs out. Returns true when a bite finished. */
  updateEating(using: boolean, dt: number): boolean {
    const held = this.held;
    const food = held ? itemDef(held.id)?.food : null;
    if (!using || !food || this.dead || !this.survival || this.vitals.hunger >= 20) {
      this.eating = null;
      return false;
    }
    if (!this.eating || this.eating.slot !== this.selected) this.eating = { slot: this.selected, time: 0 };
    this.eating.time += dt;
    if (this.eating.time < EAT_TIME) return false;
    this.eating = null;
    takeOne(this.inventory, this.selected);
    eat(this.vitals, food);
    this.events.inventory();
    return true;
  }

  // ---- Per game tick (20 Hz) ----

  tick(world: World, body: Body, eyeY: number): void {
    if (!this.survival || this.dead) return;
    const ex = Math.floor(body.x);
    const ez = Math.floor(body.z);
    const eye = world.getVirtual(ex, Math.floor(eyeY), ez) & 0xff;
    const env = {
      headInWater: eye === B.WATER,
      inWater: body.liquid === 1 || eye === B.WATER,
      inLava: body.liquid === 2,
      headInSolid: OCCLUDES[eye] === 1 && !body.flying,
      touchingCactus: touches(world, body, B.CACTUS),
    };
    for (const hit of tickVitals(this.vitals, env, { peaceful: this.difficulty === 'peaceful' })) this.afterHit(hit);
    if (body.y < -40) this.damage(4, 'void');
  }

  // ---- Items ----

  /** Pick up a stack; returns how many didn't fit. */
  collect(s: ItemStack): number {
    const left = addStack(this.inventory, s, PICKUP_ORDER);
    if (left < s.count) this.events.inventory();
    return left;
  }

  /** Creative: fill the selected slot with a full stack of `id`. */
  giveCreative(id: number): void {
    this.inventory[this.selected] = { id, count: maxStack(id), damage: 0 };
    this.events.inventory();
  }

  /** Middle click: creative copies the block; survival selects it if it's on the hotbar. */
  pickBlock(id: number): void {
    const hit = this.inventory.findIndex((s, i) => i < HOTBAR_SLOTS && s?.id === id);
    if (hit >= 0) {
      this.selected = hit;
    } else if (!this.survival) {
      this.giveCreative(id);
    }
    this.events.inventory();
  }

  /** Use up the held item after placing it (creative never runs out). */
  consumeHeld(): void {
    if (!this.survival) return;
    takeOne(this.inventory, this.selected);
    this.events.inventory();
  }

  /** Take `all` or one of the held stack out, to throw. */
  dropHeld(all: boolean): ItemStack | null {
    const s = this.held;
    if (!s) return null;
    const n = all ? s.count : 1;
    s.count -= n;
    if (s.count <= 0) this.inventory[this.selected] = null;
    this.events.inventory();
    return { ...s, count: n };
  }

  // ---- Saving ----

  toJSON(): { vitals: Record<string, number>; inventory: ReturnType<typeof slotsToJSON> } {
    return { vitals: vitalsToJSON(this.vitals), inventory: slotsToJSON(this.inventory) };
  }

  /** Restore from a player record; old records only have a hotbar of block ids. */
  load(vitals: unknown, inventory: unknown, hotbar: readonly number[], selected: number): void {
    this.vitals = vitalsFromJSON(vitals);
    this.dead = this.vitals.health <= 0;
    if (this.dead) this.vitals = newVitals();
    this.dead = false;
    if (inventory !== undefined) {
      this.inventory = slotsFromJSON(inventory, INVENTORY_SIZE);
    } else {
      this.inventory = emptySlots(INVENTORY_SIZE);
      hotbar.forEach((id, i) => {
        if (i < HOTBAR_SLOTS && itemDef(id)) this.inventory[i] = { id, count: maxStack(id), damage: 0 };
      });
    }
    this.selected = Math.max(0, Math.min(HOTBAR_SLOTS - 1, Math.floor(selected) || 0));
    this.mining = null;
    this.eating = null;
    this.events.inventory();
  }
}

/** Does the body's box (grown by a hair) touch a block of `id`? */
function touches(world: World, body: Body, id: number): boolean {
  const e = 0.02;
  const h = body.width / 2 + e;
  const x0 = Math.floor(body.x - h);
  const x1 = Math.floor(body.x + h);
  const y0 = Math.floor(body.y - e);
  const y1 = Math.floor(body.y + body.height);
  const z0 = Math.floor(body.z - h);
  const z1 = Math.floor(body.z + h);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) if (world.getId(x, y, z) === id) return true;
    }
  }
  return false;
}
