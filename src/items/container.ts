/**
 * What an open container screen holds and how clicks move items (pure).
 * Every screen shows the player's inventory (hotbar + main) plus its own
 * sections: a crafting grid with its result, and later furnace / chest slots.
 */
import {
  addStack,
  clickSlot,
  HOTBAR_SLOTS,
  INVENTORY_SIZE,
  quickMove,
  takeResult,
  type Button,
  type ItemStack,
  type Slots,
} from './inventory';
import { consumeGrid, matchRecipe } from './recipes';

export interface Section {
  readonly id: string;
  readonly slots: Slots;
  /** Which slot indices of `slots` this section shows. */
  readonly indices: readonly number[];
  /** Result slots can only be taken from. */
  readonly output?: boolean;
  /** What may be put in (default: anything). */
  readonly accepts?: (s: ItemStack) => boolean;
}

const HOTBAR = Array.from({ length: HOTBAR_SLOTS }, (_, i) => i);
const MAIN = Array.from({ length: INVENTORY_SIZE - HOTBAR_SLOTS }, (_, i) => i + HOTBAR_SLOTS);
const ALL_INV = [...HOTBAR, ...MAIN];

/** Hooks for container-specific sections (furnace, chest). */
export interface ContainerExtras {
  readonly sections: readonly Section[];
  /** Where shift-clicking a player slot sends it (null: hotbar ↔ main). */
  shiftFromPlayer?(s: ItemStack): Section | null;
  changed?(): void;
}

export class Container {
  cursor: ItemStack | null = null;
  readonly grid: Slots;
  readonly result: Slots = [null];
  readonly sections: Section[];

  /**
   * @param inventory the player's 36 slots
   * @param gridSize crafting grid side (2 for the inventory, 3 for a table, 0 for none)
   */
  constructor(
    readonly inventory: Slots,
    readonly gridSize: 0 | 2 | 3,
    private readonly extras: ContainerExtras | null = null,
  ) {
    this.grid = Array.from({ length: gridSize * gridSize }, () => null);
    this.sections = [
      ...(extras?.sections ?? []),
      { id: 'main', slots: inventory, indices: MAIN },
      { id: 'hotbar', slots: inventory, indices: HOTBAR },
    ];
    if (gridSize > 0) {
      this.sections.push(
        { id: 'grid', slots: this.grid, indices: this.grid.map((_, i) => i) },
        { id: 'result', slots: this.result, indices: [0], output: true },
      );
    }
  }

  section(id: string): Section | undefined {
    return this.sections.find((s) => s.id === id);
  }

  /** Recompute the crafting result. */
  refresh(): void {
    if (this.gridSize === 0) return;
    const r = matchRecipe(this.grid, this.gridSize, this.gridSize);
    this.result[0] = r ? { ...r.out } : null;
  }

  /** A click on slot `index` (position within the section's indices). */
  click(sectionId: string, index: number, button: Button, shift: boolean): void {
    const sec = this.section(sectionId);
    if (!sec) return;
    const i = sec.indices[index];
    if (i === undefined) return;
    if (sec.id === 'result') {
      this.takeCraft(shift);
    } else if (shift) {
      this.shiftClick(sec, i);
    } else if (sec.output) {
      const s = sec.slots[i];
      if (s) {
        const t = takeResult(this.cursor, s);
        if (t.taken) {
          this.cursor = t.cursor;
          sec.slots[i] = null;
        }
      }
    } else {
      this.cursor = clickSlot(sec.slots, i, this.cursor, button, sec.accepts);
    }
    this.refresh();
    this.extras?.changed?.();
  }

  private shiftClick(sec: Section, i: number): void {
    const s = sec.slots[i];
    if (!s) return;
    if (sec.id === 'hotbar' || sec.id === 'main') {
      const target = this.extras?.shiftFromPlayer?.(s) ?? null;
      if (target) {
        const order = target.indices.filter(() => true);
        quickMove(sec.slots, i, target.slots, order);
        return;
      }
      quickMove(sec.slots, i, this.inventory, sec.id === 'hotbar' ? MAIN : HOTBAR);
      return;
    }
    // Anything else goes back to the player: main inventory first, then hotbar.
    quickMove(sec.slots, i, this.inventory, [...MAIN, ...HOTBAR]);
  }

  /** Take the crafting result: once into the cursor, or (shift) as many times as fit. */
  private takeCraft(shift: boolean): void {
    for (let guard = 0; guard < 64; guard++) {
      this.refresh();
      const out = this.result[0];
      if (!out) return;
      if (shift) {
        const probe = this.inventory.map((s) => (s ? { ...s } : null));
        if (addStack(probe, out, ALL_INV) > 0) return;
        addStack(this.inventory, out, ALL_INV);
        consumeGrid(this.grid);
        continue;
      }
      const t = takeResult(this.cursor, out);
      if (!t.taken) return;
      this.cursor = t.cursor;
      consumeGrid(this.grid);
      this.refresh();
      return;
    }
  }

  /** Drop one (or the whole stack) from a slot; returns what was removed. */
  dropFrom(sectionId: string, index: number, all: boolean): ItemStack | null {
    const sec = this.section(sectionId);
    const i = sec?.indices[index];
    if (!sec || i === undefined || sec.id === 'result') return null;
    const s = sec.slots[i];
    if (!s) return null;
    const n = all ? s.count : 1;
    s.count -= n;
    if (s.count <= 0) sec.slots[i] = null;
    this.refresh();
    this.extras?.changed?.();
    return { ...s, count: n };
  }

  /** Throw away whatever the cursor holds (clicking outside the panel). */
  dropCursor(): ItemStack | null {
    const c = this.cursor;
    this.cursor = null;
    return c;
  }

  /**
   * Closing: the crafting grid and cursor go back into the inventory;
   * returns whatever didn't fit (to be dropped).
   */
  close(): ItemStack[] {
    const spill: ItemStack[] = [];
    const back = (s: ItemStack | null): void => {
      if (!s) return;
      const left = addStack(this.inventory, s, ALL_INV);
      if (left > 0) spill.push({ ...s, count: left });
    };
    back(this.cursor);
    this.cursor = null;
    for (let i = 0; i < this.grid.length; i++) {
      back(this.grid[i] ?? null);
      this.grid[i] = null;
    }
    this.result[0] = null;
    return spill;
  }
}
