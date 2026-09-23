import type { ChunkMeshData } from '../render/mesher';
import type { MeshInput } from '../render/meshInput';

export type JobRequest =
  | { kind: 'generate'; seed: number; cx: number; cz: number }
  | { kind: 'light'; cx: number; cz: number; ids: Uint8Array }
  | { kind: 'mesh'; input: MeshInput };

export type JobResult =
  | { kind: 'generate'; cx: number; cz: number; blocks: Uint16Array; tints: Uint8Array; biomes: Uint8Array }
  | { kind: 'light'; cx: number; cz: number; light: Uint8Array; ms: number }
  | { kind: 'mesh'; cx: number; cz: number; sections: Array<ChunkMeshData | null>; ms: number };

export interface WorkerRequest {
  id: number;
  job: JobRequest;
}

export type WorkerReply = { id: number; ok: true; result: JobResult } | { id: number; ok: false; error: string };

/** Typed arrays in a result that can be transferred instead of copied. */
export function resultTransfers(result: JobResult): Transferable[] {
  if (result.kind === 'generate') return [result.blocks.buffer, result.tints.buffer, result.biomes.buffer];
  if (result.kind === 'light') return [result.light.buffer];
  const out: Transferable[] = [];
  for (const s of result.sections) {
    if (!s) continue;
    for (const p of s) {
      if (p) out.push(p.positions.buffer, p.uvs.buffer, p.colors.buffer, p.sky.buffer, p.block.buffer, p.tints.buffer);
    }
  }
  return out;
}

export function requestTransfers(job: JobRequest): Transferable[] {
  if (job.kind === 'mesh') {
    const t: Transferable[] = [job.input.blocks.buffer, job.input.light.buffer];
    if (job.input.tints) t.push(job.input.tints.buffer);
    return t;
  }
  if (job.kind === 'light') return [job.ids.buffer];
  return [];
}
