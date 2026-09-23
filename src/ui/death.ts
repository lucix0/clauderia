import { el, show } from './dom';

/** "You died" with Respawn / Title screen. */
export class DeathScreen {
  readonly root: HTMLElement;
  private readonly message: HTMLElement;
  private readonly respawnBtn: HTMLButtonElement;

  constructor(parent: HTMLElement, handlers: { respawn(): void; title(): void }) {
    this.message = el('p', { className: 'death-message' });
    this.respawnBtn = el('button', { className: 'btn btn-primary', text: 'Respawn', attrs: { type: 'button' } });
    const titleBtn = el('button', { className: 'btn', text: 'Title screen', attrs: { type: 'button' } });
    this.respawnBtn.addEventListener('click', () => handlers.respawn());
    titleBtn.addEventListener('click', () => handlers.title());
    this.root = el('div', { className: 'overlay death-screen hidden' }, [
      el('div', { className: 'panel death-panel' }, [
        el('h1', { className: 'death-title', text: 'You died!' }),
        this.message,
        el('div', { className: 'menu-buttons' }, [this.respawnBtn, titleBtn]),
      ]),
    ]);
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(message: string): void {
    this.message.textContent = message;
    show(this.root, true);
    this.respawnBtn.focus();
  }

  close(): void {
    show(this.root, false);
  }
}
