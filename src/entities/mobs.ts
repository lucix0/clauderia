/**
 * Mobs: passive animals (pig, cow, sheep) and hostiles (zombie, skeleton,
 * spider) on the shared body physics. Thinking happens at 10 Hz, movement
 * every physics step. Nothing moves in chunks that aren't loaded and lit.
 * Pure logic; drawing lives in mobRender.ts.
 */
import type { ItemStack } from '../items/inventory';
import { I } from '../items/items';
import { createBody, moveBody, stepBody, type Body, type CollisionWorld } from '../player/physics';
import { B, IS_LIQUID, IS_SOLID, supportsPlant } from '../world/blocks';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'zombie' | 'skeleton' | 'spider';
export const MOB_KINDS: readonly MobKind[] = ['pig', 'cow', 'sheep', 'zombie', 'skeleton', 'spider'];

export interface MobDef {
  readonly kind: MobKind;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly health: number;
  /** Walking speed, blocks per second. */
  readonly speed: number;
  readonly hostile: boolean;
  /** Burns in sunlight. */
  readonly undead: boolean;
  /** Melee damage (hostiles). */
  readonly damage: number;
  drops(rand: () => number): ItemStack[];
}

const stack = (id: number, count: number): ItemStack => ({ id, count, damage: 0 });
const between = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

export const MOBS: Readonly<Record<MobKind, MobDef>> = {
  pig: {
    kind: 'pig', name: 'Pig', width: 0.9, height: 0.9, health: 10, speed: 2.2, hostile: false, undead: false, damage: 0,
    drops: (r) => [stack(I.RAW_PORK, between(r, 1, 3))],
  },
  cow: {
    kind: 'cow', name: 'Cow', width: 0.9, height: 1.4, health: 10, speed: 2, hostile: false, undead: false, damage: 0,
    drops: (r) => [stack(I.RAW_BEEF, between(r, 1, 3))],
  },
  sheep: {
    kind: 'sheep', name: 'Sheep', width: 0.9, height: 1.3, health: 8, speed: 2.1, hostile: false, undead: false, damage: 0,
    drops: () => [stack(B.WOOL_FIRST + 15, 1)],
  },
  zombie: {
    kind: 'zombie', name: 'Zombie', width: 0.6, height: 1.9, health: 20, speed: 2.3, hostile: true, undead: true, damage: 3,
    drops: (r) => (r() < 0.05 ? [stack(I.IRON_INGOT, 1)] : []),
  },
  skeleton: {
    kind: 'skeleton', name: 'Skeleton', width: 0.6, height: 1.9, health: 20, speed: 2.4, hostile: true, undead: true, damage: 2,
    drops: (r) => {
      const n = between(r, 0, 2);
      return n > 0 ? [stack(I.BONE, n)] : [];
    },
  },
  spider: {
    kind: 'spider', name: 'Spider', width: 1.3, height: 0.8, health: 16, speed: 3.4, hostile: true, undead: false, damage: 2,
    drops: (r) => {
      const n = between(r, 0, 2);
      return n > 0 ? [stack(I.STRING, n)] : [];
    },
  },
};

type Mode = 'idle' | 'wander' | 'flee' | 'chase' | 'hold';

export interface Mob {
  readonly id: number;
  readonly def: MobDef;
  readonly body: Body;
  yaw: number;
  health: number;
  /** Seconds left of the red hurt flash (also invulnerability). */
  hurt: number;
  /** Seconds since dying began (−1 alive). */
  dying: number;
  /** Seconds left burning. */
  fire: number;
  mode: Mode;
  targetX: number;
  targetZ: number;
  /** Seconds before the current plan is reconsidered. */
  timer: number;
  attackCooldown: number;
  /** Hit by the player: spiders turn hostile, animals flee. */
  provoked: number;
  /** Distance fallen since last on the ground. */
  fall: number;
  /** Walk animation phase and how strongly the legs swing (0–1). */
  walk: number;
  swing: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  removed: boolean;
}

export interface Arrow {
  readonly id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  /** Stuck in a block: seconds left before it vanishes. */
  stuck: number;
  age: number;
  removed: boolean;
}

