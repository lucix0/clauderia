import type { ItemStack, Slots } from '../items/inventory';
import { itemDef, itemName } from '../items/items';
import { MAX_AIR, type Vitals } from '../survival/vitals';
import { el } from './dom';
import type { IconCache } from './icons';
import { statusIcon } from './statusIcons';

export const HOTBAR_SIZE = 9;

/** Draw a stack into a slot element: icon, count, durability bar. */
export function renderStackInto(slot: HTMLElement, s: ItemStack | null, icons: IconCache): void {
  let img = slot.querySelector('img');
  let count = slot.querySelector<HTMLElement>('.slot-count');
  let bar = slot.querySelector<HTMLElement>('.slot-bar');
  if (!img) {
    img = el('img', { attrs: { alt: '', draggable: 'false' } });
    slot.appendChild(img);
  }
  if (!count) {
    count = el('span', { className: 'slot-count' });
    slot.appendChild(count);
  }
  if (!bar) {
    bar = el('span', { className: 'slot-bar' }, [el('span', { className: 'slot-bar-fill' })]);
    slot.appendChild(bar);
  }
  if (!s) {
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
    count.textContent = '';
    bar.style.display = 'none';
    return;
  }
  const src = icons.url(s.id);
  if (img.getAttribute('src') !== src) img.src = src;
  img.style.visibility = 'visible';
  count.textContent = s.count > 1 ? String(s.count) : '';
  const tool = itemDef(s.id)?.tool;
  if (tool && s.damage > 0) {
    const left = 1 - s.damage / tool.durability;
    bar.style.display = 'block';
    const fill = bar.firstElementChild as HTMLElement;
    fill.style.width = `${Math.max(0, left) * 100}%`;
    fill.style.background = `hsl(${Math.round(left * 120)}, 90%, 50%)`;
  } else {
    bar.style.display = 'none';
  }
}

/** Crosshair, hotbar, vitals and the damage flash. */
export class Hud {
  readonly root: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private readonly label: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly vitals: HTMLElement;
  private readonly hearts: HTMLImageElement[] = [];
  private readonly food: HTMLImageElement[] = [];
  private readonly bubbles: HTMLImageElement[] = [];
  private readonly air: HTMLElement;
  private readonly flashEl: HTMLElement;
  private readonly fireEl: HTMLElement;
  private labelTimer = 0;
  private toastTimer = 0;
  private lastVitals = '';

  constructor(
    parent: HTMLElement,
    private readonly icons: IconCache,
  ) {
    const bar = el('div', { className: 'hotbar' });
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = el('div', { className: 'slot' }, [el('span', { className: 'slot-key', text: String(i + 1) })]);
      this.slots.push(slot);
      bar.appendChild(slot);
    }
    const heartRow = el('div', { className: 'vital-row hearts' });
    const foodRow = el('div', { className: 'vital-row food' });
    this.air = el('div', { className: 'vital-row air' });
    for (let i = 0; i < 10; i++) {
      const h = el('img', { attrs: { alt: '', draggable: 'false' } });
      this.hearts.push(h);
      heartRow.appendChild(h);
      const f = el('img', { attrs: { alt: '', draggable: 'false' } });
      this.food.push(f);
      foodRow.prepend(f); // hunger fills from the right, like the hearts from the left
      const b = el('img', { attrs: { alt: '', draggable: 'false', src: statusIcon('bubble') } });
      this.bubbles.push(b);
      this.air.prepend(b);
    }
    this.vitals = el('div', { className: 'vitals hidden' }, [heartRow, foodRow, this.air]);
    this.label = el('div', { className: 'hotbar-label' });
    this.toast = el('div', { className: 'toast' });
    this.flashEl = el('div', { className: 'hurt-flash' });
    this.fireEl = el('div', { className: 'fire-overlay' });
    this.root = el('div', { className: 'hud hidden' }, [
      this.flashEl,
      this.fireEl,
      el('div', { className: 'crosshair' }),
      this.toast,
      this.label,
      this.vitals,
      bar,
    ]);
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  /** Draw the hotbar (slots 0–8 of the inventory). */
  render(inventory: Slots, selected: number, announce = false): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = inventory[i] ?? null;
      const slot = this.slots[i]!;
      renderStackInto(slot, s, this.icons);
      slot.title = s ? itemName(s.id) : '';
      slot.classList.toggle('selected', i === selected);
    }
    if (announce) {
      const s = inventory[selected];
      this.label.textContent = s ? itemName(s.id) : '';
      this.label.classList.toggle('visible', !!s);
      window.clearTimeout(this.labelTimer);
      this.labelTimer = window.setTimeout(() => this.label.classList.remove('visible'), 1400);
    }
  }

  /** Hearts, hunger and air (survival); null hides them (creative). */
  setVitals(v: Vitals | null, underwater = false): void {
    this.vitals.classList.toggle('hidden', !v);
    this.fireEl.classList.toggle('visible', !!v && v.fire > 0);
    if (!v) return;
    const bubbles = underwater || v.air < MAX_AIR ? Math.ceil((v.air / MAX_AIR) * 10) : -1;
    const key = `${Math.ceil(v.health)}|${v.hunger}|${bubbles}`;
    if (key === this.lastVitals) return;
    this.lastVitals = key;
    const health = Math.ceil(v.health);
    this.hearts.forEach((img, i) => {
      const icon = health >= (i + 1) * 2 ? 'heart' : health === i * 2 + 1 ? 'heart-half' : 'heart-empty';
      const src = statusIcon(icon);
      if (img.getAttribute('src') !== src) img.src = src;
    });
    this.food.forEach((img, i) => {
      const icon = v.hunger >= (i + 1) * 2 ? 'food' : v.hunger === i * 2 + 1 ? 'food-half' : 'food-empty';
      const src = statusIcon(icon);
      if (img.getAttribute('src') !== src) img.src = src;
    });
    this.air.style.visibility = bubbles >= 0 ? 'visible' : 'hidden';
    this.bubbles.forEach((img, i) => (img.style.visibility = i < bubbles ? 'visible' : 'hidden'));
    this.vitals.classList.toggle('low', health <= 4);
  }

  /** Red flash when hurt. */
  hurt(): void {
    this.flashEl.classList.remove('active');
    void this.flashEl.offsetWidth; // restart the animation
    this.flashEl.classList.add('active');
  }

  /** Brief message above the hotbar (e.g. "Flying on"). */
  flash(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('visible'), 1600);
  }
}
