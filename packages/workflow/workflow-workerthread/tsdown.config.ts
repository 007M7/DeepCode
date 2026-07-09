import { defineConfig } from 'tsdown'

/**
 * The engine ships two runtime entries: the engine service (index) and the
 * worker-thread entry (worker) the engine spawns via `new Worker`. The
 * entries are JS emitted by tsc under lib/types and are bundled as two
 * single-entry passes so shared modules (realm, runtime, session) are inlined
 * into each instead of split into a hash-named chunk (the worker entry must
 * be a self-contained file the Worker constructor can load by path).
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/worker.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
