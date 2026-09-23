import { describe, expect, it } from 'vitest';
import { Mobs, type MobTarget, type MobWorld } from '../src/entities/mobs';
import { countItem, stack, type Slots } from '../src/items/inventory';
import { I, itemByName, itemDef } from '../src/items/items';
import { matchRecipe } from '../src/items/recipes';
import { arrowDamage, arrowSpeed, bowPower } from '../src/survival/bow';
import { drops } from '../src/survival/mining';
import { Survivor } from '../src/survival/survivor';
import { B } from '../src/world/blocks';

function grid(rows: number[][]): Slots {
  return rows.flat().map((id) => (id ? stack(id) : null));
}

/** Flat stone floor below y = 10, a stone wall at x = 20; night, so zombies don't burn. */
const world: MobWorld = {
  solidHeight: (x, y) => (y < 10 || x === 20 ? 1 : 0),
  liquidAt: () => 0,
  active: () => true,
  blockId: (x, y) => (y < 10 || x === 20 ? B.STONE : B.AIR),
  light: () => 0,
  daylight: 0,
};

function run(mobs: Mobs, seconds: number, player: MobTarget | null): void {
  for (let t = 0; t < seconds * 60; t++) mobs.update(world, 1 / 60, player, false);
}

describe('bow', () => {
  it('draw strength eases in and caps at a full draw', () => {
    expect(bowPower(0)).toBe(0);
    expect(bowPower(0.5)).toBeCloseTo((0.25 + 1) / 3);
    expect(bowPower(1)).toBe(1);
    expect(bowPower(3)).toBe(1);
    expect(arrowSpeed(1)).toBeGreaterThan(arrowSpeed(0.3));
    expect(arrowDamage(1)).toBe(9);
    expect(arrowDamage(0.01)).toBe(1);
  });

  it('bows, arrows and flint exist and can be made', () => {
    expect(itemByName('bow')).toBe(I.BOW);
    expect(itemDef(I.BOW)?.durability).toBeGreaterThan(0);
    const S = I.STICK;
    const X = I.STRING;
    expect(matchRecipe(grid([[0, S, X], [S, 0, X], [0, S, X]]), 3, 3)?.out).toEqual(stack(I.BOW));
    expect(matchRecipe(grid([[X, S, 0], [X, 0, S], [X, S, 0]]), 3, 3)?.out).toEqual(stack(I.BOW)); // mirrored
    expect(matchRecipe(grid([[I.FLINT, 0], [S, 0]]), 2, 2)?.out).toEqual(stack(I.ARROW, 4));
    expect(drops(B.GRAVEL, null, () => 0.05)).toEqual([stack(I.FLINT)]);
    expect(drops(B.GRAVEL, null, () => 0.5)).toEqual([stack(B.GRAVEL)]);
  });

  it('survival shots need arrows, use one up and wear the bow', () => {
    const s = new Survivor();
    s.mode = 'survival';
    s.inventory[0] = stack(I.BOW);
    // No arrows: drawing does nothing.
    expect(s.updateBow(true, 0.5)).toBeNull();
    expect(s.drawing).toBeNull();
    expect(s.updateBow(false, 0.1)).toBeNull();
    s.inventory[5] = stack(I.ARROW, 3);
    for (let i = 0; i < 60; i++) expect(s.updateBow(true, 1 / 60)).toBeNull();
    expect(s.updateBow(false, 1 / 60)).toBeCloseTo(1, 5);
    expect(countItem(s.inventory, I.ARROW)).toBe(2);
    expect(s.inventory[0]?.damage).toBe(1);
    // A quick tap is cancelled, not shot.
    s.updateBow(true, 0.05);
    expect(s.updateBow(false, 0.01)).toBeNull();
    expect(countItem(s.inventory, I.ARROW)).toBe(2);
    // Switching slots mid-draw cancels it.
    s.updateBow(true, 0.8);
    s.selected = 1;
    expect(s.updateBow(false, 0.01)).toBeNull();
  });

  it('creative shots are free', () => {
    const s = new Survivor();
    s.inventory[0] = stack(I.BOW);
    s.updateBow(true, 1);
    expect(s.updateBow(false, 0)).toBe(1);
    expect(s.inventory[0]?.damage).toBe(0);
  });

  it("the player's arrows hit mobs, not the player, and can be picked up", () => {
    const mobs = new Mobs(() => 0.5);
    const zombie = mobs.spawn('zombie', 10.5, 10, 0.5, 0);
    const player: MobTarget & { taken: number } = {
      x: 0.5,
      y: 10,
      z: 0.5,
      attackable: false, // creative: the zombie ignores us
      taken: 0,
      hurt(amount) {
        player.taken += amount;
        return amount;
      },
    };
    let hurt = 0;
    mobs.events.hurt = () => hurt++;
    // Straight at the zombie's chest from the player's eyes.
    const speed = arrowSpeed(1);
    mobs.shootFromPlayer(1, 11.5, 0.5, speed, 0, 0, 9, true);
    run(mobs, 1, player);
    expect(hurt).toBe(1);
    expect(zombie.health).toBe(20 - 9);
    expect(zombie.body.vx).toBeGreaterThan(0); // knocked back along the shot
    expect(player.taken).toBe(0);
    expect(mobs.arrows.length).toBe(0);
    // A miss sticks in the wall and lingers (unlike a skeleton's arrow).
    const miss = mobs.shootFromPlayer(1, 14, 5.5, speed, 0, 0, 9, true);
    run(mobs, 2, player);
    expect(miss.stuck).toBeGreaterThan(50);
    expect(miss.x).toBeLessThan(21);
  });
});
