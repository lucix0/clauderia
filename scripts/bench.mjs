// `npm run bench`: bundle scripts/bench.ts for Node with Vite, then run it.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const outDir = resolve('node_modules/.cache/blocktide-bench');
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: resolve('scripts/bench.ts'),
    outDir,
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'bench.mjs' } },
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'bench.mjs')).href);
console.log('Blocktide chunk pipeline (single thread, 16x16x128 columns)\n');
for (const line of mod.run()) console.log(line);
