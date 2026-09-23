import { afterEach, describe, expect, it } from 'vitest';
import { materialOf, Sound } from '../src/audio/sound';
import { B } from '../src/world/blocks';

/** Just enough of the WebAudio API to count and inspect the nodes a sound builds. */
class FakeParam {
  value = 0;
  setValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}

class FakeNode {
  readonly gain = new FakeParam();
  readonly pan = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly playbackRate = new FakeParam();
  type = '';
  buffer: unknown = null;
  constructor(readonly kind: string) {}
  connect<T>(next: T): T {
    return next;
  }
  start(): void {}
  stop(): void {}
}

class FakeContext {
  static last: FakeContext | null = null;
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  constructor() {
    FakeContext.last = this;
  }
  private make(kind: string): FakeNode {
    const n = new FakeNode(kind);
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeNode {
    return this.make('gain');
  }
  createStereoPanner(): FakeNode {
    return this.make('panner');
  }
  createBiquadFilter(): FakeNode {
    return this.make('filter');
  }
  createBufferSource(): FakeNode {
    return this.make('source');
  }
  createOscillator(): FakeNode {
    return this.make('osc');
  }
  createBuffer(_c: number, length: number): { getChannelData(): Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

function withAudio(): { sound: Sound; ctx: FakeContext } {
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeContext };
  const sound = new Sound();
  sound.unlock();
  return { sound, ctx: FakeContext.last! };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  FakeContext.last = null;
});

describe('sound', () => {
  it('maps blocks to materials', () => {
    expect(materialOf(B.STONE)).toBe('stone');
    expect(materialOf(B.GRASS)).toBe('grass');
    expect(materialOf(B.PLANKS)).toBe('wood');
    expect(materialOf(B.GLASS)).toBe('glass');
    expect(materialOf(B.SAND)).toBe('sand');
    expect(materialOf(B.WOOL_FIRST + 3)).toBe('cloth');
    expect(materialOf(B.SNOW_LAYER)).toBe('snow');
  });

  it('is silent (and harmless) before audio is unlocked', () => {
    const sound = new Sound();
    expect(sound.ready).toBe(false);
    expect(() => {
      sound.step(B.STONE, { x: 0, y: 0, z: 0 });
      sound.breakBlock(B.GLASS, { x: 0, y: 0, z: 0 });
      sound.mob('cow', { x: 0, y: 0, z: 0 }, 'idle');
      sound.hurt();
    }).not.toThrow();
  });

  it('plays nearby sounds and drops ones out of earshot', () => {
    const { sound, ctx } = withAudio();
    expect(sound.ready).toBe(true);
    const before = ctx.nodes.length;
    sound.setListener({ x: 0, y: 64, z: 0, yaw: 0 });
    sound.step(B.STONE, { x: 200, y: 64, z: 0 });
    expect(ctx.nodes.length).toBe(before);
    sound.step(B.STONE, { x: 2, y: 64, z: 0 });
    expect(ctx.nodes.length).toBeGreaterThan(before);
  });

  it('gets quieter with distance and pans toward the source', () => {
    const { sound, ctx } = withAudio();
    // Facing −Z (yaw 0): +X is to the right.
    sound.setListener({ x: 0, y: 64, z: 0, yaw: 0 });
    const outputFor = (x: number, z: number): { gain: number; pan: number } => {
      const start = ctx.nodes.length;
      sound.dig(B.STONE, { x, y: 64, z });
      const made = ctx.nodes.slice(start);
      const gain = made.find((n) => n.kind === 'gain')!;
      const panner = made.find((n) => n.kind === 'panner')!;
      return { gain: gain.gain.value, pan: panner.pan.value };
    };
    const near = outputFor(3, 0);
    const far = outputFor(15, 0);
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(near.pan).toBeGreaterThan(0.5);
    expect(outputFor(-3, 0).pan).toBeLessThan(-0.5);
    expect(Math.abs(outputFor(0, -3).pan)).toBeLessThan(0.05);
    // Turned around (yaw π), +X is on the left.
    sound.setListener({ x: 0, y: 64, z: 0, yaw: Math.PI });
    expect(outputFor(3, 0).pan).toBeLessThan(-0.5);
  });

  it('scales everything by the volume setting', () => {
    const { sound, ctx } = withAudio();
    const master = ctx.nodes.find((n) => n.kind === 'gain')!;
    sound.setVolume(0.25);
    expect(master.gain.value).toBe(0.25);
    sound.setVolume(4);
    expect(master.gain.value).toBe(1);
  });
});
