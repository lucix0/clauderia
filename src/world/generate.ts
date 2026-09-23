import { generateLevel, type GenOptions, type ProgressFn } from './generator';
import type { GenMessage } from './gen.worker';

/**
 * Generate a level off the main thread when workers are available, falling
 * back to generating inline.
 */
export function generateAsync(opts: GenOptions, progress: ProgressFn): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return Promise.resolve(generateLevel(opts, progress));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<GenMessage>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        progress(msg.stage, msg.fraction);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.blocks);
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Level generator worker failed'));
    };
    worker.postMessage(opts);
  });
}
