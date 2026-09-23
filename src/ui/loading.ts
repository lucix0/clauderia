import { el, show } from './dom';

/** Full-screen "Generating level…" progress screen. */
export class LoadingScreen {
  readonly root: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly bar: HTMLElement;

  constructor(parent: HTMLElement) {
    this.heading = el('h2', { className: 'loading-heading', text: 'Generating level…' });
    this.stage = el('p', { className: 'loading-stage', text: '' });
    this.bar = el('div', { className: 'loading-bar-fill' });
    this.root = el('div', { className: 'overlay loading hidden' }, [
      el('div', { className: 'panel loading-panel' }, [
        el('h1', { className: 'title', text: 'Blocktide' }),
        this.heading,
        el('div', { className: 'loading-bar' }, [this.bar]),
        this.stage,
      ]),
    ]);
    parent.appendChild(this.root);
  }

  open(heading: string): void {
    this.heading.textContent = heading;
    this.set('', 0);
    show(this.root, true);
  }

  set(stage: string, fraction: number): void {
    this.stage.textContent = stage;
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  close(): void {
    show(this.root, false);
  }
}
