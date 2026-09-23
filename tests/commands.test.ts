import { describe, expect, it } from 'vitest';
import { parseBlock, parseCoord, runCommand, type CommandContext } from '../src/commands/commands';
import { B } from '../src/world/blocks';

function ctx(): CommandContext & { pos: { x: number; y: number; z: number }; placed: number[][] } {
  const pos = { x: 10, y: 70, z: -5 };
  const placed: number[][] = [];
  return {
    seed: 99,
    pos,
    placed,
    position: () => ({ ...pos }),
    teleport: (x, y, z) => Object.assign(pos, { x, y, z }),
    setBlock: (x, y, z, id) => {
      placed.push([x, y, z, id]);
      return true;
    },
  };
}

describe('command parsing', () => {
  it('reads absolute and relative coordinates', () => {
    expect(parseCoord('5', 100)).toBe(5);
    expect(parseCoord('-12.5', 100)).toBe(-12.5);
    expect(parseCoord('~', 100)).toBe(100);
    expect(parseCoord('~3', 100)).toBe(103);
    expect(parseCoord('~-3', 100)).toBe(97);
    expect(() => parseCoord('x', 0)).toThrow();
    expect(() => parseCoord(undefined, 0)).toThrow();
  });

  it('finds blocks by name or id', () => {
    expect(parseBlock('stone')).toBe(B.STONE);
    expect(parseBlock('gold_block')).toBe(B.GOLD_BLOCK);
    expect(parseBlock('Mossy-Cobblestone')).toBe(B.MOSSY_COBBLESTONE);
    expect(parseBlock('43')).toBe(B.BRICKS);
    expect(() => parseBlock('unobtainium')).toThrow(/Unknown block/);
  });
});

describe('commands', () => {
  it('teleports, with relative coordinates', () => {
    const c = ctx();
    expect(runCommand(c, '/tp 1 2 3')).toMatch(/Teleported/);
    expect(c.pos).toEqual({ x: 1, y: 2, z: 3 });
    runCommand(c, 'tp ~10 ~ ~-1');
    expect(c.pos).toEqual({ x: 11, y: 2, z: 2 });
  });

  it('sets blocks and reports the seed', () => {
    const c = ctx();
    expect(runCommand(c, '/setblock ~1 ~ ~ bricks')).toMatch(/Bricks/);
    expect(c.placed).toEqual([[11, 70, -5, B.BRICKS]]);
    expect(runCommand(c, '/seed')).toBe('Seed: 99');
  });

  it('explains mistakes instead of throwing', () => {
    const c = ctx();
    expect(runCommand(c, '/nope')).toMatch(/Unknown command/);
    expect(runCommand(c, '/tp 1 2')).toMatch(/Missing coordinate.*\/tp/);
    expect(runCommand(c, '/time set noon')).toMatch(/not available/);
    expect(runCommand(c, '/help')).toMatch(/\/tp/);
  });
});
