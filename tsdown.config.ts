import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

/**
 * JS bundling for vendored Cordis and Harness TypeScript packages.
 * TypeScript source is compiled first by `tsc -b` (the root solution); tsdown
 * reads only the emitted JS under lib/types and writes the package root and
 * invariant companion runtime bundles. Declarations are NOT produced here,
 * hence `dts: false`.
 *
 * Per-package shape overrides live in `<package>/tsdown.config.ts`
 * (schemastery: dual ESM+CJS; logger-console: extra browser entry).
 */
export default defineConfig({
  // Explicit globs keep bundling to vendored Cordis, the TypeScript package tree, and
  // the Node CLI assembly. `apps/web` is a Vite application with no lib/types entry;
  // `workspace: true` or `apps/*` would incorrectly treat it as a package bundle.
  workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
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
  // The final pass sees both independent TypeScript faces. Workspace mode
  // writes only packages that explicitly publish a Typert/Remote subpath.
  plugins: [typertPlugin({ mode: 'workspace' })],
})
