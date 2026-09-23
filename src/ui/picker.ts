import { blockName, PICKABLE_BLOCKS } from '../world/blocks';
import { el, show } from './dom';
import type { IconCache } from './icons';

/** B: grid of every placeable block. */
export class BlockPicker {
  readonly root: HTMLElement;
  onPick: (id: number) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, icons: IconCache) {
    const grid = el('div', { className: 'picker-grid' });
    for (const id of PICKABLE_BLOCKS) {
      const img = el('img', { attrs: { src: icons.url(id), alt: blockName(id), draggable: 'false' } });
      const cell = el('button', { className: 'picker-cell', attrs: { title: blockName(id), type: 'button' } }, [img]);
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onPick(id);
      });
      grid.appendChild(cell);
    }
    const panel = el('div', { className: 'panel picker-panel' }, [
      el('h2', { className: 'panel-heading', text: 'Select block' }),
      grid,
      el('p', { className: 'hint', html: 'Click a block to put it in the selected slot · <kbd>B</kbd> to close' }),
    ]);
    panel.addEventListener('click', (e) => e.stopPropagation());
    this.root = el('div', { className: 'overlay picker hidden' }, [panel]);
    this.root.addEventListener('click', () => this.onClose());
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(): void {
    show(this.root, true);
  }

  close(): void {
    show(this.root, false);
  }
}
