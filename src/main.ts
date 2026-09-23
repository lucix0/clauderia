import './style.css';
import { Game } from './game';
import { createFlatWorld } from './world/flat';

async function main(): Promise<void> {
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('Missing #view / #ui');
  const game = new Game(canvas, ui);
  await game.setWorld(createFlatWorld(128, 64, 128));
  game.start();
}

void main();