/** What mobs need from the world. */
export interface MobWorld extends CollisionWorld {
  active(x: number, z: number): boolean;
  blockId(x: number, y: number, z: number): number;
  /** Packed light (sky << 4 | block). */
  light(x: number, y: number, z: number): number;
  /** 0 night … 1 day. */
  readonly daylight: number;
}

/** The player as mobs see it. */
export interface MobTarget {
  x: number;
  y: number;
  z: number;
  /** Can be attacked (alive, survival mode). */
  attackable: boolean;
  /** Take a hit from (fromX, fromZ); returns damage dealt. */
  hurt(amount: number, fromX: number, fromZ: number): number;
}

export interface MobEvents {
  /** A mob finished dying: drop its loot. */
  died(mob: Mob, loot: ItemStack[]): void;
  /** A mob took damage (health may now be 0). */
  hurt?(mob: Mob): void;
  /** A skeleton loosed an arrow. */
  shot?(mob: Mob): void;
  /** An arrow stuck into a block at (x, y, z). */
  arrowStuck?(x: number, y: number, z: number): void;
}

const THINK_INTERVAL = 0.1;
const HOSTILE_CAP = 20;
const DESPAWN_FAR = 128;
const DESPAWN_MAYBE = 40;
const SPAWN_MIN = 24;
const SPAWN_MAX = 56;
const ARROW_GRAVITY = 18;
/** Falls up to this far are harmless. */
const SAFE_FALL = 3;

/** Effective light level for spawning: block light, or sky light dimmed by night. */
export function effectiveLight(packed: number, daylight: number): number {
  const sky = Math.max(0, (packed >> 4) - Math.round((1 - daylight) * 11));
  return Math.max(sky, packed & 15);
}

export class Mobs {
  readonly list: Mob[] = [];
  readonly arrows: Arrow[] = [];
  events: MobEvents = { died: () => {} };
  private nextId = 1;
  private thinkTimer = 0;
  private spawnTimer = 0;

  constructor(private readonly rand: () => number = Math.random) {}

  get hostileCount(): number {
    return this.list.filter((m) => !m.removed && m.def.hostile).length;
  }

  spawn(kind: MobKind, x: number, y: number, z: number, yaw = this.rand() * Math.PI * 2): Mob {
    const def = MOBS[kind];
    const body = createBody(x, y, z, def.width, def.height);
    const mob: Mob = {
      id: this.nextId++,
      def,
      body,
      yaw,
      health: def.health,
      hurt: 0,
      dying: -1,
      fire: 0,
      mode: 'idle',
      targetX: x,
      targetZ: z,
      timer: this.rand() * 2,
      attackCooldown: 0,
      provoked: 0,
      fall: 0,
      walk: 0,
      swing: 0,
      prevX: x,
      prevY: y,
      prevZ: z,
      removed: false,
    };
    this.list.push(mob);
    return mob;
  }

  // ---- Combat ----

  /**
   * The player hits a mob for `damage` from (fromX, fromZ). Returns false
   * while it's still flashing from the last hit.
   */
  hit(mob: Mob, damage: number, fromX: number, fromZ: number): boolean {
    if (mob.dying >= 0 || mob.hurt > 0) return false;
    mob.health -= damage;
    mob.hurt = 0.5;
    mob.provoked = 20;
    const dx = mob.body.x - fromX;
    const dz = mob.body.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    mob.body.vx += (dx / d) * 7;
    mob.body.vz += (dz / d) * 7;
    if (mob.body.onGround) mob.body.vy = 5;
    if (!mob.def.hostile) {
      mob.mode = 'flee';
      mob.timer = 4 + this.rand() * 2;
      mob.targetX = mob.body.x + (dx / d) * 10;
      mob.targetZ = mob.body.z + (dz / d) * 10;
    }
    if (mob.health <= 0) mob.dying = 0;
    this.events.hurt?.(mob);
    return true;
  }

  kill(mob: Mob): void {
    if (mob.dying < 0) {
      mob.health = 0;
      mob.dying = 0;
    }
  }

