import { MAX_RENDER_DISTANCE, MIN_RENDER_DISTANCE } from '../config';
import { el, show } from './dom';
import type { Settings } from './settings';

export interface MenuActions {
  resume(): void;
  save(): void;
  quit(): void;
  settingsChanged(settings: Settings): void;
  lockDaytime(locked: boolean): void;
}

type PanelName = 'main' | 'settings';

function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', { className, text: label, attrs: { type: 'button' } });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Pause menu with Resume / Save / Settings / Save & quit. */
export class PauseMenu {
  readonly root: HTMLElement;
  private readonly panels: Record<PanelName, HTMLElement>;
  private readonly status: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly sens: HTMLInputElement;
  private readonly sensValue: HTMLElement;
  private readonly fov: HTMLInputElement;
  private readonly fovValue: HTMLElement;
  private readonly distance: HTMLSelectElement;
  private readonly invert: HTMLInputElement;
  private readonly lockDay: HTMLInputElement;
  private readonly info: HTMLElement;
  private current: PanelName = 'main';

  constructor(
    parent: HTMLElement,
    private readonly actions: MenuActions,
  ) {
    this.status = el('p', { className: 'menu-status', text: '' });
    this.info = el('p', { className: 'menu-info', text: '' });
    this.saveButton = button('Save', () => actions.save());
    const main = el('div', { className: 'menu-panel' }, [
      el('h1', { className: 'title', text: 'Blocktide' }),
      el('p', { className: 'subtitle', text: 'Paused' }),
      el('div', { className: 'menu-buttons' }, [
        button('Resume', () => actions.resume(), 'btn btn-primary'),
        el('div', { className: 'btn-row' }, [this.saveButton, button('Settings…', () => this.showPanel('settings'))]),
        button('Save & quit to title', () => actions.quit()),
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

    this.sens = el('input', { attrs: { id: 'set-sens', type: 'range', min: '0.1', max: '4', step: '0.05' } });
    this.sensValue = el('span', { className: 'value' });
    this.fov = el('input', { attrs: { id: 'set-fov', type: 'range', min: '40', max: '120', step: '1' } });
    this.fovValue = el('span', { className: 'value' });
    this.distance = el('select', { className: 'field', attrs: { id: 'set-dist' } });
    for (let d = MIN_RENDER_DISTANCE; d <= MAX_RENDER_DISTANCE; d++) {
      this.distance.append(el('option', { text: `${d} chunks (${d * 16} blocks)`, attrs: { value: String(d) } }));
    }
    this.invert = el('input', { attrs: { id: 'set-invert', type: 'checkbox' } });
    for (const input of [this.sens, this.fov, this.distance, this.invert]) {
      input.addEventListener('input', () => this.emitSettings());
      input.addEventListener('change', () => this.emitSettings());
    }
    this.lockDay = el('input', { attrs: { id: 'set-lockday', type: 'checkbox' } });
    this.lockDay.addEventListener('change', () => this.actions.lockDaytime(this.lockDay.checked));
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
      el('label', { className: 'form-row', attrs: { for: 'set-lockday' } }, [
        el('span', { text: 'Lock daytime (this world)' }),
        this.lockDay,
      ]),
      el('div', { className: 'btn-row' }, [button('Back', () => this.showPanel('main'), 'btn btn-primary')]),
    ]);

    this.panels = { main, settings: settingsPanel };
    const box = el('div', { className: 'panel menu' }, [main, settingsPanel]);
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

  setLockDaytime(locked: boolean): void {
    this.lockDay.checked = locked;
  }

  setCanSave(canSave: boolean): void {
    this.saveButton.disabled = !canSave;
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
