/**
 * Slash commands (pure). The game implements `CommandContext`; the same
 * entry point serves the `/` bar and `window.__game.command()`.
 */
import { BLOCKS, BLOCK_COUNT, isValidBlock } from '../world/blocks';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What commands can do. Optional members belong to later features. */
export interface CommandContext {
  readonly seed: number;
  /** Player feet position. */
  position(): Vec3;
  teleport(x: number, y: number, z: number): void;
  setBlock(x: number, y: number, z: number, id: number): boolean;
  setTime?(ticks: number): void;
  getTime?(): number;
  setGameMode?(mode: 'creative' | 'survival'): void;
  give?(item: string, count: number): string;
  summon?(kind: string, at: Vec3): string;
  kill?(target: string): string;
  biomeAt?(x: number, z: number): string;
  locateBiome?(name: string, from: Vec3): Vec3 | null;
  biomeNames?(): readonly string[];
  setDifficulty?(d: 'peaceful' | 'normal'): void;
}

export class CommandError extends Error {}

/** Parse one coordinate: absolute, or relative with `~` / `~n`. */
export function parseCoord(token: string | undefined, base: number): number {
  if (token === undefined) throw new CommandError('Missing coordinate');
  if (token.startsWith('~')) {
    const rest = token.slice(1);
    if (rest === '') return base;
    const n = Number(rest);
    if (!Number.isFinite(n)) throw new CommandError(`Bad coordinate "${token}"`);
    return base + n;
  }
  const n = Number(token);
  if (!Number.isFinite(n)) throw new CommandError(`Bad coordinate "${token}"`);
  return n;
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Block id from a name ("gold_block", "Gold Block") or number. */
export function parseBlock(token: string | undefined): number {
  if (!token) throw new CommandError('Missing block');
  if (/^\d+$/.test(token)) {
    const id = Number(token);
    if (!isValidBlock(id)) throw new CommandError(`No block with id ${id}`);
    return id;
  }
  const want = normalise(token.replace(/^minecraft:/, ''));
  for (let id = 0; id < BLOCK_COUNT; id++) if (normalise(BLOCKS[id]!.name) === want) return id;
  throw new CommandError(`Unknown block "${token}"`);
}

interface CommandDef {
  usage: string;
  help: string;
  run(ctx: CommandContext, args: string[]): string;
}

function fmt(v: Vec3): string {
  return `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.z.toFixed(1)}`;
}

const TIME_NAMES: Record<string, number> = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };

