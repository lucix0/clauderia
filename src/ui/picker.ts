import { ALL_ITEMS } from '../items/items';
import { B } from '../world/blocks';
import { el, show } from './dom';
import type { IconCache } from './icons';

/** Creative inventory: every block and item; a click fills the selected hotbar slot. */
export class BlockPicker {
  readonly root: HTMLElement;
  onPick: (id: number) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, icons: IconCache) {
    const grid = el('div', { className: 'picker-grid' });
    for (const item of ALL_ITEMS) {
      if (item.id === B.AIR) continue;
      const img = el('img', { attrs: { src: icons.url(item.id), alt: item.name, draggable: 'false' } });
      const cell = el('button', { className: 'picker-cell', attrs: { title: item.name, type: 'button', 'data-item': String(item.id) } }, [img]);
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onPick(item.id);
      });
      grid.appendChild(cell);
    }
    const panel = el('div', { className: 'panel picker-panel' }, [
      el('h2', { className: 'panel-heading', text: 'Creative inventory' }),
      grid,
      el('p', { className: 'hint', html: 'Click to put a stack in the selected slot · <kbd>E</kbd> or <kbd>B</kbd> to close' }),
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