  /** Nearest living mob the ray (unit direction) hits within `reach`, with its distance. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number): { mob: Mob; t: number } | null {
    let best: { mob: Mob; t: number } | null = null;
    for (const m of this.list) {
      if (m.removed || m.dying >= 0) continue;
      const b = m.body;
      const h = b.width / 2;
      const t = rayBox(ox, oy, oz, dx, dy, dz, b.x - h, b.y, b.z - h, b.x + h, b.y + b.height, b.z + h);
      if (t !== null && t <= reach && (!best || t < best.t)) best = { mob: m, t };
    }
    return best;
  }

  // ---- Simulation ----

  /** Advance by one physics step. */
  update(world: MobWorld, dt: number, player: MobTarget | null, peaceful: boolean): void {
    this.thinkTimer += dt;
    const think = this.thinkTimer >= THINK_INTERVAL;
    if (think) this.thinkTimer = 0;
    for (const m of this.list) {
      if (m.removed) continue;
      const b = m.body;
      m.prevX = b.x;
      m.prevY = b.y;
      m.prevZ = b.z;
      if (peaceful && m.def.hostile) {
        m.removed = true;
        continue;
      }
      if (!world.active(Math.floor(b.x), Math.floor(b.z))) continue;
      m.hurt = Math.max(0, m.hurt - dt);
      m.attackCooldown = Math.max(0, m.attackCooldown - dt);
      m.provoked = Math.max(0, m.provoked - dt);
      if (m.dying >= 0) {
        m.dying += dt;
        // Keep falling / sliding while toppling over.
        this.move(world, m, dt, 0, false);
        if (m.dying >= 0.9) {
          m.removed = true;
          this.events.died(m, m.def.drops(this.rand));
        }
        continue;
      }
      if (think) this.think(world, m, player);
      this.act(world, m, dt, player);
      this.environment(world, m, dt);
    }
    this.updateArrows(world, dt, player);
    this.compact();
  }

