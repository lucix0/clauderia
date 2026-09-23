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
import { CommandError, runCommand, type CommandContext, type Vec3 } from './commands/commands';
import { Streamer } from './stream/streamer';
import { CommandBar } from './ui/commandBar';
import { WorkerPool } from './workers/pool';
import { ItemEntities, loadItems, saveItem } from './entities/items';
import { ItemRenderer } from './entities/itemRender';
import { animalGroup, MOB_KINDS, Mobs, type MobKind, type MobTarget, type MobWorld } from './entities/mobs';
import { createMobAtlas, MobRenderer } from './entities/mobRender';
import { Container, type ContainerExtras, type Section } from './items/container';
import { fuelTicks, furnaceSlotFor, SMELT_TICKS } from './items/smelting';
import { HOTBAR_SLOTS, wearTool, type ItemStack } from './items/inventory';
import { I, itemByName, itemDef, maxStack } from './items/items';
import { BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT, Input } from './player/input';
import { bodyOverlapsCell, type CollisionWorld } from './player/physics';
import { collisionWorld, Player } from './player/player';
import { raycast, type RayHit } from './player/raycast';
import { createAtlas, type Atlas } from './render/atlas';
import { ChunkRenderer } from './render/chunks';
import { CrackOverlay } from './render/crack';
import { createEntityMaterial, createMaterials, lightUniforms } from './render/materials';
import { BlockOutline } from './render/outline';
import { Sky, type Medium } from './render/sky';
import { gunzip } from './save/compress';
import { commitMigration, deleteWorld, getWorld, listWorlds, packChunks, readLegacySave } from './save/db';
import { migrateV1 } from './save/migrate';
import { emptyExtras, newWorldId, type ChunkExtras, type ClassicSizeName, type PlayerRecord } from './save/records';
import { deserializeSave } from './save/serialize';
import { WorldSession } from './session';
import { ContainerView, type ScreenKind } from './ui/containerView';
import { DeathScreen } from './ui/death';
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
import { Survivor } from './survival/survivor';
import { DEATH_MESSAGES, exhaust, MAX_AIR } from './survival/vitals';
import { BlockEntities } from './world/blockEntities';
import {
  B,
  blockBounds,
  blockName,
  DEFAULT_HOTBAR,
  facingToward,
  FURNACE_LIT,
  HAS_FACING,
  idOf,
  IS_LIQUID,
  IS_SOLID,
  REPLACEABLE,
  SELECTABLE,
} from './world/blocks';
import { BIOME, BIOME_KEYS, BIOMES } from './world/gen/biomes';
import { infiniteGenerator } from './world/gen/infinite';
import { breakBlock, placeBlock, placementTarget, placementValue, type Cell } from './world/placement';
import type { Chunk } from './world/chunk';
import type { World } from './world/world';

const MOUSE_SCALE = 0.0022;
/** Two W presses within this many ms start a sprint. */
const SPRINT_TAP_MS = 300;
const SPRINT_SPEED = 1.3;
const SNEAK_SPEED = 0.3;
/** Eyes drop this much while sneaking. */
const SNEAK_DROP = 0.15;

/**
 * - menu: title screen / world list
 * - loading: generating or reading a world
 * - ready: world loaded, waiting for the click that captures the mouse
 */
