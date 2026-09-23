import { requestTransfers, type JobRequest, type JobResult, type WorkerReply } from './protocol';

export interface PoolJob {
  /** Dedupe key: a job with the same key replaces a pending one. */
  key: string;
  /** The request, or a builder run at dispatch time (null skips the job). */
  request: JobRequest | (() => JobRequest | null);
  /** Lower runs first; re-evaluated on every dispatch. */
  priority: () => number;
  onDone: (result: JobResult) => void;
  onError?: (error: string) => void;
}

interface Slot {
  worker: Worker;
  busy: PoolJob | null;
}

/**
 * A small pool of module workers running generation / lighting / meshing.
 * Jobs wait in a pending set and are dispatched by priority whenever a
 * worker is free.
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<string, PoolJob>();
  private readonly inFlight = new Map<number, { slot: Slot; job: PoolJob }>();
  private nextId = 1;
  /** Jobs completed (stats). */
  completed = 0;

  constructor(size = defaultPoolSize()) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: null };
      worker.onmessage = (event: MessageEvent<WorkerReply>) => this.onReply(event.data);
      worker.onerror = (event) => {
        console.warn('Chunk worker error:', event.message);
        const entry = [...this.inFlight.entries()].find(([, v]) => v.slot === slot);
        if (entry) {
          this.inFlight.delete(entry[0]);
          slot.busy = null;
          entry[1].job.onError?.(event.message || 'worker failed');
        }
      };
      this.slots.push(slot);
    }
  }

  get size(): number {
    return this.slots.length;
  }

  /** Pending (not yet started) jobs. */
  get queued(): number {
    return this.pending.size;
  }

  get running(): number {
    return this.inFlight.size;
  }

  has(key: string): boolean {
    if (this.pending.has(key)) return true;
    for (const { job } of this.inFlight.values()) if (job.key === key) return true;
    return false;
  }

  submit(job: PoolJob): void {
    this.pending.set(job.key, job);
  }

  cancel(key: string): void {
    this.pending.delete(key);
  }

  /** Cancel pending jobs whose keys fail the predicate. */
  retain(keep: (key: string) => boolean): void {
    for (const key of [...this.pending.keys()]) if (!keep(key)) this.pending.delete(key);
  }

  /** Start the most urgent pending jobs on idle workers. */
  dispatch(): void {
    const idle = this.slots.filter((s) => !s.busy);
    if (idle.length === 0 || this.pending.size === 0) return;
    const ranked = [...this.pending.values()].map((job) => ({ job, p: job.priority() })).sort((a, b) => a.p - b.p);
    let next = 0;
    for (const slot of idle) {
      let request: JobRequest | null = null;
      let job: PoolJob | null = null;
      while (!request && next < ranked.length) {
        job = ranked[next++]!.job;
        this.pending.delete(job.key);
        request = typeof job.request === 'function' ? job.request() : job.request;
      }
      if (!request || !job) break;
      const id = this.nextId++;
      slot.busy = job;
      this.inFlight.set(id, { slot, job });
      slot.worker.postMessage({ id, job: request }, requestTransfers(request));
    }
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    this.slots.length = 0;
    this.pending.clear();
    this.inFlight.clear();
  }

  private onReply(reply: WorkerReply): void {
    const entry = this.inFlight.get(reply.id);
    if (!entry) return;
    this.inFlight.delete(reply.id);
    entry.slot.busy = null;
    this.completed++;
    if (reply.ok) entry.job.onDone(reply.result);
    else entry.job.onError?.(reply.error);
    this.dispatch();
  }
}

export function defaultPoolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(2, Math.min(4, cores - 1));
}
