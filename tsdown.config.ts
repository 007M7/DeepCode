import { defineConfig } from 'tsdown'

/**
 * JS bundling for all workspace packages (vendor and the packages hierarchy).
 * TypeScript source is compiled first by `tsc -b tsconfig.build.json`; tsdown
 * reads only the emitted JS under lib/types and writes lib/index.* runtime
 * bundles. Declarations are NOT produced here, hence `dts: false`.
 *
 * Per-package shape overrides live in `<package>/tsdown.config.ts`
 * (schemastery: dual ESM+CJS; logger-console: extra browser entry).
 */
export default defineConfig({
  // Explicit globs: `workspace: true` would also discover examples (any
  // package.json), but only vendor and the packages hierarchy are pnpm
  // workspaces.
  workspace: ['vendor/*', 'packages/*/*'],
  entry: ['lib/types/index.js'],
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
