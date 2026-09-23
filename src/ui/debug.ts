import { el, show } from './dom';

export interface DebugStats {
  fps: number;
  frameMs: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  target: string;
  rebuildsPerSec: number;
  rebuildsTotal: number;
  pendingChunks: number;
  drawCalls: number;
  triangles: number;
  world: string;
  mode: string;
  tick: string;
  chunk: string;
  streaming: string;
  extra: string[];
}

const FACING = ['north (-Z)', 'west (-X)', 'south (+Z)', 'east (+X)'];

/** F3 overlay: FPS, position, target, chunk rebuilds, draw calls. */
export class DebugOverlay {
  readonly root: HTMLElement;
  private readonly text: HTMLElement;
  visible = false;

  constructor(parent: HTMLElement) {
    this.text = el('pre', { className: 'debug-text' });
    this.root = el('div', { className: 'debug hidden' }, [this.text]);
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    show(this.root, this.visible);
  }

  update(s: DebugStats): void {
    if (!this.visible) return;
    const turn = ((s.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const facing = FACING[Math.round(turn / (Math.PI / 2)) % 4];
    this.text.textContent = [
      `Blocktide  ${s.fps.toFixed(0)} fps  (${s.frameMs.toFixed(1)} ms)`,
      `XYZ: ${s.x.toFixed(2)} / ${s.y.toFixed(2)} / ${s.z.toFixed(2)}`,
      `Block: ${Math.floor(s.x)} ${Math.floor(s.y)} ${Math.floor(s.z)}   Chunk: ${s.chunk}   Facing: ${facing}`,
      `Yaw/Pitch: ${((turn * 180) / Math.PI).toFixed(1)}° / ${((s.pitch * 180) / Math.PI).toFixed(1)}°`,
      `Target: ${s.target}`,
      `Section rebuilds: ${s.rebuildsPerSec}/s  total ${s.rebuildsTotal}  pending ${s.pendingChunks}`,
      `Streaming: ${s.streaming}`,
      `Draw calls: ${s.drawCalls}   Triangles: ${s.triangles.toLocaleString()}`,
      `Mode: ${s.mode}`,
      `Ticks: ${s.tick}`,
      `World: ${s.world}`,
      ...s.extra,
    ].join('\n');
  }
}
