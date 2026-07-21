import { defineConfig } from 'tsdown'

/**
 * JS bundling for vendored Cordis and Harness TypeScript packages.
 * TypeScript source is compiled first by `tsc -b tsconfig.build.json`; tsdown
 * reads only the emitted JS under lib/types and writes the package root and
 * invariant companion runtime bundles. Declarations are NOT produced here,
 * hence `dts: false`.
 *
 * Per-package shape overrides live in `<package>/tsdown.config.ts`
 * (schemastery: dual ESM+CJS; logger-console: extra browser entry).
 */
export default defineConfig({
  // Explicit globs keep bundling to vendored Cordis and the TypeScript package tree;
  // `workspace: true` would discover package manifests outside that bundle set. Landlock
  // platform packages contain only a prebuilt native binary, so they have no JS entry.
  workspace: ['vendor/*', 'packages/*/*'],
  // The brace glob admits the package companion when present while retaining the
  // index-only build for vendored Cordis packages outside the Harness package tree.
  entry: ['lib/types/{index,invariant}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  // All packages set "type": "module"; fixedExtension false keeps ESM output
  // at .js (not .mjs), matching the package.json main/exports fields.
  fixedExtension: false,
  dts: false,
  clean: false,
})
