import { defineConfig } from 'tsdown'

/** Builds the plugin and executable entries from declarations emitted by `tsc -b`. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
