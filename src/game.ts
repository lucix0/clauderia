import * as THREE from 'three';
import {
  ACTION_REPEAT_S,
  AUTOSAVE_S,
  MAX_FRAME_DT,
  PLAYER_EYE,
  REMESH_BUDGET_MS,
  RENDER_DISTANCES,
  STEP_DT,
  STEPS_PER_TICK,
  UPLOAD_BUDGET_MS,
} from './config';
import { runCommand, type CommandContext, type Vec3 } from './commands/commands';
import { Streamer } from './stream/streamer';
import { CommandBar } from './ui/commandBar';
import { WorkerPool } from './workers/pool';
import { BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT, Input } from './player/input';
import { bodyOverlapsCell, type CollisionWorld } from './player/physics';
import { collisionWorld, Player } from './player/player';
import type { RayHit } from './player/raycast';
import { createAtlas, type Atlas } from './render/atlas';
import { ChunkRenderer } from './render/chunks';
import { createMaterials } from './render/materials';
import { BlockOutline } from './render/outline';
import { Sky, type Medium } from './render/sky';
import { gunzip } from './save/compress';
import { commitMigration, deleteWorld, getWorld, listWorlds, packChunks, readLegacySave } from './save/db';
import { migrateV1 } from './save/migrate';
import { newWorldId, type ClassicSizeName, type PlayerRecord } from './save/records';
import { deserializeSave } from './save/serialize';
import { WorldSession } from './session';
import { DebugOverlay } from './ui/debug';
import { el } from './ui/dom';
import { Hud, HOTBAR_SIZE } from './ui/hud';
import { IconCache } from './ui/icons';
import { LoadingScreen } from './ui/loading';
import { PauseMenu } from './ui/menu';
import { BlockPicker } from './ui/picker';
import { loadSettings, sanitizeSettings, saveSettings, type Settings } from './ui/settings';
import { TitleScreen, type CreateWorldOptions } from './ui/title';
import { randomSeed, seedFromString } from './util/prng';
import { B, blockBounds, blockName, DEFAULT_HOTBAR, IS_SOLID, isValidBlock } from './world/blocks';
import { breakBlock, placeBlock, placementTarget, type Cell } from './world/placement';
import type { World } from './world/world';

const MOUSE_SCALE = 0.0022;

/**
 * - menu: title screen / world list
 * - loading: generating or reading a world
 * - ready: world loaded, waiting for the click that captures the mouse
 */
export type GameState = 'menu' | 'loading' | 'ready' | 'playing' | 'paused' | 'picker' | 'command';

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
  /** World type for ?debug. */
  type: 'classic' | 'infinite';
  size: ClassicSizeName;
}

