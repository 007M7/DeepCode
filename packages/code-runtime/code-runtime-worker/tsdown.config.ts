import { defineConfig } from 'tsdown'

/**
 * Package-shape override (see the root tsdown.config.ts): besides the
 * default lib/index.js bundle, the worker BOOTSTRAP ships as its own
 * sibling entry — `new Worker(new URL('./worker.js', import.meta.url))`
 * loads it as a file, so it cannot be part of the index bundle. TWO
 * single-entry builds, not one two-entry build: a multi-entry build emits
 * the shared bootstrap module as a `lib/bootstrap-*.js` chunk both bundles
 * import, which the package.json `files` whitelist (deliberately exact)
 * would omit from the packed artifact — each single-entry build inlines its
 * own bootstrap copy instead, keeping every shipped file self-contained.
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
