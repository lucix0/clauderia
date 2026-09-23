import { blockName } from '../world/blocks';
import { el } from './dom';
import type { IconCache } from './icons';

export const HOTBAR_SIZE = 9;

/** Crosshair plus the 9-slot hotbar. */
export class Hud {
  readonly root: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly images: HTMLImageElement[] = [];
  private readonly label: HTMLElement;
  private readonly toast: HTMLElement;
  private labelTimer = 0;
  private toastTimer = 0;

  constructor(
    parent: HTMLElement,
    private readonly icons: IconCache,
  ) {
    const bar = el('div', { className: 'hotbar' });
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const img = el('img', { attrs: { alt: '', draggable: 'false' } });
      const slot = el('div', { className: 'slot' }, [img, el('span', { className: 'slot-key', text: String(i + 1) })]);
      this.images.push(img);
      this.slots.push(slot);
      bar.appendChild(slot);
    }
    this.label = el('div', { className: 'hotbar-label' });
    this.toast = el('div', { className: 'toast' });
    this.root = el('div', { className: 'hud hidden' }, [el('div', { className: 'crosshair' }), this.toast, this.label, bar]);
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  render(hotbar: readonly number[], selected: number, announce = false): void {
    hotbar.forEach((id, i) => {
      const img = this.images[i]!;
      const src = this.icons.url(id);
      if (img.getAttribute('src') !== src) img.src = src;
      img.title = blockName(id);
      this.slots[i]!.classList.toggle('selected', i === selected);
    });
    if (announce) {
      this.label.textContent = blockName(hotbar[selected] ?? 0);
      this.label.classList.add('visible');
      window.clearTimeout(this.labelTimer);
      this.labelTimer = window.setTimeout(() => this.label.classList.remove('visible'), 1400);
    }
  }

  /** Brief message above the hotbar (e.g. "Flying on"). */
  flash(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), 1600);
  }
}
