import { defineConfig } from 'tsdown'

/**
 * tool-fs exposes one package root plus one entry per tool plugin, so each tool
 * can be loaded or replaced independently as a subpath plugin
 * (`@deepseek-ai/dsh-tool-fs/read`, `/write`, `/edit`). The root tsdown config
 * only auto-discovers `src/index.ts`, so the subpath entries are declared here.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/read.ts', 'src/write.ts', 'src/edit.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
