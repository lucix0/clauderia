import { RENDER_DISTANCES } from '../config';
import { WORLD_SIZES, isWorldSizeName, type WorldSizeName } from '../world/sizes';
import { el, show } from './dom';
import type { Settings } from './settings';

export interface MenuActions {
  resume(): void;
  save(): void;
  load(): void;
  newWorld(size: WorldSizeName, seedText: string): void;
  settingsChanged(settings: Settings): void;
}

type PanelName = 'main' | 'new' | 'settings';

function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', { className, text: label, attrs: { type: 'button' } });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Pause menu with Resume / Save / Load / New World / Settings. */
export class PauseMenu {
  readonly root: HTMLElement;
  private readonly panels: Record<PanelName, HTMLElement>;
  private readonly status: HTMLElement;
  private readonly loadButton: HTMLButtonElement;
  private readonly sizeSelect: HTMLSelectElement;
  private readonly seedInput: HTMLInputElement;
  private readonly sens: HTMLInputElement;
  private readonly sensValue: HTMLElement;
  private readonly fov: HTMLInputElement;
  private readonly fovValue: HTMLElement;
  private readonly distance: HTMLSelectElement;
  private readonly invert: HTMLInputElement;
  private readonly info: HTMLElement;
  private current: PanelName = 'main';

