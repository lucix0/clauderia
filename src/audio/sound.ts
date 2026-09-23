/**
 * Procedural sound: everything is synthesised with WebAudio (noise bursts
 * through filters, simple oscillators, short envelopes). Positional sounds
 * are attenuated with distance and panned by their direction from the
 * camera. The AudioContext is only created on a user gesture.
 */
import { B } from '../world/blocks';

export type Material = 'stone' | 'dirt' | 'grass' | 'sand' | 'gravel' | 'wood' | 'leaves' | 'glass' | 'snow' | 'cloth' | 'metal';

/** How a block sounds when stepped on, dug or broken. */
export function materialOf(id: number): Material {
  switch (id) {
    case B.GRASS:
    case B.TALL_GRASS:
    case B.SAPLING:
    case B.DANDELION:
    case B.ROSE:
    case B.DEAD_BUSH:
      return 'grass';
    case B.DIRT:
    case B.CLAY:
      return 'dirt';
    case B.SAND:
    case B.SANDSTONE:
      return 'sand';
    case B.GRAVEL:
      return 'gravel';
    case B.LOG:
    case B.SPRUCE_LOG:
    case B.BIRCH_LOG:
    case B.PLANKS:
    case B.SPRUCE_PLANKS:
    case B.BIRCH_PLANKS:
    case B.CRAFTING_TABLE:
    case B.CHEST:
    case B.BOOKSHELF:
      return 'wood';
    case B.LEAVES:
    case B.SPRUCE_LEAVES:
    case B.BIRCH_LEAVES:
    case B.CACTUS:
      return 'leaves';
    case B.GLASS:
    case B.ICE:
      return 'glass';
    case B.SNOW_BLOCK:
    case B.SNOW_LAYER:
      return 'snow';
    case B.SPONGE:
      return 'cloth';
    case B.IRON_BLOCK:
    case B.GOLD_BLOCK:
    case B.DIAMOND_BLOCK:
      return 'metal';
    default:
      return id >= B.WOOL_FIRST && id < B.WOOL_FIRST + 16 ? 'cloth' : 'stone';
  }
}

/** Filter centre (Hz), filter Q, length (s) and loudness per material. */
const MATERIAL: Record<Material, { freq: number; q: number; len: number; gain: number; type: BiquadFilterType }> = {
  stone: { freq: 1800, q: 1.2, len: 0.09, gain: 0.5, type: 'bandpass' },
  dirt: { freq: 600, q: 0.8, len: 0.1, gain: 0.55, type: 'lowpass' },
  grass: { freq: 2500, q: 0.6, len: 0.12, gain: 0.35, type: 'highpass' },
  sand: { freq: 3500, q: 0.5, len: 0.12, gain: 0.35, type: 'highpass' },
  gravel: { freq: 1200, q: 0.7, len: 0.13, gain: 0.5, type: 'bandpass' },
  wood: { freq: 700, q: 3, len: 0.1, gain: 0.55, type: 'bandpass' },
  leaves: { freq: 4000, q: 0.5, len: 0.12, gain: 0.3, type: 'highpass' },
  glass: { freq: 3200, q: 6, len: 0.08, gain: 0.4, type: 'bandpass' },
  snow: { freq: 1500, q: 0.4, len: 0.12, gain: 0.3, type: 'lowpass' },
  cloth: { freq: 800, q: 0.5, len: 0.1, gain: 0.3, type: 'lowpass' },
  metal: { freq: 2600, q: 8, len: 0.12, gain: 0.45, type: 'bandpass' },
};

export interface Listener {
  x: number;
  y: number;
  z: number;
  /** Camera yaw (0 looks toward −Z). */
  yaw: number;
}

export interface At {
  x: number;
  y: number;
  z: number;
}

