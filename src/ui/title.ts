import type { ClassicSizeName, Difficulty, GameMode, WorldRecord } from '../save/records';
import { WORLD_SIZES } from '../world/sizes';
import { el, show } from './dom';

export type WorldTypeName = 'classic' | 'infinite';

export interface CreateWorldOptions {
  name: string;
  seedText: string;
  type: WorldTypeName;
  classicSize: ClassicSizeName;
  gameMode: GameMode;
  difficulty: Difficulty;
}

export interface TitleActions {
  play(id: string): void;
  create(opts: CreateWorldOptions): void;
  remove(id: string): void;
}

/** What the create form may offer (grows with each milestone). */
export interface TitleFeatures {
  types: WorldTypeName[];
  modes: GameMode[];
  difficulties: Difficulty[];
}

function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', { className, text: label, attrs: { type: 'button' } });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function option(value: string, label: string): HTMLOptionElement {
  return el('option', { text: label, attrs: { value } });
}

const TYPE_LABEL: Record<WorldTypeName, string> = { infinite: 'Infinite', classic: 'Classic' };
const MODE_LABEL: Record<GameMode, string> = { creative: 'Creative', survival: 'Survival' };
const DIFFICULTY_LABEL: Record<Difficulty, string> = { peaceful: 'Peaceful', normal: 'Normal' };

export function describeWorld(w: WorldRecord): string {
  const type = w.type === 'classic' ? `Classic ${w.classicSize ? WORLD_SIZES[w.classicSize].label : ''}` : 'Infinite';
  const mode = MODE_LABEL[w.gameMode];
  const diff = w.gameMode === 'survival' ? ` · ${DIFFICULTY_LABEL[w.difficulty]}` : '';
  return `${type} · ${mode}${diff}`;
}

