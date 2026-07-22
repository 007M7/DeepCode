import { defineConfig } from 'tsdown'

/**
 * Root shape plus the store subpath, built as SEPARATE single-entry bundles:
 * a multi-entry build emits a hash-named shared chunk that the exact `files`
 * whitelist cannot publish (same shape as code-runtime-worker/user-approval).
 * Each entry inlines the shared store code instead; the node lib is the
 * repo-uniform shape (publint/NodeNext), not an identity-sensitive runtime —
 * browser consumers resolve this package through the loader module table.
 */
export default defineConfig([
  {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { invariant: 'lib/types/invariant.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { 'store/index': 'lib/types/store/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
