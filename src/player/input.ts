/**
 * Keyboard / mouse / pointer-lock state. Movement keys are polled; one-shot
 * keys, mouse buttons and the wheel are delivered through callbacks.
 */

export const BUTTON_LEFT = 0;
export const BUTTON_MIDDLE = 1;
export const BUTTON_RIGHT = 2;

/** Mouse presses this soon after locking belong to the click that locked. */
const LOCK_GRACE_MS = 200;

export interface InputHandlers {
  onKeyDown?(code: string, event: KeyboardEvent): void;
  onButtonDown?(button: number): void;
  onWheel?(steps: number): void;
  onLockChange?(locked: boolean): void;
}

export class Input {
  handlers: InputHandlers = {};
  private readonly keys = new Set<string>();
  private readonly held = [false, false, false];
  private mouseX = 0;
  private mouseY = 0;
  private lockedAt = 0;
  private wheelAccum = 0;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly target: HTMLElement) {
    this.listen(window, 'keydown', (e) => this.keyDown(e as KeyboardEvent));
    this.listen(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(document, 'mousemove', (e) => {
      if (!this.locked) return;
      const m = e as MouseEvent;
      this.mouseX += m.movementX;
      this.mouseY += m.movementY;
    });
    this.listen(document, 'mousedown', (e) => this.mouseDown(e as MouseEvent));
    this.listen(document, 'mouseup', (e) => {
      const b = (e as MouseEvent).button;
      if (b >= 0 && b < 3) this.held[b] = false;
    });
    this.listen(document, 'contextmenu', (e) => e.preventDefault());
    this.listen(
      document,
      'wheel',
      (e) => {
        if (!this.locked) return;
        e.preventDefault();
        const w = e as WheelEvent;
        // Normalise: one notch ≈ 100px in pixel mode, 3 lines in line mode.
        this.wheelAccum += w.deltaMode === 1 ? w.deltaY / 3 : w.deltaMode === 2 ? w.deltaY : w.deltaY / 100;
        const steps = Math.trunc(this.wheelAccum) || Math.sign(this.wheelAccum);
        if (steps !== 0) {
          this.wheelAccum = 0;
          this.handlers.onWheel?.(steps);
        }
      },
      { passive: false },
    );
    this.listen(document, 'pointerlockchange', () => {
      const locked = this.locked;
      if (locked) this.lockedAt = performance.now();
      this.releaseAll();
      this.handlers.onLockChange?.(locked);
    });
    this.listen(document, 'pointerlockerror', () => this.handlers.onLockChange?.(false));
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  isButtonHeld(button: number): boolean {
    return this.held[button] ?? false;
  }

  /** Mouse movement since the last call, in pixels. */
  takeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseX, dy: this.mouseY };
    this.mouseX = 0;
    this.mouseY = 0;
    return d;
  }

  /** Ask for pointer lock. Resolves false when the browser refuses. */
  async requestLock(): Promise<boolean> {
    if (this.locked) return true;
    try {
      await this.target.requestPointerLock();
      return true;
    } catch {
      return false;
    }
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  releaseAll(): void {
    this.keys.clear();
    this.held.fill(false);
    this.mouseX = 0;
    this.mouseY = 0;
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
  }

  private keyDown(e: KeyboardEvent): void {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (typing) return;
    if (e.code === 'F3') e.preventDefault();
    if (this.locked && (e.code === 'Space' || e.code.startsWith('Digit') || e.code === 'Tab' || e.code === 'Slash' || e.code === 'Quote')) {
      e.preventDefault();
    }
    if (!e.repeat) this.handlers.onKeyDown?.(e.code, e);
    if (this.locked) this.keys.add(e.code);
  }

  private mouseDown(e: MouseEvent): void {
    if (!this.locked) return;
    if (e.button === BUTTON_MIDDLE) e.preventDefault();
    if (performance.now() - this.lockedAt < LOCK_GRACE_MS) return;
    if (e.button < 0 || e.button > 2) return;
    this.held[e.button] = true;
    this.handlers.onButtonDown?.(e.button);
  }

  private listen(
    on: EventTarget,
    type: string,
    fn: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    on.addEventListener(type, fn, options);
    this.cleanup.push(() => on.removeEventListener(type, fn, options));
  }
}
