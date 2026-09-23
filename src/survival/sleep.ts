/**
 * Sleeping in a bed: when it's allowed and what it does to the clock. Pure.
 */

/** Evening tick from which beds can be slept in (just after sunset). */
export const SLEEP_FROM = 12500;
/** Morning tick after which it's too late to sleep (just before sunrise). */
export const SLEEP_UNTIL = 23500;
/** The clock after a night's sleep: sunrise. */
export const WAKE_TIME = 0;
/** Seconds the screen takes to fade out while falling asleep. */
export const SLEEP_FADE_S = 1.5;
/** Seconds asleep before the night is skipped. */
export const SLEEP_S = 2.2;

/** Horizontal and vertical reach of "monsters nearby". */
const MONSTER_REACH = 8;
const MONSTER_REACH_Y = 5;

export function canSleepAt(time: number): boolean {
  const t = ((time % 24000) + 24000) % 24000;
  return t >= SLEEP_FROM && t < SLEEP_UNTIL;
}

interface MobLike {
  readonly def: { readonly hostile: boolean };
  readonly body: { x: number; y: number; z: number };
  readonly removed: boolean;
  readonly dying: number;
}

/** Is a live hostile mob close enough to keep the player awake? */
export function monstersNear(mobs: readonly MobLike[], x: number, y: number, z: number): boolean {
  return mobs.some(
    (m) =>
      m.def.hostile &&
      !m.removed &&
      m.dying < 0 &&
      Math.abs(m.body.x - x) < MONSTER_REACH &&
      Math.abs(m.body.z - z) < MONSTER_REACH &&
      Math.abs(m.body.y - y) < MONSTER_REACH_Y,
  );
}
