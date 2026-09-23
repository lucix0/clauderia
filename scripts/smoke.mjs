// Playwright smoke test: serves the production build, fails on any console
// error, and writes screenshots to artifacts/. Phases: the ?debug world views
// (Classic, then Infinite: day/night, a torch-lit cave, every biome via
// /locatebiome, streaming while flying and far from the origin)
// and interactions; title screen create / save / reload / delete; v1 save
// migration.
//
//   npm run smoke            (builds first)
//   CHROMIUM_PATH=/path/to/chrome node scripts/smoke.mjs
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { preview } from 'vite';

const OUT = resolve('artifacts');
mkdirSync(OUT, { recursive: true });

const server = await preview({ preview: { port: 4179, strictPort: false, open: false }, logLevel: 'warn' });
const base = server.resolvedUrls?.local[0] ?? 'http://localhost:4179/';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const problems = [];
let failed = false;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

/** A v1 save (flat Small world with a marker block), gzipped, as a byte array. */
function legacySave() {
  const sx = 128;
  const sy = 64;
  const sz = 128;
  const blocks = new Uint8Array(sx * sy * sz);
  for (let y = 0; y < 32; y++) blocks.fill(y === 0 ? 7 : y < 31 ? 1 : 2, y * sx * sz, (y + 1) * sx * sz);
  blocks[(40 * sz + 20) * sx + 30] = 41;
  const hotbar = [1, 4, 43, 3, 5, 15, 16, 18, 42];
  const buf = new ArrayBuffer(4 + 2 + 6 + 4 + 32 + 3 + hotbar.length + 4 + blocks.length);
  const v = new DataView(buf);
  let o = 0;
  v.setUint32(o, 0x544b4c42, true);
  o += 4;
  v.setUint16(o, 1, true);
  o += 2;
  for (const n of [sx, sy, sz]) {
    v.setUint16(o, n, true);
    o += 2;
  }
  v.setUint32(o, 4242, true);
  o += 4;
  for (const f of [30.5, 41, 18.5, 0.5, -0.2, 64.5, 32, 64.5]) {
    v.setFloat32(o, f, true);
    o += 4;
  }
  v.setUint8(o++, 0);
  v.setUint8(o++, 3);
  v.setUint8(o++, hotbar.length);
  for (const id of hotbar) v.setUint8(o++, id);
  v.setUint32(o, blocks.length, true);
  o += 4;
  new Uint8Array(buf).set(blocks, o);
  return Array.from(gzipSync(Buffer.from(buf)));
}

async function openTitle(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  await page.goto(url);
  await page.waitForSelector('.title-screen:not(.hidden)', { timeout: 60_000 });
  return page;
}

async function openPage(url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  return page;
}

