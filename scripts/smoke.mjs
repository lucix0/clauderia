// Playwright smoke test: serves the production build, fails on any console
// error, and writes screenshots to artifacts/. Phases: the ?debug world view
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
  const flight = await inf.evaluate(async () => {
    const g = window.__game;
    g.player.body.flying = true;
    g.player.yaw = -Math.PI / 2;
    g.input.keys.add('KeyW');
    const x0 = g.player.body.x;
    await new Promise((r) => setTimeout(r, 6000));
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
    await new Promise((r) => setTimeout(r, 4000));
    return { fraction: g.streamer.meshedFraction(-6250, -6250, 2), chunks: g.currentWorld.chunks.size };
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
  const kept2 = await game.evaluate(({ x, z }) => window.__game.currentWorld.get(x, 110, z), spot);
  check(kept2 === 47, 'Infinite world edits survive a page reload', `block ${kept2}`);
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
