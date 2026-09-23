/**
 * Survival vitals: health, hunger (with saturation and exhaustion), air,
 * burning and the timers behind damage over time. Ticked at 20 Hz; pure.
 */

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
/** Air in ticks (10 bubbles × 30). */
export const MAX_AIR = 300;
/** Invulnerability after taking damage, in ticks. */
export const HURT_COOLDOWN = 10;
/** Burning after leaving lava, in ticks. */
export const LAVA_BURN = 300;
/** Exhaustion that costs one saturation or hunger point. */
const EXHAUSTION_STEP = 4;

export type DamageCause = 'fall' | 'drown' | 'lava' | 'fire' | 'cactus' | 'suffocate' | 'starve' | 'mob' | 'void' | 'command';

export interface Vitals {
  health: number;
  hunger: number;
  saturation: number;
  exhaustion: number;
  air: number;
  /** Ticks left burning. */
  fire: number;
  /** Ticks of invulnerability left. */
  hurt: number;
  /** Counters for periodic effects. */
  regenTimer: number;
  starveTimer: number;
  drownTimer: number;
  lavaTimer: number;
  fireTimer: number;
  suffocateTimer: number;
  /** Blocks fallen since last touching the ground (or water). */
  fallDistance: number;
}

export function newVitals(): Vitals {
  return {
    health: MAX_HEALTH,
    hunger: MAX_HUNGER,
    saturation: 5,
    exhaustion: 0,
    air: MAX_AIR,
    fire: 0,
    hurt: 0,
    regenTimer: 0,
    starveTimer: 0,
    drownTimer: 0,
    lavaTimer: 9,
    fireTimer: 0,
    suffocateTimer: 0,
    fallDistance: 0,
  };
}

/** What the player is touching this tick. */
export interface Surroundings {
  /** Eyes under water. */
  headInWater: boolean;
  /** Any part in water (puts fire out, stops falls). */
  inWater: boolean;
  inLava: boolean;
  /** Eyes inside a solid block. */
  headInSolid: boolean;
  touchingCactus: boolean;
}

export interface Rules {
  /** Peaceful: no hunger drain, health keeps regenerating. */
  peaceful: boolean;
}

export interface Hit {
  amount: number;
  cause: DamageCause;
}

/**
 * Apply damage unless still invulnerable from the last hit. Returns the
 * damage dealt (0 when ignored).
 */
export function hurt(v: Vitals, amount: number, cause: DamageCause): number {
  if (amount <= 0 || v.health <= 0) return 0;
  if (v.hurt > 0 && cause !== 'void' && cause !== 'command') return 0;
  v.health = Math.max(0, v.health - amount);
  v.hurt = HURT_COOLDOWN;
  exhaust(v, 0.1);
  return amount;
}

export function exhaust(v: Vitals, amount: number): void {
  v.exhaustion += amount;
}

/** Damage for landing after falling `distance` blocks. */
export function fallDamage(distance: number): number {
  return Math.max(0, Math.ceil(distance - 3));
}

export function eat(v: Vitals, food: { hunger: number; saturation: number }): void {
  v.hunger = Math.min(MAX_HUNGER, v.hunger + food.hunger);
  v.saturation = Math.min(v.hunger, v.saturation + food.saturation);
}

export function canSprint(v: Vitals): boolean {
  return v.hunger > 6;
}

/** Advance one tick. Returns the damage taken this tick. */
export function tickVitals(v: Vitals, env: Surroundings, rules: Rules): Hit[] {
  const hits: Hit[] = [];
  const take = (amount: number, cause: DamageCause): void => {
    const dealt = hurt(v, amount, cause);
    if (dealt > 0) hits.push({ amount: dealt, cause });
  };
  if (v.hurt > 0) v.hurt--;

  // Hunger.
  if (rules.peaceful) {
    v.exhaustion = 0;
    if (v.hunger < MAX_HUNGER && ++v.starveTimer >= 20) {
      v.starveTimer = 0;
      v.hunger++;
    }
  }
  while (v.exhaustion >= EXHAUSTION_STEP) {
    v.exhaustion -= EXHAUSTION_STEP;
    if (v.saturation > 0) v.saturation = Math.max(0, v.saturation - 1);
    else v.hunger = Math.max(0, v.hunger - 1);
  }

  // Healing and starving.
  if (v.health < MAX_HEALTH && v.health > 0) {
    const fast = v.hunger >= MAX_HUNGER && v.saturation > 0;
    if (rules.peaceful || fast || v.hunger >= 18) {
      v.regenTimer++;
      if (v.regenTimer >= (fast ? 10 : rules.peaceful ? 20 : 80)) {
        v.regenTimer = 0;
        v.health = Math.min(MAX_HEALTH, v.health + 1);
        if (!rules.peaceful) exhaust(v, fast ? Math.min(v.saturation, 6) : 6);
      }
    } else {
      v.regenTimer = 0;
    }
  } else {
    v.regenTimer = 0;
  }
  if (v.hunger <= 0 && !rules.peaceful) {
    if (++v.starveTimer >= 80) {
      v.starveTimer = 0;
      // Normal difficulty: starving leaves you at half a heart.
      if (v.health > 1) take(1, 'starve');
    }
  } else if (!rules.peaceful) {
    v.starveTimer = 0;
  }

  // Air and drowning.
  if (env.headInWater) {
    if (v.air > 0) v.air--;
    else if (++v.drownTimer >= 20) {
      v.drownTimer = 0;
      take(2, 'drown');
    }
  } else {
    v.drownTimer = 0;
    v.air = Math.min(MAX_AIR, v.air + 5);
  }

  // Lava, fire, water.
  if (env.inLava) {
    v.fire = LAVA_BURN;
    if (++v.lavaTimer >= 10) {
      v.lavaTimer = 0;
      take(4, 'lava');
    }
  } else {
    v.lavaTimer = 9; // the first touch hurts on the next tick
  }
  if (env.inWater) v.fire = 0;
  if (v.fire > 0) {
    v.fire--;
    if (!env.inLava && ++v.fireTimer >= 20) {
      v.fireTimer = 0;
      take(1, 'fire');
    }
  } else {
    v.fireTimer = 0;
  }

  if (env.touchingCactus) take(1, 'cactus');
  if (env.headInSolid) {
    if (++v.suffocateTimer >= 10) {
      v.suffocateTimer = 0;
      take(1, 'suffocate');
    }
  } else {
    v.suffocateTimer = 0;
  }
  return hits;
}

/** Serialise for the world record. */
export function vitalsToJSON(v: Vitals): Record<string, number> {
  return { ...v };
}

export function vitalsFromJSON(raw: unknown): Vitals {
  const v = newVitals();
  if (typeof raw !== 'object' || raw === null) return v;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(v) as Array<keyof Vitals>) {
    const n = r[k];
    if (typeof n === 'number' && Number.isFinite(n)) v[k] = n;
  }
  v.health = Math.max(0, Math.min(MAX_HEALTH, v.health));
  v.hunger = Math.max(0, Math.min(MAX_HUNGER, v.hunger));
  v.air = Math.max(0, Math.min(MAX_AIR, v.air));
  return v;
}

/** Death messages by cause. */
export const DEATH_MESSAGES: Readonly<Record<DamageCause, string>> = {
  fall: 'You hit the ground too hard',
  drown: 'You drowned',
  lava: 'You tried to swim in lava',
  fire: 'You burned to death',
  cactus: 'You were pricked to death',
  suffocate: 'You suffocated in a wall',
  starve: 'You starved to death',
  mob: 'You were slain',
  void: 'You fell out of the world',
  command: 'You died',
};
