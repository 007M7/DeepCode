import { defineConfig } from 'tsdown'

/**
 * tui-demo ships the plugin (`index`) and its invariant companion; the CLI
 * front door is `dsh` (apps/cli), which mounts this bundle through its config.
 * The root tsdown builds only `lib/types/index.js`, so this override adds the
 * invariant entry. Declarations come from `tsc -b` (dts: false), matching
 * every package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
