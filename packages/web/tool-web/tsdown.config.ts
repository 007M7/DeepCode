import { defineConfig } from 'tsdown'

/**
 * tool-web exposes one package root plus one entry per tool plugin, so each tool
 * can be loaded or replaced independently as a subpath plugin
 * (`@deepseek-ai/dsh-tool-web/search`, `/fetch`). The root tsdown config only
 * auto-discovers `src/index.ts`, so the subpath entries are declared here.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/search.ts', 'src/fetch.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