  /** Every second: maybe spawn hostiles in the dark near the player, despawn far ones. */
  spawnTick(world: MobWorld, player: { x: number; y: number; z: number }, dt: number, allowHostile: boolean): void {
    this.spawnTimer += dt;
    if (this.spawnTimer < 1) return;
    this.spawnTimer = 0;
    for (const m of this.list) {
      if (m.removed || !m.def.hostile) continue;
      const d = Math.hypot(m.body.x - player.x, m.body.z - player.z);
      if (d > DESPAWN_FAR || (d > DESPAWN_MAYBE && this.rand() < 1 / 30)) m.removed = true;
    }
    if (!allowHostile || this.hostileCount >= HOSTILE_CAP) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = this.rand() * Math.PI * 2;
      const r = SPAWN_MIN + this.rand() * (SPAWN_MAX - SPAWN_MIN);
      const x = Math.floor(player.x + Math.cos(a) * r);
      const z = Math.floor(player.z + Math.sin(a) * r);
      if (!world.active(x, z)) continue;
      const y = this.findSpawnY(world, x, Math.floor(player.y), z);
      if (y === null) continue;
      const roll = this.rand();
      const kind: MobKind = roll < 0.4 ? 'zombie' : roll < 0.75 ? 'skeleton' : 'spider';
      if (kind === 'spider' && !this.roomFor(world, x, y, z, 2)) continue;
      this.spawn(kind, x + 0.5, y, z + 0.5);
      if (this.hostileCount >= HOSTILE_CAP) break;
    }
  }

  /** A dark floor cell near height `near` with two free cells above, or null. */
  private findSpawnY(world: MobWorld, x: number, near: number, z: number): number | null {
    for (let y = Math.min(126, near + 16); y > Math.max(1, near - 24); y--) {
      if (!supportsPlant(world.blockId(x, y - 1, z))) continue;
      if (!this.free(world, x, y, z) || !this.free(world, x, y + 1, z)) continue;
      if (effectiveLight(world.light(x, y, z), world.daylight) > 7) continue;
      return y;
    }
    return null;
  }

  private free(world: MobWorld, x: number, y: number, z: number): boolean {
    const id = world.blockId(x, y, z);
    return !IS_SOLID[id] && !IS_LIQUID[id];
  }

  private roomFor(world: MobWorld, x: number, y: number, z: number, r: number): boolean {
    for (let dx = -1; dx < r; dx++) for (let dz = -1; dz < r; dz++) if (!this.free(world, x + dx, y, z + dz)) return false;
    return true;
  }

  // ---- AI ----

  private think(world: MobWorld, m: Mob, player: MobTarget | null): void {
    const b = m.body;
    m.timer -= THINK_INTERVAL;
    const dist = player ? Math.hypot(player.x - b.x, player.z - b.z) : Infinity;
    const vertical = player ? Math.abs(player.y - b.y) : Infinity;
    if (m.def.hostile && player?.attackable && dist < 18 && vertical < 10 && this.aggressive(world, m)) {
      if (m.def.kind === 'skeleton') {
        // Keep a shooting distance.
        m.mode = dist < 6 ? 'flee' : dist > 11 ? 'chase' : 'hold';
        const away = dist < 6;
        m.targetX = away ? b.x + (b.x - player.x) : player.x;
        m.targetZ = away ? b.z + (b.z - player.z) : player.z;
      } else {
        m.mode = 'chase';
        m.targetX = player.x;
        m.targetZ = player.z;
      }
      return;
    }
    if (m.mode === 'flee' && m.timer > 0 && !m.def.hostile) return;
    if (m.mode === 'chase' || m.mode === 'hold') m.mode = 'idle';
    if (m.timer > 0) return;
    // Wander: pick a nearby spot, or stand around for a bit.
    if (this.rand() < 0.6) {
      const a = this.rand() * Math.PI * 2;
      const r = 3 + this.rand() * 6;
      m.mode = 'wander';
      m.targetX = b.x + Math.cos(a) * r;
      m.targetZ = b.z + Math.sin(a) * r;
      m.timer = 4 + this.rand() * 4;
    } else {
      m.mode = 'idle';
      m.timer = 2 + this.rand() * 5;
    }
  }

  /** Spiders leave you alone in daylight unless you hit them. */
  private aggressive(world: MobWorld, m: Mob): boolean {
    if (m.def.kind !== 'spider' || m.provoked > 0) return true;
    const b = m.body;
    return effectiveLight(world.light(Math.floor(b.x), Math.floor(b.y + 0.5), Math.floor(b.z)), world.daylight) <= 7;
  }

  private act(world: MobWorld, m: Mob, dt: number, player: MobTarget | null): void {
    const b = m.body;
    let forward = 0;
    let speed = 1;
    if (m.mode !== 'idle') {
      const dx = m.targetX - b.x;
      const dz = m.targetZ - b.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) {
        const want = Math.atan2(-dx, -dz);
        m.yaw = turnToward(m.yaw, want, dt * 8);
        forward = m.mode === 'hold' ? 0 : 1;
      } else if (m.mode === 'wander') {
        m.mode = 'idle';
      }
      if (m.mode === 'flee') speed = m.def.hostile ? 1 : 1.5;
      if (m.mode === 'hold' && player) m.yaw = turnToward(m.yaw, Math.atan2(-(player.x - b.x), -(player.z - b.z)), dt * 8);
      if (m.mode === 'chase' && m.def.kind === 'spider') speed = 1.1;
    }
    // Don't walk off cliffs or into lava while calm.
    if (forward && m.mode !== 'chase' && this.danger(world, m)) {
      forward = 0;
      if (m.mode === 'wander') {
        m.mode = 'idle';
        m.timer = 0.5;
      }
    }
    this.move(world, m, dt, forward * speed, forward > 0);

    if (!player || !player.attackable || !m.def.hostile) return;
    const px = player.x - b.x;
    const pz = player.z - b.z;
    const horiz = Math.hypot(px, pz);
    const py = player.y - b.y;
    if (m.def.kind === 'skeleton') {
      if ((m.mode === 'hold' || m.mode === 'chase' || m.mode === 'flee') && horiz < 16 && m.attackCooldown === 0) {
        this.shoot(m, player);
        m.attackCooldown = 2 + this.rand();
      }
      return;
    }
    // Melee: close enough and roughly level.
    const reach = m.def.width / 2 + 0.9;
    if (m.mode === 'chase' && horiz < reach && py > -1.5 && py < 2 && m.attackCooldown === 0) {
      player.hurt(m.def.damage, b.x, b.z);
      m.attackCooldown = 1;
    } else if (m.def.kind === 'spider' && m.mode === 'chase' && horiz < 3.5 && horiz > 1.5 && b.onGround && m.attackCooldown === 0) {
      // Pounce.
      b.vy = 6;
      b.vx += (px / horiz) * 4;
      b.vz += (pz / horiz) * 4;
    }
  }

  /** Physics step with the shared body code; hops up steps and climbs (spiders). */
  private move(world: MobWorld, m: Mob, dt: number, forward: number, trying: boolean): void {
    const b = m.body;
    const jump = (trying && b.hitWall && b.onGround) || b.liquid > 0;
    const px = b.x;
    const pz = b.z;
    const py = b.y;
    stepBody(world, b, { forward: forward > 0 ? 1 : 0, strafe: 0, jump, down: false, yaw: m.yaw, walkSpeed: m.def.speed * Math.max(1, forward) }, dt);
    if (m.def.kind === 'spider' && trying && b.hitWall) {
      // Climb straight up the wall.
      b.vy = Math.max(b.vy, 3);
      moveBody(world, b, 0, 3 * dt, 0);
    }
    const moved = Math.hypot(b.x - px, b.z - pz);
    m.swing += ((moved > 0.004 ? 1 : 0) - m.swing) * Math.min(1, dt * 8);
    m.walk += moved * 2.4;
    // Fall damage.
    const dy = b.y - py;
    if (b.liquid) m.fall = 0;
    else if (!b.onGround && dy < 0) m.fall -= dy;
    else if (b.onGround) {
      if (m.fall > SAFE_FALL && m.dying < 0) this.damage(m, Math.ceil(m.fall - 3));
      m.fall = 0;
    }
  }

  /** Is the way ahead a drop of more than 3 blocks, or lava? */
  private danger(world: MobWorld, m: Mob): boolean {
    const b = m.body;
    const ax = Math.floor(b.x - Math.sin(m.yaw) * (b.width / 2 + 0.5));
    const az = Math.floor(b.z - Math.cos(m.yaw) * (b.width / 2 + 0.5));
    const y = Math.floor(b.y);
    for (let dy = 0; dy >= -4; dy--) {
      const id = world.blockId(ax, y + dy - 1, az);
      if (id === B.LAVA) return true;
      if (IS_SOLID[id] || id === B.WATER) return false;
    }
    return true;
  }

  private environment(world: MobWorld, m: Mob, dt: number): void {
    const b = m.body;
    if (b.liquid === 2) {
      m.fire = 8;
      this.damage(m, 4);
    }
    const head = Math.floor(b.y + b.height - 0.2);
    if (m.def.undead && world.daylight > 0.45 && !b.liquid) {
      const sky = world.light(Math.floor(b.x), head, Math.floor(b.z)) >> 4;
      if (sky >= 15) m.fire = Math.max(m.fire, 3);
    }
    if (b.liquid === 1) m.fire = 0;
    if (m.fire > 0) {
      const before = Math.floor(m.fire);
      m.fire -= dt;
      if (Math.floor(m.fire) !== before) this.damage(m, 1);
    }
    if (b.y < -40) m.removed = true;
  }

  /** Damage from the environment (no knockback). */
  private damage(m: Mob, amount: number): void {
    if (m.dying >= 0 || m.hurt > 0) return;
    m.health -= amount;
    m.hurt = 0.5;
    if (m.health <= 0) m.dying = 0;
    this.events.hurt?.(m);
  }

  // ---- Arrows ----

  private shoot(m: Mob, player: MobTarget): void {
    const b = m.body;
    const ex = b.x;
    const ey = b.y + b.height * 0.8;
    const ez = b.z;
    const tx = player.x;
    const ty = player.y + 1.2;
    const tz = player.z;
    const horiz = Math.hypot(tx - ex, tz - ez);
    const speed = 16;
    const time = horiz / speed;
    // Aim high enough that gravity brings the arrow onto the target.
    const vy = (ty - ey) / time + 0.5 * ARROW_GRAVITY * time;
    const spread = 0.04;
    this.arrows.push({
      id: this.nextId++,
      x: ex,
      y: ey,
      z: ez,
      vx: ((tx - ex) / horiz) * speed + (this.rand() - 0.5) * spread * speed,
      vy,
      vz: ((tz - ez) / horiz) * speed + (this.rand() - 0.5) * spread * speed,
      prevX: ex,
      prevY: ey,
      prevZ: ez,
      stuck: 0,
      age: 0,
      removed: false,
    });
    this.events.shot?.(m);
  }

  private updateArrows(world: MobWorld, dt: number, player: MobTarget | null): void {
    for (const a of this.arrows) {
      if (a.removed) continue;
      a.prevX = a.x;
      a.prevY = a.y;
      a.prevZ = a.z;
      a.age += dt;
      if (a.stuck > 0) {
        a.stuck -= dt;
        if (a.stuck <= 0) a.removed = true;
        continue;
      }
      if (a.age > 10) {
        a.removed = true;
        continue;
      }
      a.vy -= ARROW_GRAVITY * dt;
      // Sub-steps so fast arrows don't pass through thin things.
      const steps = 4;
      for (let s = 0; s < steps && !a.removed && a.stuck <= 0; s++) {
        a.x += (a.vx * dt) / steps;
        a.y += (a.vy * dt) / steps;
        a.z += (a.vz * dt) / steps;
        if (world.solidHeight(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)) > a.y - Math.floor(a.y)) {
          a.stuck = 8;
          this.events.arrowStuck?.(a.x, a.y, a.z);
          break;
        }
        if (player?.attackable && Math.abs(a.x - player.x) < 0.4 && Math.abs(a.z - player.z) < 0.4 && a.y > player.y && a.y < player.y + 1.8) {
          player.hurt(3, a.x - a.vx, a.z - a.vz);
          a.removed = true;
        }
      }
    }
    let w = 0;
    for (const a of this.arrows) if (!a.removed) this.arrows[w++] = a;
    this.arrows.length = w;
  }

  private compact(): void {
    let w = 0;
    for (const m of this.list) if (!m.removed) this.list[w++] = m;
    this.list.length = w;
  }

  // ---- Saving ----

  /** Passive mobs in chunk (cx, cz) in save form; `remove` unloads all mobs there (hostiles vanish). */
  inChunk(cx: number, cz: number, remove: boolean): unknown[] {
    const out: unknown[] = [];
    for (const m of this.list) {
      if (m.removed) continue;
      if (Math.floor(m.body.x) >> 4 !== cx || Math.floor(m.body.z) >> 4 !== cz) continue;
      if (!m.def.hostile && m.dying < 0) {
        const r = (v: number): number => Math.round(v * 100) / 100;
        out.push({ kind: m.def.kind, x: r(m.body.x), y: r(m.body.y), z: r(m.body.z), yaw: r(m.yaw), health: m.health });
      }
      if (remove) m.removed = true;
    }
    if (remove) this.compact();
    return out;
  }

  load(raw: readonly unknown[]): void {
    for (const r of raw) {
      if (typeof r !== 'object' || r === null) continue;
      const o = r as Record<string, unknown>;
      const kind = o['kind'];
      if (typeof kind !== 'string' || !(MOB_KINDS as readonly string[]).includes(kind)) continue;
      const [x, y, z, yaw, health] = ['x', 'y', 'z', 'yaw', 'health'].map((k) => o[k]);
      if (![x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const m = this.spawn(kind as MobKind, x as number, y as number, z as number, typeof yaw === 'number' ? yaw : 0);
      if (typeof health === 'number' && health > 0) m.health = Math.min(health, m.def.health);
    }
  }

  clear(): void {
    this.list.length = 0;
    this.arrows.length = 0;
  }
}

function turnToward(yaw: number, want: number, max: number): number {
  let d = want - yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return yaw + Math.max(-max, Math.min(max, d));
}

/** Ray / AABB slab test; returns the entry distance or null. */
function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]!) < 1e-9) {
      if (o[a]! < lo[a]! || o[a]! > hi[a]!) return null;
      continue;
    }
    let t1 = (lo[a]! - o[a]!) / d[a]!;
    let t2 = (hi[a]! - o[a]!) / d[a]!;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  return Math.max(0, tMin);
}

/** Pick 2–4 animals of one kind for a fresh chunk's grassy spot. */
export function animalGroup(rand: () => number): { kind: MobKind; count: number } {
  const r = rand();
  return { kind: r < 0.34 ? 'pig' : r < 0.67 ? 'cow' : 'sheep', count: 2 + Math.floor(rand() * 3) };
}
