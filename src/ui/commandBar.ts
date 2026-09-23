import { el, show } from './dom';

/** The `/` command line plus a short message log above the hotbar. */
export class CommandBar {
  readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly log: HTMLElement;
  private readonly history: string[] = [];
  private historyIndex = -1;
  onSubmit: (line: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.input = el('input', {
      className: 'command-input',
      attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', maxlength: '200', 'aria-label': 'Command' },
    });
    this.log = el('div', { className: 'command-log' });
    const bar = el('div', { className: 'command-bar hidden' }, [this.input]);
    this.root = el('div', { className: 'command-area' }, [this.log, bar]);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const line = this.input.value;
        if (line.trim()) {
          this.history.unshift(line);
          this.history.length = Math.min(this.history.length, 30);
        }
        this.close();
        this.onSubmit(line);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        this.onClose();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = this.historyIndex + (e.key === 'ArrowUp' ? 1 : -1);
        if (next >= -1 && next < this.history.length) {
          this.historyIndex = next;
          this.input.value = next === -1 ? '/' : this.history[next]!;
        }
      }
    });
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.input.parentElement!.classList.contains('hidden');
  }

  open(): void {
    show(this.input.parentElement!, true);
    this.input.value = '/';
    this.historyIndex = -1;
    this.root.classList.add('typing');
    // Focus after the key event that opened us, so the "/" isn't typed twice.
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.setSelectionRange(1, 1);
    });
  }

  close(): void {
    show(this.input.parentElement!, false);
    this.root.classList.remove('typing');
    this.input.blur();
  }

  /** Add a message to the log; it fades after a few seconds. */
  print(text: string, kind: 'info' | 'error' = 'info'): void {
    if (!text) return;
    const line = el('div', { className: `command-line ${kind}`, text });
    this.log.appendChild(line);
    while (this.log.children.length > 8) this.log.firstElementChild?.remove();
    window.setTimeout(() => line.classList.add('fade'), 7000);
    window.setTimeout(() => line.remove(), 9000);
  }
}
