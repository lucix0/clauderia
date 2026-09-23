/**
 * The slot-grid screen for the inventory (E), the crafting table and, later,
 * furnaces and chests. It only draws a Container and forwards clicks; the
 * item logic lives in items/container.ts.
 */
import type { Container, Section } from '../items/container';
import type { ItemStack } from '../items/inventory';
import { itemDef, itemName } from '../items/items';
import { el, show } from './dom';
import { renderStackInto } from './hud';
import type { IconCache } from './icons';

export type ScreenKind = 'inventory' | 'crafting' | 'furnace' | 'chest';

export interface ContainerViewHandlers {
  /** Items thrown out of the screen (Q over a slot, or clicking outside). */
  drop(stack: ItemStack): void;
  /** Close button / clicking the backdrop with nothing held. */
  close(): void;
  /** Something moved (redraw the hotbar behind the screen). */
  changed(): void;
}

interface SlotEl {
  readonly node: HTMLElement;
  readonly section: string;
  readonly index: number;
}

export class ContainerView {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly top: HTMLElement;
  private readonly body: HTMLElement;
  private readonly cursorEl: HTMLElement;
  private readonly tooltip: HTMLElement;
  private slots: SlotEl[] = [];
  private container: Container | null = null;
  private hovered: SlotEl | null = null;
  private mouseX = 0;
  private mouseY = 0;
  /** Extra per-screen drawing (furnace progress etc.). */
  decorate: ((top: HTMLElement) => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly icons: IconCache,
    private readonly handlers: ContainerViewHandlers,
  ) {
    this.heading = el('h2', { className: 'panel-heading' });
    this.top = el('div', { className: 'container-top' });
    this.body = el('div', { className: 'container-body' });
    this.panel = el('div', { className: 'panel container-panel' }, [this.heading, this.top, this.body]);
    this.cursorEl = el('div', { className: 'slot cursor-stack' });
    this.tooltip = el('div', { className: 'item-tooltip hidden' });
    this.root = el('div', { className: 'overlay container-screen hidden' }, [this.panel, this.cursorEl, this.tooltip]);
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    this.panel.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('mousedown', (e) => {
      // Outside the panel: throw what's held, or close.
      const c = this.container;
      if (!c) return;
      const held = c.dropCursor();
      if (held) {
        this.handlers.drop(held);
        this.render();
      } else if (e.button === 0) {
        this.handlers.close();
      }
    });
    this.root.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.placeFloating();
    });
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(container: Container, kind: ScreenKind, title: string): void {
    this.container = container;
    this.heading.textContent = title;
    this.build(container, kind);
    this.render();
    show(this.root, true);
  }

  close(): void {
    show(this.root, false);
    this.container = null;
    this.hovered = null;
    show(this.tooltip, false);
  }

  /** Q over a slot drops one item (all with Ctrl). Returns true if handled. */
  dropHovered(all: boolean): boolean {
    const c = this.container;
    const h = this.hovered;
    if (!c || !h) return false;
    const s = c.dropFrom(h.section, h.index, all);
    if (s) this.handlers.drop(s);
    this.render();
    this.handlers.changed();
    return true;
  }

  private build(c: Container, kind: ScreenKind): void {
    this.slots = [];
    this.top.replaceChildren();
    this.body.replaceChildren();
    this.top.className = `container-top kind-${kind}`;
    const grid = (section: Section | undefined, columns: number, className = ''): HTMLElement => {
      const g = el('div', { className: `slot-grid ${className}` });
      g.style.gridTemplateColumns = `repeat(${columns}, 52px)`;
      if (!section) return g;
      section.indices.forEach((_, index) => g.appendChild(this.slot(section.id, index)));
      return g;
    };
    if (c.gridSize > 0) {
      this.top.append(
        grid(c.section('grid'), c.gridSize, 'craft-grid'),
        el('div', { className: 'craft-arrow', text: '➜' }),
        grid(c.section('result'), 1, 'craft-result'),
      );
    }
    if (kind === 'furnace') {
      this.top.append(
        el('div', { className: 'furnace-column' }, [
          grid(c.section('input'), 1),
          el('div', { className: 'furnace-flame' }, [el('span', { className: 'furnace-flame-fill' })]),
          grid(c.section('fuel'), 1),
        ]),
        el('div', { className: 'furnace-arrow' }, [el('span', { className: 'furnace-arrow-fill' })]),
        grid(c.section('output'), 1, 'craft-result'),
      );
    }
    if (kind === 'chest') this.top.append(grid(c.section('chest'), 9));
    this.body.append(grid(c.section('main'), 9), grid(c.section('hotbar'), 9, 'hotbar-row'));
  }

  private slot(section: string, index: number): HTMLElement {
    const node = el('div', { className: 'slot' });
    const s: SlotEl = { node, section, index };
    node.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const c = this.container;
      if (!c || e.button === 1) return;
      c.click(section, index, e.button === 2 ? 'right' : 'left', e.shiftKey);
      this.render();
      this.handlers.changed();
    });
    node.addEventListener('mouseenter', () => {
      this.hovered = s;
      this.updateTooltip();
    });
    node.addEventListener('mouseleave', () => {
      if (this.hovered === s) this.hovered = null;
      this.updateTooltip();
    });
    this.slots.push(s);
    return node;
  }

  /** Redraw every slot and the held stack. */
  render(): void {
    const c = this.container;
    if (!c) return;
    for (const s of this.slots) {
      const sec = c.section(s.section);
      const i = sec?.indices[s.index];
      renderStackInto(s.node, sec && i !== undefined ? sec.slots[i] ?? null : null, this.icons);
    }
    renderStackInto(this.cursorEl, c.cursor, this.icons);
    this.cursorEl.style.display = c.cursor ? 'flex' : 'none';
    this.decorate?.(this.top);
    this.updateTooltip();
    this.placeFloating();
  }

  private stackAt(s: SlotEl | null): ItemStack | null {
    const c = this.container;
    if (!c || !s) return null;
    const sec = c.section(s.section);
    const i = sec?.indices[s.index];
    return sec && i !== undefined ? sec.slots[i] ?? null : null;
  }

  private updateTooltip(): void {
    const s = this.container?.cursor ? null : this.stackAt(this.hovered);
    if (!s) {
      show(this.tooltip, false);
      return;
    }
    const durability = itemDef(s.id)?.durability ?? 0;
    const food = itemDef(s.id)?.food;
    const lines = [itemName(s.id)];
    if (durability > 0) lines.push(`Durability ${durability - s.damage} / ${durability}`);
    if (food) lines.push(`Restores ${food.hunger / 2} hunger`);
    this.tooltip.replaceChildren(...lines.map((l, i) => el('div', { className: i ? 'tip-sub' : 'tip-name', text: l })));
    show(this.tooltip, true);
    this.placeFloating();
  }

  private placeFloating(): void {
    this.cursorEl.style.left = `${this.mouseX - 26}px`;
    this.cursorEl.style.top = `${this.mouseY - 26}px`;
    this.tooltip.style.left = `${this.mouseX + 16}px`;
    this.tooltip.style.top = `${this.mouseY + 12}px`;
  }
}
