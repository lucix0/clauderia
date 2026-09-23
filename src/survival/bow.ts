/**
 * Bow numbers: how drawing time turns into arrow speed and damage. Pure.
 */

/** Seconds to a full draw. */
export const FULL_DRAW_S = 1;
/** Shorter draws are cancelled rather than shot. */
export const MIN_DRAW_S = 0.1;

/** Draw strength 0–1 after holding for `seconds` (eases in: quick taps are weak). */
export function bowPower(seconds: number): number {
  const f = Math.max(0, seconds) / FULL_DRAW_S;
  return Math.min(1, (f * f + f * 2) / 3);
}

/** Launch speed in blocks per second. */
export function arrowSpeed(power: number): number {
  return 12 + 28 * power;
}

/** Damage (half hearts) an arrow deals on hitting a mob. */
export function arrowDamage(power: number): number {
  return Math.max(1, Math.round(9 * power));
}