  constructor(
    parent: HTMLElement,
    private readonly actions: MenuActions,
  ) {
    this.status = el('p', { className: 'menu-status', text: '' });
    this.info = el('p', { className: 'menu-info', text: '' });
    this.loadButton = button('Load', () => actions.load());
    const main = el('div', { className: 'menu-panel' }, [
      el('h1', { className: 'title', text: 'Blocktide' }),
      el('p', { className: 'subtitle', text: 'Paused' }),
      el('div', { className: 'menu-buttons' }, [
        button('Resume', () => actions.resume(), 'btn btn-primary'),
        el('div', { className: 'btn-row' }, [button('Save', () => actions.save()), this.loadButton]),
        button('New World…', () => this.showPanel('new')),
        button('Settings…', () => this.showPanel('settings')),
      ]),
      this.status,
      this.info,
      el('p', {
        className: 'hint',
        html:
          '<kbd>WASD</kbd> move · <kbd>Space</kbd> jump / swim · <kbd>Z</kbd> fly · <kbd>R</kbd> respawn<br>' +
          '<kbd>1</kbd>–<kbd>9</kbd> hotbar · <kbd>B</kbd> blocks · <kbd>F</kbd> view distance · <kbd>F3</kbd> debug',
      }),
    ]);

    this.sizeSelect = el('select', { className: 'field', attrs: { id: 'nw-size' } });
    for (const size of Object.values(WORLD_SIZES)) {
      this.sizeSelect.append(el('option', { text: size.label, attrs: { value: size.name } }));
    }
    this.sizeSelect.value = 'normal';
    this.seedInput = el('input', {
      className: 'field',
      attrs: { id: 'nw-seed', type: 'text', placeholder: 'Random', maxlength: '32', spellcheck: 'false' },
    });
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createWorld();
    });
    const newPanel = el('div', { className: 'menu-panel' }, [
      el('h2', { className: 'panel-heading', text: 'New World' }),
      el('label', { className: 'form-row', attrs: { for: 'nw-size' } }, [el('span', { text: 'Size' }), this.sizeSelect]),
      el('label', { className: 'form-row', attrs: { for: 'nw-seed' } }, [el('span', { text: 'Seed' }), this.seedInput]),
      el('p', { className: 'hint', text: 'Leave the seed blank for a random world. Text seeds work too.' }),
      el('div', { className: 'btn-row' }, [
        button('Back', () => this.showPanel('main')),
        button('Create', () => this.createWorld(), 'btn btn-primary'),
      ]),
    ]);

    this.sens = el('input', { attrs: { id: 'set-sens', type: 'range', min: '0.1', max: '4', step: '0.05' } });
    this.sensValue = el('span', { className: 'value' });
    this.fov = el('input', { attrs: { id: 'set-fov', type: 'range', min: '40', max: '120', step: '1' } });
    this.fovValue = el('span', { className: 'value' });
    this.distance = el('select', { className: 'field', attrs: { id: 'set-dist' } });
    RENDER_DISTANCES.forEach((d, i) =>
      this.distance.append(el('option', { text: `${d.name} (${d.blocks})`, attrs: { value: String(i) } })),
    );
    this.invert = el('input', { attrs: { id: 'set-invert', type: 'checkbox' } });
    for (const input of [this.sens, this.fov, this.distance, this.invert]) {
      input.addEventListener('input', () => this.emitSettings());
      input.addEventListener('change', () => this.emitSettings());
    }
    const settingsPanel = el('div', { className: 'menu-panel' }, [
      el('h2', { className: 'panel-heading', text: 'Settings' }),
      el('label', { className: 'form-row', attrs: { for: 'set-sens' } }, [
        el('span', { text: 'Mouse sensitivity' }),
        this.sens,
        this.sensValue,
      ]),
      el('label', { className: 'form-row', attrs: { for: 'set-fov' } }, [el('span', { text: 'Field of view' }), this.fov, this.fovValue]),
      el('label', { className: 'form-row', attrs: { for: 'set-dist' } }, [el('span', { text: 'Render distance' }), this.distance]),
      el('label', { className: 'form-row', attrs: { for: 'set-invert' } }, [el('span', { text: 'Invert mouse Y' }), this.invert]),
      el('div', { className: 'btn-row' }, [button('Back', () => this.showPanel('main'), 'btn btn-primary')]),
    ]);

    this.panels = { main, new: newPanel, settings: settingsPanel };
    const box = el('div', { className: 'panel menu' }, [main, newPanel, settingsPanel]);
    box.addEventListener('click', (e) => e.stopPropagation());
    this.root = el('div', { className: 'overlay pause-menu hidden' }, [box]);
    parent.appendChild(this.root);
    this.showPanel('main');
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(): void {
    this.showPanel('main');
    show(this.root, true);
  }

  close(): void {
    show(this.root, false);
  }

  /** Esc inside the menu: step back to the main panel. Returns true if handled. */
  back(): boolean {
    if (this.current === 'main') return false;
    this.showPanel('main');
    return true;
  }

  setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
    this.status.textContent = text;
    this.status.dataset['kind'] = kind;
  }

  setInfo(text: string): void {
    this.info.textContent = text;
  }

  setCanLoad(canLoad: boolean): void {
    this.loadButton.disabled = !canLoad;
  }

  setSettings(s: Settings): void {
    this.sens.value = String(s.sensitivity);
    this.sensValue.textContent = `${s.sensitivity.toFixed(2)}×`;
    this.fov.value = String(s.fov);
    this.fovValue.textContent = `${s.fov}°`;
    this.distance.value = String(s.renderDistance);
    this.invert.checked = s.invertY;
  }

  private showPanel(name: PanelName): void {
    this.current = name;
    for (const [key, panel] of Object.entries(this.panels)) show(panel, key === name);
    if (name === 'new') this.seedInput.focus();
  }

  private createWorld(): void {
    const size = this.sizeSelect.value;
    this.actions.newWorld(isWorldSizeName(size) ? size : 'normal', this.seedInput.value);
  }

  private emitSettings(): void {
    const s: Settings = {
      sensitivity: Number(this.sens.value),
      fov: Number(this.fov.value),
      renderDistance: Number(this.distance.value),
      invertY: this.invert.checked,
    };
    this.sensValue.textContent = `${s.sensitivity.toFixed(2)}×`;
    this.fovValue.textContent = `${s.fov}°`;
    this.actions.settingsChanged(s);
  }
}
