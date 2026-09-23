import { meshSection, type ChunkMeshData } from '../render/mesher';
import { fillPaddedFromInput } from '../render/meshInput';
import { createPadded } from '../render/padded';
import { SECTIONS } from '../world/coords';
import { infiniteGenerator } from '../world/gen/infinite';
import { computeChunkLight } from '../world/light';
import { resultTransfers, type JobRequest, type JobResult, type WorkerReply, type WorkerRequest } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const padded = createPadded();

function run(job: JobRequest): JobResult {
  if (job.kind === 'generate') {
    const { blocks, tints, biomes } = infiniteGenerator(job.seed).generate(job.cx, job.cz);
    return { kind: 'generate', cx: job.cx, cz: job.cz, blocks, tints, biomes };
  }
  if (job.kind === 'light') {
    const t = performance.now();
    const light = computeChunkLight(job.ids);
    return { kind: 'light', cx: job.cx, cz: job.cz, light, ms: performance.now() - t };
  }
  const t0 = performance.now();
  const input = job.input;
  const sections: Array<ChunkMeshData | null> = [];
  for (let sy = 0; sy < SECTIONS; sy++) {
    if (!(input.sections & (1 << sy))) {
      sections.push(null);
      continue;
    }
    fillPaddedFromInput(padded, input, sy);
    sections.push(meshSection(padded));
  }
  return { kind: 'mesh', cx: input.cx, cz: input.cz, sections, ms: performance.now() - t0 };
}

scope.onmessage = (event) => {
  const { id, job } = event.data;
  try {
    const result = run(job);
    scope.postMessage({ id, ok: true, result }, resultTransfers(result));
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
