import { generateLevel, type GenOptions } from './generator';

export type GenRequest = GenOptions;

export type GenMessage =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'done'; blocks: Uint8Array }
  | { type: 'error'; message: string };

/** The bits of the dedicated worker scope we use (avoids pulling in the WebWorker lib). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<GenRequest>) => void) | null;
  postMessage(message: GenMessage, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<GenRequest>) => {
  try {
    const blocks = generateLevel(event.data, (stage, fraction) => {
      scope.postMessage({ type: 'progress', stage, fraction } satisfies GenMessage);
    });
    scope.postMessage({ type: 'done', blocks } satisfies GenMessage, [blocks.buffer]);
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies GenMessage);
  }
};
