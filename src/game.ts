import * as THREE from 'three';
import {
  ACTION_REPEAT_S,
  AUTOSAVE_S,
  DEBUG_SEED,
  MAX_FRAME_DT,
  PLAYER_EYE,
  REMESH_BUDGET_MS,
  RENDER_DISTANCES,
  STEP_DT,
  STEPS_PER_TICK,
} from './config';
import { BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT, Input } from './player/input';
import { bodyOverlapsCell, type CollisionWorld } from './player/physics';
import { collisionWorld, Player } from './player/player';
import type { RayHit } from './player/raycast';
import { createAtlas, type Atlas } from './render/atlas';
import { ChunkManager } from './render/chunks';
import { createMaterials } from './render/materials';
import { BlockOutline } from './render/outline';
import { Sky, type Medium } from './render/sky';
import { gunzip, gzip } from './save/compress';
import { deserializeSave, serializeSave, type SaveData } from './save/serialize';
import { readSave, writeSave } from './save/storage';
import { DebugOverlay } from './ui/debug';
import { el } from './ui/dom';
import { Hud, HOTBAR_SIZE } from './ui/hud';
import { IconCache } from './ui/icons';
import { LoadingScreen } from './ui/loading';
import { PauseMenu } from './ui/menu';
import { BlockPicker } from './ui/picker';
import { loadSettings, sanitizeSettings, saveSettings, type Settings } from './ui/settings';
import { randomSeed, seedFromString } from './util/prng';
import { B, blockBounds, blockName, DEFAULT_HOTBAR, isValidBlock } from './world/blocks';
import { generateAsync } from './world/generate';
import { findSpawn } from './world/generator';
import { breakBlock, placeBlock, placementTarget, type Cell } from './world/placement';
import { WORLD_SIZES, type WorldSizeName } from './world/sizes';
import { Ticker } from './world/ticker';
import { World } from './world/world';

const MOUSE_SCALE = 0.0022;

export type GameState = 'loading' | 'title' | 'playing' | 'paused' | 'picker';

export interface Viewpoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface BootOptions {
  /** ?debug: fixed seed, fixed camera, no overlay, no saving. */
  debug: boolean;
  size: WorldSizeName;
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
  readonly menu: PauseMenu;
  readonly loading: LoadingScreen;
  readonly debugOverlay: DebugOverlay;
  readonly icons: IconCache;
  readonly outline = new BlockOutline();
  settings: Settings = loadSettings();
  hotbar: number[] = [...DEFAULT_HOTBAR];
  selected = 0;
  state: GameState = 'loading';
  target: RayHit | null = null;
  debugMode = false;
  /** Called after a world finishes loading and the first frame is drawn. */
  onWorldReady: () => void = () => {};
  private world: World | null = null;
  private collision: CollisionWorld | null = null;
  private ticker: Ticker | null = null;
  private stepCount = 0;
  private accumulator = 0;
  private lastTime = 0;
  private readonly repeatAt = [0, 0, 0];
  private openPickerOnUnlock = false;
  private readonly titleOverlay: HTMLElement;
  private frameResolvers: Array<() => void> = [];
  private autosaveTimer = 0;
  private saving = false;
  private busy = false;
  // Debug counters.
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;
  private frameMs = 0;
  private rebuildsAtLastSample = 0;
  private rebuildsPerSec = 0;
  private debugRefresh = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    ui: HTMLElement,
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
    this.debugOverlay = new DebugOverlay(ui);
    this.picker = new BlockPicker(ui, this.icons);
    this.picker.onPick = (id) => {
      this.hotbar[this.selected] = id;
      this.hud.render(this.hotbar, this.selected, true);
      this.resume();
    };
    this.picker.onClose = () => this.resume();

    this.titleOverlay = el('div', { className: 'overlay click-to-play hidden' }, [
      el('div', { className: 'panel' }, [
        el('h1', { className: 'title', text: 'Blocktide' }),
        el('p', { className: 'subtitle', text: 'A little world of blocks' }),
        el('p', { className: 'big-cta', text: 'Click to play' }),
        el('p', {
          className: 'hint',
          html:
            '<kbd>WASD</kbd> move · <kbd>Space</kbd> jump · <kbd>Z</kbd> fly · <kbd>B</kbd> blocks · <kbd>Esc</kbd> menu<br>' +
            'Left click break · right click place · middle click pick',
        }),
      ]),
    ]);
    this.titleOverlay.addEventListener('click', () => this.resume());
    ui.appendChild(this.titleOverlay);

