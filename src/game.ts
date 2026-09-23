import * as THREE from 'three';
import {
  ACTION_REPEAT_S,
  DEFAULT_RENDER_DISTANCE,
  MAX_FRAME_DT,
  PLAYER_EYE,
  REMESH_BUDGET_MS,
  RENDER_DISTANCES,
  STEP_DT,
} from './config';
import { bodyOverlapsCell } from './player/physics';
import { BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT, Input } from './player/input';
import { collisionWorld, Player } from './player/player';
import type { RayHit } from './player/raycast';
import { createAtlas, type Atlas } from './render/atlas';
import { ChunkManager } from './render/chunks';
import { createMaterials } from './render/materials';
import { BlockOutline } from './render/outline';
import { Sky, type Medium } from './render/sky';
import { BlockPicker } from './ui/picker';
import { Hud, HOTBAR_SIZE } from './ui/hud';
import { IconCache } from './ui/icons';
import { B, blockBounds, DEFAULT_HOTBAR, isValidBlock } from './world/blocks';
import { breakBlock, placeBlock, placementTarget, type Cell } from './world/placement';
import type { CollisionWorld } from './player/physics';
import type { World } from './world/world';

const MOUSE_SCALE = 0.0022;

export type GameState = 'loading' | 'title' | 'playing' | 'paused' | 'picker';

