import './style.css';
import { Game } from './game';
import { isWorldSizeName } from './world/sizes';

declare global {
  interface Window {
    /** Set once the first world is meshed and rendered (used by the smoke test). */
    __ready?: boolean;
    /** The running game, exposed in ?debug mode for tests and poking around. */
    __game?: Game;
  }
}

function main(): void {
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('Missing #view / #ui');

  const params = new URLSearchParams(location.search);
  const debug = params.has('debug');
  const sizeParam = params.get('size') ?? 'normal';

  const game = new Game(canvas, ui);
  // ?debug (or ?api for normal saved worlds) exposes the game for scripted tests.
  if (debug || params.has('api')) window.__game = game;
  game.onWorldReady = () => {
    window.__ready = true;
  };
  game.onWorldUnready = () => {
    window.__ready = false;
  };
  const type = params.get('type') === 'classic' ? 'classic' : 'infinite';
  void game.boot({ debug, type, size: isWorldSizeName(sizeParam) ? sizeParam : 'normal' });
}

main();
