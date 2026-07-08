import { defineConfig } from 'tsdown'

/**
 * Package-shape override (see the root tsdown.config.ts): besides the
 * default lib/index.js bundle, the worker BOOTSTRAP ships as its own
 * sibling entry — `new Worker(new URL('./worker.js', import.meta.url))`
 * loads it as a file, so it cannot be part of the index bundle.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/worker.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
