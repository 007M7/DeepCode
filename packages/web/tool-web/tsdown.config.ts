import { defineConfig } from 'tsdown'

/**
 * tool-web exposes one package root plus one entry per tool plugin, so each tool
 * can be loaded or replaced independently as a subpath plugin
 * (`@deepseek-ai/dsh-tool-web/search`, `/fetch`). The root tsdown builds only
 * `lib/types/index.js`, so this override adds the subpath entries. Declarations
 * come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/search.js', 'lib/types/fetch.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
