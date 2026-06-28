import { defineConfig } from 'tsdown'

/**
 * tool-fs exposes one package root plus one entry per tool plugin, so each tool
 * can be loaded or replaced independently as a subpath plugin
 * (`@deepseek-ai/dsh-tool-fs/read`, `/write`, `/edit`). The root tsdown builds
 * only `lib/types/index.js`, so this override adds the per-tool entries. tsdown
 * reads the emitted JS under `lib/types` (from `tsc -b`); declarations come from
 * `tsc -b` too (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/read.js', 'lib/types/write.js', 'lib/types/edit.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

