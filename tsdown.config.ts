import { defineConfig } from 'tsdown'

/**
 * JS bundling for all workspace packages (vendor/* + packages/*).
 * Declarations are NOT produced here — `tsc -b tsconfig.build.json` owns
 * .d.ts output (composite project references); hence `dts: false` and
 * `clean: false` (lib/ already holds tsc's declarations).
 *
 * Per-package shape overrides live in `<package>/tsdown.config.ts`
 * (schemastery: dual ESM+CJS; logger-console: extra browser entry).
 */
export default defineConfig({
  // Explicit globs: `workspace: true` would also discover examples/* (any
  // package.json), but only vendor/* and packages/* are pnpm workspaces.
  workspace: ['vendor/*', 'packages/*'],
  entry: ['src/index.ts'],
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