function formatWhen(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Title screen: world list, create form, delete confirmation. */
export class TitleScreen {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly listPanel: HTMLElement;
  private readonly createPanel: HTMLElement;
  private readonly confirmPanel: HTMLElement;
  private readonly confirmText: HTMLElement;
  private readonly status: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly seedInput: HTMLInputElement;
  private readonly typeSelect: HTMLSelectElement;
  private readonly sizeSelect: HTMLSelectElement;
  private readonly sizeRow: HTMLElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly modeRow: HTMLElement;
  private readonly difficultySelect: HTMLSelectElement;
  private readonly difficultyRow: HTMLElement;
  private pendingDelete: string | null = null;
  private worldCount = 0;

  constructor(
    parent: HTMLElement,
    private readonly actions: TitleActions,
    features: TitleFeatures,
  ) {
    this.list = el('div', { className: 'world-list' });
    this.status = el('p', { className: 'menu-status', text: '' });
    this.listPanel = el('div', { className: 'menu-panel' }, [
      el('h1', { className: 'title', text: 'Blocktide' }),
      el('p', { className: 'subtitle', text: 'Select a world' }),
      this.list,
      this.status,
      el('div', { className: 'btn-row' }, [button('Create new world', () => this.openCreate(), 'btn btn-primary')]),
    ]);

    this.nameInput = el('input', { className: 'field', attrs: { id: 'cw-name', type: 'text', maxlength: '40', spellcheck: 'false' } });
    this.seedInput = el('input', {
      className: 'field',
      attrs: { id: 'cw-seed', type: 'text', placeholder: 'Random', maxlength: '32', spellcheck: 'false' },
    });
    this.typeSelect = el('select', { className: 'field', attrs: { id: 'cw-type' } });
    for (const t of features.types) this.typeSelect.append(option(t, TYPE_LABEL[t]));
    this.sizeSelect = el('select', { className: 'field', attrs: { id: 'cw-size' } });
    for (const size of Object.values(WORLD_SIZES)) this.sizeSelect.append(option(size.name, size.label));
    this.sizeSelect.value = 'normal';
    this.modeSelect = el('select', { className: 'field', attrs: { id: 'cw-mode' } });
    for (const m of features.modes) this.modeSelect.append(option(m, MODE_LABEL[m]));
    this.difficultySelect = el('select', { className: 'field', attrs: { id: 'cw-difficulty' } });
    for (const d of features.difficulties) this.difficultySelect.append(option(d, DIFFICULTY_LABEL[d]));
    this.difficultySelect.value = features.difficulties.includes('normal') ? 'normal' : (features.difficulties[0] ?? 'normal');

    const row = (label: string, id: string, input: HTMLElement): HTMLElement =>
      el('label', { className: 'form-row', attrs: { for: id } }, [el('span', { text: label }), input]);
    this.sizeRow = row('Classic size', 'cw-size', this.sizeSelect);
    this.modeRow = row('Game mode', 'cw-mode', this.modeSelect);
    this.difficultyRow = row('Difficulty', 'cw-difficulty', this.difficultySelect);
    show(this.modeRow, features.modes.length > 1);
    this.typeSelect.addEventListener('change', () => this.syncForm());
    this.modeSelect.addEventListener('change', () => this.syncForm());
    for (const input of [this.nameInput, this.seedInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.submitCreate();
      });
    }
    this.createPanel = el('div', { className: 'menu-panel' }, [
      el('h2', { className: 'panel-heading', text: 'Create world' }),
      row('Name', 'cw-name', this.nameInput),
      row('Seed', 'cw-seed', this.seedInput),
      row('World type', 'cw-type', this.typeSelect),
      this.sizeRow,
      this.modeRow,
      this.difficultyRow,
      el('p', { className: 'hint', text: 'Leave the seed blank for a random world. Text seeds work too.' }),
      el('div', { className: 'btn-row' }, [
        button('Cancel', () => this.showPanel('list')),
        button('Create', () => this.submitCreate(), 'btn btn-primary'),
      ]),
    ]);

    this.confirmText = el('p', { className: 'confirm-text' });
    this.confirmPanel = el('div', { className: 'menu-panel' }, [
      el('h2', { className: 'panel-heading', text: 'Delete world?' }),
      this.confirmText,
      el('div', { className: 'btn-row' }, [
        button('Cancel', () => this.showPanel('list')),
        button(
          'Delete',
          () => {
            const id = this.pendingDelete;
            this.pendingDelete = null;
            this.showPanel('list');
            if (id) this.actions.remove(id);
          },
          'btn btn-danger',
        ),
      ]),
    ]);

    const box = el('div', { className: 'panel menu title-menu' }, [this.listPanel, this.createPanel, this.confirmPanel]);
    this.root = el('div', { className: 'overlay title-screen hidden' }, [box]);
    parent.appendChild(this.root);
    this.showPanel('list');
    this.syncForm();
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(worlds: readonly WorldRecord[]): void {
    this.render(worlds);
    this.showPanel('list');
    show(this.root, true);
  }

  close(): void {
    show(this.root, false);
  }

  setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
    this.status.textContent = text;
    this.status.dataset['kind'] = kind;
  }

  render(worlds: readonly WorldRecord[]): void {
    this.worldCount = worlds.length;
    this.list.replaceChildren();
    if (worlds.length === 0) {
      this.list.append(el('p', { className: 'world-empty', text: 'No worlds yet — create one to start.' }));
      return;
    }
    for (const w of worlds) {
      const info = el('div', { className: 'world-info' }, [
        el('div', { className: 'world-name', text: w.name }),
        el('div', { className: 'world-meta', text: describeWorld(w) }),
        el('div', { className: 'world-meta', text: `Seed ${w.seed} · ${formatWhen(w.lastPlayed)}` }),
      ]);
      const row = el('div', { className: 'world-row', attrs: { 'data-world': w.id } }, [
        info,
        button('Play', () => this.actions.play(w.id), 'btn btn-primary btn-small'),
        button(
          'Delete',
          () => {
            this.pendingDelete = w.id;
            this.confirmText.textContent = `"${w.name}" will be deleted for good. This can't be undone.`;
            this.showPanel('confirm');
          },
          'btn btn-small',
        ),
      ]);
      row.addEventListener('dblclick', () => this.actions.play(w.id));
      this.list.append(row);
    }
  }

  /** Esc: back out of sub-panels. */
  back(): void {
    this.showPanel('list');
  }

  private openCreate(): void {
    this.nameInput.value = `World ${this.worldCount + 1}`;
    this.seedInput.value = '';
    this.showPanel('create');
    this.nameInput.focus();
    this.nameInput.select();
  }

  private syncForm(): void {
    show(this.sizeRow, this.typeSelect.value === 'classic');
    show(this.difficultyRow, this.modeSelect.value === 'survival' && this.difficultySelect.options.length > 1);
  }

  private submitCreate(): void {
    const type = this.typeSelect.value === 'classic' ? 'classic' : 'infinite';
    const size = this.sizeSelect.value;
    this.actions.create({
      name: this.nameInput.value.trim() || `World ${this.worldCount + 1}`,
      seedText: this.seedInput.value,
      type,
      classicSize: size === 'small' || size === 'large' ? size : 'normal',
      gameMode: this.modeSelect.value === 'survival' ? 'survival' : 'creative',
      difficulty: this.difficultySelect.value === 'peaceful' ? 'peaceful' : 'normal',
    });
  }

  private showPanel(name: 'list' | 'create' | 'confirm'): void {
    show(this.listPanel, name === 'list');
    show(this.createPanel, name === 'create');
    show(this.confirmPanel, name === 'confirm');
  }
}