const COMMANDS: Record<string, CommandDef> = {
  help: {
    usage: '/help',
    help: 'List commands',
    run: () => `Commands: ${Object.values(COMMANDS).map((c) => c.usage.split(' ')[0]).join(', ')}`,
  },
  tp: {
    usage: '/tp <x> <y> <z>',
    help: 'Teleport (~ for relative)',
    run(ctx, args) {
      const p = ctx.position();
      const x = parseCoord(args[0], p.x);
      const y = parseCoord(args[1], p.y);
      const z = parseCoord(args[2], p.z);
      ctx.teleport(x, y, z);
      return `Teleported to ${fmt({ x, y, z })}`;
    },
  },
  setblock: {
    usage: '/setblock <x> <y> <z> <block>',
    help: 'Place a block',
    run(ctx, args) {
      const p = ctx.position();
      const x = Math.floor(parseCoord(args[0], p.x));
      const y = Math.floor(parseCoord(args[1], p.y));
      const z = Math.floor(parseCoord(args[2], p.z));
      const id = parseBlock(args[3]);
      if (!ctx.setBlock(x, y, z, id)) return `Nothing changed at ${x} ${y} ${z}`;
      return `Set ${x} ${y} ${z} to ${BLOCKS[id]!.name}`;
    },
  },
  seed: {
    usage: '/seed',
    help: 'Show the world seed',
    run: (ctx) => `Seed: ${ctx.seed}`,
  },
  time: {
    usage: '/time set <day|noon|night|midnight|ticks>',
    help: 'Set the time of day',
    run(ctx, args) {
      if (!ctx.setTime || !ctx.getTime) throw new CommandError('Time is not available here');
      if (args[0] === 'query' || args.length === 0) return `Time: ${ctx.getTime()}`;
      if (args[0] !== 'set' && args[0] !== 'add') throw new CommandError('Usage: /time set <value>');
      const v = args[1];
      if (v === undefined) throw new CommandError('Usage: /time set <value>');
      let ticks = TIME_NAMES[v.toLowerCase()] ?? Number(v);
      if (!Number.isFinite(ticks)) throw new CommandError(`Bad time "${v}"`);
      if (args[0] === 'add') ticks += ctx.getTime();
      ticks = ((Math.floor(ticks) % 24000) + 24000) % 24000;
      ctx.setTime(ticks);
      return `Time set to ${ticks}`;
    },
  },
  gamemode: {
    usage: '/gamemode <creative|survival>',
    help: 'Switch game mode',
    run(ctx, args) {
      if (!ctx.setGameMode) throw new CommandError('Game modes are not available here');
      const m = (args[0] ?? '').toLowerCase();
      const mode = m === 'survival' || m === 's' || m === '0' ? 'survival' : m === 'creative' || m === 'c' || m === '1' ? 'creative' : null;
      if (!mode) throw new CommandError('Usage: /gamemode <creative|survival>');
      ctx.setGameMode(mode);
      return `Game mode set to ${mode}`;
    },
  },
  give: {
    usage: '/give <item> [count]',
    help: 'Give yourself items',
    run(ctx, args) {
      if (!ctx.give) throw new CommandError('Items are not available here');
      if (!args[0]) throw new CommandError('Usage: /give <item> [count]');
      const count = args[1] === undefined ? 1 : Number(args[1]);
      if (!Number.isInteger(count) || count < 1 || count > 64 * 36) throw new CommandError(`Bad count "${args[1]}"`);
      return ctx.give(args[0], count);
    },
  },
  summon: {
    usage: '/summon <mob> [x y z]',
    help: 'Spawn a mob',
    run(ctx, args) {
      if (!ctx.summon) throw new CommandError('Mobs are not available here');
      if (!args[0]) throw new CommandError('Usage: /summon <mob> [x y z]');
      const p = ctx.position();
      const at = args.length >= 4 ? { x: parseCoord(args[1], p.x), y: parseCoord(args[2], p.y), z: parseCoord(args[3], p.z) } : p;
      return ctx.summon(args[0].toLowerCase(), at);
    },
  },
  kill: {
    usage: '/kill [@s|@e|<mob>]',
    help: 'Kill yourself, all mobs (@e) or one kind',
    run(ctx, args) {
      if (!ctx.kill) throw new CommandError('Nothing to kill here');
      return ctx.kill((args[0] ?? '@s').toLowerCase());
    },
  },
  biome: {
    usage: '/biome',
    help: 'Show the biome you are in',
    run(ctx) {
      if (!ctx.biomeAt) throw new CommandError('This world has no biomes');
      const p = ctx.position();
      return `Biome: ${ctx.biomeAt(Math.floor(p.x), Math.floor(p.z))}`;
    },
  },
  locatebiome: {
    usage: '/locatebiome <name>',
    help: 'Find the nearest biome of a kind',
    run(ctx, args) {
      if (!ctx.locateBiome) throw new CommandError('This world has no biomes');
      const name = args.join('_').toLowerCase();
      const names = ctx.biomeNames?.() ?? [];
      if (!names.includes(name)) throw new CommandError(`Unknown biome. Try: ${names.join(', ')}`);
      const p = ctx.position();
      const found = ctx.locateBiome(name, p);
      if (!found) return `No ${name} found nearby`;
      const dist = Math.round(Math.hypot(found.x - p.x, found.z - p.z));
      return `Nearest ${name} at ${Math.floor(found.x)} ${Math.floor(found.y)} ${Math.floor(found.z)} (${dist} blocks away)`;
    },
  },
  difficulty: {
    usage: '/difficulty <peaceful|normal>',
    help: 'Set the difficulty',
    run(ctx, args) {
      if (!ctx.setDifficulty) throw new CommandError('Difficulty is not available here');
      const d = (args[0] ?? '').toLowerCase();
      if (d !== 'peaceful' && d !== 'normal') throw new CommandError('Usage: /difficulty <peaceful|normal>');
      ctx.setDifficulty(d);
      return `Difficulty set to ${d}`;
    },
  },
};

export const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

/** Run one command line (leading "/" optional). Returns the message to show. */
export function runCommand(ctx: CommandContext, line: string): string {
  const text = line.trim().replace(/^\//, '');
  if (!text) return '';
  const [name, ...args] = text.split(/\s+/);
  const def = COMMANDS[(name ?? '').toLowerCase()];
  if (!def) return `Unknown command "/${name}". Type /help for a list.`;
  try {
    return def.run(ctx, args);
  } catch (err) {
    if (err instanceof CommandError) return `${err.message} — ${def.usage}`;
    throw err;
  }
}
