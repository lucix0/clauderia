/**
 * Chunk pipeline benchmark (run with `npm run bench`): chunks per second
 * for generation, lighting and meshing, single-threaded.
 */
import { buildMeshInput, fillPaddedFromInput } from '../src/render/meshInput';
import { meshSection } from '../src/render/mesher';
import { createPadded } from '../src/render/padded';
import { Chunk } from '../src/world/chunk';
import { SECTIONS } from '../src/world/coords';
import { InfiniteGenerator } from '../src/world/gen/infinite';
import { computeChunkLight } from '../src/world/light';
import { buildLightRegion } from '../src/world/lightRegion';
import { World } from '../src/world/world';

const SEED = 1337;
const SIDE = 12; // SIDE × SIDE chunks

function time<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
}

function row(label: string, count: number, ms: number): string {
  return `${label.padEnd(12)} ${String(count).padStart(5)} chunks  ${ms.toFixed(0).padStart(6)} ms  ${((count / ms) * 1000).toFixed(0).padStart(6)} chunks/s  ${(ms / count).toFixed(2).padStart(6)} ms/chunk`;
}

export function run(): string[] {
  const out: string[] = [];
  const gen = new InfiniteGenerator(SEED);
  gen.generate(0, 0); // warm up
  const world = new World({ type: 'infinite', seed: SEED, height: 128, seaLevel: 62 });

  const [chunks, genMs] = time(() => {
    const list: Chunk[] = [];
    for (let cz = 0; cz < SIDE; cz++) for (let cx = 0; cx < SIDE; cx++) list.push(new Chunk(cx, cz, gen.generate(cx, cz).blocks));
    return list;
  });
  out.push(row('generate', chunks.length, genMs));
  for (const c of chunks) world.addChunk(c);

  const inner = chunks.filter((c) => c.cx > 0 && c.cz > 0 && c.cx < SIDE - 1 && c.cz < SIDE - 1);
  const [, lightMs] = time(() => {
    for (const c of inner) c.light = computeChunkLight(buildLightRegion(world, c.cx, c.cz));
  });
  out.push(row('light', inner.length, lightMs));

  const pad = createPadded();
  let quads = 0;
  const [, meshMs] = time(() => {
    for (const c of inner) {
      const input = buildMeshInput(world, c, c.nonEmpty, (ch) => ch.light, true); // smooth lighting, the default
      for (let sy = 0; sy < SECTIONS; sy++) {
        if (!(c.nonEmpty & (1 << sy))) continue;
        fillPaddedFromInput(pad, input, sy);
        for (const p of meshSection(pad)) quads += p?.quads ?? 0;
      }
    }
  });
  out.push(row('mesh', inner.length, meshMs));
  out.push(`(${(quads / inner.length).toFixed(0)} quads per column on average)`);
  return out;
}
