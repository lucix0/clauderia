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
  if (debug) window.__game = game;
  game.onWorldReady = () => {
    window.__ready = true;
  };
  void game.boot({ debug, size: isWorldSizeName(sizeParam) ? sizeParam : 'normal' });
}

main();
