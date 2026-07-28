import { defineConfig } from 'tsdown'

/**
 * Build the plugin, reusable runtime host, and worker as separate bundles. The
 * sibling `worker.cjs` is loaded by file and must be CommonJS for pkg's VFS
 * Worker hook. Separate builds inline shared implementation instead of
 * emitting an unlisted chunk outside the exact `files` whitelist.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/runtime-host.js'],
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
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