/** Owns the renderer, world, player, UI and the fixed-step loop. */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1000);
  readonly atlas: Atlas;
  readonly chunks: ChunkRenderer;
  readonly sky: Sky;
  readonly input: Input;
  readonly player = new Player();
  readonly hud: Hud;
  readonly picker: BlockPicker;
  readonly menu: PauseMenu;
  readonly loading: LoadingScreen;
  readonly title: TitleScreen;
  readonly commandBar: CommandBar;
  readonly pool: WorkerPool;
  streamer: Streamer | null = null;
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
  /** Called when a world starts loading (or the game returns to the title screen). */
  onWorldUnready: () => void = () => {};
  session: WorldSession | null = null;
  private world: World | null = null;
  private collision: CollisionWorld | null = null;
  private stepCount = 0;
  private accumulator = 0;
  private lastTime = 0;
  private readonly repeatAt = [0, 0, 0];
  private openPickerOnUnlock = false;
  private openCommandOnUnlock = false;
  private readonly titleOverlay: HTMLElement;
  private frameResolvers: Array<() => void> = [];
  private readonly tmpDir = new THREE.Vector3();
  private autosaveTimer = 0;
  private pendingSpawn = false;
  private placeOnSpawn = false;
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
    this.chunks = new ChunkRenderer(createMaterials(this.atlas.texture));
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
      quit: () => void this.quitToTitle(),
      settingsChanged: (s) => this.applySettings(s),
    });
    this.menu.setSettings(this.settings);
    this.title = new TitleScreen(
      ui,
      {
        play: (id) => void this.playWorld(id),
        create: (opts) => void this.createWorld(opts),
        remove: (id) => void this.removeWorld(id),
      },
      { types: ['infinite', 'classic'], modes: ['creative'], difficulties: ['normal'] },
    );
    this.loading = new LoadingScreen(ui);
    this.commandBar = new CommandBar(ui);
    this.commandBar.onSubmit = (line) => {
      const out = this.command(line);
      if (out) this.commandBar.print(out, /^(Unknown|Bad|Missing|No |Usage|Nothing)/.test(out) || out.includes(' — /') ? 'error' : 'info');
      this.resume();
    };
    this.commandBar.onClose = () => this.resume();
    this.pool = new WorkerPool();

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
    // Best effort: flush when the tab is hidden or closed.
    window.addEventListener('pagehide', () => void this.saveNow('autosave'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.saveNow('autosave');
    });
    this.applySettings(this.settings);
    this.resize();
  }

  /** Render distance in blocks. */
  get renderDistance(): number {
    return this.settings.renderDistance * 16;
  }

  get currentWorld(): World | null {
    return this.world;
  }

  // ---- World lifecycle ----

  /** Start the loop, then show the world list (or jump into ?debug). */
  async boot(opts: BootOptions): Promise<void> {
    this.debugMode = opts.debug;
    this.start();
    if (opts.debug) {
      await this.openSession(() => WorldSession.openDebug(opts.type, opts.size, (st, f) => this.loading.set(st, f)));
      return;
    }
    await this.migrateLegacySave();
    await this.showTitleScreen();
  }

  /** Title screen with the stored worlds. */
  async showTitleScreen(status = ''): Promise<void> {
    this.state = 'menu';
    this.input.exitLock();
    this.menu.close();
    this.picker.close();
    this.titleOverlay.classList.add('hidden');
    this.hud.setVisible(false);
    this.loading.close();
    let worlds: Awaited<ReturnType<typeof listWorlds>> = [];
    try {
      worlds = await listWorlds();
    } catch (err) {
      console.warn('Could not list worlds:', err);
      status = 'Saving is unavailable in this browser; worlds will not be kept.';
    }
    this.title.open(worlds);
    this.title.setStatus(status, status ? 'error' : 'info');
  }

  async createWorld(opts: CreateWorldOptions): Promise<void> {
    const seed = opts.seedText.trim() === '' ? randomSeed() : seedFromString(opts.seedText);
    const record = WorldSession.newRecord({ ...opts, seed });
    await this.openSession(() => WorldSession.open(record, true, (st, f) => this.loading.set(st, f)));
  }

  async playWorld(id: string): Promise<void> {
    const record = await getWorld(id);
    if (!record) {
      await this.showTitleScreen('That world could not be read.');
      return;
    }
    record.lastPlayed = Date.now();
    await this.openSession(() => WorldSession.open(record, true, (st, f) => this.loading.set(st, f)));
  }

  async removeWorld(id: string): Promise<void> {
    try {
      await deleteWorld(id);
      await this.showTitleScreen();
    } catch (err) {
      console.warn('Delete failed:', err);
      this.title.setStatus(`Could not delete: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async quitToTitle(): Promise<void> {
    await this.saveNow('autosave');
    this.closeSession();
    await this.showTitleScreen();
  }

  /** Convert a v1 single-slot save into a Classic world, once. */
  private async migrateLegacySave(): Promise<void> {
    try {
      const legacy = await readLegacySave();
      if (!legacy) return;
      this.enterLoading('Upgrading your saved world…');
      this.loading.set('Converting save', 0.2);
      const data = deserializeSave(await gunzip(new Uint8Array(legacy)));
      await new Promise((r) => setTimeout(r, 0));
      const migrated = migrateV1(data, newWorldId(), Date.now());
      this.loading.set('Writing chunks', 0.8);
      await commitMigration(migrated.world, await packChunks(migrated.world.id, migrated.chunks));
    } catch (err) {
      console.warn('Could not migrate the old save:', err);
    }
  }

  /** Load a world behind the loading screen, then wait for the click to play. */
  private async openSession(open: () => Promise<WorldSession>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.title.close();
      this.enterLoading(this.debugMode ? 'Generating level…' : 'Loading world…');
      this.closeSession();
      const session = await open();
      await this.installSession(session);
      await this.finishLoading();
      if (session.persistent && !session.record.player) await this.saveNow('autosave');
    } catch (err) {
      console.error(err);
      await this.showTitleScreen(`Could not open the world: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private closeSession(): void {
    this.onWorldUnready();
    this.streamer?.dispose();
    this.streamer = null;
    this.session?.dispose();
    this.session = null;
    this.world = null;
    this.collision = null;
    this.target = null;
    this.outline.set(null);
    this.chunks.disposeAll();
  }

  async saveNow(reason: 'manual' | 'autosave'): Promise<boolean> {
    const session = this.session;
    if (!session || !session.persistent) {
      if (reason === 'manual') this.menu.setStatus('Saving is off in ?debug mode.', 'error');
      return false;
    }
    if (this.state === 'loading') return false;
    try {
      await session.save(this.playerRecord());
      const time = new Date().toLocaleTimeString();
      this.menu.setStatus(reason === 'manual' ? `Saved at ${time}.` : `Autosaved at ${time}.`, 'ok');
      this.autosaveTimer = 0;
      return true;
    } catch (err) {
      console.warn('Save failed:', err);
      this.menu.setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    }
  }

  private playerRecord(): PlayerRecord {
    const s = this.player.getState();
    return { ...s, hotbar: [...this.hotbar], selected: this.selected };
  }

  private enterLoading(heading: string): void {
    this.state = 'loading';
    this.input.exitLock();
    this.menu.close();
    this.picker.close();
    this.title.close();
    this.titleOverlay.classList.add('hidden');
    this.hud.setVisible(false);
    this.loading.open(heading);
  }

  private async installSession(session: WorldSession): Promise<void> {
    const world = session.world;
    this.session = session;
    this.world = world;
    this.collision = collisionWorld(world);
    this.stepCount = 0;
    this.target = null;
    this.outline.set(null);
    this.sky.setWorld(world);
    this.chunks.setWorld(world);
    const streamer = new Streamer(world, this.pool, this.chunks, {
      loadRecord: (cx, cz) => session.loadRecord(cx, cz),
      unloaded: (chunks) => session.chunksUnloaded(chunks),
    });
    streamer.radius = this.settings.renderDistance;
    this.streamer = streamer;

    const spawn = session.spawn;
    this.player.setSpawn(spawn.x, Math.max(spawn.y, 0), spawn.z);
    const p = session.record.player;
    if (p) {
      this.player.setState(p);
      this.setHotbar(p.hotbar, p.selected);
    } else {
      this.player.teleport(spawn.x, spawn.y < 0 ? world.seaLevel + 24 : spawn.y, spawn.z);
      this.player.body.flying = false;
      this.player.yaw = 0;
      this.player.pitch = 0;
      this.setHotbar(DEFAULT_HOTBAR, 0);
    }
    this.pendingSpawn = session.spawnPending;
    this.placeOnSpawn = !p;

    // Wait for the terrain around the player to be meshed (and the spawn to resolve).
    const b = this.player.body;
    const pcx = Math.floor(b.x) >> 4;
    const pcz = Math.floor(b.z) >> 4;
    for (;;) {
      await this.nextFrame();
      if (this.session !== session) return;
      const f = streamer.meshedFraction(pcx, pcz, 2);
      this.loading.set('Building terrain', 0.8 + 0.2 * f);
      if (f >= 1 && !this.pendingSpawn) break;
    }
    this.menu.setCanSave(session.persistent);
    this.menu.setStatus('');
    this.menu.setInfo(`${session.record.name} · seed ${world.seed}`);
  }

  /** Once the spawn column is loaded, find the ground and (maybe) put the player there. */
  private resolveSpawn(): void {
    const session = this.session;
    const world = this.world;
    if (!session || !world) return;
    const s = session.spawn;
    if (this.pendingSpawn) {
      if (!world.isActive(Math.floor(s.x), Math.floor(s.z))) return;
      const y = groundHeight(world, Math.floor(s.x), Math.floor(s.z));
      session.setSpawn(s.x, y, s.z);
      this.player.setSpawn(s.x, y, s.z);
      this.pendingSpawn = false;
    }
    if (this.placeOnSpawn && world.isActive(Math.floor(s.x), Math.floor(s.z))) {
      this.player.respawn();
      this.placeOnSpawn = false;
    }
  }

  private async finishLoading(): Promise<void> {
    this.loading.close();
    this.autosaveTimer = 0;
    if (this.debugMode) {
      this.setViewpoint(debugViewpoint(this.world!, this.player.spawn));
      this.enterPlayUnlocked();
    } else {
      this.showReady();
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

  /** World loaded: show "Click to play". */
  showReady(): void {
    this.state = 'ready';
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
    if (this.state === 'loading' || this.state === 'menu' || !this.world) return;
    this.picker.close();
    void this.input.requestLock().then((ok) => {
      if (!ok && !this.input.locked) {
        // The browser refused (e.g. too soon after Esc): ask for another click.
        if (this.state === 'picker') this.picker.close();
        this.showReady();
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

  private openCommand(): void {
    this.state = 'command';
    this.commandBar.open();
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
      this.commandBar.close();
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
    if (this.openCommandOnUnlock) {
      this.openCommandOnUnlock = false;
      this.openCommand();
      return;
    }
    this.pause();
  }

  // ---- Settings ----

  applySettings(s: Settings): void {
    this.settings = sanitizeSettings(s);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    if (this.streamer) this.streamer.radius = this.settings.renderDistance;
    saveSettings(this.settings);
  }

  cycleRenderDistance(): void {
    const i = RENDER_DISTANCES.indexOf(this.settings.renderDistance);
    const next = RENDER_DISTANCES[(i + 1) % RENDER_DISTANCES.length]!;
    this.applySettings({ ...this.settings, renderDistance: next });
    this.menu.setSettings(this.settings);
    this.hud.flash(`Render distance: ${next} chunks`);
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
    if (this.state === 'menu') {
      if (code === 'Escape') this.title.back();
      return;
    }
    if (this.state === 'command') return;
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
      case 'Slash':
        if (this.input.locked) {
          this.openCommandOnUnlock = true;
          this.input.exitLock();
        } else {
          this.openCommand();
        }
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

  // ---- Commands ----

  /** Run a slash command (also `window.__game.command()`); returns its output. */
  command(line: string): string {
    if (!this.world) return 'No world loaded';
    return runCommand(this.commandContext(), line);
  }

  private commandContext(): CommandContext {
    const world = this.world!;
    const player = this.player;
    const ctx: CommandContext = {
      seed: world.seed,
      position: (): Vec3 => ({ x: player.body.x, y: player.body.y, z: player.body.z }),
      teleport: (x, y, z) => {
        player.teleport(x, y, z);
        this.placeOnSpawn = false;
      },
      setBlock: (x, y, z, id) => {
        const ok = world.setBlock(x, y, z, id);
        if (ok) this.chunks.rebuildAt(x, y, z);
        return ok;
      },
    };
    return ctx;
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
    this.resolveSpawn();
    if (this.streamer) {
      const dir = this.camera.getWorldDirection(this.tmpDir);
      this.streamer.setView(this.camera.position.x, this.camera.position.z, dir.x, dir.z);
      this.streamer.update();
      this.streamer.upload(UPLOAD_BUDGET_MS);
    }
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
    const world = this.world;
    if (!collision || !world) return;
    // Wait (frozen) until the ground under the player has loaded.
    const b = this.player.body;
    if (this.placeOnSpawn || !world.isActive(Math.floor(b.x), Math.floor(b.z))) {
      this.player.prevX = b.x;
      this.player.prevY = b.y;
      this.player.prevZ = b.z;
      return;
    }
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
    if (this.session && this.stepCount % STEPS_PER_TICK === 0) {
      this.session.ticker.setFocus(b.x, b.z);
      this.session.ticker.step();
    }
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
      world: w
        ? `${w.type}${w.bounds ? ` ${w.bounds.sx}×${w.bounds.sz}` : ''} seed ${w.seed} · ${w.chunks.size} chunks`
        : '—',
      mode: `${b.flying ? 'flying' : b.liquid === 1 ? 'swimming' : b.liquid === 2 ? 'in lava' : 'walking'}${b.onGround ? ', on ground' : ''} · view ${this.settings.renderDistance} chunks`,
      tick: this.session
        ? `#${this.session.ticker.tick}  ${this.session.ticker.lastUpdates} updates/tick  ${this.session.ticker.pending} queued`
        : '—',
      chunk: `${Math.floor(b.x) >> 4}, ${Math.floor(b.z) >> 4}`,
      streaming: this.streamer
        ? `${w?.chunks.size ?? 0} loaded, ${this.chunks.columnCount} meshed · workers ${this.pool.running}/${this.pool.size} busy, ${this.pool.queued} queued · mesh ${this.streamer.lastMeshMs.toFixed(1)} ms`
        : '—',
      extra: [],
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

/**
 * Fixed camera for the ?debug screenshot: looking across the map centre
 * (Classic) or toward the spawn (Infinite).
 */
export function debugViewpoint(world: World, spawn: { x: number; z: number }): Viewpoint {
  const cx = world.bounds ? world.bounds.sx * 0.5 : spawn.x;
  const cz = world.bounds ? world.bounds.sz * 0.5 : spawn.z;
  const x = cx - 40;
  const z = cz + 44;
  const y = world.seaLevel + 22;
  const tx = cx + 8;
  const tz = cz - 16;
  return { x, y, z, yaw: Math.atan2(-(tx - x), -(tz - z)), pitch: -0.32 };
}

/** Feet height for standing on the highest solid ground of a column. */
export function groundHeight(world: World, x: number, z: number): number {
  for (let y = world.height - 2; y > 0; y--) {
    const id = world.getId(x, y, z);
    if (IS_SOLID[id] && id !== B.LEAVES && world.getId(x, y + 1, z) === B.AIR && world.getId(x, y + 2, z) === B.AIR) {
      return y + 1;
    }
  }
  return world.seaLevel + 1;
}