export type GameState = 'menu' | 'loading' | 'ready' | 'playing' | 'paused' | 'picker' | 'command' | 'container' | 'dead';

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
  /** Game mode, inventory, vitals, mining. */
  readonly survivor = new Survivor();
  /** Dropped items. */
  readonly items = new ItemEntities();
  /** Furnaces and chests. */
  readonly blockEntities = new BlockEntities();
  /** Animals and monsters. */
  readonly mobs = new Mobs();
  readonly mobRenderer: MobRenderer;
  /** The mob under the crosshair (closer than any block), if any. */
  mobTarget: { mob: Mobs['list'][number]; t: number } | null = null;
  private mobWorld: MobWorld | null = null;
  private lastAttack = 0;
  readonly itemRenderer: ItemRenderer;
  readonly crack: CrackOverlay;
  readonly containerView: ContainerView;
  readonly deathScreen: DeathScreen;
  /** The open container screen's contents (inventory / crafting table). */
  container: Container | null = null;
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
  private lastForwardTap = -1e9;
  private hurtShake = 0;
  private sneakDrop = 0;
  private fovKick = 0;
  private openContainerOnUnlock: (() => void) | null = null;
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
    const materials = createMaterials(this.atlas.texture);
    this.chunks = new ChunkRenderer(materials);
    this.scene.add(this.chunks.group);
    this.scene.add(this.outline.object);
    this.itemRenderer = new ItemRenderer({
      blocks: materials,
      blockSprites: createEntityMaterial(this.atlas.texture, 'block-sprite'),
      itemSprites: createEntityMaterial(this.atlas.itemTexture, 'item-sprite'),
    });
    this.scene.add(this.itemRenderer.group);
    this.mobRenderer = new MobRenderer(createEntityMaterial(createMobAtlas(), 'mob'));
    this.scene.add(this.mobRenderer.group);
    this.mobs.events.died = (mob, loot) => {
      for (const st of loot) this.items.spawn(st, mob.body.x, mob.body.y + 0.5, mob.body.z, (Math.random() - 0.5) * 2, 3, (Math.random() - 0.5) * 2, 0.5);
    };
    this.crack = new CrackOverlay(this.atlas.texture);
    this.scene.add(this.crack.object);
    this.sky = new Sky(this.scene, this.atlas);
    this.input = new Input(canvas);
    this.icons = new IconCache(this.atlas.canvas, this.atlas.itemCanvas);

    this.hud = new Hud(ui, this.icons);
    this.debugOverlay = new DebugOverlay(ui);
    this.picker = new BlockPicker(ui, this.icons);
    this.picker.onPick = (id) => {
      this.survivor.giveCreative(id);
      this.hud.render(this.survivor.inventory, this.survivor.selected, true);
      this.resume();
    };
    this.picker.onClose = () => this.resume();
    this.containerView = new ContainerView(ui, this.icons, {
      drop: (s) => this.throwStack(s),
      close: () => this.closeContainer(),
      changed: () => this.hud.render(this.survivor.inventory, this.survivor.selected),
    });
    this.deathScreen = new DeathScreen(ui, {
      respawn: () => this.respawnAfterDeath(),
      title: () => void this.quitToTitle(),
    });
    this.survivor.events = {
      hurt: () => {
        this.hud.hurt();
        this.hurtShake = 1;
      },
      died: (cause) => this.onDeath(cause),
      inventory: () => this.hud.render(this.survivor.inventory, this.survivor.selected),
    };
    this.items.onCollect = () => this.hud.render(this.survivor.inventory, this.survivor.selected);

    this.titleOverlay = el('div', { className: 'overlay click-to-play hidden' }, [
      el('div', { className: 'panel' }, [
        el('h1', { className: 'title', text: 'Blocktide' }),
        el('p', { className: 'subtitle', text: 'A little world of blocks' }),
        el('p', { className: 'big-cta', text: 'Click to play' }),
        el('p', {
          className: 'hint',
          html:
            '<kbd>WASD</kbd> move (double-tap <kbd>W</kbd> sprint) · <kbd>Space</kbd> jump · <kbd>Shift</kbd> sneak · <kbd>E</kbd> inventory · <kbd>Esc</kbd> menu<br>' +
            'Left click break · right click place / use · middle click pick · <kbd>Q</kbd> drop · <kbd>/</kbd> commands<br>' +
            'Creative: <kbd>Z</kbd> fly · <kbd>B</kbd> all blocks · <kbd>R</kbd> respawn',
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
      lockDaytime: (locked) => {
        if (this.session) this.session.lockDaytime = locked;
      },
    });
    this.menu.setSettings(this.settings);
    this.title = new TitleScreen(
      ui,
      {
        play: (id) => void this.playWorld(id),
        create: (opts) => void this.createWorld(opts),
        remove: (id) => void this.removeWorld(id),
      },
      { types: ['infinite', 'classic'], modes: ['survival', 'creative'], difficulties: ['normal', 'peaceful'] },
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
        this.select((((this.survivor.selected + steps) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE);
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
    this.containerView.close();
    this.container = null;
    this.deathScreen.close();
    this.crack.set(null);
    this.streamer?.dispose();
    this.streamer = null;
    this.session?.dispose();
    this.session = null;
    this.world = null;
    this.collision = null;
    this.target = null;
    this.outline.set(null);
    this.chunks.disposeAll();
    this.items.clear();
    this.itemRenderer.clear();
    this.blockEntities.clear();
    this.mobs.clear();
    this.mobRenderer.clear();
    this.mobWorld = null;
  }

  /** Grassy chunks sometimes get a small herd when first generated. */
  private seedAnimals(chunk: Chunk): void {
    if (Math.random() > 0.12) return;
    const grassy = new Set<number>([BIOME.PLAINS, BIOME.FOREST, BIOME.TAIGA, BIOME.SWAMP, BIOME.MOUNTAINS]);
    const lx = 2 + Math.floor(Math.random() * 12);
    const lz = 2 + Math.floor(Math.random() * 12);
    if (chunk.biomes && !grassy.has(chunk.biomes[(lz << 4) | lx]!)) return;
    const { kind, count } = animalGroup(Math.random);
    let placed = 0;
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const x = Math.max(0, Math.min(15, lx + Math.floor(Math.random() * 5) - 2));
      const z = Math.max(0, Math.min(15, lz + Math.floor(Math.random() * 5) - 2));
      let y = 126;
      while (y > 0 && chunk.blocks[(y << 8) | (z << 4) | x] === B.AIR) y--;
      if ((chunk.blocks[(y << 8) | (z << 4) | x]! & 0xff) !== B.GRASS) continue;
      this.mobs.spawn(kind, chunk.cx * 16 + x + 0.5, y + 1, chunk.cz * 16 + z + 0.5);
      placed++;
    }
    // Make sure the chunk gets a record, so the herd isn't added again next visit.
    if (placed) chunk.storedExtras = true;
  }

  /** Entities to store with a chunk (and, when unloading, take out of the world). */
  private chunkExtras(chunk: Chunk, remove: boolean): ChunkExtras {
    const extras = emptyExtras();
    extras.items = this.items.inChunk(chunk.cx, chunk.cz, remove).map(saveItem);
    extras.blockEntities = this.blockEntities.inChunk(chunk.cx, chunk.cz, remove);
    extras.mobs = this.mobs.inChunk(chunk.cx, chunk.cz, remove);
    return extras;
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
    const surv = this.survivor.toJSON();
    return { ...s, hotbar: this.hotbar, selected: this.survivor.selected, vitals: surv.vitals, inventory: surv.inventory };
  }

  /** Hotbar item ids (0 for empty slots). */
  get hotbar(): number[] {
    return this.survivor.inventory.slice(0, HOTBAR_SLOTS).map((s) => s?.id ?? 0);
  }

  get selected(): number {
    return this.survivor.selected;
  }

  set selected(slot: number) {
    this.select(slot);
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
    this.items.clear();
    this.itemRenderer.clear();
    this.blockEntities.clear();
    this.mobs.clear();
    this.mobRenderer.clear();
    const collide = this.collision!;
    const sky = this.sky;
    this.mobWorld = {
      solidHeight: (x, y, z) => collide.solidHeight(x, y, z),
      liquidAt: (x, y, z) => collide.liquidAt(x, y, z),
      active: (x, z) => world.isActive(x, z),
      blockId: (x, y, z) => world.getId(x, y, z),
      light: (x, y, z) => world.lightAt(x, y, z),
      get daylight() {
        return sky.daylight;
      },
    };
    session.extrasFor = (chunk, remove) => this.chunkExtras(chunk, remove);
    for (const rec of session.initialRecords) {
      loadItems(this.items, rec.extras.items);
      this.blockEntities.load(rec.extras.blockEntities);
      this.mobs.load(rec.extras.mobs);
    }
    // A brand-new Classic world gets its animals now.
    if (world.type === 'classic' && !session.record.player) for (const c of world.chunks.values()) this.seedAnimals(c);
    // A broken furnace or chest spills what it held.
    world.addListener((x, y, z, oldValue, newValue) => {
      const was = idOf(oldValue);
      if ((was !== B.FURNACE && was !== B.CHEST) || idOf(newValue) === was) return;
      const e = this.blockEntities.remove(x, y, z);
      if (e) for (const st of BlockEntities.contents(e)) this.items.dropFromBlock(st, x, y, z);
    });
    const streamer = new Streamer(world, this.pool, this.chunks, {
      loadRecord: (cx, cz) => session.loadRecord(cx, cz),
      added: (chunk, record) => {
        if (!record) {
          // First visit: maybe a group of animals on the grass.
          this.seedAnimals(chunk);
          return;
        }
        loadItems(this.items, record.extras.items);
        this.blockEntities.load(record.extras.blockEntities);
        this.mobs.load(record.extras.mobs);
      },
      unloaded: (chunks) => session.chunksUnloaded(chunks),
    });
    streamer.radius = this.settings.renderDistance;
    this.streamer = streamer;

    const spawn = session.spawn;
    this.player.setSpawn(spawn.x, Math.max(spawn.y, 0), spawn.z);
    const p = session.record.player;
    this.survivor.mode = session.record.gameMode;
    this.survivor.difficulty = session.record.difficulty;
    this.survivor.respawn();
    if (p) {
      this.player.setState(p);
      this.survivor.load(p.vitals, p.inventory, p.hotbar, p.selected);
    } else {
      this.player.teleport(spawn.x, spawn.y < 0 ? world.seaLevel + 24 : spawn.y, spawn.z);
      this.player.body.flying = false;
      this.player.yaw = 0;
      this.player.pitch = 0;
      // Creative starts with a hotbar of building blocks; survival with nothing.
      this.survivor.load(undefined, undefined, this.survivor.survival ? [] : DEFAULT_HOTBAR, 0);
    }
    if (this.survivor.survival) this.player.body.flying = false;
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
    this.hud.render(this.survivor.inventory, this.survivor.selected);
  }

  resume(): void {
    if (this.state === 'loading' || this.state === 'menu' || this.state === 'dead' || !this.world) return;
    this.picker.close();
    if (this.container) this.closeContainer(false);
    void this.input.requestLock().then((ok) => {
      if (!ok && !this.input.locked) {
        if (this.state === 'dead' || this.state === 'menu' || this.state === 'loading') return;
        // The browser refused (e.g. too soon after Esc): ask for another click.
        // The ?debug view carries on without the lock (automation).
        if (this.state === 'picker') this.picker.close();
        if (this.debugMode) this.enterPlayUnlocked();
        else this.showReady();
      }
    });
  }

  pause(): void {
    const wasPlaying = this.state === 'playing' || this.state === 'picker' || this.state === 'container';
    if (this.container) this.closeContainer(false);
    this.state = 'paused';
    this.picker.close();
    this.titleOverlay.classList.add('hidden');
    this.hud.setVisible(false);
    this.menu.setSettings(this.settings);
    this.menu.setLockDaytime(this.session?.lockDaytime ?? false);
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
      // A lock granted late (after dying or leaving the world) is refused.
      if (this.state === 'loading' || this.state === 'dead' || this.state === 'menu') {
        this.input.exitLock();
        return;
      }
      this.state = 'playing';
      this.titleOverlay.classList.add('hidden');
      this.menu.close();
      this.picker.close();
      this.commandBar.close();
      if (this.container) this.closeContainer(false);
      this.hud.setVisible(true);
      this.hud.render(this.survivor.inventory, this.survivor.selected);
      return;
    }
    if (this.state !== 'playing') return;
    if (this.openContainerOnUnlock) {
      const open = this.openContainerOnUnlock;
      this.openContainerOnUnlock = null;
      open();
      return;
    }
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
    const smoothChanged = this.settings.smoothLighting !== s.smoothLighting;
    this.settings = sanitizeSettings(s);
    this.chunks.smooth = this.settings.smoothLighting;
    if (smoothChanged) this.streamer?.invalidateAll();
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
    this.survivor.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, Math.floor(slot) || 0));
    this.survivor.mining = null;
    this.hud.render(this.survivor.inventory, this.survivor.selected, true);
  }

  // ---- Containers, dropping, death ----

  /** Open a container screen (E inventory, crafting table, furnace, chest). */
  openContainer(
    kind: ScreenKind,
    title: string,
    gridSize: 0 | 2 | 3,
    extras: ContainerExtras | null = null,
    decorate: ((top: HTMLElement) => void) | null = null,
  ): void {
    const open = (): void => {
      this.state = 'container';
      this.container = new Container(this.survivor.inventory, gridSize, extras);
      this.containerView.decorate = decorate;
      this.containerView.open(this.container, kind, title);
    };
    if (this.input.locked) {
      this.openContainerOnUnlock = open;
      this.input.exitLock();
    } else {
      open();
    }
  }

  /** Close the container screen; crafting leftovers go back or get dropped. */
  closeContainer(relock = true): void {
    const c = this.container;
    if (!c) return;
    for (const s of c.close()) this.throwStack(s);
    this.container = null;
    this.containerView.close();
    this.hud.render(this.survivor.inventory, this.survivor.selected);
    if (relock && this.state === 'container') {
      this.state = 'playing';
      this.resume();
    }
  }

  private openFurnace(x: number, y: number, z: number): void {
    const f = this.blockEntities.furnace(x, y, z);
    const input: Section = { id: 'input', slots: f.slots, indices: [0] };
    const fuel: Section = { id: 'fuel', slots: f.slots, indices: [1], accepts: (st) => fuelTicks(st.id) > 0 };
    const output: Section = { id: 'output', slots: f.slots, indices: [2], output: true, accepts: () => false };
    this.openContainer(
      'furnace',
      'Furnace',
      0,
      {
        sections: [input, fuel, output],
        shiftFromPlayer: (st) => {
          const where = furnaceSlotFor(st);
          return where === 'input' ? input : where === 'fuel' ? fuel : null;
        },
      },
      (top) => {
        const flame = top.querySelector<HTMLElement>('.furnace-flame-fill');
        const arrow = top.querySelector<HTMLElement>('.furnace-arrow-fill');
        if (flame) flame.style.height = `${f.burnMax > 0 ? (f.burn / f.burnMax) * 100 : 0}%`;
        if (arrow) arrow.style.width = `${(f.progress / SMELT_TICKS) * 100}%`;
      },
    );
  }

  private openChest(x: number, y: number, z: number): void {
    const slots = this.blockEntities.chest(x, y, z);
    const chest: Section = { id: 'chest', slots, indices: slots.map((_, i) => i) };
    this.openContainer('chest', 'Chest', 0, { sections: [chest], shiftFromPlayer: () => chest });
  }

  /** Right click holding a bucket: scoop up a fluid source, or pour one out. */
  private useBucket(held: ItemStack): void {
    const world = this.world;
    if (!world) return;
    const surv = this.survivor;
    const p = this.camera.position;
    const [dx, dy, dz] = this.player.viewDir();
    if (held.id === I.BUCKET) {
      const hit = raycast(world, p.x, p.y, p.z, dx, dy, dz, 5, (id) => SELECTABLE[id] === 1 || IS_LIQUID[id] === 1);
      if (!hit || !IS_LIQUID[hit.id]) return;
      const value = world.get(hit.x, hit.y, hit.z);
      if (value >> 8 !== 0) return; // only sources
      world.setBlock(hit.x, hit.y, hit.z, B.AIR);
      this.chunks.rebuildAt(hit.x, hit.y, hit.z);
      const filled: ItemStack = { id: hit.id === B.WATER ? I.WATER_BUCKET : I.LAVA_BUCKET, count: 1, damage: 0 };
      if (surv.survival && held.count === 1) surv.inventory[surv.selected] = filled;
      else {
        if (surv.survival) held.count--;
        if (surv.collect(filled) > 0) this.throwStack(filled);
      }
      this.hud.render(surv.inventory, surv.selected);
      return;
    }
    const hit = this.target;
    if (!hit) return;
    const normal = [hit.nx, hit.ny, hit.nz] as const;
    const here = world.getId(hit.x, hit.y, hit.z);
    const cell = REPLACEABLE[here] ? { x: hit.x, y: hit.y, z: hit.z } : placementTarget(world, hit, normal, B.WATER);
    const cur = world.getId(cell.x, cell.y, cell.z);
    if (cur !== B.AIR && !REPLACEABLE[cur] && !IS_LIQUID[cur]) return;
    if (!world.setBlock(cell.x, cell.y, cell.z, held.id === I.WATER_BUCKET ? B.WATER : B.LAVA)) return;
    this.edited(cell);
    if (surv.survival) {
      surv.inventory[surv.selected] = { id: I.BUCKET, count: 1, damage: 0 };
      this.hud.render(surv.inventory, surv.selected);
    }
  }

  /** Throw a stack forward from the player's eyes. */
  throwStack(s: ItemStack): void {
    const [dx, dy, dz] = this.player.viewDir();
    const b = this.player.body;
    this.items.spawn(s, b.x + dx * 0.3, b.y + PLAYER_EYE - 0.3, b.z + dz * 0.3, dx * 5, dy * 5 + 1.5, dz * 5, 2);
  }

  private onDeath(cause: keyof typeof DEATH_MESSAGES): void {
    const b = this.player.body;
    for (const s of this.survivor.takeAll()) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 2.5;
      this.items.spawn(s, b.x, b.y + 0.8, b.z, Math.cos(a) * r, 3 + Math.random() * 2, Math.sin(a) * r, 1.5);
    }
    if (this.container) this.closeContainer(false);
    this.state = 'dead';
    this.input.exitLock();
    this.hud.setVisible(false);
    this.deathScreen.open(DEATH_MESSAGES[cause]);
    void this.saveNow('autosave');
  }

  private respawnAfterDeath(): void {
    this.deathScreen.close();
    this.survivor.respawn();
    this.player.respawn();
    this.player.body.flying = false;
    this.state = 'playing';
    this.hud.setVisible(true);
    this.hud.render(this.survivor.inventory, this.survivor.selected);
    this.resume();
  }

  /** Switch game mode (the /gamemode command). */
  setGameMode(mode: 'creative' | 'survival'): void {
    this.survivor.mode = mode;
    if (this.session) this.session.record = { ...this.session.record, gameMode: mode };
    if (mode === 'survival') this.player.body.flying = false;
    this.survivor.mining = null;
    this.crack.set(null);
    this.hud.flash(mode === 'survival' ? 'Survival mode' : 'Creative mode');
  }

  // ---- Input ----

  private onKey(code: string): void {
    if (code === 'F3') {
      this.debugOverlay.toggle();
      return;
    }
    if (this.state === 'picker') {
      if (code === 'KeyB' || code === 'KeyE') this.resume();
      else if (code === 'Escape') this.pause();
      return;
    }
    if (this.state === 'container') {
      if (code === 'KeyE' || code === 'Escape') this.closeContainer();
      else if (code === 'KeyQ') this.containerView.dropHovered(this.input.isDown('ControlLeft') || this.input.isDown('ControlRight'));
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
    if (this.state === 'command' || this.state === 'dead') return;
    if (this.state !== 'playing') return;
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= HOTBAR_SIZE) this.select(n - 1);
      return;
    }
    const surv = this.survivor;
    switch (code) {
      case 'KeyW': {
        const now = performance.now();
        if (now - this.lastForwardTap < SPRINT_TAP_MS && !surv.sneaking) surv.sprinting = true;
        this.lastForwardTap = now;
        break;
      }
      case 'KeyZ': {
        if (surv.survival) break;
        const b = this.player.body;
        b.flying = !b.flying;
        b.vy = 0;
        this.hud.flash(b.flying ? 'Flying' : 'Walking');
        break;
      }
      case 'KeyR':
        if (!surv.survival) this.player.respawn();
        break;
      case 'KeyF':
        this.cycleRenderDistance();
        break;
      case 'KeyQ': {
        const all = this.input.isDown('ControlLeft') || this.input.isDown('ControlRight');
        const s = surv.dropHeld(all);
        if (s) this.throwStack(s);
        break;
      }
      case 'KeyE':
        if (surv.survival) this.openContainer('inventory', 'Inventory', 2);
        else this.openPickerFromPlay();
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
        if (surv.survival) this.openContainer('inventory', 'Inventory', 2);
        else this.openPickerFromPlay();
        break;
      case 'Escape':
        // Only reached when playing without pointer lock (debug view).
        if (!this.input.locked) this.pause();
        break;
    }
  }

  private openPickerFromPlay(): void {
    if (this.input.locked) {
      this.openPickerOnUnlock = true;
      this.input.exitLock();
    } else {
      this.openPicker();
    }
  }

  private onButton(button: number): void {
    if (this.state !== 'playing') return;
    if (button === BUTTON_LEFT && this.attackMob()) return;
    // Survival mining is continuous (see frame()); everything else acts on press.
    if (button === BUTTON_LEFT && this.survivor.survival) return;
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
      getTime: () => Math.floor(this.session?.time ?? 0),
      setTime: (t) => {
        if (this.session) this.session.time = t;
      },
      setGameMode: (mode) => this.setGameMode(mode),
      setDifficulty: (d) => {
        this.survivor.difficulty = d;
        if (this.session) this.session.record = { ...this.session.record, difficulty: d };
      },
      give: (name, count) => {
        const id = itemByName(name);
        if (id === null || id === B.AIR) throw new CommandError(`Unknown item "${name}"`);
        let left = count;
        while (left > 0) {
          const n = Math.min(left, maxStack(id));
          const over = this.survivor.collect({ id, count: n, damage: 0 });
          if (over > 0) {
            // Inventory full: drop the rest at the player's feet.
            const b = player.body;
            this.items.spawn({ id, count: over, damage: 0 }, b.x, b.y + 0.5, b.z, 0, 2, 0, 1);
          }
          left -= n;
        }
        this.hud.render(this.survivor.inventory, this.survivor.selected);
        return `Gave ${count} × ${itemDef(id)!.name}`;
      },
      summon: (kind, at) => {
        if (!(MOB_KINDS as readonly string[]).includes(kind)) throw new CommandError(`Unknown mob. Try: ${MOB_KINDS.join(', ')}`);
        let { x, y, z } = at;
        const b = player.body;
        if (x === b.x && y === b.y && z === b.z) {
          // No position given: a few blocks in front.
          const [dx, , dz] = player.viewDir();
          const len = Math.hypot(dx, dz) || 1;
          x += (dx / len) * 3;
          z += (dz / len) * 3;
        }
        this.mobs.spawn(kind as MobKind, x, y, z, player.yaw + Math.PI);
        return `Summoned a ${kind}`;
      },
      kill: (target) => {
        if (target === '@e' || (MOB_KINDS as readonly string[]).includes(target)) {
          let n = 0;
          for (const m of this.mobs.list) {
            if (m.removed || m.dying >= 0 || (target !== '@e' && m.def.kind !== target)) continue;
            this.mobs.kill(m);
            n++;
          }
          return `Killed ${n} mob${n === 1 ? '' : 's'}`;
        }
        if (target !== '@s' && target !== 'me') throw new CommandError('Nothing like that to kill');
        if (!this.survivor.survival) {
          this.player.respawn();
          return 'Creative players respawn instead';
        }
        this.survivor.vitals.hurt = 0;
        this.survivor.damage(1000, 'command');
        return 'Ouch';
      },
    };
    if (world.type === 'infinite') {
      const gen = infiniteGenerator(world.seed);
      ctx.biomeAt = (x, z) => {
        const id = world.biomeAt(x, z);
        return (id >= 0 ? BIOMES[id]! : gen.biomeAt(x, z)).name;
      };
      ctx.biomeNames = () => BIOME_KEYS;
      ctx.locateBiome = (name, from) => {
        const found = gen.locateBiome(name, from.x, from.z);
        return found ? { x: found.x + 0.5, y: gen.heightAt(found.x, found.z) + 1, z: found.z + 0.5 } : null;
      };
    }
    return ctx;
  }

  // ---- Block interaction ----

  /** Perform the action bound to a mouse button on the current target. */
  act(button: number): void {
    const world = this.world;
    const hit = this.target;
    const surv = this.survivor;
    if (!world || surv.dead) return;
    if (button === BUTTON_LEFT) {
      if (!hit) return;
      if (surv.survival) {
        if (surv.harvest(world, this.items, hit, world.get(hit.x, hit.y, hit.z))) this.edited(hit);
      } else if (breakBlock(world, hit.x, hit.y, hit.z)) {
        this.edited(hit);
      }
    } else if (button === BUTTON_RIGHT) {
      if (hit && this.useBlock(hit)) return;
      const held = surv.held;
      if (held && (held.id === I.BUCKET || held.id === I.WATER_BUCKET || held.id === I.LAVA_BUCKET)) {
        this.useBucket(held);
        return;
      }
      if (!hit || !held) return;
      if (held.id === I.BONE_MEAL) {
        if (world.getId(hit.x, hit.y, hit.z) === B.SAPLING && this.session?.ticker.forceGrow(hit.x, hit.y, hit.z)) {
          surv.consumeHeld();
          this.chunks.rebuildAt(hit.x, hit.y, hit.z);
          this.updateTarget();
        }
        return;
      }
      if (!itemDef(held.id)?.block) return;
      const id = held.id;
      const normal = [hit.nx, hit.ny, hit.nz] as const;
      let value = placementValue(id, normal);
      if (value === null) return;
      if (HAS_FACING[id]) value = id | (facingToward(this.player.yaw) << 8);
      const cell = placementTarget(world, hit, normal, id);
      const changed = placeBlock(world, cell, value, (c, h) => bodyOverlapsCell(this.player.body, c.x, c.y, c.z, h));
      if (changed) {
        surv.consumeHeld();
        this.edited(changed);
      }
    } else if (button === BUTTON_MIDDLE) {
      if (!hit) return;
      surv.pickBlock(idOf(world.get(hit.x, hit.y, hit.z)));
      this.hud.render(surv.inventory, surv.selected, true);
    }
  }

  /** Hit the mob under the crosshair, if there is one. */
  attackMob(): boolean {
    const t = this.mobTarget;
    const surv = this.survivor;
    if (!t || surv.dead) return false;
    const now = performance.now();
    if (now - this.lastAttack < 250) return true;
    this.lastAttack = now;
    const held = surv.held;
    const def = held ? itemDef(held.id) : undefined;
    const damage = def?.attack ?? 1;
    const b = this.player.body;
    if (this.mobs.hit(t.mob, damage, b.x, b.z) && surv.survival) {
      exhaustPlayer(surv, 0.1);
      if (def?.tool) {
        wearTool(surv.inventory, surv.selected, def.tool.kind === 'sword' ? 1 : 2);
        this.hud.render(surv.inventory, surv.selected);
      }
    }
    return true;
  }

  /** Right click on an interactive block (crafting table). Sneaking skips it. */
  private useBlock(hit: RayHit): boolean {
    if (this.survivor.sneaking) return false;
    const id = this.world?.getId(hit.x, hit.y, hit.z);
    if (id === B.CRAFTING_TABLE) {
      this.openContainer('crafting', 'Crafting', 3);
      return true;
    }
    if (id === B.FURNACE) {
      this.openFurnace(hit.x, hit.y, hit.z);
      return true;
    }
    if (id === B.CHEST) {
      this.openChest(hit.x, hit.y, hit.z);
      return true;
    }
    return false;
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
      this.mobTarget = null;
      this.outline.set(null);
      return;
    }
    const p = this.camera.position;
    this.target = this.player.target(world, p.x, p.y, p.z);
    const [dx, dy, dz] = this.player.viewDir();
    this.mobTarget = this.mobs.raycast(p.x, p.y, p.z, dx, dy, dz, 3.5);
    if (this.mobTarget && this.target && this.target.t < this.mobTarget.t) this.mobTarget = null;
    // A mob in front of the block takes the click instead.
    if (this.mobTarget) this.target = null;
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
    // The world keeps running behind the inventory and death screens.
    const running = playing || this.state === 'container' || this.state === 'dead';
    if (playing && this.input.locked) {
      const k = MOUSE_SCALE * this.settings.sensitivity;
      this.player.look(-dx * k, -dy * k * (this.settings.invertY ? -1 : 1));
    }

    if (running && this.collision) {
      this.accumulator += dt;
      while (this.accumulator >= STEP_DT) {
        this.step(STEP_DT, playing);
        this.accumulator -= STEP_DT;
      }
      if (!this.debugMode) {
        this.autosaveTimer += dt;
        if (this.autosaveTimer >= AUTOSAVE_S) void this.saveNow('autosave');
      }
    } else {
      this.accumulator = 0;
    }

    const surv = this.survivor;
    const alpha = this.accumulator / STEP_DT;
    const pl = this.player;
    const b = pl.body;
    // Camera effects: sneaking lowers the eyes, sprinting widens the view, hits shake it.
    this.sneakDrop += ((surv.sneaking ? SNEAK_DROP : 0) - this.sneakDrop) * Math.min(1, dt * 12);
    this.fovKick += ((surv.sprinting ? 1 : 0) - this.fovKick) * Math.min(1, dt * 8);
    this.hurtShake = Math.max(0, this.hurtShake - dt * 3);
    this.camera.position.set(
      pl.prevX + (b.x - pl.prevX) * alpha,
      pl.prevY + (b.y - pl.prevY) * alpha + PLAYER_EYE - this.sneakDrop,
      pl.prevZ + (b.z - pl.prevZ) * alpha,
    );
    this.camera.rotation.set(pl.pitch, pl.yaw, Math.sin(this.hurtShake * 9) * this.hurtShake * 0.06);
    const fov = this.settings.fov * (1 + this.fovKick * 0.1);
    if (Math.abs(this.camera.fov - fov) > 0.01) this.camera.fov = fov;

    this.updateTarget();
    const world = this.world;
    if (playing && this.input.locked && world) {
      for (const button of [BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT]) {
        if (!this.input.isButtonHeld(button)) continue;
        if (button === BUTTON_LEFT && surv.survival) continue;
        if (button === BUTTON_RIGHT && surv.survival && surv.held && itemDef(surv.held.id)?.food) continue;
        if (now >= this.repeatAt[button]!) {
          this.act(button);
          this.repeatAt[button] = now + ACTION_REPEAT_S * 1000;
        }
      }
    }
    if (world && surv.survival) {
      const attacking = playing && this.input.locked && this.input.isButtonHeld(BUTTON_LEFT);
      const broke = surv.updateMining(world, this.items, attacking ? this.target : null, attacking, dt);
      if (broke) this.edited(broke);
      const using = playing && this.input.locked && this.input.isButtonHeld(BUTTON_RIGHT);
      if (surv.updateEating(using, dt)) this.hud.flash('Yum!');
    } else {
      surv.mining = null;
    }
    this.crack.set(surv.mining, surv.mining?.progress ?? 0);

    const distance = this.renderDistance;
    this.camera.far = distance + 256;
    this.camera.updateProjectionMatrix();
    this.sky.update(dt, this.camera, this.cameraMedium(), distance, this.session?.time ?? 6000);
    lightUniforms.uDaylight.value = this.sky.daylight;
    this.resolveSpawn();
    if (this.streamer) {
      const dir = this.camera.getWorldDirection(this.tmpDir);
      this.streamer.setView(this.camera.position.x, this.camera.position.z, dir.x, dir.z);
      this.streamer.update();
      this.streamer.upload(UPLOAD_BUDGET_MS);
    }
    this.chunks.update(this.camera.position, REMESH_BUDGET_MS);
    this.chunks.updateVisibility(this.camera.position, distance);
    if (world) {
      this.itemRenderer.update(this.items, alpha, now / 1000, pl.yaw, (x, y, z) => world.lightAt(x, y, z));
      this.mobRenderer.update(this.mobs, alpha, now / 1000, (x, y, z) => world.lightAt(x, y, z), this.camera.position, Math.min(distance, 80));
      const eye = world.getVirtual(Math.floor(this.camera.position.x), Math.floor(this.camera.position.y), Math.floor(this.camera.position.z));
      this.hud.setVitals(surv.survival && !surv.dead ? surv.vitals : null, (eye & 0xff) === B.WATER || surv.vitals.air < MAX_AIR);
    }
    this.renderer.render(this.scene, this.camera);

    this.updateDebug(rawDt, performance.now() - frameStart);
    const resolvers = this.frameResolvers;
    this.frameResolvers = [];
    for (const r of resolvers) r();
  }

  private step(dt: number, controlled: boolean): void {
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
    const surv = this.survivor;
    const alive = !surv.dead;
    const key = (code: string): boolean => controlled && alive && i.isDown(code);
    const forward = (key('KeyW') ? 1 : 0) - (key('KeyS') ? 1 : 0);
    const shift = key('ShiftLeft') || key('ShiftRight');
    surv.sneaking = shift && !b.flying;
    surv.updateSprint(forward > 0, b);
    const jump = key('Space');
    const wasGrounded = b.onGround;
    const px = b.x;
    const py = b.y;
    const pz = b.z;
    this.player.step(
      collision,
      {
        forward,
        strafe: (key('KeyD') ? 1 : 0) - (key('KeyA') ? 1 : 0),
        jump,
        down: shift,
        speed: surv.sprinting ? SPRINT_SPEED : surv.sneaking ? SNEAK_SPEED : 1,
        sneak: surv.sneaking,
      },
      dt,
    );
    surv.afterMove(b, px, py, pz, jump && wasGrounded && b.vy > 0);
    if (b.y < -32 && !surv.survival) this.player.respawn();
    const eyeY = b.y + PLAYER_EYE - this.sneakDrop;
    this.items.update(
      { ...collision, active: (x, z) => world.isActive(x, z) },
      dt,
      alive ? { x: b.x, y: b.y, z: b.z, collect: (s) => surv.collect(s) } : null,
    );
    const mw = this.mobWorld;
    if (mw) {
      const target: MobTarget = {
        x: b.x,
        y: b.y,
        z: b.z,
        attackable: surv.survival && alive,
        hurt: (amount, fx, fz) => {
          const dealt = surv.damage(amount, 'mob');
          if (dealt > 0) {
            // Knocked back away from the attacker.
            const kx = b.x - fx;
            const kz = b.z - fz;
            const d = Math.hypot(kx, kz) || 1;
            b.vx += (kx / d) * 7;
            b.vz += (kz / d) * 7;
            if (b.onGround) b.vy = 5;
          }
          return dealt;
        },
      };
      this.mobs.update(mw, dt, target, surv.difficulty === 'peaceful');
    }
    // Block behaviours and vitals tick at 20 Hz on the same fixed clock.
    this.stepCount++;
    if (this.session && this.stepCount % STEPS_PER_TICK === 0) {
      this.session.tickTime();
      this.session.ticker.setFocus(b.x, b.z);
      this.session.ticker.step();
      surv.tick(world, b, eyeY);
      if (mw) this.mobs.spawnTick(mw, b, 1 / 20, surv.difficulty !== 'peaceful');
      this.blockEntities.tick(
        (x, z) => world.isActive(x, z),
        (x, y, z, on) => {
          const v = world.get(x, y, z);
          if (idOf(v) !== B.FURNACE) return;
          world.setBlock(x, y, z, (v & ~(FURNACE_LIT << 8)) | (on ? FURNACE_LIT << 8 : 0));
        },
      );
      // Keep an open furnace's gauges moving.
      if (this.container && this.stepCount % (STEPS_PER_TICK * 4) === 0) this.containerView.render();
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
      extra: w
        ? [
            (() => {
              const ex = Math.floor(b.x);
              const ey = Math.floor(b.y + PLAYER_EYE);
              const ez = Math.floor(b.z);
              const l = w.lightAt(ex, ey, ez);
              const t = Math.floor(this.session?.time ?? 0);
              return `Light: sky ${l >> 4}, block ${l & 15}   Time: ${t} (${formatClock(t)}) · daylight ${this.sky.daylight.toFixed(2)}${this.session?.lockDaytime ? ' · locked' : ''}`;
            })(),
            `Entities: ${this.mobs.list.length} mobs (${this.mobs.hostileCount} hostile), ${this.items.list.length} items, ${this.mobs.arrows.length} arrows`,
            `Biome: ${(() => {
              const id = w.biomeAt(Math.floor(b.x), Math.floor(b.z));
              return id >= 0 ? BIOMES[id]!.name : w.type === 'classic' ? 'none (Classic)' : '—';
            })()}`,
          ]
        : [],
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

function exhaustPlayer(surv: Survivor, amount: number): void {
  exhaust(surv.vitals, amount);
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

/** Ticks → a 24-hour clock (0 ticks = 06:00). */
export function formatClock(ticks: number): string {
  const minutes = Math.floor((((ticks / 1000 + 6) % 24) + 24) % 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