    this.menu = new PauseMenu(ui, {
      resume: () => this.resume(),
      save: () => void this.saveNow('manual'),
      load: () => void this.loadSaved(true),
      newWorld: (size, seedText) => {
        const seed = seedText.trim() === '' ? randomSeed() : seedFromString(seedText);
        void this.newWorld(size, seed);
      },
      settingsChanged: (s) => this.applySettings(s),
    });
    this.menu.setSettings(this.settings);
    this.menu.setCanLoad(false);
    this.loading = new LoadingScreen(ui);

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
    window.addEventListener('beforeunload', () => {
      // Best effort: kick off a save if the page is closed mid-game.
      if (this.state === 'playing') void this.saveNow('autosave');
    });
    this.applySettings(this.settings);
    this.resize();
  }

  get renderDistance(): number {
    return RENDER_DISTANCES[this.settings.renderDistance]!.blocks;
  }

  get currentWorld(): World | null {
    return this.world;
  }

  // ---- World lifecycle ----

  /** Load the last save, or generate a new world. */
  async boot(opts: BootOptions): Promise<void> {
    this.debugMode = opts.debug;
    this.start();
    if (!opts.debug) {
      const hasSave = await this.hasSave();
      this.menu.setCanLoad(hasSave);
      if (hasSave && (await this.loadSaved(false))) return;
    }
    await this.newWorld(opts.size, opts.debug ? DEBUG_SEED : randomSeed());
  }

  async newWorld(size: WorldSizeName, seed: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const dims = WORLD_SIZES[size];
      this.enterLoading('Generating level…');
      const blocks = await generateAsync({ sx: dims.sx, sy: dims.sy, sz: dims.sz, seed }, (stage, f) =>
        this.loading.set(stage, f * 0.8),
      );
      const world = new World(dims.sx, dims.sy, dims.sz, seed, blocks);
      await this.installWorld(world);
      const spawn = findSpawn(world.blocks, world.sx, world.sy, world.sz);
      this.player.setSpawn(spawn.x, spawn.y, spawn.z);
      this.player.respawn();
      this.player.body.flying = false;
      this.player.yaw = 0;
      this.player.pitch = 0;
      await this.finishLoading();
      if (!this.debugMode) await this.saveNow('autosave');
    } catch (err) {
      console.error(err);
      this.loading.set(`Could not generate the level: ${err instanceof Error ? err.message : String(err)}`, 0);
    } finally {
      this.busy = false;
    }
  }

  /** Load the save slot. Returns false when there is none or it is unreadable. */
  async loadSaved(fromMenu: boolean): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const stored = await readSave();
      if (!stored) {
        if (fromMenu) this.menu.setStatus('No saved world yet.', 'error');
        return false;
      }
      this.enterLoading('Loading level…');
      this.loading.set('Reading save', 0.1);
      const data = deserializeSave(await gunzip(new Uint8Array(stored.data)));
      const { sx, sy, sz, seed, blocks } = data.world;
      const world = new World(sx, sy, sz, seed, blocks);
      await this.installWorld(world);
      const p = data.player;
      this.player.setSpawn(p.spawnX, p.spawnY, p.spawnZ);
      this.player.setState({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flying: p.flying });
      this.setHotbar(data.hotbar, data.selected);
      await this.finishLoading();
      return true;
    } catch (err) {
      console.warn('Could not load save:', err);
      if (fromMenu) {
        this.loading.close();
        this.pause();
        this.menu.setStatus(`Could not load: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  async saveNow(reason: 'manual' | 'autosave'): Promise<boolean> {
    const world = this.world;
    if (this.debugMode) {
      if (reason === 'manual') this.menu.setStatus('Saving is off in ?debug mode.', 'error');
      return false;
    }
    if (!world || this.saving || this.state === 'loading') return false;
    this.saving = true;
    try {
      const raw = serializeSave(this.collectSave(world));
      const packed = await gzip(raw);
      await writeSave({ data: packed.buffer, savedAt: Date.now(), label: `${world.sx}×${world.sz} seed ${world.seed}` });
      this.menu.setCanLoad(true);
      const time = new Date().toLocaleTimeString();
      this.menu.setStatus(reason === 'manual' ? `Saved at ${time}.` : `Autosaved at ${time}.`, 'ok');
      this.autosaveTimer = 0;
      return true;
    } catch (err) {
      console.warn('Save failed:', err);
      this.menu.setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    } finally {
      this.saving = false;
    }
  }

  private async hasSave(): Promise<boolean> {
    try {
      return (await readSave()) !== null;
    } catch {
      return false;
    }
  }

  private collectSave(world: World): SaveData {
    const s = this.player.getState();
    return {
      world: { sx: world.sx, sy: world.sy, sz: world.sz, seed: world.seed, blocks: world.blocks },
      player: {
        ...s,
        spawnX: this.player.spawn.x,
        spawnY: this.player.spawn.y,
        spawnZ: this.player.spawn.z,
      },
      hotbar: [...this.hotbar],
      selected: this.selected,
    };
  }

  private enterLoading(heading: string): void {
    this.state = 'loading';
    this.input.exitLock();
    this.menu.close();
    this.picker.close();
    this.titleOverlay.classList.add('hidden');
    this.hud.setVisible(false);
    this.loading.open(heading);
  }

  private async installWorld(world: World): Promise<void> {
    this.ticker?.dispose();
    this.world = world;
    this.collision = collisionWorld(world);
    this.ticker = new Ticker(world);
    this.stepCount = 0;
    this.target = null;
    this.outline.set(null);
    this.sky.setWorld(world);
    this.chunks.setWorld(world);
    this.loading.set('Building terrain', 0.8);
    await this.chunks.buildAll((done, total) => this.loading.set('Building terrain', 0.8 + (0.2 * done) / total));
    this.menu.setInfo(`World ${world.sx}×${world.sz} · seed ${world.seed}`);
  }

  private async finishLoading(): Promise<void> {
    this.loading.close();
    this.autosaveTimer = 0;
    if (this.debugMode) {
      this.setViewpoint(debugViewpoint(this.world!));
      this.enterPlayUnlocked();
    } else {
      this.showTitle();
    }
    await this.nextFrame();
    this.onWorldReady();
  }

  // ---- Views and state ----

  /** Place the camera (flying) at a fixed viewpoint. */
  setViewpoint(v: Viewpoint): void {
    this.player.teleport(v.x, v.y - PLAYER_EYE, v.z);
    this.player.yaw = v.yaw;
    this.player.pitch = v.pitch;
    this.player.body.flying = true;
  }

  showTitle(): void {
    this.state = 'title';
    this.menu.close();
    this.titleOverlay.classList.remove('hidden');
    this.hud.setVisible(false);
  }

  /** Enter play without pointer lock (the ?debug view). */
  enterPlayUnlocked(): void {
    this.state = 'playing';
    this.titleOverlay.classList.add('hidden');
    this.menu.close();
    this.hud.setVisible(true);
    this.hud.render(this.hotbar, this.selected);
  }

  resume(): void {
    if (this.state === 'loading') return;
    this.picker.close();
    void this.input.requestLock().then((ok) => {
      if (!ok && !this.input.locked) {
        // The browser refused (e.g. too soon after Esc): ask for another click.
        if (this.state === 'picker') this.picker.close();
        this.showTitle();
      }
    });
  }

  pause(): void {
    const wasPlaying = this.state === 'playing' || this.state === 'picker';
    this.state = 'paused';
    this.picker.close();
    this.titleOverlay.classList.add('hidden');
    this.hud.setVisible(false);
    this.menu.setSettings(this.settings);
    this.menu.open();
    if (wasPlaying) void this.saveNow('autosave');
  }

  private openPicker(): void {
    this.state = 'picker';
    this.picker.open();
  }

  private onLockChange(locked: boolean): void {
    if (locked) {
      if (this.state === 'loading') {
        this.input.exitLock();
        return;
      }
      this.state = 'playing';
      this.titleOverlay.classList.add('hidden');
      this.menu.close();
      this.picker.close();
      this.hud.setVisible(true);
      this.hud.render(this.hotbar, this.selected);
      return;
    }
    if (this.state !== 'playing') return;
    if (this.openPickerOnUnlock) {
      this.openPickerOnUnlock = false;
      this.openPicker();
      return;
    }
    this.pause();
  }

  // ---- Settings ----

  applySettings(s: Settings): void {
    this.settings = sanitizeSettings(s);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    saveSettings(this.settings);
  }

  cycleRenderDistance(): void {
    const next = (this.settings.renderDistance + 1) % RENDER_DISTANCES.length;
    this.applySettings({ ...this.settings, renderDistance: next });
    this.menu.setSettings(this.settings);
    this.hud.flash(`Render distance: ${RENDER_DISTANCES[next]!.name}`);
  }

  // ---- Hotbar ----

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

  // ---- Input ----

  private onKey(code: string): void {
    if (code === 'F3') {
      this.debugOverlay.toggle();
      return;
    }
    if (this.state === 'picker') {
      if (code === 'KeyB') this.resume();
      else if (code === 'Escape') this.pause();
      return;
    }
    if (this.state === 'paused') {
      if (code === 'Escape') this.menu.back();
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
      case 'Escape':
        // Only reached when playing without pointer lock (debug view).
        if (!this.input.locked) this.pause();
        break;
    }
  }

  private onButton(button: number): void {
    if (this.state !== 'playing') return;
    this.act(button);
    this.repeatAt[button] = performance.now() + ACTION_REPEAT_S * 1000;
  }

  // ---- Block interaction ----

  /** Perform the action bound to a mouse button on the current target. */
  act(button: number): void {
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

  /** Resolves after the next frame has been rendered. */
  nextFrame(): Promise<void> {
    return new Promise((resolve) => this.frameResolvers.push(resolve));
  }

  private start(): void {
    this.lastTime = performance.now();
    const frame = (now: number): void => {
      this.frame(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private frame(now: number): void {
    const frameStart = performance.now();
    const rawDt = (now - this.lastTime) / 1000;
    const dt = Math.min(Math.max(rawDt, 0), MAX_FRAME_DT);
    this.lastTime = now;

    const { dx, dy } = this.input.takeMouseDelta();
    const playing = this.state === 'playing';
    if (playing && this.input.locked) {
      const k = MOUSE_SCALE * this.settings.sensitivity;
      this.player.look(-dx * k, -dy * k * (this.settings.invertY ? -1 : 1));
    }

    if (playing && this.collision) {
      this.accumulator += dt;
      while (this.accumulator >= STEP_DT) {
        this.step(STEP_DT);
        this.accumulator -= STEP_DT;
      }
      if (!this.debugMode) {
        this.autosaveTimer += dt;
        if (this.autosaveTimer >= AUTOSAVE_S) void this.saveNow('autosave');
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
    if (playing && this.input.locked) {
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

    this.updateDebug(rawDt, performance.now() - frameStart);
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
    if (this.player.body.y < -32) this.player.respawn();
    // Block behaviours tick at 20 Hz on the same fixed clock.
    this.stepCount++;
    if (this.ticker && this.stepCount % STEPS_PER_TICK === 0) this.ticker.step();
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

  private updateDebug(rawDt: number, frameMs: number): void {
    this.fpsFrames++;
    this.fpsTime += rawDt;
    this.frameMs = this.frameMs * 0.9 + frameMs * 0.1;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.rebuildsPerSec = Math.round((this.chunks.rebuilds - this.rebuildsAtLastSample) / this.fpsTime);
      this.rebuildsAtLastSample = this.chunks.rebuilds;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    if (!this.debugOverlay.visible) return;
    this.debugRefresh -= rawDt;
    if (this.debugRefresh > 0) return;
    this.debugRefresh = 0.2;
    const b = this.player.body;
    const t = this.target;
    const info = this.renderer.info.render;
    const w = this.world;
    this.debugOverlay.update({
      fps: this.fps,
      frameMs: this.frameMs,
      x: b.x,
      y: b.y,
      z: b.z,
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      target: t ? `${blockName(t.id)} @ ${t.x} ${t.y} ${t.z} (face ${['+X', '-X', '+Y', '-Y', '+Z', '-Z'][t.face]})` : 'none',
      rebuildsPerSec: this.rebuildsPerSec,
      rebuildsTotal: this.chunks.rebuilds,
      pendingChunks: this.chunks.pending,
      drawCalls: info.calls,
      triangles: info.triangles,
      world: w ? `${w.sx}×${w.sy}×${w.sz} seed ${w.seed}` : '—',
      mode: `${b.flying ? 'flying' : b.liquid === 1 ? 'swimming' : b.liquid === 2 ? 'in lava' : 'walking'}${b.onGround ? ', on ground' : ''} · view ${RENDER_DISTANCES[this.settings.renderDistance]!.name}`,
      tick: this.ticker
        ? `#${this.ticker.tick}  ${this.ticker.lastUpdates} updates/tick  ${this.ticker.pending} queued`
        : '—',
    });
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

/** Fixed camera for the ?debug screenshot: looking across the map centre. */
export function debugViewpoint(world: World): Viewpoint {
  const x = world.sx * 0.5 - 40;
  const z = world.sz * 0.5 + 44;
  const y = world.seaLevel + 22;
  const tx = world.sx * 0.5 + 8;
  const tz = world.sz * 0.5 - 16;
  return { x, y, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: -0.32 };
}