try {
  // ---- 1. Classic debug view ----
  const t0 = Date.now();
  const page = await openPage(`${base}?debug&type=classic`);
  check(true, 'Classic debug world generated, meshed and rendered', `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/smoke-classic.png` });

  const stats = await page.evaluate(() => {
    const g = window.__game;
    const info = g.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles, pending: g.chunks.pending, seed: g.currentWorld.seed };
  });
  check(stats.calls > 0 && stats.triangles > 0, 'scene draws something', JSON.stringify(stats));
  check(stats.pending === 0, 'no chunks left to mesh');

  // Walk from spawn and interact.
  const edit = await page.evaluate(async () => {
    const g = window.__game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.player.body.flying = false;
    g.player.respawn();
    g.player.pitch = -1.2;
    await wait(1200);
    const onGround = g.player.body.onGround;
    // Hover two blocks up so breaking can't drop us into the hole.
    const b = g.player.body;
    g.player.teleport(b.x, b.y + 2, b.z);
    b.flying = true;
    g.player.pitch = -1.45;
    await wait(200);
    const t = g.target;
    if (!t) return { onGround, target: null };
    const w = g.currentWorld;
    g.act(0);
    const broken = w.get(t.x, t.y, t.z);
    await wait(50);
    g.selected = 2;
    const t2 = g.target;
    let placed = null;
    if (t2) {
      g.act(2);
      placed = w.get(t2.x + t2.nx, t2.y + t2.ny, t2.z + t2.nz);
    }
    return { onGround, broken, placed, wanted: g.hotbar[2] };
  });
  check(edit.onGround === true, 'player lands on the ground at spawn');
  check(edit.broken === 0, 'left click breaks the targeted block', JSON.stringify(edit));
  check(edit.placed === edit.wanted, 'right click places the selected block');

  await page.keyboard.press('F3');
  await page.waitForTimeout(400);
  const debugText = await page.textContent('.debug-text');
  check(/Draw calls: \d+/.test(debugText ?? ''), 'F3 overlay shows draw calls');
  await page.screenshot({ path: `${OUT}/smoke-play.png` });
  await page.keyboard.press('F3');

  // Under water: dense blue fog.
  const fog = await page.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    const b = w.bounds ?? { sx: 64, sz: 64 };
    for (let x = 1; x < b.sx - 1; x += 3) {
      for (let z = 1; z < b.sz - 1; z += 3) {
        if (w.get(x, w.seaLevel - 1, z) === 8 && w.get(x, w.seaLevel - 3, z) === 8) {
          g.setViewpoint({ x: x + 0.5, y: w.seaLevel - 1.5, z: z + 0.5, yaw: 0, pitch: 0 });
          await new Promise((r) => setTimeout(r, 300));
          return { far: g.sky.fog.far, found: true };
        }
      }
    }
    return { found: false };
  });
  check(fog.found && fog.far < 20, 'dense fog under water', JSON.stringify(fog));
  await page.screenshot({ path: `${OUT}/smoke-underwater.png` });

  // Block picker renders an icon per block.
  await page.evaluate(() => window.__game.openPicker());
  await page.waitForTimeout(300);
  const cells = await page.locator('.picker-cell').count();
  check(cells >= 45, 'block picker lists every block', `${cells} cells`);
  await page.screenshot({ path: `${OUT}/smoke-picker.png` });
  await page.close();

  // ---- 2. Infinite debug world: streaming, fly-through, commands ----
  const t1 = Date.now();
  const inf = await openPage(`${base}?debug`);
  check(true, 'Infinite debug world streamed in and rendered', `${((Date.now() - t1) / 1000).toFixed(1)} s`);
  await inf.waitForTimeout(1500);
  await inf.screenshot({ path: `${OUT}/smoke-infinite.png` });
  const cmd = await inf.evaluate(() => window.__game.command('/seed'));
  check(cmd === 'Seed: 1337', 'command API answers /seed', cmd);

  // Day and night at the spawn.
  await inf.evaluate(() => window.__game.command('/time set noon'));
  await inf.waitForTimeout(400);
  await inf.screenshot({ path: `${OUT}/smoke-noon.png` });
  const night = await inf.evaluate(async () => {
    const g = window.__game;
    g.command('/time set midnight');
    await new Promise((r) => setTimeout(r, 400));
    return g.sky.daylight;
  });
  check(night < 0.05, 'midnight is dark', `daylight ${night}`);
  await inf.screenshot({ path: `${OUT}/smoke-midnight.png` });

  // A torch-lit cave: hollow out a room underground and light it.
  const cave = await inf.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    g.command('/time set noon');
    const s = g.player.spawn;
    const x0 = Math.floor(s.x);
    const z0 = Math.floor(s.z);
    const y0 = 34;
    for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) for (let y = 0; y < 5; y++) w.setBlock(x0 + x, y0 + y, z0 + z, 0);
    for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) w.setBlock(x0 + x, y0 - 1, z0 + z, 4);
    w.setBlock(x0 - 5, y0, z0 - 5, 48);
    w.setBlock(x0 + 4, y0, z0 + 2, 48);
    w.setBlock(x0 + 7, y0 + 2, z0 - 3, 1);
    w.setBlock(x0 + 6, y0 + 2, z0 - 3, 48 | (2 << 8)); // wall torch
    g.setViewpoint({ x: x0 - 4.5, y: y0 + 2.4, z: z0 + 6.5, yaw: 0.45, pitch: -0.3 });
    await new Promise((r) => setTimeout(r, 1500));
    return { nearTorch: w.lightAt(x0 - 5, y0 + 1, z0 - 4) & 15, dark: w.lightAt(x0 + 7, y0, z0 + 7) >> 4 };
  });
  check(cave.nearTorch >= 12 && cave.dark === 0, 'torches light a sealed cave', JSON.stringify(cave));
  await inf.screenshot({ path: `${OUT}/smoke-cave.png` });

  // Every biome: find it, check /biome agrees, and photograph it from above.
  const BIOME_KEYS = ['plains', 'forest', 'taiga', 'snowy_tundra', 'desert', 'swamp', 'mountains', 'river', 'beach', 'ocean', 'deep_ocean'];
  for (const key of BIOME_KEYS) {
    const res = await inf.evaluate(async (key) => {
      const g = window.__game;
      const msg = g.command(`/locatebiome ${key}`);
      const m = msg.match(/at (-?\d+) (-?\d+) (-?\d+)/);
      if (!m) return { ok: false, msg };
      const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
      g.command(`/tp ${x + 0.5} ${Math.max(y, 62) + 2} ${z + 0.5}`);
      const t0 = performance.now();
      while (performance.now() - t0 < 30000 && g.streamer.meshedFraction(x >> 4, z >> 4, 2) < 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const here = g.command('/biome');
      // Look north at the spot from 24 blocks south, above whatever is in between.
      const w = g.currentWorld;
      const t1 = performance.now();
      while (performance.now() - t1 < 30000 && g.streamer.meshedFraction(x >> 4, (z + 24) >> 4, 3) < 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
      let top = Math.max(y, 62);
      for (let dz = 0; dz <= 26; dz += 2) {
        for (let dx = -3; dx <= 3; dx++) {
          for (let ty = 127; ty > top; ty--) {
            if (w.getId(x + dx, ty, z + dz) !== 0) {
              top = ty;
              break;
            }
          }
        }
      }
      g.setViewpoint({ x: x + 0.5, y: Math.max(Math.max(y, 62) + 16, top + 8), z: z + 24.5, yaw: 0, pitch: -0.45 });
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true, msg, here };
    }, key);
    const name = key.replace(/_/g, ' ');
    check(res.ok && res.here.toLowerCase() === `biome: ${name}`, `/locatebiome ${key} finds it`, `${res.msg} → ${res.here}`);
    await inf.screenshot({ path: `${OUT}/biome-${key}.png` });
  }
  // Survival: HUD, crafting through the inventory screen, mining, pickup, falling, death.
  const surv = await inf.evaluate(async () => {
    const g = window.__game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.command('/time set noon');
    const s = g.player.spawn;
    g.player.teleport(s.x, s.y, s.z);
    g.player.yaw = 0;
    g.player.pitch = -0.35;
    // The spawn area may have unloaded during the biome tour: wait for it.
    for (let i = 0; i < 150 && !(g.currentWorld.isActive(Math.floor(s.x), Math.floor(s.z)) && g.streamer.meshedFraction(Math.floor(s.x) >> 4, Math.floor(s.z) >> 4, 2) === 1); i++) {
      await wait(200);
    }
    const out = { mode: g.command('/gamemode survival') };
    g.survivor.inventory.fill(null);
    g.command('/give oak_log 3');
    g.command('/give cobblestone 3');
    g.command('/give apple 4');
    await wait(300);
    // Logs → planks in the 2×2 grid, clicking like a player would.
    g.openContainer('inventory', 'Inventory', 2);
    const c = g.container;
    const inv = g.survivor.inventory;
    const at = (id) => {
      const i = inv.findIndex((st) => st && st.id === id);
      return i < 9 ? ['hotbar', i] : ['main', i - 9];
    };
    c.click(...at(15), 'left', false); // pick up the logs
    c.click('grid', 0, 'left', false); // all three into the grid
    c.click('result', 0, 'left', true); // shift: craft them all → 12 planks
    out.planks = inv.filter((st) => st && st.id === 5).reduce((n, st) => n + st.count, 0);
    // Leave a stick recipe in the grid for the screenshot.
    for (const cell of [1, 3]) {
      const [sec, i] = at(5);
      c.click(sec, i, 'left', false);
      c.click('grid', cell, 'right', false);
      c.click(sec, i, 'left', false);
    }
    out.preview = c.result[0]?.id ?? null;
    g.containerView.render();
    return out;
  });
  check(surv.mode === 'Game mode set to survival' && surv.planks === 12 && surv.preview === 256, 'survival: logs craft into planks in the inventory grid', JSON.stringify(surv));
  await inf.mouse.move(640, 250);
  await inf.screenshot({ path: `${OUT}/survival-inventory.png` });
  const surv2 = await inf.evaluate(async () => {
    const g = window.__game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.closeContainer();
    await wait(200);
    const inv = () => g.survivor.inventory;
    const count = (id) => inv().filter((st) => st && st.id === id).reduce((n, st) => n + st.count, 0);
    // Sticks and a wooden pickaxe on a crafting table.
    g.openContainer('crafting', 'Crafting', 3);
    for (let i = 0; i < 50 && !g.container; i++) await wait(50); // waits for the pointer lock to let go
    const table = g.container;
    const put = (id, cell) => {
      const i = inv().findIndex((st) => st && st.id === id);
      const sec = i < 9 ? 'hotbar' : 'main';
      const idx = i < 9 ? i : i - 9;
      table.click(sec, idx, 'left', false); // pick up
      table.click('grid', cell, 'right', false); // place one
      table.click(sec, idx, 'left', false); // put the rest back
    };
    put(5, 1);
    put(5, 4);
    table.click('result', 0, 'left', true); // sticks
    for (const cell of [0, 1, 2]) put(5, cell);
    put(256, 4);
    put(256, 7);
    table.click('result', 0, 'left', true); // wooden pickaxe
    g.closeContainer();
    const pick = inv().findIndex((st) => st && st.id === 280);
    const result = { sticks: count(256), pickaxe: pick >= 0 };
    // Mine the stone under a dug hole with the pickaxe: drops cobblestone, which gets picked up.
    if (pick >= 0) {
      const tmp = inv()[0];
      inv()[0] = inv()[pick];
      inv()[pick] = tmp;
      g.select(0);
    }
    const w = g.currentWorld;
    const b = g.player.body;
    const x = Math.floor(b.x);
    const z = Math.floor(b.z) - 1;
    let y = Math.floor(b.y) - 1;
    w.setBlock(x, y, z, 1);
    const cobbleBefore = count(4);
    // Software GL can be slow: wait for simulation steps (60 per second), not wall time.
    const waitSteps = async (n) => {
      const start = g.stepCount;
      for (let i = 0; i < 600 && g.stepCount - start < n; i++) await wait(50);
    };
    let broke = null;
    for (let i = 0; i < 300 && !broke; i++) broke = g.survivor.updateMining(w, g.items, { x, y, z }, true, 1 / 60);
    g.chunks.rebuildAt(x, y, z);
    await waitSteps(120);
    result.mined = !!broke && w.getId(x, y, z) === 0;
    result.pickedUp = count(4) - cobbleBefore;
    result.wear = inv()[0]?.damage ?? -1;
    // A 10-block drop hurts.
    w.setBlock(x, y, z, 1);
    // Below 18 hunger nothing heals in the meantime.
    g.survivor.vitals.hunger = 17;
    g.survivor.vitals.saturation = 0;
    g.player.teleport(b.x, b.y + 10, b.z);
    const hp = g.survivor.vitals.health;
    await waitSteps(150);
    result.fall = hp - g.survivor.vitals.health;
    g.survivor.vitals.hunger = 14;
    g.survivor.vitals.air = 180;
    return result;
  });
  check(surv2.sticks === 2 && surv2.pickaxe, 'survival: sticks and a wooden pickaxe on a 3×3 grid', JSON.stringify(surv2));
  check(surv2.mined && surv2.pickedUp === 1 && surv2.wear === 1, 'survival: pickaxe mines stone, cobblestone is picked up', JSON.stringify(surv2));
  check(surv2.fall >= 5 && surv2.fall <= 8, 'survival: falling ten blocks hurts', `${surv2.fall} damage`);
  await inf.waitForTimeout(300);
  await inf.screenshot({ path: `${OUT}/survival-hud.png` });
  const bucket = await inf.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    const b = g.player.body;
    const x = Math.floor(b.x) + 2;
    const z = Math.floor(b.z);
    const y = 100;
    w.setBlock(x, y - 1, z, 1);
    w.setBlock(x, y, z, 8); // a water source on a stone pillar
    g.survivor.inventory[0] = { id: 270, count: 1, damage: 0 };
    g.select(0);
    g.player.body.flying = true;
    g.player.teleport(x + 0.5, y + 1.4, z + 0.5);
    g.player.pitch = -1.55;
    // The camera (and so the aim) moves on the next frames.
    await g.nextFrame();
    await g.nextFrame();
    g.useBucket(g.survivor.held);
    const scooped = { cell: w.getId(x, y, z), held: g.survivor.held?.id };
    await g.nextFrame();
    g.useBucket(g.survivor.held);
    const poured = { cell: w.getId(x, y, z), held: g.survivor.held?.id };
    g.player.body.flying = false;
    w.setBlock(x, y, z, 0);
    w.setBlock(x, y - 1, z, 0);
    return { scooped, poured };
  });
  check(
    bucket.scooped.cell === 0 && bucket.scooped.held === 271 && bucket.poured.cell === 8 && bucket.poured.held === 270,
    'survival: a bucket scoops up a water source and pours it back',
    JSON.stringify(bucket),
  );
  // A bed: place it, sleep through the night, and (below) respawn beside it.
  const bed = await inf.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    const b = g.player.body;
    const x = Math.floor(b.x) + 4;
    const z = Math.floor(b.z);
    const y = 100;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -3; dz <= 3; dz++) w.setBlock(x + dx, y - 1, z + dz, 4);
    const kept = g.survivor.inventory[0];
    g.survivor.inventory[0] = { id: 68, count: 1, damage: 0 };
    g.select(0);
    g.player.body.flying = true;
    g.player.teleport(x + 0.5, y + 0.2, z + 2.5);
    g.player.yaw = 0;
    g.player.pitch = -Math.atan2(1.82 + 0.2, 2);
    await g.nextFrame();
    await g.nextFrame();
    g.act(2);
    const placed = { foot: w.get(x, y, z), head: w.get(x, y, z - 1), left: g.survivor.inventory[0]?.count ?? 0 };
    g.survivor.inventory[0] = kept;
    g.command('/kill @e');
    g.command('/time set midnight');
    g.useBed({ x, y, z: z - 1 });
    const asleep = g.sleep >= 0;
    for (let i = 0; i < 300 && g.sleep >= 0; i++) await new Promise((r) => setTimeout(r, 100));
    const morning = g.session.time;
    g.command('/time set noon');
    g.player.body.flying = false;
    g.setViewpoint({ x: x + 2.5, y: y + 1.8, z: z + 2.2, yaw: 0.75, pitch: -0.5 });
    return { placed, asleep, morning, spawn: g.bed, x, y, z };
  });
  check(
    bed.placed.foot === 68 && bed.placed.head === (68 | (4 << 8)) && bed.placed.left === 0,
    'survival: a bed is placed two blocks long',
    JSON.stringify(bed.placed),
  );
  check(bed.asleep && bed.morning === 0 && bed.spawn?.z === bed.z, 'survival: sleeping in the bed skips to morning and sets the respawn point', JSON.stringify(bed));
  await inf.evaluate(() => window.__game.nextFrame());
  await inf.screenshot({ path: `${OUT}/survival-bed.png` });
  // Farming: till with a hoe, sow seeds, bone meal them ripe, harvest.
  const farm = await inf.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    const b = g.player.body;
    const x0 = Math.floor(b.x) - 6;
    const z0 = Math.floor(b.z) - 3;
    const y = 99;
    // A 5×5 grass bed with a water source in the middle, beside the bed platform.
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) w.setBlock(x0 + dx, y, z0 + dz, 2);
    w.setBlock(x0, y, z0, 8);
    // Stand two blocks south of (tx, tz) and look at height `at` above the grass.
    const aim = async (tx, tz, at) => {
      g.player.teleport(tx + 0.5, y + 1.2, tz + 2.5);
      g.player.body.flying = true;
      g.player.yaw = 0;
      g.player.pitch = -Math.atan2(1.2 + 1.62 - at, 2);
      await g.nextFrame();
      await g.nextFrame();
    };
    const kept = g.survivor.inventory.slice(0, 3);
    g.survivor.inventory[0] = { id: 300, count: 1, damage: 0 }; // wooden hoe
    g.survivor.inventory[1] = { id: 276, count: 8, damage: 0 }; // seeds
    g.survivor.inventory[2] = { id: 268, count: 8, damage: 0 }; // bone meal
    const tx = x0 + 1;
    const tz = z0;
    await aim(tx, tz, 0.5);
    g.select(0);
    g.act(2);
    const tilled = w.get(tx, y, tz);
    g.select(1);
    g.act(2);
    const planted = w.getId(tx, y + 1, tz);
    // Bone meal until ripe (aim at the crop itself).
    await aim(tx, tz, 1.4);
    g.select(2);
    for (let i = 0; i < 4; i++) {
      await g.nextFrame();
      g.act(2);
    }
    const ripe = w.get(tx, y + 1, tz) >> 8;
    // Dress the rest of the field in every growth stage for the picture.
    let stage = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if ((dx === 0 && dz === 0) || (dx === 1 && dz === 0)) continue;
        w.setBlock(x0 + dx, y, z0 + dz, 69 | (1 << 8));
        w.setBlock(x0 + dx, y + 1, z0 + dz, 70 | ((stage++ % 8) << 8));
      }
    }
    await g.nextFrame();
    g.act(0); // harvest the ripe one
    await new Promise((r) => setTimeout(r, 300));
    const harvested = g.items.list.filter((it) => it.stack.id === 277).length;
    g.survivor.inventory.splice(0, 3, ...kept);
    g.player.body.flying = false;
    g.setViewpoint({ x: x0 + 0.5, y: y + 4, z: z0 + 5.5, yaw: 0, pitch: -0.6 });
    return { tilled, planted, ripe, harvested };
  });
  check(
    farm.tilled === (69 | (1 << 8)) && farm.planted === 70 && farm.ripe === 7 && farm.harvested > 0,
    'survival: a hoe tills moist farmland, seeds grow into wheat and ripe wheat is harvested',
    JSON.stringify(farm),
  );
  await inf.evaluate(() => window.__game.nextFrame());
  await inf.screenshot({ path: `${OUT}/survival-farm.png` });
  // Doors, ladders and fences: a little hut to walk through and climb.
  const hut = await inf.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    const b = g.player.body;
    const x0 = Math.floor(b.x) + 2;
    const z0 = Math.floor(b.z) + 6;
    const y = 100;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 5; dz++) w.setBlock(x0 + dx, y - 1, z0 + dz, 2);
    // Walls three high around a 3×3 room, with a doorway in the south wall.
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
        for (let h = 0; h < 3; h++) w.setBlock(x0 + dx, y + h, z0 + dz, 5);
      }
    }
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) w.setBlock(x0 + dx, y + 3, z0 + dz, 5);
    w.setBlock(x0, y, z0 + 2, 0);
    w.setBlock(x0, y + 1, z0 + 2, 0);
    // A fence along the front garden.
    for (let dx = -4; dx <= 4; dx++) if (dx !== 0) w.setBlock(x0 + dx, y, z0 + 5, 73);
    const kept = g.survivor.inventory[0];
    g.survivor.inventory[0] = { id: 71, count: 1, damage: 0 };
    g.select(0);
    g.player.body.flying = true;
    // Place the door from outside, looking north at the doorway floor.
    g.player.teleport(x0 + 0.5, y, z0 + 4.5);
    g.player.yaw = 0;
    g.player.pitch = -Math.atan2(1.62, 2.1);
    await g.nextFrame();
    await g.nextFrame();
    g.act(2);
    const door = { lower: w.get(x0, y, z0 + 2), upper: w.get(x0, y + 1, z0 + 2) };
    // Closed, it stops the player; open, they walk in.
    g.player.body.flying = false;
    g.player.teleport(x0 + 0.5, y, z0 + 3.6);
    await g.nextFrame();
    g.player.pitch = 0;
    await g.nextFrame();
    g.act(2); // opens it
    const opened = (w.get(x0, y, z0 + 2) >> 8) & 4;
    g.act(2); // and closes it again
    g.survivor.inventory[0] = kept;
    // A ladder up the east wall's outside.
    for (let h = 0; h < 4; h++) w.setBlock(x0 + 3, y + h, z0, 72 | (1 << 8));
    g.setViewpoint({ x: x0 + 6.5, y: y + 2.6, z: z0 + 6.5, yaw: Math.atan2(6, 5.5), pitch: -0.2 });
    return { door, opened, x0, z0 };
  });
  check(
    (hut.door.lower & 0xff) === 71 && (hut.door.upper & 0xff) === 71 && (hut.door.upper >> 8) & 8 && hut.opened === 4,
    'doors are placed two tall and open with a click',
    JSON.stringify(hut),
  );
  await inf.evaluate(() => window.__game.nextFrame());
  await inf.screenshot({ path: `${OUT}/survival-hut.png` });
  const death = await inf.evaluate(async () => {
    const g = window.__game;
    const had = g.survivor.inventory.filter(Boolean).length;
    g.command('/kill');
    await new Promise((r) => setTimeout(r, 600));
    const dropped = g.items.list.length;
    const state = g.state;
    return { had, dropped, state };
  });
  check(death.state === 'dead' && death.dropped >= death.had, 'survival: dying drops the inventory and shows the death screen', JSON.stringify(death));
  await inf.screenshot({ path: `${OUT}/survival-death.png` });
  const back = await inf.evaluate(async () => {
    const g = window.__game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.death-screen .btn-primary').click();
    await wait(500);
    const at = { x: g.player.body.x, z: g.player.body.z };
    const r = { health: g.survivor.vitals.health, state: g.state, at, mode: g.command('/gamemode creative') };
    // Back to the unlocked debug view for the rest of the run.
    g.input.exitLock();
    await wait(300);
    g.items.clear();
    g.enterPlayUnlocked();
    return r;
  });
  check(back.health === 20, 'survival: respawn restores health', JSON.stringify(back));
  check(
    Math.abs(back.at.x - (bed.x + 0.5)) < 1 && Math.abs(back.at.z - (bed.z + 0.5)) < 1,
    'survival: the player respawns at their bed',
    JSON.stringify({ at: back.at, bed: { x: bed.x, z: bed.z } }),
  );

  // Mobs: every kind lined up for a photo, then a night fight.
  const lineup = await inf.evaluate(async () => {
    const g = window.__game;
    const w = g.currentWorld;
    const s = g.player.spawn;
    const x0 = Math.floor(s.x);
    const z0 = Math.floor(s.z) - 8;
    const y0 = 95;
    for (let dx = -9; dx <= 9; dx++) for (let dz = -6; dz <= 6; dz++) w.setBlock(x0 + dx, y0, z0 + dz, 2);
    // A leafy canopy: bright underneath, but not full sun, so the undead don't burn.
    for (let dx = -9; dx <= 9; dx++) for (let dz = -3; dz <= 3; dz++) w.setBlock(x0 + dx, y0 + 4, z0 + dz, 16);
    g.command('/time set noon');
    g.command('/kill @e');
    await new Promise((r) => setTimeout(r, 1200));
    const kinds = ['pig', 'cow', 'sheep', 'zombie', 'skeleton', 'spider'];
    const out = kinds.map((k, i) => g.command(`/summon ${k} ${x0 - 6.5 + i * 2.6} ${y0 + 1} ${z0 + 0.5}`));
    const shown = g.mobs.list.filter((m) => m.dying < 0 && Math.abs(m.body.z - z0 - 0.5) < 1);
    for (const m of shown) {
      m.yaw = Math.PI + 0.45; // turned toward the camera
      m.timer = 999;
      m.mode = 'idle';
      m.fire = 0;
    }
    g.setViewpoint({ x: x0 + 0.5, y: y0 + 3, z: z0 + 7.5, yaw: 0, pitch: -0.22 });
    await new Promise((r) => setTimeout(r, 1500));
    for (const m of shown) m.fire = 0;
    return { out, count: shown.length };
  });
  check(lineup.count === 6, 'every mob kind can be summoned', JSON.stringify(lineup));
  await inf.screenshot({ path: `${OUT}/mobs.png` });
  const fight = await inf.evaluate(async () => {
    const g = window.__game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitSteps = async (n) => {
      const start = g.stepCount;
      for (let i = 0; i < 800 && g.stepCount - start < n; i++) await wait(50);
    };
    g.command('/kill @e');
    await waitSteps(80);
    g.command('/time set midnight');
    g.command('/gamemode survival');
    g.survivor.inventory.fill(null);
    g.command('/give iron_sword');
    g.select(0);
    const b = g.player.body;
    // Stand on the grass stage built for the lineup.
    const s = g.player.spawn;
    g.player.teleport(Math.floor(s.x) + 0.5, 96, Math.floor(s.z) - 8 + 3.5);
    g.player.body.flying = false;
    await waitSteps(30);
    const hp = g.survivor.vitals.health;
    // A zombie right in front: it attacks, then we fight back with the sword.
    g.player.yaw = 0;
    g.player.pitch = -0.2;
    g.command(`/summon zombie ${b.x} ${b.y} ${b.z - 2.2}`);
    const zombie = g.mobs.list[g.mobs.list.length - 1];
    await waitSteps(90);
    const hurt = hp - g.survivor.vitals.health;
    let swings = 0;
    for (let i = 0; i < 40 && zombie.dying < 0; i++) {
      g.player.yaw = Math.atan2(-(zombie.body.x - b.x), -(zombie.body.z - b.z));
      await g.nextFrame();
      if (g.attackMob()) swings++;
      await wait(300);
    }
    await waitSteps(80);
    const killed = zombie.removed;
    const sword = g.survivor.inventory[0];
    // A full draw of the bow at a pig eight blocks away.
    g.command('/give bow');
    g.command('/give arrow 4');
    g.select(1);
    g.command(`/summon pig ${b.x} ${b.y} ${b.z - 8}`);
    const pig = g.mobs.list[g.mobs.list.length - 1];
    await waitSteps(20);
    const px = pig.body.x - b.x;
    const pz = pig.body.z - b.z;
    g.player.yaw = Math.atan2(-px, -pz);
    g.player.pitch = Math.atan2(pig.body.y + 0.6 - (b.y + 1.62), Math.hypot(px, pz)) + 0.03;
    await g.nextFrame();
    g.survivor.updateBow(true, 1);
    const power = g.survivor.updateBow(false, 0);
    if (power !== null) g.shootArrow(power);
    await waitSteps(40);
    const bow = { power, pigHealth: pig.health, arrowsLeft: g.survivor.inventory.filter((st) => st?.id === 274).reduce((n, st) => n + st.count, 0) };
    // Peaceful clears hostiles.
    g.command('/summon skeleton ~ ~ ~');
    g.command('/difficulty peaceful');
    await waitSteps(10);
    const hostiles = g.mobs.hostileCount;
    g.command('/difficulty normal');
    g.command('/gamemode creative');
    g.command('/time set noon');
    g.survivor.respawn();
    return { hurt, swings, killed, swordWear: sword?.damage ?? -1, hostiles, bow };
  });
  check(fight.hurt > 0, 'a zombie hurts a survival player at night', JSON.stringify(fight));
  check(fight.killed && fight.swordWear > 0, 'the player kills the zombie with a sword', JSON.stringify(fight));
  check(fight.hostiles === 0, 'Peaceful removes hostile mobs', JSON.stringify(fight));
  check(fight.bow.power === 1 && fight.bow.pigHealth < 10 && fight.bow.arrowsLeft === 3, 'a drawn bow shoots an arrow into a pig', JSON.stringify(fight.bow));

  await inf.evaluate(() => window.__game.setViewpoint({ x: window.__game.player.spawn.x, y: 90, z: window.__game.player.spawn.z, yaw: 0, pitch: -0.3 }));
  const flight = await inf.evaluate(async () => {
    const g = window.__game;
    g.input.exitLock();
    await new Promise((r) => setTimeout(r, 300));
    g.enterPlayUnlocked();
    g.player.body.flying = true;
    g.player.yaw = -Math.PI / 2;
    const x0 = g.player.body.x;
    // Hold W (re-pressed in case a pointer-lock change releases keys).
    const hold = setInterval(() => g.input.keys.add('KeyW'), 100);
    await new Promise((r) => setTimeout(r, 6000));
    clearInterval(hold);
    g.input.keys.delete('KeyW');
    await new Promise((r) => setTimeout(r, 1500));
    const b = g.player.body;
    const cx = Math.floor(b.x) >> 4;
    const cz = Math.floor(b.z) >> 4;
    return { moved: b.x - x0, fraction: g.streamer.meshedFraction(cx, cz, 3), chunks: g.currentWorld.chunks.size };
  });
  check(flight.moved > 30 && flight.fraction === 1, 'terrain keeps up while flying', JSON.stringify(flight));
  const far = await inf.evaluate(async () => {
    const g = window.__game;
    g.command('/tp -100000 100 -100000');
    // Wait until the 5×5 columns around the player are meshed (software GL is slow; allow 30 s).
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000 && g.streamer.meshedFraction(-6250, -6250, 2) < 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const seconds = Math.round((performance.now() - t0) / 100) / 10;
    return { fraction: g.streamer.meshedFraction(-6250, -6250, 2), seconds, chunks: g.currentWorld.chunks.size };
  });
  check(far.fraction === 1, 'terrain streams in 100k blocks from the origin', JSON.stringify(far));
  await inf.screenshot({ path: `${OUT}/smoke-far.png` });
  await inf.close();

  // ---- 3. Title screen: create, edit, save & quit, reopen, delete ----
  const game = await openTitle(`${base}?api`);
  await game.screenshot({ path: `${OUT}/smoke-title.png` });
  await game.click('text=Create new world');
  await game.fill('#cw-name', 'Smoke world');
  await game.fill('#cw-seed', 'smoke');
  if (await game.locator('#cw-type').isVisible()) await game.selectOption('#cw-type', 'classic');
  await game.selectOption('#cw-size', 'small');
  await game.click('button:visible:has-text("Create")');
  await game.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  await game.waitForSelector('.click-to-play:not(.hidden)');
  const marker = await game.evaluate(async () => {
    const g = window.__game;
    g.enterPlayUnlocked();
    const s = g.player.spawn;
    const x = Math.floor(s.x) + 3;
    const z = Math.floor(s.z) - 2;
    g.currentWorld.setBlock(x, 50, z, 39); // gold block in the sky
    await g.quitToTitle();
    return { x, z };
  });
  await game.waitForSelector('.title-screen:not(.hidden)');
  await game.reload();
  await game.waitForSelector('.title-screen:not(.hidden)');
  check((await game.locator('.world-row').count()) === 1, 'world list shows the saved world');
  await game.click('.world-row >> text=Play');
  await game.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  const kept = await game.evaluate(({ x, z }) => window.__game.currentWorld.get(x, 50, z), marker);
  check(kept === 39, 'edits survive save & quit and a page reload', `block ${kept}`);
  await game.evaluate(() => window.__game.quitToTitle());
  await game.waitForSelector('.title-screen:not(.hidden)');
  await game.click('.world-row >> text=Delete');
  await game.click('button:visible:has-text("Delete")');
  await game.waitForTimeout(400);
  check((await game.locator('.world-row').count()) === 0, 'delete (with confirmation) removes the world');

  // ---- 4. Infinite world: edits survive unloading, quitting and reloading ----
  await game.click('text=Create new world');
  await game.fill('#cw-name', 'Endless');
  await game.fill('#cw-seed', 'endless');
  await game.selectOption('#cw-type', 'infinite');
  await game.click('button:visible:has-text("Create")');
  await game.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  const spot = await game.evaluate(async () => {
    const g = window.__game;
    const until = async (cond, ms) => {
      const end = performance.now() + ms;
      while (!cond() && performance.now() < end) await new Promise((r) => setTimeout(r, 100));
      return cond();
    };
    g.enterPlayUnlocked();
    const s = g.player.spawn;
    const x = Math.floor(s.x) - 5;
    const z = Math.floor(s.z) + 7;
    const placed = g.currentWorld.setBlock(x, 110, z, 47); // obsidian in the sky
    // A chest with diamonds, and an apple lying on the obsidian.
    g.currentWorld.setBlock(x + 1, 110, z, 67);
    g.blockEntities.chest(x + 1, 110, z)[4] = { id: 261, count: 3, damage: 0 };
    g.items.spawn({ id: 262, count: 2, damage: 0 }, x + 0.5, 111.2, z + 0.5, 0, 0, 0, 99);
    g.command('/gamemode creative');
    g.player.body.flying = true;
    g.command('/tp 3000 100 3000'); // far enough to unload the edit
    const unloaded = await until(() => g.currentWorld.chunkAt(x, z) === undefined, 15000);
    await new Promise((r) => setTimeout(r, 2000)); // let the unloaded chunk be written
    g.command(`/tp ${x} 112 ${z}`);
    const reloaded = await until(() => g.currentWorld.chunkAt(x, z) !== undefined, 15000);
    const back = g.currentWorld.get(x, 110, z);
    await g.quitToTitle();
    return { x, z, placed, unloaded, reloaded, back };
  });
  check(spot.placed && spot.unloaded && spot.back === 47, 'edits survive unloading and reloading chunks', JSON.stringify(spot));
  await game.reload();
  await game.waitForSelector('.title-screen:not(.hidden)');
  await game.click('.world-row:has-text("Endless") >> text=Play');
  await game.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  const kept2 = await game.evaluate(async ({ x, z }) => {
    const g = window.__game;
    const chest = g.blockEntities.get(x + 1, 110, z);
    const items = g.items.list.filter((e) => Math.abs(e.body.x - x - 0.5) < 1 && Math.abs(e.body.z - z - 0.5) < 1).map((e) => e.stack);
    return { block: g.currentWorld.get(x, 110, z), chest: chest?.kind === 'chest' ? chest.slots[4] : null, items };
  }, spot);
  check(kept2.block === 47, 'Infinite world edits survive a page reload', JSON.stringify(kept2));
  check(kept2.chest?.id === 261 && kept2.chest.count === 3 && kept2.items.some((st) => st.id === 262 && st.count === 2), 'chest contents and dropped items survive too', JSON.stringify(kept2));
  await game.evaluate(() => window.__game.quitToTitle());
  await game.waitForSelector('.title-screen:not(.hidden)');

  // ---- 5. A v1 single-slot save is migrated into a Classic world ----
  await game.evaluate(async (bytes) => {
    const db = await new Promise((res) => {
      const q = indexedDB.open('blocktide');
      q.onsuccess = () => res(q.result);
    });
    const tx = db.transaction('saves', 'readwrite');
    tx.objectStore('saves').put({ data: new Uint8Array(bytes).buffer, savedAt: 1, label: 'v1' }, 'latest');
    await new Promise((r) => {
      tx.oncomplete = r;
    });
    db.close();
  }, legacySave());
  await game.reload();
  await game.waitForSelector('.title-screen:not(.hidden)', { timeout: 60_000 });
  await game.click('.world-row:has-text("My first world") >> text=Play');
  await game.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  const migrated = await game.evaluate(() => window.__game.currentWorld.get(30, 40, 20));
  check(migrated === 41, 'v1 save migrates into a playable Classic world', `marker ${migrated}`);
  await game.close();
} catch (err) {
  check(false, 'smoke run threw', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

check(problems.length === 0, 'no console errors', problems.join('\n'));
console.log(failed ? '\nSMOKE TEST FAILED' : `\nSmoke test passed. Screenshots in ${OUT}/`);
process.exit(failed ? 1 : 0);
