import './style.css';
import { DEBUG_SEED } from './config';
import { Game } from './game';
import { LoadingScreen } from './ui/loading';
import { randomSeed } from './util/prng';
import { generateAsync } from './world/generate';
import { findSpawn } from './world/generator';
import { isWorldSizeName, WORLD_SIZES } from './world/sizes';
import { World } from './world/world';

declare global {
  interface Window {
    /** Set once the first world is meshed and rendered (used by the smoke test). */
    __ready?: boolean;
    /** The running game, exposed in ?debug mode for tests and poking around. */
    __game?: Game;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('Missing #view / #ui');

  const params = new URLSearchParams(location.search);
  const debug = params.has('debug');
  const sizeParam = params.get('size') ?? 'normal';
  const size = WORLD_SIZES[isWorldSizeName(sizeParam) ? sizeParam : 'normal'];
  const seed = debug ? DEBUG_SEED : randomSeed();

  const game = new Game(canvas, ui);
  if (debug) window.__game = game;
  const loading = new LoadingScreen(ui);
  loading.open('Generating level…');
  game.start();

  const blocks = await generateAsync({ sx: size.sx, sy: size.sy, sz: size.sz, seed }, (stage, f) =>
    loading.set(stage, f * 0.8),
  );
  const world = new World(size.sx, size.sy, size.sz, seed, blocks);
  loading.set('Building terrain', 0.8);
  await game.setWorld(world, (done, total) => loading.set('Building terrain', 0.8 + (0.2 * done) / total));

  const spawn = findSpawn(world.blocks, world.sx, world.sy, world.sz);
  game.player.setSpawn(spawn.x, spawn.y, spawn.z);
  game.player.respawn();
  loading.close();
  if (debug) {
    game.setViewpoint(debugViewpoint(world));
    game.enterPlayUnlocked();
  } else {
    game.showTitle();
  }
  await game.nextFrame();
  window.__ready = true;
}

/** Fixed camera for the ?debug screenshot: looking across the map centre. */
function debugViewpoint(world: World): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const x = world.sx * 0.5 - 40;
  const z = world.sz * 0.5 + 44;
  const y = world.seaLevel + 22;
  const tx = world.sx * 0.5 + 8;
  const tz = world.sz * 0.5 - 16;
  const dx = tx - x;
  const dz = tz - z;
  return { x, y, z, yaw: Math.atan2(-dx, -dz), pitch: -0.32 };
}

main().catch((err: unknown) => {
  console.error(err);
});