export interface Viewpoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Owns the renderer, world, player, UI and the fixed-step loop. */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
  readonly atlas: Atlas;
  readonly chunks: ChunkManager;
  readonly sky: Sky;
  readonly input: Input;
  readonly player = new Player();
  readonly hud: Hud;
  readonly picker: BlockPicker;
  readonly icons: IconCache;
  readonly outline = new BlockOutline();
  hotbar: number[] = [...DEFAULT_HOTBAR];
  selected = 0;
  state: GameState = 'loading';
  renderDistanceIndex = DEFAULT_RENDER_DISTANCE;
  sensitivity = 1;
  invertY = false;
  target: RayHit | null = null;
  private world: World | null = null;
  private collision: CollisionWorld | null = null;
  private accumulator = 0;
  private lastTime = 0;
  private readonly repeatAt = [0, 0, 0];
  private openPickerOnUnlock = false;
  private readonly overlay: HTMLElement;
  private readonly overlayText: HTMLElement;
  private frameResolvers: Array<() => void> = [];

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
    this.scene.add(this.outline.object);
    this.sky = new Sky(this.scene, this.atlas);
    this.input = new Input(canvas);
    this.icons = new IconCache(this.atlas.canvas);
    this.hud = new Hud(ui, this.icons);
    this.picker = new BlockPicker(ui, this.icons);
    this.picker.onPick = (id) => {
      this.hotbar[this.selected] = id;
      this.hud.render(this.hotbar, this.selected, true);
      this.resume();
    };
    this.picker.onClose = () => this.resume();

    this.overlayText = document.createElement('p');
    this.overlayText.className = 'big-cta';
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay click-to-play hidden';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<h1 class="title">Blocktide</h1>';
    panel.append(this.overlayText);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML =
      '<kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>Z</kbd> fly · <kbd>B</kbd> blocks · <kbd>R</kbd> respawn<br>' +
      'Left click break · right click place · middle click pick';
    panel.append(hint);
    this.overlay.append(panel);
    this.overlay.addEventListener('click', () => this.resume());
    this.ui.appendChild(this.overlay);
    canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) this.resume();
    });

    this.input.handlers = {
      onKeyDown: (code) => this.onKey(code),
      onButtonDown: (button) => this.onButton(button),
      onWheel: (steps) => {
        if (this.state !== 'playing') return;
        this.select((((this.selected + steps) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE);
      },
      onLockChange: (locked) => this.onLockChange(locked),
    };

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get renderDistance(): number {
    return RENDER_DISTANCES[this.renderDistanceIndex]!.blocks;
  }

  get currentWorld(): World | null {
    return this.world;
  }

  async setWorld(world: World, onProgress?: (done: number, total: number) => void): Promise<void> {
    this.world = world;
    this.collision = collisionWorld(world);
    this.target = null;
    this.sky.setWorld(world);
    this.chunks.setWorld(world);
    await this.chunks.buildAll(onProgress);
  }

  /** Place the camera (flying) at a fixed viewpoint. */
  setViewpoint(v: Viewpoint): void {
    this.player.teleport(v.x, v.y - PLAYER_EYE, v.z);
    this.player.yaw = v.yaw;
    this.player.pitch = v.pitch;
    this.player.body.flying = true;
  }

  /** Show the click-to-play overlay. */
  showTitle(): void {
    this.state = 'title';
    this.overlayText.textContent = 'Click to play';
    this.overlay.classList.remove('hidden');
    this.hud.setVisible(false);
  }

  /** Enter play without pointer lock (the ?debug view). */
  enterPlayUnlocked(): void {
    this.state = 'playing';
    this.overlay.classList.add('hidden');
    this.hud.setVisible(true);
    this.hud.render(this.hotbar, this.selected);
  }

  /** Resolves after the next frame has been rendered. */
  nextFrame(): Promise<void> {
    return new Promise((resolve) => this.frameResolvers.push(resolve));
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
    this.hud.flash(`Render distance: ${RENDER_DISTANCES[this.renderDistanceIndex]!.name}`);
  }

  select(slot: number): void {
    this.selected = slot;
    this.hud.render(this.hotbar, this.selected, true);
  }

  setHotbar(ids: readonly number[], selected: number): void {
    this.hotbar = Array.from({ length: HOTBAR_SIZE }, (_, i) => {
      const id = ids[i];
      return id !== undefined && isValidBlock(id) && id !== B.AIR ? id : DEFAULT_HOTBAR[i]!;
    });
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, Math.floor(selected) || 0));
    this.hud.render(this.hotbar, this.selected);
  }

  // ---- State transitions ----

  resume(): void {
    this.picker.close();
    void this.input.requestLock().then((ok) => {
      if (!ok && !this.input.locked) this.pause();
    });
  }

  pause(): void {
    this.state = 'paused';
    this.picker.close();
    this.overlayText.textContent = 'Paused — click to resume';
    this.overlay.classList.remove('hidden');
    this.hud.setVisible(false);
  }

  private openPicker(): void {
    this.state = 'picker';
    this.overlay.classList.add('hidden');
    this.picker.open();
  }

  private onLockChange(locked: boolean): void {
    if (locked) {
      this.state = 'playing';
      this.overlay.classList.add('hidden');
      this.picker.close();
      this.hud.setVisible(true);
      this.hud.render(this.hotbar, this.selected);
      return;
    }
    if (this.state !== 'playing') return;
    if (this.openPickerOnUnlock) {
      this.openPickerOnUnlock = false;
      this.openPicker();
    } else {
      this.pause();
    }
  }

  private onKey(code: string): void {
    if (this.state === 'picker') {
      if (code === 'KeyB') this.resume();
      else if (code === 'Escape') this.pause();
      return;
    }
    if (this.state !== 'playing') return;
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= HOTBAR_SIZE) this.select(n - 1);
      return;
    }
    switch (code) {
      case 'KeyZ': {
        const b = this.player.body;
        b.flying = !b.flying;
        b.vy = 0;
        this.hud.flash(b.flying ? 'Flying' : 'Walking');
        break;
      }
      case 'KeyR':
        this.player.respawn();
        break;
      case 'KeyF':
        this.cycleRenderDistance();
        break;
      case 'KeyB':
        if (this.input.locked) {
          this.openPickerOnUnlock = true;
          this.input.exitLock();
        } else {
          this.openPicker();
        }
        break;
    }
  }

  private onButton(button: number): void {
    if (this.state !== 'playing') return;
    this.act(button);
    this.repeatAt[button] = performance.now() + ACTION_REPEAT_S * 1000;
  }

  // ---- Block interaction ----

  private act(button: number): void {
    const world = this.world;
    const hit = this.target;
    if (!world || !hit) return;
    if (button === BUTTON_LEFT) {
      if (breakBlock(world, hit.x, hit.y, hit.z)) this.edited(hit);
    } else if (button === BUTTON_RIGHT) {
      const id = this.hotbar[this.selected] ?? B.AIR;
      const cell = placementTarget(world, hit, [hit.nx, hit.ny, hit.nz], id);
      const changed = placeBlock(world, cell, id, (c, h) => bodyOverlapsCell(this.player.body, c.x, c.y, c.z, h));
      if (changed) this.edited(changed);
    } else if (button === BUTTON_MIDDLE) {
      this.hotbar[this.selected] = hit.id;
      this.hud.render(this.hotbar, this.selected, true);
    }
  }

  /** Rebuild the edited chunk right away and refresh the target. */
  private edited(cell: Cell): void {
    this.chunks.rebuildAt(cell.x, cell.y, cell.z);
    this.updateTarget();
  }

  private updateTarget(): void {
    const world = this.world;
    if (!world || this.state !== 'playing') {
      this.target = null;
      this.outline.set(null);
      return;
    }
    const p = this.camera.position;
    this.target = this.player.target(world, p.x, p.y, p.z);
    const t = this.target;
    if (!t) {
      this.outline.set(null);
      return;
    }
    const b = blockBounds(t.id);
    this.outline.set([t.x + b[0], t.y + b[1], t.z + b[2], t.x + b[3], t.y + b[4], t.z + b[5]]);
  }

  // ---- Loop ----

  private frame(now: number): void {
    const dt = Math.min((now - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = now;

    const { dx, dy } = this.input.takeMouseDelta();
    if (this.state === 'playing' && this.input.locked) {
      const k = MOUSE_SCALE * this.sensitivity;
      this.player.look(-dx * k, -dy * k * (this.invertY ? -1 : 1));
    }

    if (this.state === 'playing' && this.collision) {
      this.accumulator += dt;
      while (this.accumulator >= STEP_DT) {
        this.step(STEP_DT);
        this.accumulator -= STEP_DT;
      }
    } else {
      this.accumulator = 0;
    }

    const alpha = this.accumulator / STEP_DT;
    const pl = this.player;
    const b = pl.body;
    this.camera.position.set(
      pl.prevX + (b.x - pl.prevX) * alpha,
      pl.prevY + (b.y - pl.prevY) * alpha + PLAYER_EYE,
      pl.prevZ + (b.z - pl.prevZ) * alpha,
    );
    this.camera.rotation.set(pl.pitch, pl.yaw, 0);

    this.updateTarget();
    if (this.state === 'playing' && this.input.locked) {
      for (const button of [BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT]) {
        if (!this.input.isButtonHeld(button)) continue;
        if (now >= this.repeatAt[button]!) {
          this.act(button);
          this.repeatAt[button] = now + ACTION_REPEAT_S * 1000;
        }
      }
    }

    const distance = this.renderDistance;
    this.camera.far = distance + 256;
    this.camera.updateProjectionMatrix();
    this.sky.update(dt, this.camera, this.cameraMedium(), distance);
    this.chunks.update(this.camera.position, REMESH_BUDGET_MS);
    this.chunks.updateVisibility(this.camera.position, distance);
    this.renderer.render(this.scene, this.camera);

    const resolvers = this.frameResolvers;
    this.frameResolvers = [];
    for (const r of resolvers) r();
  }

  private step(dt: number): void {
    const i = this.input;
    const collision = this.collision;
    if (!collision) return;
    this.player.step(
      collision,
      {
        forward: (i.isDown('KeyW') ? 1 : 0) - (i.isDown('KeyS') ? 1 : 0),
        strafe: (i.isDown('KeyD') ? 1 : 0) - (i.isDown('KeyA') ? 1 : 0),
        jump: i.isDown('Space'),
        down: i.isDown('ShiftLeft') || i.isDown('ShiftRight'),
      },
      dt,
    );
    // Fell out of the world somehow: put the player back.
    if (this.player.body.y < -32) this.player.respawn();
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

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