const HEARING = 28;

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
  private volume = 0.7;

  /** Start (or resume) audio; call from a user gesture. */
  unlock(): void {
    try {
      if (!this.ctx) {
        // Without a user gesture the browser would only hand out a muted context (and complain).
        const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
        if (activation && !activation.isActive) return;
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
        // One second of white noise, reused by every noisy sound.
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  setListener(l: Listener): void {
    this.listener = l;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  // ---- Building blocks ----

  /** Output node for a sound at `at` (or at the listener): gain + pan by position. Null if inaudible. */
  private out(at: At | null, gain: number): { node: AudioNode; t: number } | null {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || ctx.state !== 'running') return null;
    let g = gain;
    let pan = 0;
    if (at) {
      const l = this.listener;
      const dx = at.x - l.x;
      const dy = at.y - l.y;
      const dz = at.z - l.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > HEARING) return null;
      g *= Math.pow(1 - d / HEARING, 1.6);
      // Right vector for yaw: (cos yaw, 0, −sin yaw).
      const right = (dx * Math.cos(l.yaw) - dz * Math.sin(l.yaw)) / Math.max(1, d);
      pan = Math.max(-0.9, Math.min(0.9, right));
    }
    if (g < 0.01) return null;
    const gainNode = ctx.createGain();
    gainNode.gain.value = g;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gainNode.connect(panner).connect(master);
    return { node: gainNode, t: ctx.currentTime };
  }

  /** A filtered noise burst with a fast attack and exponential decay. */
  private burst(dest: AudioNode, t: number, len: number, freq: number, q: number, type: BiquadFilterType, gain = 1): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq * (0.85 + Math.random() * 0.3);
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(filter).connect(env).connect(dest);
    src.start(t, Math.random() * 0.5, len + 0.05);
  }

  /** An oscillator note gliding from f0 to f1. */
  private tone(dest: AudioNode, t: number, len: number, f0: number, f1: number, type: OscillatorType, gain = 1, vibrato = 0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len);
    if (vibrato > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 7;
      const depth = ctx.createGain();
      depth.gain.value = vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + len);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.04, len / 4));
    env.gain.setValueAtTime(gain, t + len * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(env).connect(dest);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }

  // ---- Game sounds ----

  step(id: number, at: At, soft = false): void {
    const m = MATERIAL[materialOf(id)];
    const o = this.out(at, m.gain * (soft ? 0.35 : 0.6));
    if (o) this.burst(o.node, o.t, m.len, m.freq, m.q, m.type);
  }

  dig(id: number, at: At): void {
    const m = MATERIAL[materialOf(id)];
    const o = this.out(at, m.gain * 0.5);
    if (o) this.burst(o.node, o.t, m.len * 0.8, m.freq * 1.2, m.q, m.type);
  }

  breakBlock(id: number, at: At): void {
    const mat = materialOf(id);
    const m = MATERIAL[mat];
    const o = this.out(at, m.gain);
    if (!o) return;
    for (let i = 0; i < 3; i++) this.burst(o.node, o.t + i * 0.03, m.len * 1.8, m.freq * (1 - i * 0.15), m.q, m.type, 0.8);
    if (mat === 'glass') for (let i = 0; i < 4; i++) this.tone(o.node, o.t + i * 0.025, 0.12, 2400 + Math.random() * 1800, 1800, 'sine', 0.15);
  }

  place(id: number, at: At): void {
    const m = MATERIAL[materialOf(id)];
    const o = this.out(at, m.gain * 0.9);
    if (!o) return;
    this.burst(o.node, o.t, m.len * 1.2, m.freq * 0.7, m.q, m.type);
    this.tone(o.node, o.t, 0.06, 180, 90, 'sine', 0.3);
  }

  land(id: number, at: At, hard: number): void {
    const m = MATERIAL[materialOf(id)];
    const o = this.out(at, Math.min(1, 0.4 + hard * 0.1));
    if (!o) return;
    this.burst(o.node, o.t, 0.15, m.freq * 0.5, m.q, m.type);
    this.tone(o.node, o.t, 0.12, 120, 50, 'sine', 0.5);
  }

  hurt(): void {
    const o = this.out(null, 0.5);
    if (!o) return;
    this.tone(o.node, o.t, 0.18, 420, 180, 'sawtooth', 0.25);
    this.burst(o.node, o.t, 0.1, 900, 1, 'bandpass', 0.4);
  }

  pickup(): void {
    const o = this.out(null, 0.25);
    if (o) this.tone(o.node, o.t, 0.08, 600 + Math.random() * 200, 1400, 'sine', 0.6);
  }

  eat(): void {
    const o = this.out(null, 0.35);
    if (o) this.burst(o.node, o.t, 0.08, 1500, 0.8, 'bandpass');
  }

  splash(at: At, big: boolean): void {
    const o = this.out(at, big ? 0.6 : 0.35);
    if (!o) return;
    this.burst(o.node, o.t, 0.35, 1100, 0.5, 'lowpass');
    this.burst(o.node, o.t + 0.05, 0.25, 2500, 0.7, 'bandpass', 0.5);
  }

  swing(): void {
    const o = this.out(null, 0.2);
    if (o) this.burst(o.node, o.t, 0.12, 900, 0.4, 'bandpass');
  }

  bow(at: At): void {
    const o = this.out(at, 0.45);
    if (!o) return;
    this.tone(o.node, o.t, 0.1, 300, 140, 'triangle', 0.4);
    this.burst(o.node, o.t, 0.2, 2000, 0.6, 'bandpass', 0.5);
  }

  arrowHit(at: At): void {
    const o = this.out(at, 0.45);
    if (o) this.burst(o.node, o.t, 0.06, 800, 2, 'bandpass');
  }

  /** A mob's voice: idle, hurt or death. */
  mob(kind: string, at: At, mood: 'idle' | 'hurt' | 'death'): void {
    const o = this.out(at, mood === 'idle' ? 0.45 : 0.6);
    if (!o) return;
    const n = o.node;
    const t = o.t;
    const up = mood === 'hurt' ? 1.35 : mood === 'death' ? 0.8 : 1;
    const len = mood === 'death' ? 1.3 : 1;
    switch (kind) {
      case 'pig':
        this.tone(n, t, 0.18 * len, 170 * up, 120 * up, 'sawtooth', 0.35, 20);
        this.tone(n, t + 0.16, 0.12 * len, 150 * up, 110 * up, 'sawtooth', 0.25, 15);
        break;
      case 'cow':
        this.tone(n, t, 0.7 * len, 110 * up, 85 * up, 'sawtooth', 0.3, 4);
        this.tone(n, t, 0.7 * len, 220 * up, 170 * up, 'triangle', 0.12, 4);
        break;
      case 'sheep':
        this.tone(n, t, 0.45 * len, 330 * up, 300 * up, 'square', 0.18, 28);
        break;
      case 'zombie':
        this.tone(n, t, 0.9 * len, 95 * up, 70 * up, 'sawtooth', 0.3, 6);
        this.burst(n, t, 0.8 * len, 400 * up, 1.5, 'bandpass', 0.35);
        break;
      case 'skeleton':
        for (let i = 0; i < 5; i++) this.burst(n, t + i * 0.05, 0.03, 2600 * up, 5, 'bandpass', 0.6);
        break;
      case 'spider':
        this.burst(n, t, 0.5 * len, 5000 * up, 0.7, 'highpass', 0.4);
        this.tone(n, t, 0.3 * len, 90 * up, 60 * up, 'square', 0.08);
        break;
    }
  }
}
