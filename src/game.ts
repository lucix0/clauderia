import * as THREE from 'three';
import {
  DEFAULT_RENDER_DISTANCE,
  FLY_SPEED,
  FLY_VERTICAL_SPEED,
  MAX_FRAME_DT,
  REMESH_BUDGET_MS,
  RENDER_DISTANCES,
  STEP_DT,
} from './config';
import { Input } from './player/input';
import { createAtlas, type Atlas } from './render/atlas';
import { ChunkManager } from './render/chunks';
import { createMaterials } from './render/materials';
import { Sky, type Medium } from './render/sky';
import { B } from './world/blocks';
import type { World } from './world/world';

const MOUSE_SCALE = 0.0022;

export interface Viewpoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Owns the renderer, the world view and the fixed-step loop. */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
  readonly atlas: Atlas;
  readonly chunks: ChunkManager;
  readonly sky: Sky;
  readonly input: Input;
  renderDistanceIndex = DEFAULT_RENDER_DISTANCE;
  private world: World | null = null;
  private yaw = 0;
  private pitch = 0;
  private readonly pos = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private accumulator = 0;
  private lastTime = 0;
  private readonly overlay: HTMLElement;
  private firstFrameResolvers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ui: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.camera.rotation.order = 'YXZ';
    this.atlas = createAtlas();
    this.chunks = new ChunkManager(createMaterials(this.atlas.texture));
    this.scene.add(this.chunks.group);
    this.sky = new Sky(this.scene, this.atlas);
    this.input = new Input(canvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay click-to-play hidden';
    this.overlay.innerHTML =
      '<div class="panel"><h1 class="title">Blocktide</h1><p class="big-cta">Click to play</p></div>';
    this.overlay.addEventListener('click', () => void this.input.requestLock());
    this.ui.appendChild(this.overlay);
    this.input.handlers.onLockChange = (locked) => this.overlay.classList.toggle('hidden', locked);
    this.input.handlers.onKeyDown = (code) => {
      if (code === 'KeyF') this.cycleRenderDistance();
    };

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get renderDistance(): number {
    return RENDER_DISTANCES[this.renderDistanceIndex]!.blocks;
  }

  showClickToPlay(): void {
    this.overlay.classList.remove('hidden');
  }

  async setWorld(world: World, onProgress?: (done: number, total: number) => void): Promise<void> {
    this.world = world;
    this.sky.setWorld(world);
    this.chunks.setWorld(world);
    await this.chunks.buildAll(onProgress);
  }

  setViewpoint(v: Viewpoint): void {
    this.pos.set(v.x, v.y, v.z);
    this.prevPos.copy(this.pos);
    this.yaw = v.yaw;
    this.pitch = v.pitch;
  }

  /** Resolves after the next frame has been rendered. */
  nextFrame(): Promise<void> {
    return new Promise((resolve) => this.firstFrameResolvers.push(resolve));
  }

  start(): void {
    this.lastTime = performance.now();
    const frame = (now: number): void => {
      this.frame(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  cycleRenderDistance(): void {
    this.renderDistanceIndex = (this.renderDistanceIndex + 1) % RENDER_DISTANCES.length;
  }

  private frame(now: number): void {
    const dt = Math.min((now - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = now;

    const { dx, dy } = this.input.takeMouseDelta();
    this.yaw -= dx * MOUSE_SCALE;
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.pitch - dy * MOUSE_SCALE));

    this.accumulator += dt;
    while (this.accumulator >= STEP_DT) {
      this.step(STEP_DT);
      this.accumulator -= STEP_DT;
    }
    const alpha = this.accumulator / STEP_DT;
    this.camera.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    const distance = this.renderDistance;
    this.camera.far = distance + 256;
    this.camera.updateProjectionMatrix();
    this.sky.update(dt, this.camera, this.cameraMedium(), distance);
    this.chunks.update(this.camera.position, REMESH_BUDGET_MS);
    this.chunks.updateVisibility(this.camera.position, distance);
    this.renderer.render(this.scene, this.camera);

    const resolvers = this.firstFrameResolvers;
    this.firstFrameResolvers = [];
    for (const r of resolvers) r();
  }

  private cameraMedium(): Medium {
    const w = this.world;
    if (!w) return 'air';
    const p = this.camera.position;
    const id = w.getVirtual(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (id === B.WATER) return 'water';
    if (id === B.LAVA) return 'lava';
    return 'air';
  }

  /** Free-fly camera (replaced by player physics in M3). */
  private step(dt: number): void {
    this.prevPos.copy(this.pos);
    const i = this.input;
    const f = (i.isDown('KeyW') ? 1 : 0) - (i.isDown('KeyS') ? 1 : 0);
    const s = (i.isDown('KeyD') ? 1 : 0) - (i.isDown('KeyA') ? 1 : 0);
    const u = (i.isDown('Space') ? 1 : 0) - (i.isDown('ShiftLeft') || i.isDown('ShiftRight') ? 1 : 0);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.pos.x += (-sin * f + cos * s) * FLY_SPEED * dt;
    this.pos.z += (-cos * f - sin * s) * FLY_SPEED * dt;
    this.pos.y += u * FLY_VERTICAL_SPEED * dt;
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
