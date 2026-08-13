import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships the generic `dsh` launcher and the direct `deepseek`
 * terminal entry referenced by package.json `bin`. The root tsdown builds only
 * `lib/types/index.js`, so this override points at both executable entries.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/deepseek.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
