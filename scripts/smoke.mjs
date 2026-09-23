// Playwright smoke test: serves the production build, opens it with ?debug,
// fails on any console error, exercises a few interactions, checks that a
// save survives a reload, and writes screenshots to artifacts/.
//
//   npm run smoke            (builds first)
//   CHROMIUM_PATH=/path/to/chrome node scripts/smoke.mjs
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
  // ---- 1. Debug view ----
  const t0 = Date.now();
  const page = await openPage(`${base}?debug`);
  check(true, 'debug world generated, meshed and rendered', `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/smoke-debug.png` });

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
    for (let x = 1; x < w.sx - 1; x += 3) {
      for (let z = 1; z < w.sz - 1; z += 3) {
        if (w.get(x, w.seaLevel - 1, z) === 8 && w.get(x, w.seaLevel - 3, z) === 8) {
          g.setViewpoint({ x: x + 0.5, y: w.seaLevel - 1.5, z: z + 0.5, yaw: 0, pitch: 0 });
          await new Promise((r) => setTimeout(r, 300));
          return { far: g.sky.fog.far, found: true };
        }
      }
    }
    return { found: false };
  });
  check(!fog.found || fog.far < 20, 'dense fog under water', JSON.stringify(fog));
  await page.screenshot({ path: `${OUT}/smoke-underwater.png` });

  // Block picker renders an icon per block.
  await page.evaluate(() => window.__game.openPicker());
  await page.waitForTimeout(300);
  const cells = await page.locator('.picker-cell').count();
  check(cells >= 45, 'block picker lists every block', `${cells} cells`);
  await page.screenshot({ path: `${OUT}/smoke-picker.png` });
  await page.close();

  // ---- 2. Save survives a reload (normal mode, small world) ----
  const game = await openPage(`${base}?size=small`);
  await game.waitForSelector('.click-to-play:not(.hidden)', { timeout: 60_000 });
  const before = await game.textContent('.menu-info');
  await game.waitForTimeout(500);
  await game.reload();
  await game.waitForFunction(() => window.__ready === true, null, { timeout: 120_000 });
  const after = await game.textContent('.menu-info');
  check(Boolean(before) && before === after, 'world is restored from IndexedDB after reload', `${before} → ${after}`);
  await game.screenshot({ path: `${OUT}/smoke-title.png` });
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
